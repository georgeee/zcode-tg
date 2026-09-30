// Tests for antigravity backend self-wake turns:
// (a) a user turn ends; the fake agy later emits step_update + result -> replies_get
//     has the reply, and progress showed active in between.
// (b) the reaper doesn't fire while untracked events flow, and does fire after
//     20 min of true silence (fake timers).
// (c) no double turn when the user message and the self-wake race.

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
const NODE = process.env.ZCODE_NODE_BIN || '/home/cage-bare-exec/agy/agywakefix-20260930/bin/node';

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

function unixJsonRpc(sock, requests) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock);
    let buf = '';
    const lines = [];
    s.on('connect', () => {
      for (const r of requests) s.write(JSON.stringify(r) + '\n');
    });
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) lines.push(JSON.parse(line));
        if (lines.length === requests.length) {
          s.end();
          resolve(lines);
        }
      }
    });
    s.on('error', reject);
  });
}

test('(a) a user turn ends; the fake agy later emits step_update + result -> replies_get has the reply, and progress showed active in between', async (t) => {
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

  const call = (id, name, args) =>
    unixJsonRpc(sock, [{ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }]).then((ls) => ls[0]);

  const created = await call(1, 'session_create', { name: 'selfwake-session' });
  assert.equal(created?.result?.isError, false, 'session_create succeeded');
  const key = JSON.parse(created.result.content[0].text).key;

  // Send initial message that finishes and then triggers self-wake
  const sent = await call(2, 'message_send', { key, text: 'TRIGGER-SELF-WAKE' });
  assert.equal(sent?.result?.isError, false, 'first message sent');
  const r1 = JSON.parse(sent.result.content[0].text).reply;
  assert.match(r1, /FAKE-REPLY: TRIGGER-SELF-WAKE/);

  // Poll progress_get during the self-wake window:
  // Fake-agy will emit step_update after 100ms, and result 1200ms after that.
  let sawActive = false;
  const pollDeadline = Date.now() + 3000;
  while (Date.now() < pollDeadline) {
    const prog = await call(3, 'progress_get', { key });
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
    const got = await call(4, 'replies_get', { key });
    if (!got?.result?.isError) {
      replies = JSON.parse(got.result.content[0].text).replies ?? [];
      if (replies.length >= 2) break;
    }
    await sleep(50);
  }
  assert.equal(replies.length, 2, 'replies_get has collected the self-wake reply');
  assert.equal(replies[1].text, 'self-wake reply text');
});

test('(b) the reaper does not fire while untracked events flow, and does fire after 20 min of true silence (fake timers)', async (t) => {
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

  // Untracked events flow every 5 minutes for 30 minutes total (> 20 min idle limit).
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(5 * 60_000);
    session.client.emit('event', {
      event: 'heartbeat',
      tick: i,
    });
    backend._reapTick();
    assert.equal(backend.procSnapshot().live, 1, `child should stay alive at minute ${(i + 1) * 5} while untracked events flow`);
    assert.equal(reaps.length, 0, `reaper should not fire while events flow (at minute ${(i + 1) * 5})`);
  }

  // Now 20 minutes of true silence
  t.mock.timers.tick(20 * 60_000);
  backend._reapTick();
  assert.equal(backend.procSnapshot().live, 0, 'child is reaped after 20 min of silence');
  assert.ok(reaps.some((r) => r.includes('reason=idle')), 'reap line logged reason=idle');

  backend._disarmReaper();
  t.mock.timers.reset();
});

test('(c) no double turn when the user message and the self-wake race', async (t) => {
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
  await sendPromise;
  await waitFor(() => turnTerminalEvents().length >= 1, 5000, 'first turn terminal');

  assert.equal(turnStartedEvents().length, 1, 'exactly one turn.started emitted during race (no double turn)');
  assert.equal(turnTerminalEvents().length, 1, 'exactly one turn.terminal emitted');

  // Race 2: self-wake starts first (auto-adopted), and a user message arrives while self-wake is running
  session.client.emit('event', {
    event: 'step_update',
    step_update: { step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'self-wake running' },
  });
  assert.equal(turnStartedEvents().length, 2, 'second turn started for self-wake');
  assert.ok(session.turn, 'self-wake turn is active');

  // User sends message while self-wake is running:
  let userTurnDone = false;
  const userSend = backend.sendMessage(sessionId, 'user follows up').then(() => {
    userTurnDone = true;
  });

  // Verify that during the self-wake, no concurrent second turn was started
  await sleep(50);
  assert.equal(turnStartedEvents().length, 2, 'user turn waited, no concurrent turn.started');

  // Self-wake finishes:
  session.client.emit('event', {
    event: 'result',
    result: { conversation_id: rawId, status: 'SUCCESS', response: 'self-wake done', usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } },
  });

  // Now user turn proceeds to start and finish:
  await userSend;
  await waitFor(() => turnTerminalEvents().length >= 3, 5000, 'all turns completed');
  assert.equal(turnStartedEvents().length, 3, 'user turn started after self-wake finished');
  assert.equal(turnTerminalEvents().length, 3, 'three terminals for three turns, non-overlapping');
});
