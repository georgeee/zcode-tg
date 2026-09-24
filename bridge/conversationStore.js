// Reader for agy's conversation SQLite store -- the one place turns typed in
// the antigravity.google dashboard (Remote Control) are visible to this
// bridge. MEASURED FACT (work/antigravity/experiments/conversation-db-notes.md,
// 2026-09-24): a headless `agy --remote-control` session runs dashboard turns,
// but neither those turns nor their replies ever appear on agy's stream-json
// stdout -- they exist only in the conversation's
// $AGY_HOME/.gemini/antigravity-cli/conversations/<conversation_id>.db
// (SQLite, WAL). Without this reader, an MCP caller (and the bridge itself)
// is blind to half the conversation its own agy child is having.
//
// Every fact below is pinned against the live store; the notes file is the
// evidence record. The schema of the one table that matters:
//
//   CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL,
//     status integer NOT NULL, ..., metadata blob, step_payload blob, ...);
//
//   - idx is a strictly increasing sequence -- the ordering AND the "new
//     since X" cursor (a primary-key range scan).
//   - step_type 14 = an incoming (user) message, 15 = the model/tool step
//     that answers it; they alternate 14,15,14,15.
//   - metadata starts with a length-delimited google.protobuf.Timestamp
//     (field 1 -> field 1 seconds varint, field 2 nanos varint).
//   - a dashboard-origin user row carries a browser User-Agent string
//     (metadata field 37 on the measured row); a turn typed on our stdin
//     does not. This is the per-turn origin discriminator.
//   - message text is cleartext inside step_payload's protobuf: field 19
//     submessage, field 2 (user rows) and field 20 submessage, field 1
//     (model rows). Extracted with a minimal protobuf walk -- a full .proto
//     mapping would be nicer, but nothing here WRITES structured replies,
//     so string-typed field extraction at the measured numbers is enough,
//     and a missed field degrades to "row skipped", never to a wrong turn.
//
// SAFETY (measured, notes file section 2): the store is opened through a
// `file:...?mode=ro&immutable=1` URI -- mode=ro means SQLite refuses to
// create or write anything (verified: a nonexistent path throws), and
// immutable=1 means not even the -shm/-wal reader files a plain read-only
// open creates on a WAL database. The cost of immutable=1 is that a held
// connection may serve a stale snapshot forever -- so each poll opens a
// FRESH connection and closes it. Polling (not inotify): a human typing is
// not a firehose and a couple of seconds of latency costs nothing.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function conversationDbPath(agyHome, conversationId) {
  return path.join(agyHome, '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`);
}

// node:sqlite is built into Node >= 22.5 (the flake pins nodejs_22, engines
// floor is 22.19) -- experimental there, so it loads with a warning, which
// is fine for a read-only listener. When it is NOT available, the watcher
// degrades to inert: warned once, nothing polled, sessions otherwise
// unaffected. No npm dependency is added for this -- a native sqlite module
// would be a build surface for something that only ever reads.
let sqlitePromise;
function loadSqlite() {
  if (!sqlitePromise) {
    sqlitePromise = import('node:sqlite')
      .then((m) => m.DatabaseSync ?? m.default?.DatabaseSync ?? null)
      .catch(() => null);
  }
  return sqlitePromise;
}

// --- minimal protobuf reading ---

