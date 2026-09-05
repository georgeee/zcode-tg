// Focused e2e for inbound documents: the real bridge against a fake
// Telegram (TELEGRAM_API_ROOT seam) + a real scratch zcode app-server.
// Proves the full owner-requested behavior: a document sent to the topic is
// downloaded, saved under inbox/telegram/, and the agent READS it in the
// same turn (asserts its reply echoes the file's first word).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SCRATCH = `${process.env.HOME}/.cache/e2e-file`;
const WS = `${SCRATCH}-ws`;
const STORE = `${SCRATCH}-store.json`;
const CHAT = -100777, USER = 42, THREAD = 91;
const FILE_TEXT = 'hello-inbound this is the rest of the file\nsecond line\n';

rmSync(WS, { recursive: true, force: true });
rmSync(STORE, { force: true });
mkdirSync(WS, { recursive: true });

const calls = { send: [], edit: [], getfile: 0, download: 0 };
let nextMsgId = 100, updateId = 1;
const updateQueue = [];
const waiting = new Set();

const srv = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.startsWith('/file/')) {
      calls.download++;
      res.end(FILE_TEXT); // whatever path the bridge was told, same content
      return;
    }
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
    if (method === 'getFile') {
      calls.getfile++;
      return ok({ file_id: 'fid1', file_unique_id: 'uniq1', file_size: FILE_TEXT.length, file_path: 'documents/note.txt' });
    }
    return ok(); // pin/setMyCommands/answerCallbackQuery/...
  } catch (e) {
    console.error('[http] error:', e);
    try { res.statusCode = 500; res.end('{"ok":false}'); } catch {}
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

// E2E_BRIDGE_CMD: run an already-packaged bridge binary (e.g. the nix
// wrapper) instead of node+index.js -- used to smoke-test the nix package
// end-to-end, with the wrapper's OWN ZCODE_BIN/ZCODE_NODE_BIN defaults
// exercising the packaged runtime (those env vars are deliberately NOT set
// here in that mode).
const bridgeCmd = process.env.E2E_BRIDGE_CMD;
const bridge = bridgeCmd
  ? spawn(bridgeCmd, [], {
      env: {
        ...process.env,
        TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
        TELEGRAM_BOT_TOKEN: 'e2e-fake-token',
        TELEGRAM_CHAT_ID: String(CHAT),
        TELEGRAM_ALLOWED_USER_ID: String(USER),
        ZCODE_WORKSPACE_DIR: WS,
        ZCODE_DEFAULT_MODEL: 'zai/glm-5.3',
        ZCODE_DEFAULT_MODE: 'yolo',
        STORE_PATH: STORE,
        HOME: process.env.HOME,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawn(NODE, [path.join(REPO, 'bridge/index.js')], {
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
bridge.stdout.on('data', (c) => { bridgeLog += c; process.stdout.write(`[bridge] ${c}`); });
bridge.stderr.on('data', (c) => { bridgeLog += c; process.stderr.write(`[bridge-err] ${c}`); });
process.on('unhandledRejection', (e) => console.error('[harness] unhandled rejection:', e));
process.on('SIGTERM', () => { try { bridge.kill('SIGKILL'); } catch {} process.exit(1); });
process.on('SIGINT', () => { try { bridge.kill('SIGKILL'); } catch {} process.exit(1); });

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

  // The user sends note.txt as a document, captioned with an instruction.
  updateQueue.push({
    update_id: updateId++,
    message: {
      message_id: nextMsgId++,
      from: { id: USER, is_bot: false },
      chat: { id: CHAT },
      message_thread_id: THREAD,
      document: { file_id: 'fid1', file_unique_id: 'uniq1', file_name: 'note.txt', mime_type: 'text/plain', file_size: FILE_TEXT.length },
      caption: 'Reply with exactly the first word of the file you were just sent, nothing else.',
    },
  });
  for (const w of [...waiting]) w();

  const ph = await waitFor(() => calls.send.find((s) => s.text === '⌛ …'), 20000, 'placeholder');
  check('placeholder posted for the document turn', !!ph);
  await waitFor(() => calls.getfile > 0, 20000, 'getFile');
  check('bridge fetched the file from Telegram', true);
  await waitFor(() => calls.download > 0, 20000, 'download');

  const inboxDir = path.join(WS, 'inbox', 'telegram');
  const saved = await waitFor(() => (readdirSync(inboxDir).find((f) => f.endsWith('note.txt')) ? path.join(inboxDir, readdirSync(inboxDir).find((f) => f.endsWith('note.txt'))) : null), 15000, 'saved file');
  check('file saved under inbox/telegram/ with timestamp prefix + original name', /-\d{2}T\d{2}-\d{2}-\d{2}-note\.txt$/.test(saved), saved);
  check('saved content matches what was sent', readFileSync(saved, 'utf8') === FILE_TEXT);

  // Milestone mode delivers the reply on the trailing milestone's message
  // (not necessarily the seed placeholder) -- match on content, any id.
  const final = await waitFor(
    () => calls.edit.concat(calls.send.map((x) => ({ message_id: x.message_id, text: x.text }))).find((e) => /hello-inbound/.test(e.text) && !/⏳|⌛/.test(e.text)),
    120000,
    'agent reply echoing the file first word',
  );
  check('agent read the file in-turn and replied with its first word', !!final, JSON.stringify(calls.edit.map((e) => e.text.slice(0, 60))));
} catch (e) {
  check('scenario completed without harness timeout', false, e.message);
} finally {
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  srv.close();
  bridge.kill('SIGTERM');
  await sleep(1000);
  try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
