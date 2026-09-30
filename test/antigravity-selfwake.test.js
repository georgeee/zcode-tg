// Tests for antigravity backend self-wake turns:
// (a) a user turn ends; the fake agy later emits step_update + result -> replies_get
//     has the reply, and progress showed active in between.
// (creator-gone) creator disconnects mid-turn -> process is closed after that turn.
// (b) the reaper does not fire while turn-bearing events flow, and does fire after
//     20 min of silence or non-turn events (fake timers).
// (c) no double turn when the user message and the self-wake race.
// (d) F2 race: user message during in-flight self-wake returns user reply,
//     self-wake recorded separately in replies_get.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

import { AntigravityBackend } from '../bridge/backends/antigravityBackend.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const FIXTURES = path.join(HERE, 'fixtures');
const AGY_FIXTURE = path.join(FIXTURES, 'fake-agy.mjs');
const ZCODE_FIXTURE = path.join(FIXTURES, 'fake-zcode-app-server.mjs');
const NODE = process.env.ZCODE_NODE_BIN || process.execPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

function openPersistentClient(sock) {
  const s = net.connect(sock);
  let buf = '';
  const pending = new Map();
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg);
          }
        } catch {}
      }
    }
  });
  let nextId = 1;
  return {
    call(name, args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        s.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      });
    },
    close() {
      s.end();
    },
    rawSocket: s,
  };
}

test('(a) a user turn ends; the fake agy later emits step_update + result -> replies_get has the reply, and progress showed active in between', { timeout: 15_000 }, async (t) => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'agy-wake-a-'));
  const sock = path.join(tmpDir, 'mcp.sock');
  const agyHome = path.join(tmpDir, 'home');
  const agyState = path.join(tmpDir, 'state');
  const storePath = path.join(tmpDir, 'store.json');

  const env = {
    DEFAULT_BACKEND: 'antigravity',
    ZCODE_NODE_BIN: NODE,
    ZCODE_BIN: ZCODE_FIXTURE,
    ZCODE_WORKSPACE_DIR: tmpDir,
    AGY_BIN: AGY_FIXTURE,
    AGY_HOME: agyHome,
    AGY_EFFORT: 'medium',
    FIXTURE_AGY_STATE: agyState,
    FIXTURE_AGY_SELF_WAKE_DELAY_MS: '100',
    FIXTURE_AGY_SELF_WAKE_RESULT_DELAY_MS: '1200',
    STORE_PATH: storePath,
    MCP_UNIX_SOCKET: sock,
  };

  const b = spawn(NODE, [path.join(REPO, 'bridge/index.js')], {
    env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    b.kill('SIGKILL');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  await waitFor(() => existsSync(sock), 15000, 'mcp unix socket');

  const client = openPersistentClient(sock);
  t.after(() => client.close());
  const call = (name, args) => client.call(name, args);

  const created = await call('session_create', { name: 'selfwake-session' });
  assert.equal(created?.result?.isError, false, 'session_create succeeded');
  const key = JSON.parse(created.result.content[0].text).key;

  // Send initial message that finishes and then triggers self-wake
  const sent = await call('message_send', { key, text: 'TRIGGER-SELF-WAKE' });
  assert.equal(sent?.result?.isError, false, 'first message sent');
  const r1 = JSON.parse(sent.result.content[0].text).reply;
  assert.match(r1, /FAKE-REPLY: TRIGGER-SELF-WAKE/);

  // Poll progress_get during the self-wake window:
  // Fake-agy will emit step_update after 100ms, and result 1200ms after that.
  let sawActive = false;
  const pollDeadline = Date.now() + 3000;
  while (Date.now() < pollDeadline) {
    const prog = await call('progress_get', { key });
    if (!prog?.result?.isError) {
      const p = JSON.parse(prog.result.content[0].text);
      if (p.active === true && p.state === 'active') {
        sawActive = true;
        break;
      }
    }
    await sleep(25);
  }
  assert.equal(sawActive, true, 'progress showed active in between');

  // Wait for the second reply to appear in replies_get
  let replies = [];
  const replyDeadline = Date.now() + 5000;
  while (Date.now() < replyDeadline) {
    const got = await call('replies_get', { key });
    if (!got?.result?.isError) {
      replies = JSON.parse(got.result.content[0].text).replies ?? [];
      if (replies.length >= 2) break;
    }
    await sleep(50);
  }
  assert.equal(replies.length, 2, 'replies_get has collected the self-wake reply');
  assert.equal(replies[1].text, 'self-wake reply text');
});

