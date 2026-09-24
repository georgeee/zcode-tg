// Tests for bridge/conversationStore.js -- the reader for agy's conversation
// SQLite store, the one place turns typed in the antigravity.google dashboard
// are visible (they never appear on agy's stream-json stdout -- MEASURED,
// work/antigravity/experiments/conversation-db-notes.md). The fixture .db is
// BUILT BY THE TEST with the real schema, seeded with the REAL row blobs
// copied read-only+immutable from the live conversation store (they contain
// only research test phrases: "Reply with exactly: LOBBY2-READY", "Say
// PHONE-TWO"), plus synthetic rows built in the same shape for the
// behavioural cases the live store cannot stage on demand.
//
// Asserted here: the dashboard turn surfaces exactly once (never duplicated
// across polls); turns our own stdin produced are never emitted (both the
// in-flight rule and the late-poll rule); the UA marker beats the in-flight
// rule; a missing .db degrades to a warning, not a crash; and the backend +
// MCP wiring carries {role, origin, text} through to the reply log.
//
// Run: nix shell nixpkgs#nodejs_22 -c node --test test/antigravity-conversation-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConversationWatcher,
  conversationDbPath,
  decodeStepRow,
  decodeStepTimestamp,
  pbFields,
} from '../bridge/conversationStore.js';
import { AntigravityBackend } from '../bridge/backends/antigravityBackend.js';
import { createMcpGateway } from '../bridge/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The live conversation store of the research session (read-only+immutable:
// the open itself was measured to create nothing beside the file).
const LIVE_DB =
  '/srv/agent-cage/cage-bare/agent/cage-bare/work/antigravity/scratch-home/.gemini/antigravity-cli/conversations/9d7330d6-ed77-4d15-9da1-37d6d3d99655.db';