// pbFields splits one protobuf message into its fields: [{field, wire,
// varint, bytes}]. Repeated fields appear once per occurrence, in wire
// order. Returns null on anything malformed -- every caller treats null as
// "cannot decode", never as data.
export function pbFields(buf) {
  if (!(buf instanceof Uint8Array)) return null;
  const out = [];
  let i = 0;
  while (i < buf.byteLength) {
    // tag: field number << 3 | wire type, varint-encoded
    let tag = 0,
      shift = 0,
      b;
    do {
      if (i >= buf.byteLength) return null;
      b = buf[i++];
      tag += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) return null;
    } while (b & 0x80);
    const f = { field: Math.floor(tag / 8), wire: tag % 8 };
    if (f.wire === 0) {
      let v = 0n,
        s = 0n;
      do {
        if (i >= buf.byteLength) return null;
        b = buf[i++];
        v += BigInt(b & 0x7f) << s;
        s += 7n;
        if (s > 70n) return null;
      } while (b & 0x80);
      f.varint = v;
    } else if (f.wire === 2) {
      let len = 0;
      shift = 0;
      do {
        if (i >= buf.byteLength) return null;
        b = buf[i++];
        len += (b & 0x7f) * 2 ** shift;
        shift += 7;
        if (shift > 63) return null;
      } while (b & 0x80);
      if (i + len > buf.byteLength) return null;
      f.bytes = buf.subarray(i, i + len);
      i += len;
    } else if (f.wire === 5) {
      if (i + 4 > buf.byteLength) return null;
      i += 4; // fixed32 -- not used by anything we read
    } else if (f.wire === 1) {
      if (i + 8 > buf.byteLength) return null;
      i += 8; // fixed64
    } else {
      return null; // groups (wire 3/4) are deprecated and not in this store
    }
    out.push(f);
  }
  return out;
}

function fieldsOf(buf) {
  return pbFields(buf) ?? [];
}

// firstField: the bytes of the FIRST occurrence of field n, or null.
function firstField(buf, n) {
  return fieldsOf(buf).find((f) => f.field === n && f.bytes)?.bytes ?? null;
}