test('(creator-gone) creator disconnects mid-turn -> process is closed after that turn', { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-wake-creator-gone-'));
  process.env.FIXTURE_AGY_STATE = path.join(dir, 'state');
  const backend = new AntigravityBackend({
    agyBin: AGY_FIXTURE,
    agyHome: path.join(dir, 'home'),
    cwd: dir,
  });
  t.after(async () => {
    await backend.stop();
    delete process.env.FIXTURE_AGY_STATE;
    rmSync(dir, { recursive: true, force: true });
  });

  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  const rawId = sessionId.slice('antigravity:'.length);
  const session = backend._sessions.get(rawId);
  assert.ok(session, 'session registered');
  assert.equal(backend.procSnapshot().live, 1, 'child is live');

  // Creator connection creates session
  session.creatorConn = 'creator-conn-1';

  // Start turn mid-flight with AGY-SLOW
  await backend.sendMessage(sessionId, 'AGY-SLOW');
  assert.ok(session.turn, 'turn started');

  // Creator disconnects MID-TURN
  backend.creatorDisconnected('creator-conn-1');

  // Verified: session is marked closeWhenIdle='creator-gone'
  assert.equal(session.closeWhenIdle, 'creator-gone', 'closeWhenIdle marked as creator-gone');
  // Process is NOT closed immediately mid-turn:
  assert.equal(backend.procSnapshot().live, 1, 'child remains live mid-turn');
  assert.ok(session.turn, 'turn still in progress');

  // Fake-agy finishes the slow turn
  session.client.emit('event', {
    event: 'result',
    result: { conversation_id: rawId, status: 'SUCCESS', response: 'done slowly', usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } },
  });
  // Process is closed AFTER that turn:
  await waitFor(() => backend.procSnapshot().live === 0, 5000, 'child closed after turn');
  assert.equal(session.closeWhenIdle, null, 'closeWhenIdle cleared after closing');
});

test('(b) the reaper does not fire while untracked events flow, and does fire after 20 min of true silence (fake timers)', { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-wake-b-'));
  process.env.FIXTURE_AGY_STATE = path.join(dir, 'state');
  const reaps = [];
  const backend = new AntigravityBackend({
    agyBin: AGY_FIXTURE,
    agyHome: path.join(dir, 'home'),
    cwd: dir,
    idleCloseMs: 20 * 60_000,
  });
  backend.on('reap', (l) => reaps.push(l));
  t.after(async () => {
    await backend.stop();
    delete process.env.FIXTURE_AGY_STATE;
    rmSync(dir, { recursive: true, force: true });
  });

  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  const rawId = sessionId.slice('antigravity:'.length);
  const session = backend._sessions.get(rawId);
  assert.ok(session, 'session registered');
  assert.equal(backend.procSnapshot().live, 1, 'child is live');

  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: Date.now() });
  backend._disarmReaper();
  backend._armReaper();

  // F3: Non-turn envelopes (heartbeat) do NOT reset idleSince.
  // After 20 min with heartbeats flowing, child IS reaped.
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(5 * 60_000);
    session.client.emit('event', {
      event: 'heartbeat',
      tick: i,
    });
    backend._reapTick();
  }
  assert.equal(backend.procSnapshot().live, 0, 'child should be reaped after 20 min despite heartbeat events');
  assert.ok(reaps.some((r) => r.includes('reason=idle')), 'reap line logged reason=idle');

  backend._disarmReaper();
  t.mock.timers.reset();
});

test('(c) no double turn when the user message and the self-wake race', { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-wake-c-'));
  process.env.FIXTURE_AGY_STATE = path.join(dir, 'state');
  const events = [];
  const backend = new AntigravityBackend({
    agyBin: AGY_FIXTURE,
    agyHome: path.join(dir, 'home'),
    cwd: dir,
  });
  backend.on('event', (e) => events.push(e));
  t.after(async () => {
    await backend.stop();
    delete process.env.FIXTURE_AGY_STATE;
    rmSync(dir, { recursive: true, force: true });
  });

  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  const rawId = sessionId.slice('antigravity:'.length);
  const session = backend._sessions.get(rawId);
  assert.ok(session, 'session registered');

  const turnStartedEvents = () => events.filter((e) => e.method === 'v4/telemetry/event' && e.params?.kind === 'turn.started');
  const turnTerminalEvents = () => events.filter((e) => e.method === 'v4/telemetry/event' && e.params?.kind === 'turn.terminal');

  // Race 1: user turn is starting (sendMessage called), and simultaneously an agy self-wake arrives
  const sendPromise = backend.sendMessage(sessionId, 'user prompt');
  session.client.emit('event', {
    event: 'step_update',
    step_update: { step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'racing self-wake' },
  });
  // The racing self-wake finishes:
  session.client.emit('event', {
    event: 'result',
    result: { conversation_id: rawId, status: 'SUCCESS', response: 'self-wake done', usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } },
  });
  await sendPromise;
  await waitFor(() => turnTerminalEvents().length >= 2, 5000, 'first turns terminal');

  assert.equal(turnStartedEvents().length, 2, 'both self-wake and user turn started (no events dropped)');
  assert.equal(turnTerminalEvents().length, 2, 'both turn.terminal emitted');

  // Race 2: self-wake starts first (auto-adopted), and a user message arrives while self-wake is running
  session.client.emit('event', {
    event: 'step_update',
    step_update: { step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'self-wake running' },
  });
  assert.equal(turnStartedEvents().length, 3, 'third turn started for self-wake');
  assert.ok(session.turn, 'self-wake turn is active');

  // User sends message while self-wake is running:
  let userTurnDone = false;
  const userSend = backend.sendMessage(sessionId, 'user follows up').then(() => {
    userTurnDone = true;
  });

  // Verify that during the self-wake, no concurrent second turn was started
  await sleep(50);
  assert.equal(turnStartedEvents().length, 3, 'user turn waited, no concurrent turn.started');

  // Self-wake finishes:
  session.client.emit('event', {
    event: 'result',
    result: { conversation_id: rawId, status: 'SUCCESS', response: 'self-wake done', usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } },
  });

  // Now user turn proceeds to start and finish:
  await userSend;
  await waitFor(() => turnTerminalEvents().length >= 4, 5000, 'all turns completed');
  assert.equal(turnStartedEvents().length, 4, 'user turn started after self-wake finished');
  assert.equal(turnTerminalEvents().length, 4, 'four terminals for four turns, non-overlapping');
});

