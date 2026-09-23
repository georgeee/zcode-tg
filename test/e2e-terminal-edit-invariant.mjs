// E2E: the terminal-edit invariant (relay-owned-group design §6, decision
// D1). The relay's coalescer is latest-text-wins with NO terminal-edit wire
// flag, so the bridge-side property that makes the whole thing safe is
// stated, not signaled: NO editMessageText for a message follows that
// message's terminal render. The one edit finalizeTurn delivers (or the
// send that replaces it) must be the last write that message ever sees.
//
// Three real-bridge scenarios, each racing a pending preview flush against
// the final render with a fake Telegram that DELAYS its editMessageText
// answers (so a flush is still in flight on the wire when turn.terminal
// lands) and records every call with an issue-order sequence number:
//
//   A. preview mode, held edits answer OK -- the control: issued-before-
//      terminal edits may RESOLVE late, and that must be harmless.
//   B. preview mode, the in-flight preview edit FAILS transiently after the
//      terminal render -- the exact leak the streamer fix seals: the old
//      catch/_schedule path re-armed a timer that re-edited the message
//      with a stale ⌛ preview AFTER the reply landed (red on the unfixed
//      tree, green after).
//   C. milestone mode (STREAM_PROGRESS=messages, the default) -- same race
//      against the ProgressReporter's live-label edits, late heartbeats
//      included: the invariant must hold there too.
//
// Drive: ZCODE_NODE_BIN=$(command -v node) node test/e2e-terminal-edit-invariant.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || process.execPath;
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ZCODE_FIXTURE = path.join(REPO, 'test', 'fixtures', 'fake-zcode-app-server.mjs');
const TMP = '/tmp/zbridge-e2e-terminal-edit';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

const CHAT = -100111, OWNER = 1, THREAD = 77;
const FINAL_MARKER = 'FINAL-REPLY-alpha-beta';
// The race schedule: deltas stream at 300/600ms; the terminal lands at
// 1500ms; preview edits are held on the wire for 1200ms -- so an edit issued
// at 400ms is still unanswered at 1500ms, exactly the "flush in flight when
// the final render happens" race D1 is about.
const TURN_SCRIPT = { deltas: ['stream one ', 'stream two '], deltaDelayMs: 300, terminalDelayMs: 1500, result: FINAL_MARKER };
const HOLD_MS = 1200;
const QUIET_MS = 4500; // how long we watch for a post-terminal edit (several intervals + heartbeats + a held release)

// A fake Telegram whose editMessageText DELAYS previews ('⌛'/'⏳' texts) and,
// in fail mode, answers them with a transient 500 -- everything is recorded
// immediately on arrival with a monotonic seq (issue order).
function startFakeTelegram({ failPreviews }) {
  const calls = [];
  let seq = 0;
  let nextMsgId = 100;
  const pendingUpdates = [];
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const method = req.url.split('/').pop();
    const ok = (result = {}) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
    if (method === 'getUpdates') {
      if (pendingUpdates.length) return ok(pendingUpdates.splice(0, pendingUpdates.length));
      const t = setTimeout(() => ok([]), 500);
      t.unref?.();
      return;
    }
    const params = body ? JSON.parse(body) : {};
    if (method === 'editMessageText' && /^[⌛⏳]/.test(params.text || '')) {
      const record = { seq: ++seq, method, params };
      calls.push(record); // recorded at ISSUE time -- issue order is what the invariant speaks
      await sleep(HOLD_MS);
      if (failPreviews) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error: transient relay hiccup' }));
      } else {
        ok({ message_id: params.message_id });
      }
      return;
    }
    calls.push({ seq: ++seq, method, params });
    if (method === 'sendMessage') {
      const message_id = nextMsgId++; // minted by this fake (the relay's job in production) -- recorded INTO the call
      calls[calls.length - 1].params.message_id = message_id;
      return ok({ message_id });
    }
    if (method === 'editMessageText') return ok({ message_id: params.message_id });
    return ok();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    srv,
    port: srv.address().port,
    calls,
    pushUpdate: (u) => pendingUpdates.push(u),
  })));
}