// asText: bytes as UTF-8 only when they decode cleanly and hold no control
// characters (whitespace excepted) -- a protobuf submessage forced through a
// string decode is the failure mode this guards against.
const textDecoder = new TextDecoder('utf8', { fatal: true });
function asText(bytes) {
  try {
    const s = textDecoder.decode(bytes);
    return /^[\t\n\r\x20-\x7e\u00a0-\uffff]*$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

// A browser User-Agent is the dashboard-origin marker (MEASURED: metadata
// field 37 on the dashboard-typed row; absent on stdin-typed rows). Scanned
// across every string in the row's two blobs rather than pinned to field 37:
// agy may move the field, and the false direction that matters is guarded
// anyway -- a stdin-typed row (the only kind that is not dashboard-origin)
// carries no browser UA string, because only the dashboard produces one.
const USER_AGENT_RE = /Mozilla\/[45]\.\d /;

export function rowHasUserAgent(metadata, payload) {
  for (const blob of [metadata, payload]) {
    if (!(blob instanceof Uint8Array)) continue;
    for (const f of fieldsOf(blob)) {
      if (!f.bytes) continue;
      // Top-level string...
      const s = asText(f.bytes);
      if (s && USER_AGENT_RE.test(s)) return true;
      if (s) continue;
      // ...or one nested inside a submessage (the measured row's UA sits at
      // the top level; this half keeps the scan honest if agy nests it).
      for (const g of fieldsOf(f.bytes)) {
        if (!g.bytes) continue;
        const t = asText(g.bytes);
        if (t && USER_AGENT_RE.test(t)) return true;
      }
    }
  }
  return false;
}

// decodeStepTimestamp: metadata's leading submessage (field 1) is a
// google.protobuf.Timestamp {1: seconds varint, 2: nanos varint} (MEASURED on
// every row). Returns a Date, or null when absent/malformed -- the timestamp
// decorates the turn, it is never load-bearing.
export function decodeStepTimestamp(metadata) {
  const ts = firstField(metadata, 1);
  if (!ts) return null;
  let seconds = null;
  let nanos = 0n;
  for (const f of fieldsOf(ts)) {
    if (f.field === 1 && f.varint != null) seconds = f.varint;
    if (f.field === 2 && f.varint != null) nanos = f.varint;
  }
  if (seconds == null) return null;
  const ms = Number(seconds) * 1000 + Number(nanos / 1000000n);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

// The text-bearing fields, at the numbers MEASURED in the live store: user
// rows carry their message at payload field 19 -> field 2; model rows their
// reply at payload field 20 -> field 1. Either may be missing (a tool step
// has no reply text) -- null means "no text here", and the watcher skips the
// row rather than emit a guess.
export function decodeStepText(stepType, payload) {
  const outer = stepType === 14 ? 19 : 20;
  const inner = stepType === 14 ? 2 : 1;
  const sub = firstField(payload, outer);
  if (!sub) return null;
  const textBytes = firstField(sub, inner);
  if (!textBytes) return null;
  return asText(textBytes);
}

// decodeStepRow: one `steps` row -> {idx, stepType, role, text, at,
// dashboardMarker}, or null for step types this reader does not know
// (skipped deliberately -- forward compatibility).
export function decodeStepRow(row) {
  const stepType = Number(row.step_type);
  const role = stepType === 14 ? 'user' : stepType === 15 ? 'assistant' : null;
  if (!role) return null;
  return {
    idx: Number(row.idx),
    stepType,
    role,
    text: decodeStepText(stepType, row.step_payload),
    at: decodeStepTimestamp(row.metadata),
    dashboardMarker: rowHasUserAgent(row.metadata, row.step_payload),
  };
}

// --- the watcher ---

// ConversationWatcher tails ONE conversation's store and emits
// 'dashboard_turn' {role, origin:'dashboard', text, at, idx} for every
// dashboard-origin turn it finds past the cursor. Turns OUR stdin produced
// are never emitted (see _classify) -- that is the contract index.js relies
// on when it surfaces these turns to MCP callers without duplicating turns
// the bridge itself started.
//
// Emission pairs user+response: when a user row is classified, the VERY NEXT
// step_type 15 row belongs to it (agy alternates 14,15 -- MEASURED). A model
// row with no pending classification is skipped: it is the response half of
// one of our own turns whose user row was consumed by the attach-time cursor
// (the watcher started mid-turn) -- emitting it would surface half a turn.
export class ConversationWatcher extends EventEmitter {
  constructor({
    dbPath,
    pollMs = 2000,
    // turnInFlight(): true while a turn WE wrote to agy's stdin is running.
    // Rows that arrive during it (and carry no UA marker) are ours.
    turnInFlight = () => false,
    // ownTurnUserTexts(): the user texts of our recent stdin turns. Closes
    // the late-poll race: rows are consumed exactly once, but a poll that
    // lands AFTER our turn finished would otherwise read our user row as
    // dashboard-origin (no turn in flight any more). Membership in the whole
    // recent set, not equality with the last turn: two of our turns can land
    // between two polls.
    ownTurnUserTexts = () => new Set(),
    // startCursor: begin at this idx (exclusive). Default: tail -- the max
    // idx at start, so history is never replayed (the bridge delivered, or
    // deliberately never delivered, everything before it). The tests pass an
    // explicit cursor to re-read seeded rows.
    startCursor = null,
  }) {
    super();
    this.dbPath = dbPath;
    this.pollMs = pollMs;
    this.turnInFlight = turnInFlight;
    this.ownTurnUserTexts = ownTurnUserTexts;
    this.startCursor = startCursor;
    this.cursor = null; // established on the first successful read
    this.running = false;
    this._timer = null;
    this._polling = false;
    this._pendingPair = null; // 'dashboard' | 'ours' | null
    this._warnedMissing = false;
    this._warnedUnpaired = false;
    this._warnedNoSqlite = false;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this._schedule();
    return this;
  }

  stop() {
    this.running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _schedule() {
    if (!this.running) return;
    // unref: a watcher must never be the thing keeping the bridge process
    // (or a test run) alive -- stop() is the lifecycle owner, not the timer.
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.pollOnce().finally(() => this._schedule());
    }, this.pollMs);
    this._timer.unref?.();
  }

  // One poll: fresh read-only connection, rows past the cursor, classify,
  // emit. NEVER throws -- a broken store degrades to silence (warned once),
  // because the alternative is a watcher whose failure takes down the
  // bridge's antigravity sessions. Returns the turns emitted (the tests poll
  // this directly for determinism instead of sleeping through pollMs).
  async pollOnce() {
    if (!this.running || this._polling) return [];
    this._polling = true;
    try {
      const DatabaseSync = await loadSqlite();
      if (!DatabaseSync) {
        if (!this._warnedNoSqlite) {
          this._warnedNoSqlite = true;
          this.emit('unavailable', 'node:sqlite is not available on this runtime -- dashboard turns cannot be read');
        }
        return [];
      }
      let rows;
      try {
        const db = new DatabaseSync(pathToFileURL(this.dbPath).href + '?mode=ro&immutable=1');
        try {
          rows = db
            .prepare('SELECT idx, step_type, status, metadata, step_payload FROM steps WHERE idx > ? ORDER BY idx')
            .all(this.cursor ?? -1);
        } finally {
          db.close();
        }
      } catch (e) {
        // Missing or not-yet-openable store: a fresh session has no .db
        // until agy first journals a turn. Warn ONCE, keep polling.
        if (!this._warnedMissing) {
          this._warnedMissing = true;
          this.emit('stalled', `conversation store not readable yet (${String(e.message).slice(0, 120)})`);
        }
        return [];
      }
      if (this.cursor === null) {
        // First successful read: establish the cursor WITHOUT emitting.
        // History is agy's own record of turns this bridge may not even have
        // been running for; replaying it would duplicate turns already
        // delivered (or deliberately never delivered). An explicit
        // startCursor opts in.
        const maxIdx = rows.length ? rows[rows.length - 1].idx : -1;
        this.cursor = this.startCursor ?? maxIdx;
        rows = rows.filter((r) => r.idx > this.cursor);
      }
      const emitted = [];
      for (const row of rows) {
        if (row.idx > this.cursor) this.cursor = row.idx;
        const step = decodeStepRow(row);
        if (!step) continue;
        if (step.role === 'user') {
          if (this._classify(step) === 'ours') {
            this._pendingPair = 'ours';
            continue;
          }
          this._pendingPair = 'dashboard';
          emitted.push(this._emit(step));
        } else {
          // step_type 15: the response half of whichever pair the preceding
          // user row opened (agy alternates 14,15 -- MEASURED), so the PAIR
          // governs, not the in-flight rule: the response to a dashboard
          // turn emitted a moment ago belongs to that dashboard turn even
          // if one of OUR turns started in between. A model row with no
          // pending pair is the tail of one of OUR turns whose user half
          // the attach-time cursor consumed -- half a turn is never emitted,
          // warned once.
          const pair = this._pendingPair;
          this._pendingPair = null;
          if (pair === 'dashboard') {
            emitted.push(this._emit(step));
          } else if (pair == null && !this._warnedUnpaired) {
            this._warnedUnpaired = true;
            this.emit('stalled', `unpaired model step at idx=${step.idx} (no pending user step) -- skipped`);
          }
        }
      }
      return emitted;
    } finally {
      this._polling = false;
    }
  }

  // 'dashboard' | 'ours' -- for a USER row. The UA marker wins FIRST: a row
  // carrying a browser User-Agent is dashboard-origin even while one of our
  // turns runs (George typing from his phone mid-turn is exactly the
  // cross-device case --remote-control exists for). A row arriving while OUR
  // turn is in flight is ours (only this bridge writes agy's stdin); so is
  // a UA-less row matching a recent stdin text of ours -- the late-poll
  // case of the same thing. Model rows never reach here: their response
  // half follows the pair their user row opened (see pollOnce).
  _classify(step) {
    if (step.dashboardMarker) return 'dashboard';
    if (this.turnInFlight()) return 'ours';
    if (step.text != null && this.ownTurnUserTexts().has(step.text)) return 'ours';
    return 'dashboard';
  }

  _emit(step) {
    const turn = {
      role: step.role,
      origin: 'dashboard',
      text: step.text ?? '',
      at: step.at ? step.at.toISOString() : null,
      idx: step.idx,
    };
    this.emit('dashboard_turn', turn);
    return turn;
  }
}
