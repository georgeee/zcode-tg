// Tests for the agy process GC (2026-09-24): the idle reaper (C1), the
// creator tie (C2), the process cap (C3), shutdown and the /proc orphan
// sweep (C4), the proc snapshot (C6), and the MCP connection-id seam the
// creator tie hangs on. Runs against test/fixtures/fake-agy.mjs (zero
// credentials, zero quota). Every timer here is a real number of
// milliseconds -- production's minutes live in index.js's cfg, these tests
// use constructor overrides.
//
// Run: node --test test/antigravity-gc.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpGateway } from '../bridge/mcp.js';
import { AntigravityBackend } from '../bridge/backends/antigravityBackend.js';
import { reapOrphanAgyChildren } from '../bridge/agyProcesses.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-agy.mjs');

function tmp(name) {
  return mkdtempSync(path.join(tmpdir(), `agy-gc-${name}-`));
}

// A backend wired against the fixture, with GC knobs the tests can afford,
// REGISTERED AGAINST THE TEST so cleanup cannot be skipped: stop() is
// bounded (stdin EOF, SIGTERM, SIGKILL), and without it a test failing
// mid-body would leak live fixture children whose stdio pipes hold the test
// runner open forever. The fixture's spawn log (one JSON line per spawn:
// {pid, argv, at}) and its state dir ride through the environment.
function makeBackend(t, dir, extra = {}) {
  process.env.FIXTURE_AGY_STATE = path.join(dir, 'state');
  const backend = new AntigravityBackend({
    agyBin: FIXTURE,
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

function setMarkerLog(dir) {
  const markerLog = path.join(dir, 'spawns.jsonl');
  process.env.FIXTURE_AGY_MARKER_LOG = markerLog;
  return markerLog;
}

function clearFixtureEnv() {
  for (const k of ['FIXTURE_AGY_STATE', 'FIXTURE_AGY_MARKER_LOG', 'FIXTURE_AGY_SLOW_MS', 'FIXTURE_AGY_STUBBORN']) delete process.env[k];
}

function spawnLog(markerLog) {
  return readFileSync(markerLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
const terminals = (events) => events.filter((e) => e.method === 'v4/telemetry/event' && e.params.kind === 'turn.terminal');
const turnStarted = (events) => events.filter((e) => e.method === 'v4/telemetry/event' && e.params.kind === 'turn.started');

// Runs one turn and waits for ITS terminal.
async function runTurn(backend, events, sessionId, text) {
  const before = terminals(events).length;
  await backend.sendMessage(sessionId, text);
  return waitFor(() => terminals(events).slice(before)[0], `turn.terminal for "${text}"`);
}

// The final result payload of a turn (the {response} shape).
const finalPayload = (events, terminal) =>
  events
    .filter((e) => e.method === 'session/event' && e.params.turnId === terminal.params.turnId && e.params.payload.kind === 'result')
    .at(-1)?.params.payload;

test('C1 idle reap: child closed after the idle limit, next message respawn-resumes the SAME conversation', async (t) => {
  const dir = tmp('idle');
  const markerLog = setMarkerLog(dir);
  const { backend, events, reaps } = makeBackend(t, dir, { idleCloseMs: 150, maxProcs: 8, closeEofGraceMs: 300, closeTermGraceMs: 300 });
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });

  // One real turn so the conversation carries state worth resuming, plus a
  // C6 snapshot while the child is live.
  const first = await runTurn(backend, events, sessionId, 'the password is NITRO');
  assert.equal(first.params.status, 'success');
  assert.equal(spawnLog(markerLog).length, 1, 'one spawn so far');
  const snap = backend.procSnapshot();
  assert.equal(snap.live, 1);
  assert.ok(snap.totalRssBytes > 0, `live child reports RSS (got ${snap.totalRssBytes})`);

  // The reaper closes the child, and says so in exactly the reap format.
  const reap = await waitFor(() => reaps.find((l) => l.includes('reason=idle')), 'idle reap line');
  assert.equal(reap, `reap key=${sessionId} idle=0m reason=idle`);
  await waitFor(() => backend.procSnapshot().live === 0, 'child gone after reap');

  // The next message respawn-resumes with --conversation <same id>, and the
  // turn history survived the reap (the fixture echoes its first turn back).
  const second = await runTurn(backend, events, sessionId, 'RESUME-CHECK');
  assert.equal(second.params.status, 'success');
  assert.match(finalPayload(events, second).response, /FIRST-WAS: the password is NITRO/);
  const spawns = spawnLog(markerLog);
  assert.equal(spawns.length, 2, 'the respawn is the second spawn');
  const convId = sessionId.slice('antigravity:'.length);
  const resumeArgv = spawns[1].argv;
  assert.ok(
    resumeArgv.includes('--conversation') && resumeArgv[resumeArgv.indexOf('--conversation') + 1] === convId,
    `respawn argv carries --conversation ${convId}: ${resumeArgv.join(' ')}`,
  );
  assert.equal(backend.procSnapshot().live, 1);
});

test('C1 the mid-turn guard: a session with a turn in flight is never reaped', async (t) => {
  const dir = tmp('midturn');
  const { backend, events, reaps } = makeBackend(t, dir, { idleCloseMs: 120, maxProcs: 8 });
  process.env.FIXTURE_AGY_SLOW_MS = '1200'; // the turn outlasts the idle limit several times over
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  await backend.sendMessage(sessionId, 'AGY-SLOW');
  await waitFor(() => turnStarted(events).length >= 1, 'turn.started');

  // Several reaper ticks' worth of idle time pass while the turn runs.
  await sleep(600);
  assert.equal(backend.procSnapshot().live, 1, 'child still alive mid-turn');
  assert.equal(reaps.length, 0, 'no reap mid-turn');

  // The turn finishes normally: the child lives on, the idle clock starts,
  // and the SAME reaper now reaps it -- proving only the turn guards.
  await waitFor(() => terminals(events).length >= 1, 'slow turn terminal');
  await waitFor(() => reaps.some((l) => l.includes('reason=idle')), 'idle reap after turn end');
  await waitFor(() => backend.procSnapshot().live === 0, 'child gone after the turn ended');
});

test('C1 idleCloseMs=0 disables the reaper', async (t) => {
  const dir = tmp('disabled');
  const { backend, reaps } = makeBackend(t, dir, { idleCloseMs: 0, maxProcs: 8 });
  await backend.createConversation({ workspaceDir: dir });
  await sleep(500); // several ticks' worth if a reaper were armed
  assert.equal(backend.procSnapshot().live, 1);
  assert.equal(reaps.length, 0);
});

test('C3 cap: evicts the least-recently-used IDLE child and never exceeds the cap at the process level', async (t) => {
  const dir = tmp('cap');
  const markerLog = setMarkerLog(dir);
  process.env.FIXTURE_AGY_STUBBORN = '1'; // the victim ignores EOF and TERM: only the KILL stage ends it
  const keyMap = new Map(); // sessionId -> MCP key, the resolver the logs/errors must speak
  const { backend, reaps } = makeBackend(t, dir, {
    maxProcs: 2,
    idleCloseMs: 0, // no reaper: the cap is the only closer here
    closeEofGraceMs: 120,
    closeTermGraceMs: 120,
    sessionKeyOf: (sid) => keyMap.get(sid) ?? null,
  });
  const s1 = await backend.createConversation({ workspaceDir: dir });
  keyMap.set(s1.sessionId, 'key-one');
  const s2 = await backend.createConversation({ workspaceDir: dir });
  assert.equal(backend.procSnapshot().live, 2);

  // At the cap, the LRU idle child (s1, spawned first, never used since) is
  // evicted -- and the new child only spawns once it is truly dead.
  const s3 = await backend.createConversation({ workspaceDir: dir });
  const reap = await waitFor(() => reaps.find((l) => l.includes('reason=cap')), 'cap eviction reap line');
  assert.equal(reap, 'reap key=key-one idle=0m reason=cap');
  const rawId1 = s1.sessionId.slice('antigravity:'.length);
  const victim = backend._sessions.get(rawId1);
  assert.equal(victim.client.exited, true, 'victim child gone');
  assert.equal(victim.client.exitInfo.signal, 'SIGKILL', 'a child ignoring EOF+TERM reaches the KILL stage');
  assert.equal(backend.procSnapshot().live, 2, 'cap held: evicted victim replaced, not exceeded');
  const spawns = spawnLog(markerLog);
  assert.equal(spawns.length, 3);
  assert.ok(!spawns[2].argv.includes('--conversation'), 'the third create is a fresh conversation');
  assert.ok(
    spawns[2].at >= victim.lastExitAt,
    `new child spawned only after the victim exited (spawn at ${spawns[2].at}, victim exit at ${victim.lastExitAt})`,
  );
  assert.ok(!reaps.some((l) => l.includes(`key=${s2.sessionId}`)), 'the more recently used child was kept');
});

test('C3 cap: all children mid-turn -> refusal naming the busy keys and their turn ages', async (t) => {
  const dir = tmp('refusal');
  process.env.FIXTURE_AGY_SLOW_MS = '30000';
  const keyMap = new Map();
  const { backend, events } = makeBackend(t, dir, {
    maxProcs: 2,
    idleCloseMs: 0,
    sessionKeyOf: (sid) => keyMap.get(sid) ?? null,
  });
  const s1 = await backend.createConversation({ workspaceDir: dir });
  const s2 = await backend.createConversation({ workspaceDir: dir });
  keyMap.set(s1.sessionId, 'busy-a');
  keyMap.set(s2.sessionId, 'busy-b');
  await backend.sendMessage(s1.sessionId, 'AGY-SLOW');
  await backend.sendMessage(s2.sessionId, 'AGY-SLOW');
  await waitFor(() => turnStarted(events).length >= 2, 'both turns started');

  await assert.rejects(
    () => backend.createConversation({ workspaceDir: dir }),
    (e) => {
      assert.match(e.message, /^antigravity: 2 sessions busy \(cap 2\): busy-a \S+, busy-b \S+; retry or session_close one$/);
      return true;
    },
  );

  // Room again once the turns are gone (cancel SIGTERMs mid-turn; the
  // fixture answers with a structured interrupted result and exits).
  await backend.cancel(s1.sessionId);
  await backend.cancel(s2.sessionId);
  await waitFor(() => backend.procSnapshot().live === 0, 'both cancelled children gone');
  const s3 = await backend.createConversation({ workspaceDir: dir });
  assert.match(s3.sessionId, /^antigravity:/);
});

test('C2 creator tie: an idle session closes when its creator disconnects; a busy one closes right after its turn', async (t) => {
  const dir = tmp('creator');
  const { backend, reaps } = makeBackend(t, dir, { maxProcs: 8, idleCloseMs: 0 });

  // IDLE: closes the moment the creator connection is gone.
  const s1 = await backend.createConversation({ workspaceDir: dir });
  backend.noteSessionCreator(s1.sessionId, 101);
  backend.creatorDisconnected(101);
  await waitFor(() => backend.procSnapshot().live === 0, 'idle session closed on creator disconnect');
  assert.ok(reaps.some((l) => l === `reap key=${s1.sessionId} idle=0m reason=creator-gone`), reaps.join(' | '));

  // An unknown connection id touches nothing.
  const before = reaps.length;
  backend.creatorDisconnected(999);
  assert.equal(reaps.length, before);

  // BUSY: survives the creator's disconnect, closes when the turn ends.
  process.env.FIXTURE_AGY_SLOW_MS = '400';
  const s2 = await backend.createConversation({ workspaceDir: dir });
  backend.noteSessionCreator(s2.sessionId, 202);
  await backend.sendMessage(s2.sessionId, 'AGY-SLOW');
  backend.creatorDisconnected(202);
  await sleep(100); // well inside the turn
  assert.equal(backend.procSnapshot().live, 1, 'busy session not killed under the creator');
  await waitFor(() => backend.procSnapshot().live === 0, 'busy session closed when its turn ended');
  assert.ok(reaps.some((l) => l === `reap key=${s2.sessionId} idle=0m reason=creator-gone`), reaps.join(' | '));
});

test('C4 orphan sweep: kills a marker-carrying orphan whose parent is gone, leaves an unmarked one and our own child alone', async (t) => {
  const dir = tmp('orphan');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mkOrphan = (marked) =>
    new Promise((resolve, reject) => {
      const setEnv = marked ? 'CAGE_AGY_BRIDGE=gctestmarker4567 ' : '';
      const sh = spawn('sh', ['-c', `${setEnv}exec sleep 30 </dev/null >/dev/null 2>&1 & echo $!`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      sh.stdout.on('data', (c) => (out += c));
      sh.on('exit', () => resolve(Number(out.trim()))); // sh exits; the sleep reparents
      sh.on('error', reject);
    });
  const markedOrphanPid = await mkOrphan(true);
  const unmarkedOrphanPid = await mkOrphan(false);
  // A marked process that is OUR child: the sweep must spare it.
  const ownChild = spawn('sleep', ['30'], { stdio: 'ignore', env: { ...process.env, CAGE_AGY_BRIDGE: 'gctestmarker4567' } });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  t.after(() => {
    for (const pid of [markedOrphanPid, unmarkedOrphanPid, ownChild.pid]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });
  assert.ok(Number.isInteger(markedOrphanPid) && markedOrphanPid > 0, 'marked orphan launched');
  assert.ok(Number.isInteger(unmarkedOrphanPid) && unmarkedOrphanPid > 0, 'unmarked orphan launched');
  const killed = await reapOrphanAgyChildren({
    marker: 'gctestmarker4567',
    termGraceMs: 300,
    log: () => {},
  });
  assert.ok(killed.includes(markedOrphanPid), `marked orphan swept: ${killed}`);
  await waitFor(() => !alive(markedOrphanPid), 'marked orphan dead');
  assert.equal(alive(unmarkedOrphanPid), true, 'unmarked orphan untouched');
  assert.equal(alive(ownChild.pid), true, 'our own live child untouched');
});

test('C4 shutdown: stop() leaves no child alive; one ignoring EOF+TERM is SIGKILLed inside the bound', async (t) => {
  const dir = tmp('shutdown');
  process.env.FIXTURE_AGY_STUBBORN = '1'; // neither EOF nor TERM ends these: only SIGKILL does
  const { backend } = makeBackend(t, dir, { maxProcs: 8, idleCloseMs: 0, closeEofGraceMs: 150, closeTermGraceMs: 150 });
  await backend.createConversation({ workspaceDir: dir });
  await backend.createConversation({ workspaceDir: dir });
  assert.equal(backend.procSnapshot().live, 2);
  const t0 = Date.now();
  await backend.stop();
  const elapsed = Date.now() - t0;
  assert.equal(backend.procSnapshot().live, 0, 'no child left alive');
  assert.ok(elapsed < 5000, `stop() returned inside the escalation bound (took ${elapsed}ms)`);
  for (const session of backend._sessions.values()) {
    assert.equal(session.client.exited, true);
    assert.equal(session.client.exitInfo.signal, 'SIGKILL');
  }
});

test('C4 the default escalation bound is within the 15s shutdown budget', () => {
  const backend = new AntigravityBackend({ agyBin: 'agy', agyHome: '/tmp/nonexistent-agy-home' });
  assert.ok(backend.closeEofGraceMs + backend.closeTermGraceMs <= 15_000, `${backend.closeEofGraceMs}+${backend.closeTermGraceMs} <= 15000`);
});

test('MCP connection ids: session_create sees the calling connection; its close fires connectionClosed once', async (t) => {
  const gw = createMcpGateway({ port: 0, log: () => {} });
  const closed = [];
  gw.wire({
    sessionCreate: async (name, _chatId, _backend, _model, connId) => ({ connId, name }),
    connectionClosed: (id) => closed.push(id),
  });
  await gw.ready;
  t.after(() => gw.close());
  const port = gw.address().port;
  // Connection: close so the server drops the TCP socket after the response
  // -- that close is the event under test.
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_create', arguments: { name: 'gc-check' } } });
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' } },
      resolve,
    );
    req.on('error', reject);
    req.end(body);
  });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(rpc.error, undefined, `no RPC error: ${JSON.stringify(rpc)}`);
  const inner = JSON.parse(rpc.result.content[0].text);
  assert.equal(typeof inner.connId, 'number', 'session_create received the connection id');
  await waitFor(() => closed.length >= 1, 'connectionClosed on socket close');
  assert.deepEqual(closed, [inner.connId]);
});