function startBridge(env) {
  const bridge = spawn(NODE, [path.join(REPO, 'bridge/index.js')], {
    env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  bridge.stdout.on('data', (c) => { log += c; });
  bridge.stderr.on('data', (c) => { log += c; });
  return { proc: bridge, get log() { return log; } };
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(60);
  }
}

const scriptFile = path.join(TMP, 'turn-script.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(scriptFile, JSON.stringify(TURN_SCRIPT)); // the fixture reads this fresh on every session/send

// Runs one scenario: a real bridge streaming a scripted turn against the
// slow fake; asserts the final render for message M is the last call ever
// issued for M.
async function scenario(letter, { streamProgress, failPreviews }) {
  console.log(`\n--- scenario ${letter}: STREAM_PROGRESS=${streamProgress}, previews ${failPreviews ? 'FAIL (transient 500)' : 'answer ok'} ---`);
  const fake = await startFakeTelegram({ failPreviews });
  const store = path.join(TMP, `${letter}-store.json`);
  const ws = path.join(TMP, `${letter}-ws`);
  mkdirSync(ws, { recursive: true });
  const b = startBridge({
    TELEGRAM_API_ROOT: `http://127.0.0.1:${fake.port}`,
    TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: String(CHAT), TELEGRAM_ALLOWED_USER_ID: String(OWNER),
    DEFAULT_BACKEND: 'zcode',
    ZCODE_NODE_BIN: NODE, ZCODE_BIN: ZCODE_FIXTURE,
    ZCODE_WORKSPACE_DIR: ws,
    FIXTURE_ZCODE_TURN_SCRIPT: scriptFile,
    STREAM_PROGRESS: streamProgress,
    STREAM_EDIT_INTERVAL_MS: '400',
    STREAM_HEARTBEAT_MS: '250', // late heartbeats are part of the race
    STORE_PATH: store,
  });
  try {
    await waitFor(() => b.log.includes('[bridge] starting.'), 15000, 'bridge boot');
    fake.pushUpdate({
      update_id: 1,
      message: {
        message_id: 5001, from: { id: OWNER, is_bot: false }, chat: { id: CHAT },
        message_thread_id: THREAD, date: Math.floor(Date.now() / 1000),
        text: 'stream something short',
      },
    });

    // M: the placeholder the streamer/progress view edits for this turn.
    await waitFor(() => fake.calls.some((c) => c.method === 'sendMessage' && (c.params.text || '').startsWith('⌛')), 15000, 'placeholder posted');
    const M = fake.calls.find((c) => c.method === 'sendMessage' && (c.params.text || '').startsWith('⌛')).params.message_id;

    // The terminal render for M: the reply text, delivered by edit (or, if
    // the final went out as a new message in milestone mode, there is an
    // edit for M only in the replace case -- wait for whichever happens).
    const finalForM = () =>
      fake.calls.find((c) => {
        if (c.method !== 'editMessageText' || c.params.message_id !== M) return false;
        const t = c.params.text || '';
        return !t.startsWith('⌛') && !t.startsWith('⏳');
      }) ?? (streamProgress === 'messages' ? null : null);
    const final = await waitFor(() => finalForM() ?? (fake.calls.some((c) => c.method === 'sendMessage' && (c.params.text || '').includes(FINAL_MARKER)) ? { messageAsNew: true } : null), 15000, 'terminal render');
    const finalSeq = final.messageAsNew ? fake.calls.find((c) => c.method === 'sendMessage' && (c.params.text || '').includes(FINAL_MARKER)).seq : final.seq;

    // Watch long past the held releases: any edit issued for M now is a D1 violation.
    await sleep(QUIET_MS);

    const postFinal = fake.calls.filter((c) => c.method === 'editMessageText' && c.params.message_id === M && c.seq > finalSeq);
    check(`[${letter}] the terminal render was delivered for message ${M}`, !!(final.messageAsNew || final), JSON.stringify(fake.calls.slice(-5)));
    check(
      `[${letter}] no editMessageText for the message followed its terminal render (D1)`,
      postFinal.length === 0,
      `post-terminal edits: ${JSON.stringify(postFinal.map((c) => ({ seq: c.seq, text: (c.params.text || '').slice(0, 60) })))}`,
    );
    const previewsForM = fake.calls.filter((c) => c.method === 'editMessageText' && c.params.message_id === M && /^[⌛⏳]/.test(c.params.text || ''));
    check(`[${letter}] the race actually happened (a preview edit was in flight near the terminal)`, previewsForM.length >= 1, JSON.stringify(fake.calls.map((c) => c.method)));
    if (failPreviews) {
      check(`[${letter}] the transient preview failure occurred post-render (the leak's precondition)`, previewsForM.some((c) => c.seq < finalSeq), 'no held preview failed');
    }
  } catch (e) {
    check(`scenario ${letter} completed without harness timeout`, false, `${e.message}\n${b.log.slice(-2000)}`);
  } finally {
    b.proc.kill('SIGKILL');
    fake.srv.close();
    await sleep(200);
    for (const f of [store, `${store}.lock`]) { try { rmSync(f, { force: true }); } catch {} }
  }
}

// One shared turn script file, written above; the fixture reads it fresh per
// session/send.
await scenario('A', { streamProgress: 'preview', failPreviews: false });
await scenario('B', { streamProgress: 'preview', failPreviews: true });
await scenario('C', { streamProgress: 'messages', failPreviews: true });

console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
