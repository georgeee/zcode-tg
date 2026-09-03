// Focused e2e for input burst-merging (Telegram splits long input into
// several near-simultaneous messages): real bridge + fake Telegram + real
// scratch app-server. Two scenarios: a burst arriving while idle must start
// ONE turn with the combined prompt; a burst arriving while busy must
// produce ONE queue entry (merged), not one per part.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SCRATCH = `${process.env.HOME}/.cache/e2e-merge`;
const WS = `${SCRATCH}-ws`;
const STORE = `${SCRATCH}-store.json`;
const CHAT = -100777, USER = 42, THREAD = 93;

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
    STREAM_PROGRESS: 'messages',
    INPUT_MERGE_MS: '800',
    HOME: process.env.HOME,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
const { appendFileSync: apl } = await import('node:fs');
bridge.on('error', (e) => console.error('BRIDGE-SPAWN-ERROR:', e.message));
bridge.on('exit', (c, sig) => console.error('BRIDGE-EXIT:', c, sig));
bridge.stdout.on('data', (c) => { bridgeLog += c; try { apl(`${process.env.HOME}/.cache/e2e-merge-bridge.log`, c); } catch {} });
bridge.stderr.on('data', (c) => { bridgeLog += c; try { apl(`${process.env.HOME}/.cache/e2e-merge-bridge.log`, c); } catch {} });
process.on('unhandledRejection', (e) => console.error('[harness] unhandled rejection:', e));
// timeout(1)-killing THIS harness must not leave the bridge orphaned
// holding the scratch store lock (how earlier runs wedged themselves).
process.on('SIGTERM', () => { bridge.kill('SIGTERM'); process.exit(1); });
process.on('SIGINT', () => { bridge.kill('SIGTERM'); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(400);
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
const delivered = () => calls.edit.concat(calls.send.map((s) => ({ message_id: s.message_id, text: s.text })));

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

try {
  await waitFor(() => bridgeLog.includes('[bridge] starting.'), 15000, 'boot');
  await sleep(300);

  // --- Scenario 1: burst while idle -> ONE turn, combined prompt ---
  console.log('== S1: idle burst ==');
  calls.send.length = 0;
  sendUser('The first half of the secret password is: ALPHA');
  wake();
  await sleep(250);
  sendUser('The second half is BETA. Reply with the full password only, nothing else.');
  wake();
  const final1 = await waitFor(
    () => delivered().find((e) => /ALPHA/i.test(e.text) && /BETA/i.test(e.text) && !/⏳|⌛/.test(e.text)),
    150000,
    'merged reply',
  );
  check('burst merged into one reply containing both halves', !!final1);
  check('exactly one seed placeholder for the burst', calls.send.filter((s) => s.text === '⌛ …').length === 1, String(calls.send.filter((s) => s.text === '⌛ …').length));

  // --- Scenario 2: burst while busy -> ONE queue entry ---
  console.log('== S2: busy burst ==');
  calls.send.length = 0;
  sendUser('Run the Bash command "sleep 10" and after it finishes reply with exactly: A-DONE');
  wake();
  await waitFor(() => calls.send.some((s) => s.text === '⌛ …'), 20000, 'turn A placeholder');
  await sleep(1500); // turn A is safely running
  sendUser('Remember this queue part one: GAMMA');
  wake();
  await sleep(250);
  sendUser('And queue part two: DELTA. When your current work finishes, reply with both words.');
  wake();
  await waitFor(() => calls.send.some((s) => s.text.startsWith('📥 Queued')), 15000, 'queue notice');
  await sleep(1500); // any second (wrong) notice would have appeared by now
  check('busy burst produced exactly ONE queue notice', calls.send.filter((s) => s.text.startsWith('📥 Queued')).length === 1, String(calls.send.filter((s) => s.text.startsWith('📥 Queued')).length));

  await waitFor(() => delivered().find((e) => /A-DONE/.test(e.text) && !/⏳|⌛/.test(e.text)), 180000, 'turn A reply');
  const final2 = await waitFor(
    () => delivered().find((e) => /GAMMA/i.test(e.text) && /DELTA/i.test(e.text) && !/⏳|⌛|Queued/.test(e.text)),
    180000,
    'merged queued reply',
  );
  check('queued burst ran as ONE turn containing both parts', !!final2);
} catch (e) {
  check('scenario completed without harness timeout', false, e.message);
} finally {
  console.log('--- bridge log tail ---');
  console.log(bridgeLog.split('\n').slice(-6).join('\n') || '(no bridge output at all)');
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  srv.close();
  bridge.kill('SIGTERM');
  await sleep(1000);
  try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); rmSync(WS, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
