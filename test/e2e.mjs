// End-to-end harness: runs the REAL bridge (bridge/index.js) against a
// local fake Telegram (TELEGRAM_API_ROOT seam) and a REAL scratch
// `zcode app-server` (real model, tiny turns). Never touches the live bot:
// getUpdates tolerates exactly one consumer and the service holds it.
//
// Drive:  node test/e2e.mjs
// Reads paths from the same env names the bridge uses when present.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const WS = '/tmp/zbridge-e2e-ws';
const STORE = '/tmp/zbridge-e2e-store.json';

rmSync(WS, { recursive: true, force: true });
rmSync(STORE, { force: true });
mkdirSync(WS, { recursive: true });
writeFileSync(path.join(WS, 'sample.txt'), 'sample file for /file e2e\n'.repeat(10));

const CHAT = -100777;
const USER = 42;
const THREAD = 77;
process.on('unhandledRejection', (e) => console.error('[harness] unhandled rejection:', e));

// --- fake Telegram ---
const calls = { send: [], edit: [], pin: [], document: [] };
let nextMsgId = 100;
let updateId = 1;
const updateQueue = [];
const waiting = new Set(); // pending poll resolvers

function pushUpdate(payload) {
  updateQueue.push({ update_id: updateId++, ...payload });
  for (const w of waiting) w();
  waiting.clear();
}

async function readBody(req) {
  let b = '';
  for await (const c of req) b += c;
  return b;
}

const srv = createServer(async (req, res) => {
  const method = req.url.split('/').pop();
  if (process.env.E2E_DEBUG_HTTP) console.log(`[http] <- ${method}`);
  try {
    await handleFake(method, req, res);
  } catch (e) {
    console.error(`[http] handler error for ${method}:`, e);
    try {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false }));
    } catch {}
  }
});
async function handleFake(method, req, res) {
  const body = await readBody(req);
  const json = () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: {} }));
  };
  if (method === 'getUpdates') {
    const p = JSON.parse(body || '{}');
    // honor offset: drop consumed updates
    while (updateQueue.length && updateQueue[0].update_id < p.offset) updateQueue.shift();
    let done = false;
    const respond = () => {
      if (done) return;
      done = true;
      const batch = updateQueue.splice(0, 10).map((u) => u);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: batch }));
    };
    if (updateQueue.length) return respond();
    const wrapper = () => respond();
    const timer = setTimeout(() => {
      waiting.delete(wrapper);
      respond();
    }, 3000);
    waiting.add(() => {
      clearTimeout(timer);
      wrapper();
    });
    return;
  }
  if (method === 'sendMessage') {
    const p = JSON.parse(body);
    calls.send.push(p);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: nextMsgId++ } }));
    return;
  }
  if (method === 'sendDocument') {
    calls.document.push({ url: req.url, bytes: body.length, multipart: /multipart\/form-data/.test(req.headers['content-type'] || '') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: nextMsgId++ } }));
    return;
  }
  if (method === 'editMessageText') {
    const p = JSON.parse(body);
    calls.edit.push(p);
    if (process.env.E2E_DEBUG_HTTP) console.log(`[http] edit ->${p.message_id}: ${(p.text || '').slice(0, 100).replace(/\n/g, ' | ')}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: p.message_id, text: p.text } }));
    return;
  }
  if (method === 'pinChatMessage') {
    calls.pin.push(JSON.parse(body));
    return json();
  }
  return json(); // setMyCommands, answerCallbackQuery, anything else: ok
}
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
console.log(`fake telegram on 127.0.0.1:${port}`);

// --- the bridge under test ---
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
    STREAM_EDIT_INTERVAL_MS: '1500',
    TURN_TIMEOUT_MS: '0',
    BRIDGE_DEBUG_EVENTS: process.env.BRIDGE_DEBUG_EVENTS || '',
    HOME: process.env.HOME,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => {
  const s = c.toString();
  bridgeLog += s;
  process.stdout.write(`[bridge] ${s}`);
});
bridge.stderr.on('data', (c) => {
  const s = c.toString();
  bridgeLog += s;
  process.stderr.write(`[bridge-err] ${s}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sendUser = (text, replyTo) =>
  pushUpdate({
    message: {
      message_id: nextMsgId++,
      from: { id: USER, is_bot: false },
      chat: { id: CHAT },
      message_thread_id: THREAD,
      text,
      ...(replyTo ? { reply_to_message: { message_id: 1, chat: { id: CHAT }, text: replyTo } } : {}),
    },
  });

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
}
async function waitFor(desc, fn, timeoutMs = 90000, every = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(every);
  }
}
const editsTo = (id) => calls.edit.filter((e) => e.message_id === id);
const lastSend = (pred) => [...calls.send].reverse().find(pred);

