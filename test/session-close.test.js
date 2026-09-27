// Tests for close-as-release (2026-09-25): every close path -- MCP
// session_close, Telegram /close, a forum_topic_closed/deleted service
// message -- must release the session's PROCESS, not just mark the topic.
// Measured on a live guest: session_close answered OK on all four BUSY
// antigravity sessions and all four children outlived it (the mid-turn idle
// reaper is guarded off too), so the cap refused a new create while NAMING
// the closed keys with advice ("session_close one") that could not work --
// four hung turns wedged the backend until a bridge restart. The antigravity
// tests pin that backend half (closeConversation: the bounded escalation, the
// cancel-is-the-verdict mid-turn rule, the cap freed and the refusal list
// clean); the other backends are pinned with what exists on every branch:
// zcode's close must be a REAL session/close on the runtime carrying the raw
// id (the request log's record), and mock's close must actually stop a
// mid-flight streamed turn (the timers its cancel()/closeConversation() clear
// are its live in-flight state). Codex's close stays a deliberate no-op --
// pinned so "safe on every backend" stays true. All of it runs against
// test/fixtures/fake-agy.mjs and fake-zcode-app-server.mjs (zero
// credentials, zero quota). The wiring itself -- index.js's sessionClose
// actually CALLING closeConversation -- is e2e-backend-lifecycle.mjs
// scenario 12, which is where the original gap lived. index.js exports
// nothing and cannot be imported without booting (the repo's standing
// policy), so these exercise the backends directly.
//
// Run: node --test test/session-close.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AntigravityBackend } from '../bridge/backends/antigravityBackend.js';
import { ZcodeBackend } from '../bridge/backends/zcodeBackend.js';
import { CodexBackend } from '../bridge/backends/codexBackend.js';
import { MockBackend } from '../bridge/backends/mockBackend.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGY_FIXTURE = path.join(HERE, 'fixtures', 'fake-agy.mjs');
const ZCODE_FIXTURE = path.join(HERE, 'fixtures', 'fake-zcode-app-server.mjs');

function tmp(name) {
  return mkdtempSync(path.join(tmpdir(), `session-close-${name}-`));
}

