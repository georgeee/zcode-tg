// Focused e2e for milestone-mode progress (STREAM_PROGRESS=messages): the
// real bridge against a fake Telegram + a real scratch app-server. The
// prompt forces narration between two Bash phases, so the turn must produce
// at least two milestone messages; the seed/first milestone must freeze
// into a "✅ label + steps" record; the final reply must arrive as its own
// message with the usage footer.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const WS = '/tmp/zbridge-e2eprog-ws';
const STORE = '/tmp/zbridge-e2eprog-store.json';
const CHAT = -100777, USER = 42, THREAD = 92;

rmSync(WS, { recursive: true, force: true });
rmSync(STORE, { force: true });
mkdirSync(WS, { recursive: true });

const calls = { send: [], edit: [] };
let nextMsgId = 100, updateId = 1;
const updateQueue = [];
const waiting = new Set();

const srv = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const c of req) body += c;
    const method = req.url.split('/').pop();
    const ok = (result = {}) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === 'getUpdates') {
      const p = JSON.parse(body || '{}');
      while (updateQueue.length && updateQueue[0].update_id < p.offset) updateQueue.shift();
      let done = false;
      const respond = () => {
        if (done) return;
        done = true;
        ok(updateQueue.splice(0, 10));
      };
      if (updateQueue.length) return respond();
      const wrapper = () => respond();
      const timer = setTimeout(() => { waiting.delete(wrapper); respond(); }, 3000);
      waiting.add(() => { clearTimeout(timer); wrapper(); });
      return;
    }
    if (method === 'sendMessage') {
      const p = JSON.parse(body);
      calls.send.push({ ...p, message_id: nextMsgId });
      return ok({ message_id: nextMsgId++ });
    }
    if (method === 'editMessageText') {
      const p = JSON.parse(body);
      calls.edit.push(p);
      return ok({ message_id: p.message_id });
    }
    return ok(); // pin/setMyCommands/answerCallbackQuery/getFile/...
  } catch (e) {
    console.error('[http] error:', e);
    try { res.statusCode = 500; res.end('{"ok":false}'); } catch {}
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const bridge = spawn(NODE, [path.join(REPO, 'bridge/index.js')], {
  env: {
    ...process.env,
    TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
    TELEGRAM_BOT_TOKEN: 'e2e-fake-token',
    TELEGRAM_CHAT_ID: String(CHAT),
    TELEGRAM_ALLOWED_USER_ID: String(USER),
    ZCODE_NODE_BIN: NODE,
    ZCODE_BIN: ZCODE_BIN,
    ZCODE_WORKSPACE_DIR: WS,
    ZCODE_DEFAULT_MODEL: 'zai/glm-5.3',
    ZCODE_DEFAULT_MODE: 'yolo',
    STORE_PATH: STORE,
    STREAM_PROGRESS: 'messages',
    HOME: process.env.HOME,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => { bridgeLog += c; });
bridge.stderr.on('data', (c) => { bridgeLog += c; process.stderr.write(`[bridge-err] ${c}`); });
process.on('unhandledRejection', (e) => console.error('[harness] unhandled rejection:', e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(500);
  }
}

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

try {
  await waitFor(() => bridgeLog.includes('starting.'), 15000, 'boot');
  await sleep(300);
  updateQueue.push({
    update_id: updateId++,
    message: {
      message_id: nextMsgId++,
      from: { id: USER, is_bot: false },
      chat: { id: CHAT },
      message_thread_id: THREAD,
      text: 'Do exactly this, in order: (1) state in one short sentence what you are about to do; (2) run the Bash command "sleep 8 && echo phase-one"; (3) state in one short sentence what you are about to do next; (4) run the Bash command "echo phase-two"; (5) reply with exactly: PROGRESS-DONE',
    },
  });
  for (const w of [...waiting]) w();

  const seed = await waitFor(() => calls.send.find((s) => s.text === '⌛ …'), 20000, 'seed placeholder');
  check('seed ⌛ placeholder posted', !!seed);

  const milestones = await waitFor(
    () => (calls.send.filter((s) => s.text === '⏳ …').length >= 2 ? calls.send.filter((s) => s.text === '⏳ …') : null),
    120000,
    '>=2 milestone messages',
  );
  check('at least two milestone messages posted (one per narrated phase)', true, `got ${milestones.length}`);

  const frozenSeed = await waitFor(
    () => calls.edit.filter((e) => e.message_id === seed.message_id).find((e) => e.text.startsWith('✅') && /Bash/.test(e.text)),
    120000,
    'seed frozen with steps',
  );
  check('first milestone froze into ✅ + steps record', !!frozenSeed, JSON.stringify(calls.edit.filter((e) => e.message_id === seed.message_id).map((e) => e.text.slice(0, 60))));

  const final = await waitFor(
    () => calls.edit.concat(calls.send.map((s) => ({ message_id: s.message_id, text: s.text }))).find((e) => /PROGRESS-DONE/.test(e.text) && /tok/.test(e.text)),
    150000,
    'final reply with footer',
  );
  check('final reply delivered with usage footer', !!final);
  const lastMilestoneSend = [...calls.send].reverse().find((s) => s.text === '⏳ …');
  check('final reply REPLACES the trailing (tool-less) milestone message, properly rendered', final.message_id === lastMilestoneSend.message_id, `final=${final.message_id} lastMilestone=${lastMilestoneSend?.message_id}`);
  check('no duplicate frozen copy of the reply text', !calls.edit.some((e) => e.text.startsWith('✅') && /PROGRESS-DONE/.test(e.text)));

  const liveEdits = calls.edit.filter((e) => e.text.startsWith('⏳'));
  check('live milestone messages showed steps (⏳ + ▶/✓ tool lines)', liveEdits.some((e) => /▪/.test(e.text)), JSON.stringify(liveEdits.slice(0, 2).map((e) => e.text.slice(0, 80))));
} catch (e) {
  check('scenario completed without harness timeout', false, e.message);
} finally {
  const progErr = bridgeLog.split('\n').filter((l) => l.includes('[progress]')).slice(0, 3);
  if (progErr.length) console.log('progress-log-lines:', progErr.join(' | '));
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  srv.close();
  bridge.kill('SIGTERM');
  await sleep(1000);
  try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); rmSync(WS, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