// Wait for boot (setMyCommands + first getUpdates) then run scenarios.
await waitFor('bridge boot', () => bridgeLog.includes('starting.'), 15000);
await sleep(500);

// S1: plain turn with streaming (tool call first so the turn lasts long
// enough for at least one intermediate throttled edit)
console.log('\n== S1: streaming reply ==');
const s1t0 = Date.now();
sendUser("Use the Bash tool to run 'echo hi', then reply with exactly: hello-stream");
let ph = await waitFor('placeholder', () => calls.send.find((s) => s.message_thread_id === THREAD && s.text === '⌛ …'), 30000);
check('placeholder ⌛ posted', !!ph);
if (ph) {
  const final = await waitFor(
    'final edit',
    () => editsTo(ph.message_id).find((e) => /hello-stream/.test(e.text) && !e.text.startsWith('⌛') && /<i>/.test(e.text) && /tok/.test(e.text)),
    120000,
  );
  check('final edit: no ⌛, footer with tokens', !!final, JSON.stringify(editsTo(ph.message_id).map((e) => e.text.slice(0, 120))));
  const fi = final ? editsTo(ph.message_id).indexOf(final) : -1;
  const streamed = fi > 0 ? editsTo(ph.message_id).slice(0, fi).find((e) => e.text.startsWith('⌛')) : null;
  check('at least one intermediate ⌛ edit streamed before final', !!streamed, JSON.stringify(editsTo(ph.message_id).slice(0, Math.max(fi, 0)).map((e) => e.text.slice(0, 60))));
}
const statusMsg = await waitFor('status message', () => calls.send.find((s) => s.text.startsWith('📌 Topic status')), 30000);
check('topic status message posted', !!statusMsg);
check('status pinned', calls.pin.length > 0);

// S2/S3: /model
console.log('\n== S2: /model ==');
calls.send.length = 0;
sendUser('/model');
let list = await waitFor('model list', () => calls.send.find((s) => /Models available/.test(s.text)), 30000);
check('model list with current marker', !!list && /▶ .*glm-5\.3/.test(list?.text || ''), list?.text?.slice(0, 200));
sendUser('/model zai/glm-5.3-flash');
const sw = await waitFor('model switched', () => calls.send.find((s) => /✅ Model/.test(s.text)), 30000);
check('model switch confirmed', /glm-5\.3-flash/.test(sw?.text || ''), sw?.text);
sendUser('/model nosuchmodel');
const bad = await waitFor('bad model rejected', () => calls.send.find((s) => /Unknown model/.test(s.text)), 30000);
check('unknown model rejected', !!bad);
sendUser('/model zai/glm-5.3');
await waitFor('model restored', () => calls.send.find((s) => /✅ Model.*glm-5\.3\b/.test(s.text) && !/flash/.test(s.text)), 30000);