function liveRows() {
  if (!existsSync(LIVE_DB)) return null;
  try {
    const db = new DatabaseSync(`file:${LIVE_DB}?mode=ro&immutable=1`);
    try {
      return db.prepare('SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx').all();
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// --- synthetic rows in the REAL shape (field numbers per the live store) ---

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

function field(num, bytes) {
  return [...varint((num << 3) | 2), ...varint(bytes.length), ...bytes];
}

function fieldVarint(num, n) {
  return [...varint((num << 3) | 0), ...varint(n)];
}

const utf8 = (s) => [...Buffer.from(s, 'utf8')];

// metadata: field 1 = protobuf Timestamp {1: seconds, 2: nanos}; optional
// field 37 = the browser User-Agent string (the dashboard marker).
function metaBytes(sec, nanos, userAgent) {
  const ts = [...fieldVarint(1, sec), ...fieldVarint(2, nanos)];
  const parts = [field(1, ts)];
  if (userAgent) parts.push(field(37, utf8(userAgent)));
  return Uint8Array.from(parts.flat());
}

// user payload: field 1 = step_type echo, field 19 submessage {2: text}
// (+ field 12's big context blob on real rows -- not needed to decode).
function userPayloadBytes(text) {
  const sub = field(2, utf8(text));
  return Uint8Array.from([...fieldVarint(1, 14), ...field(19, sub)]);
}

// model payload: field 1 = step_type echo, field 20 submessage {1: text}.
function modelPayloadBytes(text) {
  const sub = field(1, utf8(text));
  return Uint8Array.from([...fieldVarint(1, 15), ...field(20, sub)]);
}

function insertStep(db, idx, stepType, { sec = 1789958400, nanos = 0, userAgent = null, text = null }) {
  const payload = stepType === 14 ? userPayloadBytes(text ?? '') : modelPayloadBytes(text ?? '');
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)').run(
    idx,
    stepType,
    metaBytes(sec, nanos, userAgent),
    payload,
  );
}

const SCHEMA =
  'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, ' +
  'has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, ' +
  'task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, ' +
  'PRIMARY KEY (idx))';

// A fixture store: the real schema, seeded with the live store's REAL rows
// (when readable) and any extra rows the test asks for. Returns {dir, dbPath}.
function buildFixtureStore(name, seedLive = true, extraRows = []) {
  const dir = mkdtempSync(path.join(tmpdir(), `agy-store-${name}-`));
  const conversations = path.join(dir, '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(conversations, { recursive: true });
  const dbPath = path.join(conversations, 'fixture-conversation.db');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  let nextIdx = 0;
  if (seedLive) {
    const rows = liveRows();
    if (rows) {
      const ins = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(r.idx, r.step_type, r.status, r.metadata, r.step_payload);
      nextIdx = rows[rows.length - 1].idx + 1;
    }
  }
  for (const row of extraRows) {
    insertStep(db, row.idx ?? nextIdx++, row.stepType, row);
  }
  db.close();
  return { dir, dbPath, nextIdx };
}

function openForAppend(dbPath) {
  const db = new DatabaseSync(dbPath);
  return {
    insert: (idx, stepType, opts) => insertStep(db, idx, stepType, opts),
    close: () => db.close(),
  };
}

function watcherOn(dbPath, overrides = {}) {
  const turns = [];
  const stalled = [];
  const w = new ConversationWatcher({ dbPath, pollMs: 15, ...overrides });
  w.on('dashboard_turn', (t) => turns.push(t));
  w.on('stalled', (m) => stalled.push(m));
  return { w, turns, stalled };
}

// --- decoder facts against the REAL rows ---

test('decoder: the real dashboard row carries the UA marker, text and a Timestamp; the stdin row carries neither UA nor a guess', (t) => {
  const rows = liveRows();
  if (!rows) {
    t.skip('live conversation store not readable on this machine');
    return;
  }
  const decoded = rows.map((r) => decodeStepRow(r));
  const users = decoded.filter((d) => d.role === 'user');
  assert.ok(users.length >= 2, `two user rows in the live store (got ${users.length})`);
  // idx 0 was typed on stdin ("Reply with exactly: LOBBY2-READY"): no UA.
  assert.equal(users[0].dashboardMarker, false);
  assert.ok(users[0].text && users[0].text.includes('LOBBY2-READY'), `stdin text decoded: ${users[0].text}`);
  // The dashboard row says "Say PHONE-TWO" and carries the browser UA.
  const dash = users.find((u) => u.dashboardMarker);
  assert.ok(dash, 'a UA-marked user row exists');
  assert.ok(dash.text && dash.text.includes('PHONE-TWO'), `dashboard text decoded: ${dash.text}`);
  // Per-step Timestamps decode to plausible wall clocks (2026, before now).
  for (const d of decoded) {
    assert.ok(d.at instanceof Date && !Number.isNaN(d.at.getTime()), `timestamp decoded at idx=${d.idx}`);
    assert.ok(d.at.getUTCFullYear() === 2026, `timestamp is 2026 at idx=${d.idx}: ${d.at.toISOString()}`);
  }
  // The model rows decode as assistants with reply text.
  const assistants = decoded.filter((d) => d.role === 'assistant');
  assert.ok(assistants.length >= 2);
  for (const a of assistants) assert.ok(a.text && a.text.length > 0, `assistant text at idx=${a.idx}`);
  assert.equal(decoded.find((d) => d.idx === rows[0].idx).dashboardMarker, false);
});

test('decoder: malformed blobs return null/absent rather than throwing or guessing', () => {
  assert.equal(pbFields(new Uint8Array([0x0a, 0xff, 0x01])), null); // length runs past the end
  assert.equal(pbFields(new Uint8Array([0x07])), null); // wire type 7 (group end) alone
  assert.equal(pbFields('not bytes'), null);
  assert.equal(decodeStepTimestamp(new Uint8Array([0x0a, 0x02, 0x08, 0x01])).getTime(), 1000);
  assert.equal(decodeStepTimestamp(new Uint8Array([0x10, 0x01])), null); // no field 1 submessage
  // A user row whose payload lacks the text submessage: text null, never a throw.
  const bare = decodeStepRow({ idx: 9, step_type: 14, metadata: metaBytes(1, 2), step_payload: new Uint8Array([0x08, 0x0e]) });
  assert.equal(bare.text, null);
  assert.equal(bare.role, 'user');
  // Unknown step types are skipped by design.
  assert.equal(decodeStepRow({ idx: 10, step_type: 99, metadata: null, step_payload: null }), null);
});

// --- watcher behaviour on synthetic rows (deterministic pollOnce) ---

test('the dashboard turn surfaces exactly once -- never duplicated across polls', async () => {
  const { dbPath } = buildFixtureStore('once', false, [
    { stepType: 14, text: 'Say PHONE-TWO', userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36' },
    { stepType: 15, text: 'PHONE-TWO' },
  ]);
  const { w, turns } = watcherOn(dbPath, { startCursor: -1 });
  w.start();
  const first = await w.pollOnce();
  assert.equal(first.length, 2);
  assert.deepEqual(
    turns.map((t) => [t.role, t.origin, t.text]),
    [
      ['user', 'dashboard', 'Say PHONE-TWO'],
      ['assistant', 'dashboard', 'PHONE-TWO'],
    ],
  );
  assert.ok(turns[0].at.startsWith('2026-'), `timestamp carried as ISO: ${turns[0].at}`);
  // Three more polls (more than the polling loop would do while idle): silence.
  await w.pollOnce();
  await w.pollOnce();
  await w.pollOnce();
  assert.equal(turns.length, 2, 'no duplicates across polls');
  w.stop();
});

test('turns our stdin produced are never emitted: rows landing while our turn is in flight are skipped as a pair', async () => {
  const { dbPath } = buildFixtureStore('ours', false);
  let inFlight = false;
  const { w, turns } = watcherOn(dbPath, { turnInFlight: () => inFlight, startCursor: -1 });
  w.start();
  await w.pollOnce(); // establish cursor on the empty store
  const app = openForAppend(dbPath);
  inFlight = true; // we are mid-turn: the user row and its response both land now
  app.insert(0, 14, { text: 'PIN-ONE' });
  app.insert(1, 15, { text: 'PIN-ONE-REPLY' });
  assert.deepEqual(await w.pollOnce(), [], 'both rows skipped while the turn is in flight');
  assert.equal(turns.length, 0);
  // The response row landing in a LATER poll is still suppressed (the pair
  // was classified ours when its user row was).
  inFlight = false;
  app.insert(2, 15, { text: 'late half, never emitted' });
  assert.deepEqual(await w.pollOnce(), []);
  assert.equal(turns.length, 0);
  app.close();
  w.stop();
});

test('the late-poll race is closed: our row polled after the turn finished is still recognised as ours', async () => {
  const { dbPath } = buildFixtureStore('latepoll', false);
  const own = new Set();
  const { w, turns } = watcherOn(dbPath, { turnInFlight: () => false, ownTurnUserTexts: () => own, startCursor: -1 });
  w.start();
  await w.pollOnce();
  const app = openForAppend(dbPath);
  // The turn RAN (so ownTurnUserTexts holds its text) and FINISHED before
  // this poll -- the naive no-turn-in-flight rule would emit it.
  own.add('PIN-TWO');
  app.insert(0, 14, { text: 'PIN-TWO' });
  app.insert(1, 15, { text: 'PIN-TWO-REPLY' });
  assert.deepEqual(await w.pollOnce(), []);
  assert.equal(turns.length, 0, 'our late-polled turn is not re-emitted as dashboard-origin');
  // And George's real dashboard turn right after it still surfaces: the
  // UA marker, not the text set, decides for his rows.
  app.insert(2, 14, { text: 'PIN-TWO', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/154.0 Safari/537.36' });
  app.insert(3, 15, { text: 'PIN-TWO-REPLY-2' });
  const emitted = await w.pollOnce();
  assert.deepEqual(emitted.map((t) => t.text), ['PIN-TWO', 'PIN-TWO-REPLY-2']);
  app.close();
  w.stop();
});

test('the UA marker wins over an in-flight turn of ours: a dashboard turn mid-our-turn still surfaces', async () => {
  const { dbPath } = buildFixtureStore('midturn', false);
  const { w, turns } = watcherOn(dbPath, { turnInFlight: () => true, startCursor: -1 });
  w.start();
  await w.pollOnce();
  const app = openForAppend(dbPath);
  app.insert(0, 14, { text: 'Say PHONE-TWO', userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Chrome/154.0.0.0 Mobile Safari/537.36' });
  app.insert(1, 15, { text: 'PHONE-TWO' });
  const emitted = await w.pollOnce();
  assert.deepEqual(emitted.map((t) => t.role), ['user', 'assistant']);
  assert.ok(turns.every((t) => t.origin === 'dashboard'));
  app.close();
  w.stop();
});

test('a missing .db degrades gracefully: warned once, keeps polling, never throws', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-store-missing-'));
  const { w, turns, stalled } = watcherOn(path.join(dir, 'nope', 'absent.db'), { startCursor: -1 });
  w.start();
  await w.pollOnce();
  await w.pollOnce();
  await w.pollOnce();
  assert.equal(turns.length, 0);
  assert.equal(stalled.length, 1, `warned exactly once (got ${stalled.length})`);
  // The store appearing later is picked up from a TAIL cursor: history
  // written before the watcher saw the store is never replayed.
  const conversations = path.join(dir, 'gemini-does-not-exist-yet');
  mkdirSync(path.join(dir, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
  const db = new DatabaseSync(path.join(dir, '.gemini', 'antigravity-cli', 'conversations', 'absent.db'));
  db.exec(SCHEMA);
  insertStep(db, 0, 14, { text: 'historic', userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/154.0' });
  insertStep(db, 1, 15, { text: 'historic-reply' });
  db.close();
  const emitted = await w.pollOnce();
  assert.deepEqual(emitted, [], 'history is not replayed when the store appears');
  w.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('the real polling loop delivers (not just pollOnce): a row inserted after start() arrives on its own', async () => {
  const { dbPath } = buildFixtureStore('loop', false);
  const { w, turns } = watcherOn(dbPath, { pollMs: 15, startCursor: -1 });
  w.start();
  await new Promise((r) => setTimeout(r, 40));
  const app = openForAppend(dbPath);
  app.insert(0, 14, { text: 'LOOP-CHECK', userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/154.0' });
  app.insert(1, 15, { text: 'LOOP-REPLY' });
  app.close();
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(
    turns.map((t) => t.text),
    ['LOOP-CHECK', 'LOOP-REPLY'],
  );
  w.stop();
  // stop() really stopped it: another row stays unread.
  const app2 = openForAppend(dbPath);
  app2.insert(2, 14, { text: 'AFTER-STOP', userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/154.0' });
  app2.close();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(turns.length, 2, 'no polls after stop()');
});

// --- the wiring: backend -> session/event -> MCP reply log ---

test('backend wiring: a seeded dashboard turn flows out as session/event dashboard_message payloads', async () => {
  const { dir, dbPath } = buildFixtureStore('backend', true, [
    { stepType: 14, text: 'BACKEND-CHECK', userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/154.0' },
    { stepType: 15, text: 'BACKEND-REPLY' },
  ]);
  const backend = new AntigravityBackend({
    agyBin: '/nonexistent/agy',
    agyHome: dir,
    cwd: dir,
    watchStartCursor: -1, // test seam: re-read the seeded rows
  });
  // A registered session whose child is never spawned (the fixture store
  // stands in for agy's journalling). The fake client speaks the one
  // teardown method the backend uses since the GC (client.close).
  const session = {
    client: { close() { return Promise.resolve(); }, exited: false },
    effort: 'medium',
    turnSeq: 0,
    turn: null,
    workspaceDir: dir,
    rawId: 'fixture-conversation',
    initPromise: null,
    ownTurnTexts: new Set(),
    watcher: null,
    idleSince: Date.now(),
    turnStartedAt: null,
    creatorConn: null,
    closeWhenIdle: null,
    closing: false,
    closePromise: null,
    lastExitAt: null,
  };
  backend._sessions.set('fixture-conversation', session);
  backend._startWatcher(session);
  const events = [];
  backend.on('event', (e) => events.push(e));
  const emitted = await session.watcher.pollOnce();
  assert.ok(emitted.length >= 2, `user+assistant emitted (got ${emitted.length})`);
  const msgs = events.filter((e) => e.method === 'session/event' && e.params.payload.kind === 'dashboard_message');
  assert.ok(msgs.length >= 2);
  for (const m of msgs) {
    assert.equal(m.params.sessionId, 'antigravity:fixture-conversation');
    assert.match(m.params.turnId, /^dashboard:\d+$/);
    assert.equal(m.params.payload.origin, 'dashboard');
    assert.ok(['user', 'assistant'].includes(m.params.payload.role));
    assert.equal(typeof m.params.payload.text, 'string');
  }
  // sendMessage records the text for the watcher's late-poll guard.
  session.ownTurnTexts.add('OUR-TEXT');
  assert.ok(session.ownTurnTexts.has('OUR-TEXT'));
  backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('MCP reply log: dashboard entries carry {role, origin} and a role:user entry never satisfies a parked message_send', async () => {
  // waitTimeoutMs bounded: a mutant that resolves (or fails to resolve)
  // waiters differently must fail THIS test in seconds, not park the runner
  // for the production ten minutes. Gateways close in finally -- a failing
  // assert must not leak a listening server into the runner.
  const gw = createMcpGateway({ port: 0, log: () => {}, waitTimeoutMs: 10_000 });
  const gw2 = createMcpGateway({ port: 0, log: () => {}, waitTimeoutMs: 10_000 });
  try {
    const parked = gw.waitReply('topic-1');
    let resolved = false;
    parked.then(() => {
      resolved = true;
    });
    // George types in the dashboard: INPUT, not a reply.
    gw.noteReply('topic-1', 'Say PHONE-TWO', { role: 'user', origin: 'dashboard' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolved, false, 'a dashboard user turn must not resolve a parked message_send');
    // The assistant reply from the same dashboard turn IS a reply-shaped entry.
    gw.noteReply('topic-1', 'PHONE-TWO', { role: 'assistant', origin: 'dashboard' });
    const woke = await parked;
    assert.equal(woke.text, 'PHONE-TWO');
    // Both entries ride through repliesSince with their meta.
    const replies = gw.repliesSince('topic-1');
    assert.deepEqual(
      replies.map((r) => [r.role, r.origin, r.text]),
      [
        ['user', 'dashboard', 'Say PHONE-TWO'],
        ['assistant', 'dashboard', 'PHONE-TWO'],
      ],
    );
    // Legacy two-arg calls keep waking waiters (regression guard).
    const parked2 = gw2.waitReply('t');
    gw2.noteReply('t', 'legacy reply');
    assert.equal((await parked2).text, 'legacy reply');
  } finally {
    gw.close();
    gw2.close();
  }
});
