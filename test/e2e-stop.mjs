// E2E: /stop is a HARD interrupt. A real turn runs a FOREGROUND long bash
// (`sleep 120`), /stop arrives while it executes, and the test asserts the
// sleep process is actually DEAD within seconds (not when the tool would
// have returned) and the topic shows the cancel label. This is the exact
// scenario session/stop alone fails: the abort only lands at the tool
// boundary.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const H = process.env.HOME;
const WS = `${H}/.cache/e2e-stop-ws`;
const STORE = `${H}/.cache/e2e-stop-store.json`;
const CHAT = -100777, USER = 42, THREAD = 94;
const MARKER = 'e2e-stop-sleep-4711';

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
const markerProcs = () => {
  const out = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (cmd.includes(MARKER)) out.push({ pid: Number(pid), cmd: cmd.slice(0, 60) });
    } catch {}
  }
  return out;
};

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

try {
  await waitFor(() => bridgeLog.includes('[bridge] starting.'), 15000, 'boot');
  sendUser(`Use the Bash tool to run exactly this command in the FOREGROUND (do not background it): sleep 120 && echo ${MARKER}-done. After it completes, reply with exactly: NEVER-REACHED`);
  wake();
  await waitFor(() => markerProcs().length > 0, 120000, 'foreground sleep running');
  const before = markerProcs();
  check(`foreground tool process is running (${before.length} procs)`, before.length >= 1, JSON.stringify(before));

  sendUser('/stop');
  wake();
  await waitFor(() => calls.edit.some((e) => /🛑 Cancelled/.test(e.text)) || calls.send.some((x) => /🛑 Cancelled/.test(x.text)), 30000, 'cancel label');
  check('topic shows 🛑 Cancelled promptly', true);
  await waitFor(() => markerProcs().length === 0, 10000, 'tool processes dead');
  check('in-flight tool processes were KILLED within seconds (not at the 120s tool boundary)', markerProcs().length === 0, JSON.stringify(markerProcs()));
  await sleep(3000);
  check('processes stayed dead (no SIGKILL escapees)', markerProcs().length === 0, JSON.stringify(markerProcs()));
  check('no NEVER-REACHED reply arrived after the stop', !calls.edit.concat(calls.send.map((s) => ({ text: s.text }))).some((e) => /NEVER-REACHED/.test(e.text)));
} catch (e) {
  check('scenario completed without harness timeout', false, e.message);
} finally {
  console.log(bridgeLog.split('\n').filter((l) => l.includes('/stop')).slice(0, 3).join('\n'));
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  srv.close();
  bridge.kill('SIGTERM');
  await sleep(1200);
  try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