// S4: /mode
console.log('\n== S3: /mode ==');
calls.send.length = 0;
sendUser('/mode');
const modes = await waitFor('mode list', () => calls.send.find((s) => /Modes \(current: yolo\)/.test(s.text)), 15000);
check('mode list', !!modes, modes?.text?.slice(0, 120));
sendUser('/mode plan');
const ms = await waitFor('mode switched', () => calls.send.find((s) => /✅ Mode/.test(s.text)), 15000);
check('mode switch confirmed', /plan/.test(ms?.text || ''), ms?.text);
sendUser('/mode yolo');
await waitFor('mode restored', () => calls.send.find((s) => /✅ Mode: yolo/.test(s.text)), 15000);

// S5: /file
console.log('\n== S4: /file ==');
sendUser('/file sample.txt');
const doc = await waitFor('document sent', () => calls.document[0], 20000);
check('sendDocument multipart with payload', !!doc && doc.multipart && doc.bytes > 100, JSON.stringify(doc));
sendUser('/file ../../../../etc/passwd');
const denied = await waitFor('traversal denied', () => calls.send.find((s) => /outside the workspace/.test(s.text)), 15000);
check('path traversal denied', !!denied, denied?.text);

// S6: reply-to-quote turn
console.log('\n== S5: reply-to-quote ==');
calls.send.length = 0;
sendUser('Reply with exactly: quoted-ok', 'an earlier message said: bananas ripen slowly');
ph = await waitFor('placeholder', () => calls.send.find((s) => s.text === '⌛ …'), 20000);
const qFinal = ph && (await waitFor('quoted turn reply', () => editsTo(ph.message_id).find((e) => /quoted-ok/.test(e.text) && !e.text.startsWith('⌛')), 90000));
check('reply-to turn completes', !!qFinal, ph ? JSON.stringify(editsTo(ph.message_id).length) : 'no placeholder');

// S7: queueing
console.log('\n== S6: queue ==');
calls.send.length = 0;
sendUser('Reply with exactly: first-done. Then stop.');
await sleep(300);
sendUser('Reply with exactly: second-done');
const queuedNotice = await waitFor('queued notice', () => calls.send.find((s) => /📥 Queued/.test(s.text)), 20000);
check('second message queued', !!queuedNotice);
const secondFinal = await waitFor(
  'queued message ran',
  () => {
    const n = calls.edit.filter((e) => /second-done/.test(e.text) && !e.text.startsWith('⌛'));
    return n.length ? n[0] : null;
  },
  120000,
);
check('queued message delivered after first', !!secondFinal);

// S8: background task + adoption
console.log('\n== S7: background task notice + adopted turn ==');
calls.send.length = 0;
sendUser(
  'Start exactly ONE background Bash task with run_in_background=true, command: sleep 6 && echo bg-e2e. ' +
    'Your entire reply must be the single word: started. You MUST NOT call TaskOutput/TaskStop or wait for the task.',
);
const started = await waitFor(
  'started reply',
  () => calls.edit.find((e) => /started/.test(e.text) && !e.text.startsWith('⌛')),
  120000,
);
check('turn that starts bg task completed', !!started);
const bgSignal = await waitFor(
  'background completion surfaced (🌀 notice or adopted turn)',
  () => calls.send.find((s) => /🌀/.test(s.text)) || calls.edit.find((e) => /🌀/.test(e.text)),
  90000,
);
check('background task completion surfaced to topic', !!bgSignal, JSON.stringify(calls.send.slice(-3).map((s) => s.text.slice(0, 60))));
const adoptedFinal = await waitFor(
  'adopted turn delivered a reply',
  () => calls.edit.find((e) => /background/i.test(e.text) && !e.text.startsWith('⌛') && /<i>.*tok/.test(e.text)),
  150000,
);
check('adopted notification turn reply delivered with footer', !!adoptedFinal, JSON.stringify(calls.edit.slice(-4).map((e) => e.text.slice(0, 80))));

// wrap up
console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
srv.close();
bridge.kill('SIGTERM');
await sleep(1000);
try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); } catch {}
process.exit(failures === 0 ? 0 : 1);
