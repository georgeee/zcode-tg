// E2E: the TaskOutput circuit breaker. A real turn starts a background
// sleep and then BLOCKS on TaskOutput (the anti-pattern), with the breaker
// limit set to 25s via env. The turn must be auto-interrupted: the breaker
// notice posts, the session goes idle (a follow-up message works), and the
// BACKGROUND TASK IS NOT CANCELLED (its log still completes on schedule).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const H = process.env.HOME;
const WS = `${H}/.cache/e2e-breaker-ws`;
const STORE = `${H}/.cache/e2e-breaker-store.json`;
const CHAT = -100777, USER = 42, THREAD = 95;

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
      const p = JSON.parse(body || '{}');
      calls.send.push({ ...p, message_id: nextMsgId });
      return ok({ message_id: nextMsgId++ });
    }
    if (method === 'editMessageText') {
      const p = JSON.parse(body || '{}');
      calls.edit.push(p);
      return ok({ message_id: p.message_id });
    }
    return ok();
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
    TASK_BLOCK_LIMIT_MS: '25000',
    HOME: process.env.HOME,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => (bridgeLog += c));
bridge.stderr.on('data', (c) => (bridgeLog += c));
process.on('SIGTERM', () => { bridge.kill('SIGKILL'); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(1000);
  }
}
const sendUser = (text) =>
  updateQueue.push({
    update_id: updateId++,
    message: { message_id: nextMsgId++, from: { id: USER, is_bot: false }, chat: { id: CHAT }, message_thread_id: THREAD, text },
  });
const wake = () => {
  for (const w of [...waiting]) w();
  waiting.clear();
};

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

try {
  await waitFor(() => bridgeLog.includes('[bridge] starting.'), 15000, 'boot');
  sendUser(
    'Do exactly this: use Bash with run_in_background=true to run the command "sleep 45 && echo BG-COMPLETED-OK > breaker-marker.txt". ' +
    'Then immediately call TaskOutput with block=true and timeout=600000 on that task, and WAIT on it (do not end your turn). ' +
    'When it finally returns, reply with exactly: BLOCKER-NEVER-REACHED'
  );
  wake();
  await waitFor(() => bridgeLog.includes('circuit breaker'), 150000, 'breaker fired');
  check('breaker fired in the bridge log', true);
  const notice = await waitFor(
    () => calls.edit.concat(calls.send.map((x) => ({ text: x.text }))).find((e) => /Auto-interrupted/.test(e.text) && /TaskOutput/.test(e.text)),
    30000,
    'breaker notice in topic',
  );
  check('auto-interrupt notice posted to the topic', !!notice);

  // The background task must NOT have been cancelled: its marker appears on schedule.
  await waitFor(() => existsSync(path.join(WS, 'breaker-marker.txt')), 90000, 'background task completion marker');
  check('background task was NOT cancelled (completed on schedule)', readFileSync(path.join(WS, 'breaker-marker.txt'), 'utf8').includes('BG-COMPLETED-OK'));

  // The session must be usable right after: a follow-up message gets a real
  // completed reply (any text -- the model sometimes honors the interrupted
  // turn's promise instead of the new instruction, which is judgment, not a
  // bridge defect; what the bridge owes is a prompt, unwedged answer).
  calls.send.length = 0; calls.edit.length = 0;
  sendUser('Reply with exactly: STILL-ALIVE');
  wake();
  const alive = await waitFor(
    () => calls.edit.concat(calls.send.map((x) => ({ text: x.text }))).find((e) => e.text && !/^[⏳📌]/.test(e.text)),
    150000,
    'follow-up reply',
  );
  check('session usable immediately after the interruption (prompt completed reply)', !!alive, JSON.stringify((alive?.text || '').slice(0, 80)));
} catch (e) {
  check('scenario completed without harness timeout', false, e.message);
  console.log('--- edits ---');
  for (const e of calls.edit) console.log('edit>', JSON.stringify((e.text || '').slice(0, 80)));
  console.log('--- sends ---');
  for (const x of calls.send) console.log('send>', JSON.stringify((x.text || '').slice(0, 60)));
  console.log('--- log tail ---');
  console.log(bridgeLog.split('\n').filter((l) => l.trim()).slice(-8).join('\n'));
} finally {
  console.log(bridgeLog.split('\n').filter((l) => l.includes('breaker') || l.includes('/stop')).slice(0, 3).join('\n'));
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  srv.close();
  bridge.kill('SIGTERM');
  await sleep(1200);
  try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