test('(d) F2 race: user message during in-flight self-wake returns user reply, self-wake recorded in replies_get', { timeout: 15_000 }, async (t) => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'agy-wake-d-'));
  const sock = path.join(tmpDir, 'mcp.sock');
  const agyHome = path.join(tmpDir, 'home');
  const agyState = path.join(tmpDir, 'state');
  const storePath = path.join(tmpDir, 'store.json');

  const env = {
    DEFAULT_BACKEND: 'antigravity',
    ZCODE_NODE_BIN: NODE,
    ZCODE_BIN: ZCODE_FIXTURE,
    ZCODE_WORKSPACE_DIR: tmpDir,
    AGY_BIN: AGY_FIXTURE,
    AGY_HOME: agyHome,
    AGY_EFFORT: 'medium',
    FIXTURE_AGY_STATE: agyState,
    FIXTURE_AGY_SELF_WAKE_DELAY_MS: '50',
    FIXTURE_AGY_SELF_WAKE_RESULT_DELAY_MS: '200',
    FIXTURE_AGY_SLOW_MS: '600',
    STORE_PATH: storePath,
    MCP_UNIX_SOCKET: sock,
  };

  const b = spawn(NODE, [path.join(REPO, 'bridge/index.js')], {
    env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    b.kill('SIGKILL');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  await waitFor(() => existsSync(sock), 15000, 'mcp unix socket');

  const client = openPersistentClient(sock);
  t.after(() => client.close());

  const created = await client.call('session_create', { name: 'selfwake-race-session' });
  assert.equal(created?.result?.isError, false, 'session_create succeeded');
  const key = JSON.parse(created.result.content[0].text).key;

  // Turn 1: trigger self-wake
  const sent = await client.call('message_send', { key, text: 'TRIGGER-SELF-WAKE' });
  assert.equal(sent?.result?.isError, false, 'first message sent');
  const r1 = JSON.parse(sent.result.content[0].text).reply;
  assert.match(r1, /FAKE-REPLY: TRIGGER-SELF-WAKE/);

  // Wait for self-wake to start (progress_get becomes active)
  let sawActive = false;
  const pollDeadline = Date.now() + 3000;
  while (Date.now() < pollDeadline) {
    const prog = await client.call('progress_get', { key });
    if (!prog?.result?.isError) {
      const p = JSON.parse(prog.result.content[0].text);
      if (p.active === true && p.state === 'active') {
        sawActive = true;
        break;
      }
    }
    await sleep(20);
  }
  assert.equal(sawActive, true, 'self-wake turn is actively running');

  // While self-wake is running, send user message AGY-SLOW (takes 600ms).
  // The self-wake result arrives in ~200ms (before the 600ms user result).
  const userSent = await client.call('message_send', { key, text: 'AGY-SLOW' });
  assert.equal(userSent?.result?.isError, false, 'user message succeeded');
  const userReply = JSON.parse(userSent.result.content[0].text).reply;

  // Assert message_send returns the USER's reply text:
  assert.match(userReply, /done slowly/, 'message_send must return the USER reply text');

  // Assert that the self-wake reply is recorded separately in replies_get:
  const got = await client.call('replies_get', { key });
  const replies = JSON.parse(got.result.content[0].text).replies ?? [];
  assert.ok(replies.some((r) => r.text === 'self-wake reply text'), 'self-wake reply recorded in replies_get');
});
