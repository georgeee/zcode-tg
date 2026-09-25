// Tests for close-as-release (ported 2026-09-25 from ztg-status b0ef7a8,
// adapted to THIS branch's backends): every close path -- MCP session_close,
// the relay-synthesized forum_topic_deleted -- must release the session
// through the backend's closeConversation, not just mark the topic. There is
// no antigravity backend on feat/single-group (no AGY_MAX_PROCS cap to
// wedge, no child-per-session escalation to watch), so the backend half is
// pinned with what exists here: zcode's close must be a REAL session/close
// on the runtime carrying the raw id (the request log's record), and mock's
// close must actually stop a mid-flight streamed turn (the timers its
// cancel()/closeConversation() clear are this branch's live in-flight
// state). Codex's close stays a deliberate no-op -- pinned so "safe on every
// backend" stays true. The bridge wiring itself -- index.js's sessionClose
// and the relay topic-delete handler actually CALLING releaseSessionForKey
// -- is e2e-backend-lifecycle.mjs scenario 12, which is where the original
// gap lived. index.js exports nothing and cannot be imported without
// booting (the repo's standing policy), so these exercise the backends
// directly.
//
// Run: node --test test/session-close.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZcodeBackend } from '../bridge/backends/zcodeBackend.js';
import { CodexBackend } from '../bridge/backends/codexBackend.js';
import { MockBackend } from '../bridge/backends/mockBackend.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZCODE_FIXTURE = path.join(HERE, 'fixtures', 'fake-zcode-app-server.mjs');

function tmp(name) {
  return mkdtempSync(path.join(tmpdir(), `session-close-${name}-`));
}

function clearFixtureEnv() {
  for (const k of ['FIXTURE_ZCODE_LOG']) delete process.env[k];
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