// An antigravity backend against the fixture, with close-escalation knobs
// the tests can afford, REGISTERED AGAINST THE TEST so cleanup cannot be
// skipped (a leaked live fixture child holds the test runner open).
function makeBackend(t, dir, extra = {}) {
  process.env.FIXTURE_AGY_STATE = path.join(dir, 'state');
  const backend = new AntigravityBackend({
    agyBin: AGY_FIXTURE,
    agyHome: path.join(dir, 'home'),
    cwd: dir,
    ...extra,
  });
  const events = [];
  const reaps = [];
  backend.on('event', (e) => events.push(e));
  backend.on('reap', (line) => reaps.push(line));
  t.after(async () => {
    await backend.stop();
    clearFixtureEnv();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, events, reaps };
}

function clearFixtureEnv() {
  for (const k of ['FIXTURE_AGY_STATE', 'FIXTURE_AGY_MARKER_LOG', 'FIXTURE_AGY_SLOW_MS', 'FIXTURE_AGY_STUBBORN', 'FIXTURE_ZCODE_LOG']) delete process.env[k];
}

async function waitFor(fn, what, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionEvents = (events) => events.filter((e) => e.method === 'session/event');
const turnStarted = (events) => events.filter((e) => e.method === 'v4/telemetry/event' && e.params.kind === 'turn.started');
const turnTerminal = (events) => events.filter((e) => e.method === 'v4/telemetry/event' && e.params.kind === 'turn.terminal');

test('session_close on a BUSY session: the child dies within the escalation bound, the cap is freed, the turn ends failed', async (t) => {
  const dir = tmp('busy');
  process.env.FIXTURE_AGY_SLOW_MS = '30000'; // the turn would outlive the test: only the close can end it
  process.env.FIXTURE_AGY_STUBBORN = '1'; // ignore EOF and TERM: the FULL escalation (through SIGKILL) is required
  const eofGrace = 400;
  const termGrace = 400;
  const { backend, events } = makeBackend(t, dir, {
    maxProcs: 1, // the tightest cap: this session IS the cap
    idleCloseMs: 0, // no reaper: the close is the only closer here (the mid-turn guard would block it anyway)
    closeEofGraceMs: eofGrace,
    closeTermGraceMs: termGrace,
  });
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  await backend.sendMessage(sessionId, 'AGY-SLOW');
  await waitFor(() => turnStarted(events).length >= 1, 'the slow turn to start');
  assert.equal(backend.procSnapshot().live, 1, 'the child is live mid-turn');

  // At cap 1 with the only child busy, a new create is refused -- the wedge
  // the finding measured, in its one-session form.
  await assert.rejects(() => backend.createConversation({ workspaceDir: dir }), /sessions busy \(cap 1\)/);

  // THE FIX: closeConversation runs the bounded escalation. The verdict is
  // recorded synchronously (cancel wins over any envelope that races the
  // teardown), the cap frees the INSTANT the close starts -- a new create at
  // cap 1 succeeds while the old child is still mid-escalation -- and the
  // child process itself is gone within eof+term+KILL. The turn ends failed
  // instead of hanging forever.
  const rawId = sessionId.slice('antigravity:'.length);
  const pid = backend._sessions.get(rawId).client.proc.pid;
  const pidGone = () => {
    try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
  };
  const p = backend.closeConversation(sessionId);
  assert.equal(backend._sessions.get(rawId).cancelPending, true, 'the cancel is the verdict from the close instant');
  const fresh = await backend.createConversation({ workspaceDir: dir });
  assert.match(fresh.sessionId, /^antigravity:/, 'the freed slot admits a new create at once');
  const t0 = Date.now();
  await waitFor(pidGone, 'the busy child process to die', eofGrace + termGrace + 5_000);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed <= eofGrace + termGrace + 3_000, `child died within the escalation bound (took ${elapsed}ms, bound ${eofGrace + termGrace}ms)`);
  await p;

  const failed = turnTerminal(events).at(-1);
  assert.equal(failed?.params?.status, 'failed', `the mid-turn close failed the turn: ${JSON.stringify(turnTerminal(events))}`);
  assert.equal(backend.procSnapshot().live, 1, 'exactly the new child is live');
});

test('session_close on an IDLE session: the child is released at once, no turn terminal, no reap line', async (t) => {
  const dir = tmp('idle');
  const { backend, events, reaps } = makeBackend(t, dir, { maxProcs: 4, idleCloseMs: 0, closeEofGraceMs: 300, closeTermGraceMs: 300 });
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  assert.equal(backend.procSnapshot().live, 1);

  await backend.closeConversation(sessionId);
  await waitFor(() => backend.procSnapshot().live === 0, 'the idle child to die at once', 3_000);
  assert.equal(turnTerminal(events).length, 0, 'no turn ever ran, so no terminal');
  assert.equal(reaps.length, 0, 'a caller-requested close is not a reap (no log line)');
  // Closing an unknown session id resolves quietly -- safe to call best-
  // effort from any close path without pre-checking the registry.
  await backend.closeConversation('antigravity:never-existed');
});

test('the busy refusal never lists a closed key', async (t) => {
  const dir = tmp('refusal');
  process.env.FIXTURE_AGY_SLOW_MS = '30000';
  const keyMap = new Map(); // sessionId -> MCP key, the resolver the refusal must speak
  const { backend, events } = makeBackend(t, dir, {
    maxProcs: 2,
    idleCloseMs: 0,
    closeEofGraceMs: 300,
    closeTermGraceMs: 300,
    sessionKeyOf: (sid) => keyMap.get(sid) ?? null,
  });
  const s1 = await backend.createConversation({ workspaceDir: dir });
  keyMap.set(s1.sessionId, 'closed-one');
  const s2 = await backend.createConversation({ workspaceDir: dir });
  keyMap.set(s2.sessionId, 'busy-b');
  await backend.sendMessage(s1.sessionId, 'AGY-SLOW');
  await backend.sendMessage(s2.sessionId, 'AGY-SLOW');
  await waitFor(() => turnStarted(events).length >= 2, 'both turns started');

  // Close the first BUSY session: its child must go and its slot must free.
  await backend.closeConversation(s1.sessionId);
  await waitFor(() => backend.procSnapshot().live === 1, 'the closed session left the live set', 5_000);

  // The freed slot admits a third session; make it busy too, so the cap is
  // full again -- now with the closed session's registry entry still around
  // (it is retained for a possible respawn) but its child long dead.
  const s3 = await backend.createConversation({ workspaceDir: dir });
  keyMap.set(s3.sessionId, 'busy-c');
  await backend.sendMessage(s3.sessionId, 'AGY-SLOW');
  await waitFor(() => turnStarted(events).length >= 3, 'the third turn started');

  await assert.rejects(
    () => backend.createConversation({ workspaceDir: dir }),
    (e) => {
      // Exactly the finding's shape: a refusal at the cap -- and it must
      // speak only LIVE sessions. The closed key is nowhere in it, under
      // either of its names.
      assert.match(e.message, /^antigravity: 2 sessions busy \(cap 2\): busy-b \S+, busy-c \S+; retry or session_close one$/);
      assert.ok(!e.message.includes('closed-one'), `refusal must not name the closed key: ${e.message}`);
      assert.ok(!e.message.includes(s1.sessionId), `refusal must not name the closed session id: ${e.message}`);
      return true;
    },
  );
});

test("the zcode backend's close is a real session/close on the runtime, carrying the raw session id", async (t) => {
  const dir = tmp('zcode');
  const reqLog = path.join(dir, 'requests.jsonl');
  process.env.FIXTURE_ZCODE_LOG = reqLog; // ZcodeClient spawns with ...process.env, so the fixture inherits this
  const backend = new ZcodeBackend({ nodeBin: process.execPath, zcodeBin: ZCODE_FIXTURE, cwd: dir });
  t.after(async () => {
    await backend.stop();
    clearFixtureEnv();
    rmSync(dir, { recursive: true, force: true });
  });
  await backend.start();
  const { sessionId } = await backend.createConversation({ workspaceDir: dir, workspaceKey: 'tg-topic-test', model: 'zai/glm-5.3-flash', mode: 'yolo' });

  await backend.closeConversation(sessionId);

  const lines = waitFor(
    () => (existsSync(reqLog) ? readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    'the session/close request to reach the runtime',
  );
  const close = (await lines).find((r) => r.method === 'session/close');
  assert.ok(close, `a session/close request was logged: ${JSON.stringify(lines)}`);
  assert.equal(close.params.sessionId, sessionId.slice('zcode:'.length), 'the close names the raw session id');
});

test('a mid-turn closeConversation on mock stops the streamed turn: nothing further is emitted, and the close of an unknown id resolves', async (t) => {
  const dir = tmp('mock');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Enough chunks at a long enough spacing that the turn would emit for
  // ~4s: only the close can end it inside this test.
  const backend = new MockBackend({ streamChunks: 100, streamIntervalMs: 40 });
  const events = [];
  backend.on('event', (e) => events.push(e));
  const { sessionId } = await backend.createConversation({});

  await backend.sendMessage(sessionId, 'a prompt long enough to stream across one hundred mock chunks without empty trailing deltas');
  await waitFor(() => turnStarted(events).length >= 1, 'the streamed turn to start');
  await waitFor(() => sessionEvents(events).length >= 3, 'the stream to be mid-flight');

  await backend.closeConversation(sessionId);
  const atClose = events.length;
  await sleep(500); // 12+ stream intervals: a mutator that leaves the timers pending fails here loudly
  assert.equal(events.length, atClose, `nothing may be emitted after the close: ${JSON.stringify(events.slice(atClose))}`);
  assert.equal(turnTerminal(events).length, 0, 'a closed turn has no terminal -- the cancel is the verdict');

  // Closing an unknown session id resolves quietly -- safe to call best-
  // effort from any close path without pre-checking anything.
  await backend.closeConversation('mock:never-existed');
});

test("closeConversation is safe on codex: resolves without touching any child (the deliberate no-op)", async (t) => {
  const dir = tmp('codex');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Constructed but never started: closeConversation must not need a live
  // subprocess (codex's close is a DELIBERATE no-op -- an idle thread costs
  // nothing and thread/archive's effect on resumability is unverified).
  const codex = new CodexBackend({ codexBin: '/nonexistent/codex', codexHome: dir, cwd: dir, autoApprovePermissions: true });
  await codex.closeConversation('codex:any-thread');
});
