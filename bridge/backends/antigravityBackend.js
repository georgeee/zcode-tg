// The Antigravity backend: talks to the Antigravity CLI (`agy`) in headless
// stream-json mode via bridge/antigravityClient.js, and translates agy's
// "one process per conversation, NDJSON turns" model onto the shared
// session/turn vocabulary bridge/backend.js documents -- the same one
// zcodeBackend.js speaks natively and codexBackend.js maps Codex's
// threads/turns onto, so bridge/index.js's streaming/watchdog/breaker/queueing
// logic works unchanged regardless of which backend a given topic runs on.
//
// Protocol facts are cited by evidence tier exactly as codexBackend.js does
// (see that file's header): VERIFIED LIVE = captured from real `agy` 1.2.9
// sessions against George's AI Pro login (transcripts:
// work/antigravity/experiments/agy-*.txt, drivers: work/antigravity/exp-*.mjs);
// FROM DOCS = antigravity.google/docs/cli/headless; INFERRED = flagged inline.
//
// PROCESS MODEL -- the one structural difference from codex: agy's stream-json
// mode has no multiplexing app-server, so this backend is a REGISTRY of
// per-session AntigravityClient processes (one agy process == one
// conversation). A backend instance is still long-lived and one-per-kind, as
// bridge/backend.js requires; it just holds zero or more children. A child
// exiting takes down that SESSION's turn (emitting a failed turn.terminal for
// it), never the backend and never the bridge -- there is no single process
// whose death would mean "this backend kind is dead", so unlike codexBackend
// this class never re-emits 'exit' at backend level.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { Backend, makeSessionId, rawSessionId } from '../backend.js';
import { AntigravityClient, AGY_SETTINGS_DEFAULTS, ensureAgySettings } from '../antigravityClient.js';
import { ConversationWatcher, conversationDbPath } from '../conversationStore.js';
import { readProcRssBytes } from '../agyProcesses.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// formatAge: a turn's running time for the cap refusal -- "3m12s", or
// "45s" inside the first minute.
function formatAge(ms) {
  const total_s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total_s / 60);
  const s = total_s % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

// THE SINGLE MODEL REF, per George (2026-09-24): the antigravity family
// exposes exactly one model; reasoning effort is a KNOB on that ref, mapped
// to agy's `--effort low|medium|high` (bridge default: medium, AGY_EFFORT).
// Arg rule (VERIFIED LIVE, battery (d)): always the bare slug + --effort,
// never an effort-suffixed slug, never the bare slug without --effort.
export const AGY_MODEL_REF = 'gemini-3.8-flash';
export const AGY_MODEL_LABEL = 'Gemini 3.8 Flash';
export const AGY_EFFORTS = ['low', 'medium', 'high'];

// parseAgyModelRef: 'gemini-3.8-flash' -> {model, effort: null} (backend
// default effort); 'gemini-3.8-flash:high' -> {model, effort: 'high'};
// anything else -> null (caller refuses with a clear error). The suffix form
// is the ONLY switch there is on this backend -- see setModel().
export function parseAgyModelRef(ref) {
  if (ref === AGY_MODEL_REF) return { model: AGY_MODEL_REF, effort: null };
  const m = String(ref ?? '').match(/^gemini-3\.8-flash:(low|medium|high)$/);
  if (m) return { model: AGY_MODEL_REF, effort: m[1] };
  return null;
}

// Envelope statuses (VERIFIED LIVE): SUCCESS / ERROR / INTERRUPTED / TIMEOUT.
function statusOf(result) {
  return result?.status === 'SUCCESS' ? 'success' : 'failed';
}

// --- the pre-turn integrity gate ---
//
// MEASURED LIVE (agy 1.2.9, owner decision 2026-09-25): if the model uses
// its in-process file tool during a session to write
// $AGY_HOME/.gemini/config/mcp_config.json, agy re-reads that file at the
// START of the NEXT turn and EXECS the MCP servers it lists -- directly, as
// the account agy runs as (the agent, the account that holds the session
// credential), on EVERY following turn. Turn 1 writes, turn 2 fires; it
// never fires within the same turn, and a fresh start fires too.
// hooks.json is NOT an exec vector (named hooks only). So the config under
// AGY_HOME must be PROVABLY INERT before anything can turn: mcp_config.json
// and plugins.json absent, 0 bytes (a fresh agy leaves a 0-byte
// mcp_config.json), or JSON carrying no servers/plugins; config/plugins/
// absent or empty. A violation is quarantined (renamed aside for forensics,
// never exec'd or parsed further), the session's child is stopped through
// the bounded close escalation, and the turn fails with a loud
// review-before-continuing message. Every session of this AGY_HOME shares
// the file, so each of their turns runs the check (see sendMessage and
// _spawn).

// Does this file content declare MCP servers or plugins? Only provably
// inert shapes pass: an object whose server/plugin keys are absent, null,
// or empty ({} or {"mcpServers":{}} are the canonical clean forms). A
// non-empty file that does not parse -- or is not an object -- is a
// violation: it is not provably inert, and forensics keeps it either way.
function declaresServersOrPlugins(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return true;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return true;
  return Object.entries(doc).some(([key, value]) => {
    if (!/^(mcp[-_ ]?)?(servers?|plugins?)$/i.test(key)) return false;
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    return typeof value !== 'object' || Object.keys(value).length > 0;
  });
}

export class AntigravityBackend extends Backend {
  constructor({ agyBin, agyHome, cwd, effort = 'medium', autoApprovePermissions = true, remoteControl = true, initTimeoutMs = 90_000, watchStartCursor = null, idleCloseMs = 20 * 60_000, maxProcs = 4, closeEofGraceMs = 10_000, closeTermGraceMs = 5_000, bridgeMarker = null, sessionKeyOf = null }) {
    super('antigravity');
    this.agyBin = agyBin;
    this.agyHome = agyHome;
    this.cwd = cwd; // default workspace; createConversation may pass its own
    this.effort = effort;
    this.autoApprovePermissions = autoApprovePermissions;
    // Owner decision (2026-09-24): every session starts with --remote-control
    // so the SAME conversation is visible and drivable from the
    // antigravity.google dashboard. Session-scoped: the tunnel dies with the
    // process (design doc §13). Not Claude's remote-control trap.
    this.remoteControl = remoteControl;
    this.initTimeoutMs = initTimeoutMs; // cold first runs unpack skills (5-15s measured; 90s is generous)
    // Test seam for the conversation-store watcher (see _startWatcher):
    // where its cursor starts. null (production) = tail -- history is never
    // replayed. The tests seed a store and start mid-way through it.
    this.watchStartCursor = watchStartCursor ?? null;
    // --- the process GC (config in index.js: AGY_IDLE_CLOSE_MIN /
    // AGY_MAX_PROCS; the ms/grace forms here are so tests can use real
    // short timers instead of real minutes) ---
    // C1: a live child idle at least this long is closed; 0 disables the
    // reaper. The clock runs from the end of the last turn (the `result`
    // event) or from the spawn -- a session mid-turn is NEVER reaped.
    this.idleCloseMs = idleCloseMs;
    // C3: live agy children per bridge; a new child at the cap evicts the
    // least-recently-used idle child or, with every child mid-turn, is
    // refused. 0/undefined = uncapped.
    this.maxProcs = maxProcs;
    // C1/C4 teardown escalation stages (client.close): stdin EOF, then
    // SIGTERM after closeEofGraceMs, then SIGKILL after closeTermGraceMs.
    // The defaults sum to the 15s shutdown bound.
    this.closeEofGraceMs = closeEofGraceMs;
    this.closeTermGraceMs = closeTermGraceMs;
    // C4: the marker every agy child carries in its environment (see
    // reapOrphanAgyChildren). Defaults to a hash of the agy HOME so a
    // standalone backend still marks its children; the bridge passes a hash
    // of its state dir so two bridges on one host never sweep each other's
    // children.
    this.bridgeMarker = bridgeMarker ?? `agyhome-${createHash('sha256').update(String(agyHome)).digest('hex').slice(0, 16)}`;
    // (sessionId) => MCP conversation key, for reap logs and the cap
    // refusal -- the keys a caller can actually session_close. Null-safe:
    // the raw prefixed session id stands in when there is no topic.
    this.sessionKeyOf = sessionKeyOf;
    // rawId (conversation uuid) -> session state:
    //   { client, effort, turnSeq, turn: {id, toolCallIds: Map} | null,
    //     ownTurnTexts: Set (our recent stdin texts -- the watcher's
    //     late-poll guard), watcher: ConversationWatcher | null,
    //     idleSince (GC clock: spawn or last result),
    //     turnStartedAt, creatorConn (C2), closeWhenIdle (C2 pending),
    //     cancelPending (a SIGTERM was requested for the in-flight turn:
    //       the verdict is failed/interrupted whatever envelope races in,
    //       and the next send respawn-resumes -- agy exits on a cancel),
    //     closing/closePromise/lastExitAt (teardown bookkeeping) }
    // A GC-closed session KEEPS its entry (client.exited marks the death;
    // ownTurnTexts is dropped): the effort and workspaceDir on it are what
    // the next respawn restores -- without that, a reaped session would
    // silently fall back to the bridge-default effort even though its topic
    // stored gemini-3.8-flash:high.
    this._sessions = new Map();
    this._usage = { since: Date.now(), turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this._lastQuotaError = null;
    this._reapTimer = null; // armed with the first child, disarmed in stop()
    // Children between spawn start and init (the conversation id, and the
    // session's registration, only EXIST at init) -- counted toward the cap
    // so concurrent creates cannot briefly overshoot it. A session leaves
    // the set when it registers (onInit) or when its child dies
    // (_onChildExit); one stuck mid-init keeps its slot, which is honest --
    // its child is live.
    this._pending = new Set();
  }

  async start() {
    // Settings seeding on first start: the owner-mandated keys, MERGE
    // semantics, inside the agy HOME this deployment was pointed at. With
    // AUTO_APPROVE_PERMISSIONS=false the toolPermission key is left alone
    // (agy's own request-review default stands) -- that combination is
    // documented in the README as not yet usable, since this surface has no
    // approval relay; the hygiene keys are applied either way.
    ensureAgySettings(
      this.agyHome,
      this.autoApprovePermissions
        ? AGY_SETTINGS_DEFAULTS
        : (({ toolPermission, ...hygiene }) => hygiene)(AGY_SETTINGS_DEFAULTS),
    );
    return this;
  }

  // C4 (shutdown): every live child through the bounded escalation (stdin
  // EOF, SIGTERM, SIGKILL -- client.close), then wait, bounded by the
  // escalation's own total (default 10s + 5s = 15s). The race only bounds
  // this await -- the KILL timers fire regardless -- so a wedged child
  // cannot hang a redeploy past its bound.
  async stop() {
    this._disarmReaper();
    const jobs = [];
    for (const session of [...this._sessions.values()]) {
      session.watcher?.stop();
      if (this._isLive(session)) jobs.push(this._gcClose(session, null));
      else if (session.closePromise) jobs.push(session.closePromise);
    }
    await Promise.race([Promise.allSettled(jobs), sleep(this.closeEofGraceMs + this.closeTermGraceMs + 1_000)]);
  }

  // --- the process GC (C1 reaper, C2 creator tie, C3 cap) ---
  //
  // agy's stream-json mode has no multiplexing app-server, so every session
  // IS a process: idle ones are 93-181 MB anon RSS each, and before the GC
  // a finished conversation's child lived until the bridge died. Everything
  // here closes children only -- the conversation survives on disk under the
  // agy HOME, so the next sendMessage respawn-resumes with --conversation.

  _isLive(session) {
    return session.client && !session.client.exited && !session.closing;
  }

  // The MCP-facing name of a session, for logs and errors: the conversation
  // key the caller can session_close, or the prefixed session id when there
  // is no topic (backend-level use).
  _keyOf(session) {
    const sessionId = makeSessionId('antigravity', session.rawId ?? '');
    return this.sessionKeyOf?.(sessionId) ?? sessionId;
  }

  // One GC close: bounded teardown of the child, registry entry RETAINED
  // (minus the heavyweight bits) with effort/workspaceDir intact for the
  // respawn, and the reap line on the log. reason is one of 'idle', 'cap',
  // 'creator-gone' -- or null for shutdown, which is not a reap and logs
  // nothing (every redeploy would otherwise).
  _gcClose(session, reason) {
    if (session.closing || !this._isLive(session)) return session.closePromise ?? Promise.resolve();
    session.closing = true;
    session.closeWhenIdle = null; // the close in progress supersedes any pending one
    session.ownTurnTexts.clear();
    session.watcher?.stop();
    const idleMs = Date.now() - session.idleSince;
    if (reason) this.emit('reap', `reap key=${this._keyOf(session)} idle=${Math.floor(idleMs / 60_000)}m reason=${reason}`);
    session.closePromise = session.client
      .close({ eofGraceMs: this.closeEofGraceMs, termGraceMs: this.closeTermGraceMs })
      .then(() => {
        session.lastExitAt = Date.now();
      });
    return session.closePromise;
  }

  _armReaper() {
    if (this._reapTimer || !this.idleCloseMs || this.idleCloseMs <= 0) return;
    const tick = Math.max(25, Math.min(this.idleCloseMs / 2, 30_000));
    this._reapTimer = setInterval(() => this._reapTick(), tick);
    this._reapTimer.unref?.();
  }

  _disarmReaper() {
    if (this._reapTimer) {
      clearInterval(this._reapTimer);
      this._reapTimer = null;
    }
  }

  // C1: close every live child whose idle clock has run out.
  _reapTick() {
    const now = Date.now();
    for (const session of this._sessions.values()) {
      // THE MID-TURN GUARD: a session with a turn in flight is never
      // reaped, whatever the clock says. The child is the turn's transport;
      // closing it kills the turn (the conversation would survive, the
      // turn's answer does not).
      if (session.turn || !this._isLive(session)) continue;
      if (now - session.idleSince < this.idleCloseMs) continue;
      this._gcClose(session, 'idle');
    }
  }

  // C2, backend half: index.js records session_create's MCP connection id
  // here. Telegram-created sessions never get one, so creatorDisconnected
  // never touches them.
  noteSessionCreator(sessionId, connId) {
    const session = this._sessions.get(rawSessionId(sessionId));
    if (session && connId != null) session.creatorConn = connId;
  }

  // C2: the MCP connection that created sessions went away. Its idle
  // sessions close NOW; its busy ones are marked and close the moment
  // their turn ends (_onResult). A session another connection picks up
  // after its turn ends just respawn-resumes later -- the conversation was
  // never lost.
  creatorDisconnected(connId) {
    for (const session of this._sessions.values()) {
      if (session.creatorConn !== connId) continue;
      session.creatorConn = null;
      if (!this._isLive(session) || session.closing) continue;
      if (session.turn) session.closeWhenIdle = 'creator-gone';
      else this._gcClose(session, 'creator-gone');
    }
  }

  // C3, the cap: called before every new child (_spawn). At the cap, the
  // least-recently-used IDLE child is evicted first -- and awaited to a
  // full exit, so the cap holds at the process level, not just in this
  // registry (an idle child exits on stdin EOF in well under a second; the
  // escalation's TERM/KILL stages bound the pathological case). With every
  // live child mid-turn there is nothing evictable: refuse, naming the
  // busy keys and their turn ages, so the caller can retry or
  // session_close one. Children still mid-init count too, and a refusal is
  // not issued while slots are merely in flight -- concurrent creates wait
  // for each other instead of evicting or refusing on half-born children.
  async _admitNewChild() {
    if (!this.maxProcs || this.maxProcs < 1) return;
    const pendingDeadline = Date.now() + this.initTimeoutMs;
    for (;;) {
      const live = [...this._sessions.values()].filter((s) => this._isLive(s));
      const count = live.length + this._pending.size;
      if (count < this.maxProcs) return;
      const idle = live.filter((s) => !s.turn);
      if (!idle.length) {
        if (live.length < count && Date.now() < pendingDeadline) {
          await sleep(25);
          continue;
        }
        const busy = live.map((s) => `${this._keyOf(s)} ${formatAge(Date.now() - (s.turnStartedAt ?? s.idleSince))}`).join(', ');
        throw new Error(`antigravity: ${live.length} sessions busy (cap ${this.maxProcs}): ${busy}; retry or session_close one`);
      }
      idle.sort((a, b) => a.idleSince - b.idleSince);
      await this._gcClose(idle[0], 'cap');
    }
  }

  // C6: live child count and their summed RSS (VmRSS out of
  // /proc/<pid>/status). Unreadable entries contribute 0, not a failure.
  procSnapshot() {
    const live = [...this._sessions.values()].filter((s) => this._isLive(s));
    let totalRssBytes = 0;
    for (const session of live) totalRssBytes += readProcRssBytes(session.client.proc?.pid) ?? 0;
    return { live: live.length, totalRssBytes };
  }

  // --- session lifecycle ---

  // Spawns a fresh agy conversation and waits for its `init` event (the only
  // place the conversation id comes from -- VERIFIED LIVE: init carries
  // {conversation_id, init:{model, cwd, tools, permission_mode}}).
  async createConversation({ workspaceDir, model } = {}) {
    const parsed = parseAgyModelRef(model ?? AGY_MODEL_REF);
    if (!parsed) throw this._badModelRefError(model);
    const session = await this._spawn({ workspaceDir: workspaceDir ?? this.cwd, effort: parsed.effort ?? this.effort });
    const init = await session.initPromise;
    return { sessionId: makeSessionId('antigravity', init.conversation_id), model: AGY_MODEL_REF };
  }

  // Resume = respawn with --conversation (agy persists conversations as
  // SQLite under the HOME; history survives process AND bridge restarts,
  // VERIFIED LIVE battery (c)). index.js calls this on every boot for every
  // persisted session of this backend.
  async resumeConversation(sessionId, { workspaceDir, model } = {}) {
    const rawId = rawSessionId(sessionId);
    const existing = this._sessions.get(rawId);
    if (existing && this._isLive(existing)) return { sessionId };
    const parsed = parseAgyModelRef(model ?? AGY_MODEL_REF);
    if (!parsed) throw this._badModelRefError(model);
    const session = await this._spawn({
      workspaceDir: workspaceDir ?? this.cwd,
      effort: parsed.effort ?? this.effort,
      conversationId: rawId,
    });
    await session.initPromise;
    return { sessionId: makeSessionId('antigravity', rawId) };
  }

  // No subscribe step exists on this protocol: the one process per session
  // pushes its events unconditionally (VERIFIED LIVE -- the drivers never
  // subscribe and receive everything).
  async subscribe() {}

  // --- the pre-turn integrity gate (see the block comment at statusOf) ---

  // Null when the AGY_HOME config is provably inert; the violation to
  // quarantine otherwise. Runs before every turn delivery and before every
  // spawn/respawn. Every session of this AGY_HOME shares these files, so
  // each of their turns re-checks -- whoever turns first while the file is
  // dirty gets refused and quarantines it; the rest find it gone.
  _configViolation() {
    const configDir = path.join(this.agyHome, '.gemini', 'config');
    for (const name of ['mcp_config.json', 'plugins.json']) {
      const file = path.join(configDir, name);
      let dirty;
      try {
        dirty = existsSync(file) && statSync(file).size > 0 && declaresServersOrPlugins(readFileSync(file, 'utf8'));
      } catch {
        dirty = true; // unreadable: not provably inert
      }
      if (dirty) return { path: file };
    }
    const pluginsDir = path.join(configDir, 'plugins');
    let dirtyDir;
    try {
      dirtyDir = existsSync(pluginsDir) && readdirSync(pluginsDir).length > 0;
    } catch {
      dirtyDir = true; // unreadable: not provably empty
    }
    if (dirtyDir) return { path: pluginsDir };
    return null;
  }

  // THE QUARANTINE: the offending file/directory is renamed aside for
  // forensics -- kept, never exec'd, never parsed further -- the loud warn
  // goes out, the line lands on the reap log, and the human-facing message
  // comes back for the failed turn. Stopping the session's child is the
  // caller's move (the spawn path has no child to stop).
  _quarantine(violation, key) {
    const stamp = Math.floor(Date.now() / 1000);
    let target = `${violation.path}.quarantined-${stamp}`;
    for (let n = 2; existsSync(target); n += 1) target = `${violation.path}.quarantined-${stamp}-${n}`; // same-second re-quarantine never overwrites forensics
    renameSync(violation.path, target);
    const message =
      `antigravity: agy's config at ${violation.path} defines MCP servers/plugins (agy would run them as the agent account); ` +
      `quarantined as ${target}, session stopped. Something in this session wrote it — review before continuing.`;
    this.emit('warn', message);
    this.emit('reap', `quarantine path=${violation.path} key=${key}`);
    return message;
  }

  // Fire-and-forget per the Backend contract: writes ONE user turn object to
  // the session's stdin; the reply streams back as 'event' emissions ending
  // in v4/telemetry/event turn.terminal.
  async sendMessage(sessionId, text) {
    const rawId = rawSessionId(sessionId);
    // THE GATE, delivery half -- before the respawn decision (a dirty
    // AGY_HOME gets no fresh child either; _spawn checks too) and before
    // the write: agy re-reads the config at the start of the very turn we
    // are about to deliver. The write that armed the trap happened during a
    // PREVIOUS turn -- one the gate did not see; there is deliberately no
    // in-delivery re-check (it never fires within the same turn, measured),
    // and the quarantine below takes the file out of agy's reach before the
    // turn after this one.
    const violation = this._configViolation();
    if (violation) {
      const existing = this._sessions.get(rawId);
      const message = this._quarantine(violation, this._keyOf(existing ?? { rawId }));
      if (existing) this._gcClose(existing, null); // the bounded close escalation stops the session's child
      // The turn is refused, never delivered: started for correlation, then
      // the failed terminal -- index.js's event-driven path clears the turn.
      const turnId = `${rawId}:${existing ? ++existing.turnSeq : 0}`;
      this._emitTelemetry(makeSessionId('antigravity', rawId), turnId, 'turn.started');
      this._emitTelemetry(makeSessionId('antigravity', rawId), turnId, 'turn.terminal', { status: 'failed', errorCode: message });
      return;
    }
    const session = await this._runningSession(sessionId);
    const turnId = `${rawSessionId(sessionId)}:${++session.turnSeq}`;
    session.turn = { id: turnId, toolCallIds: new Map(), toolCallCount: 0 };
    session.turnStartedAt = Date.now();
    // The watcher's late-poll guard needs our recent stdin texts: a poll
    // landing after this turn finished would otherwise read its user row as
    // dashboard-origin (no turn in flight any more). Capped -- it is a
    // membership set, not a transcript.
    session.ownTurnTexts.add(text);
    if (session.ownTurnTexts.size > 16) session.ownTurnTexts.delete(session.ownTurnTexts.values().next().value);
    // turn.started FIRST: index.js correlates a turn's events on the turnId
    // learned from this event, and adopts backend-initiated turns from it.
    this._emitTelemetry(makeSessionId('antigravity', rawSessionId(sessionId)), turnId, 'turn.started');
    try {
      await session.client.sendUserTurn(text);
    } catch (err) {
      // The child died between the respawn check in _runningSession and the
      // write (crash, or a SIGTERM-cancel exit racing the next turn): the
      // message never reached agy. End the turn HERE -- index.js's watchdog
      // is off by default, so without this the topic would sit on its
      // placeholder forever -- with the client's retryable delivery message.
      // The conversation survives; the next send respawn-resumes.
      session.turn = null;
      session.ownTurnTexts.delete(text);
      this._emitTelemetry(makeSessionId('antigravity', rawSessionId(sessionId)), turnId, 'turn.terminal', {
        status: 'failed',
        errorCode: err.message,
      });
    }
  }

  // Abort the in-flight turn: SIGTERM. agy answers with a structured
  // {"status":"ERROR","error":"interrupted"} result (VERIFIED LIVE, battery
  // (f)) which flows through the normal result -> turn.terminal path, and
  // EXITS. cancelPending records the verdict from this instant -- see
  // _onResult (the cancel wins over any envelope that races in) and
  // _runningSession (the next send respawn-resumes instead of writing into
  // the child that is on its way out). The conversation survives for later
  // turns.
  async cancel(sessionId) {
    const session = this._sessions.get(rawSessionId(sessionId));
    if (session && session.turn) {
      session.cancelPending = true;
      session.client.kill('SIGTERM');
    }
  }

  // Stop the child but keep the conversation: agy's state is the SQLite db
  // under the HOME, so closing costs nothing upstream (an idle agy process
  // is the only thing being released). A later sendMessage respawn-resumes.
  // Same bounded escalation as the GC closes, but not a reap: no log line
  // (the caller asked for this one), and the registry entry is RETAINED so
  // the session's effort/workspace survive for the respawn.
  async closeConversation(sessionId) {
    const rawId = rawSessionId(sessionId);
    const session = this._sessions.get(rawId);
    if (session) {
      session.watcher?.stop();
      this._gcClose(session, null);
    }
  }

  async cancelBackgroundTask() {
    // agy auto-backgrounds long shell commands internally (VERIFIED LIVE,
    // battery (b): `sleep 45` ran as a background task inside the turn), but
    // they are not addressable from the stream -- there is nothing to cancel
    // from here; the turn's own cancel covers the session.
  }

  // Model switching = the effort knob. A bare ref is a no-op success (it is
  // the only model); `gemini-3.8-flash:<effort>` changes effort from the NEXT
  // turn: the flag is spawn-time-only (VERIFIED LIVE (d) -- no in-stream
  // override is documented), so a live child is stopped and the session
  // respawn-resumes with --conversation + the new --effort. History survives
  // (battery (c)); anything else is refused, not faked.
  async setModel(sessionId, model) {
    const parsed = parseAgyModelRef(model);
    if (!parsed) throw this._badModelRefError(model);
    if (!parsed.effort) return; // bare ref: nothing to change
    const rawId = rawSessionId(sessionId);
    const session = this._sessions.get(rawId);
    if (session && session.effort === parsed.effort) return;
    const workspaceDir = session?.client.cwd ?? this.cwd;
    if (session) {
      // Marked closing before the replacement spawns so the cap's live
      // count never sees the dying child; the entry is deleted because the
      // respawn below re-registers with the new effort.
      this._gcClose(session, null);
      this._sessions.delete(rawId);
    }
    const fresh = await this._spawn({ workspaceDir, effort: parsed.effort, conversationId: rawId });
    // Eager, so a bad resume surfaces HERE (model_set's caller) rather than
    // as a surprise on the next turn.
    await fresh.initPromise;
  }

  async listModels() {
    return [{ ref: AGY_MODEL_REF, label: AGY_MODEL_LABEL }];
  }

  listModes() {
    return []; // no mode concept -- same as codexBackend.js
  }

  onPermissionRequest() {
    // Under --dangerously-skip-permissions + toolPermission "always-proceed"
    // (AUTO MODE, the owner default) permission prompts are suppressed
    // (design doc §12/§13); there is no approval channel on the stream-json
    // surface to relay through even if one fired. The safety boundary is the
    // executor-shim arrangement, not agy's prompts.
  }

  onUserInputRequest() {
    // No mid-turn question channel exists on this surface. If a model runs
    // ask_question anyway, the turn waits it out inside agy -- documented as
    // a known scope limit in the README.
  }

  killLocalToolProcesses() {
    // Same reasoning as codexBackend.js: agy's run_command subprocesses do
    // not embed the conversation id recognizably enough for a /proc-based
    // kill to be safe. cancel() (SIGTERM to the session process) is the real
    // stop signal.
  }

  _badModelRefError(model) {
    return new Error(
      `model "${model}" is not supported by the antigravity backend: it runs exactly one model (${AGY_MODEL_REF}); ` +
      `effort variants are ${AGY_MODEL_REF}:low|medium|high`,
    );
  }

  // --- child-process plumbing ---

  // Spawn one agy process and wire its events into the shared vocabulary.
  // The returned session's initPromise resolves with the init event (or
  // rejects on spawn failure / non-zero exit before init / timeout).
  // Async because of the cap (C3): a new child at the cap first evicts an
  // idle one (awaited to a full exit -- never exceed the cap at the process
  // level) or refuses.
  async _spawn({ workspaceDir, effort, conversationId = null }) {
    // THE GATE, spawn half: a fresh or resumed child reads the config at its
    // first turn -- never start one against a dirty AGY_HOME. Nothing to
    // stop here (no child exists yet); the throw carries the quarantine
    // message to createConversation / resumeConversation / setModel's
    // callers. The rename has already made the config clean, so a retry
    // after human review spawns normally.
    const violation = this._configViolation();
    if (violation) throw new Error(this._quarantine(violation, this._keyOf({ rawId: conversationId })));
    await this._admitNewChild();
    const client = new AntigravityClient({
      agyBin: this.agyBin,
      agyHome: this.agyHome,
      cwd: workspaceDir,
      model: AGY_MODEL_REF,
      effort,
      remoteControl: this.remoteControl,
      skipPermissions: this.autoApprovePermissions,
      // C4: the bridge marker. The orphan sweep at boot identifies OUR
      // bridge's leftover agy children by exactly this variable -- it is
      // the only thing that distinguishes them from any other process.
      env: { CAGE_AGY_BRIDGE: this.bridgeMarker },
    });
    const session = { client, effort, turnSeq: 0, turn: null, workspaceDir, rawId: conversationId, initPromise: null, ownTurnTexts: new Set(), watcher: null, idleSince: Date.now(), turnStartedAt: null, creatorConn: null, closeWhenIdle: null, cancelPending: false, closing: false, closePromise: null, lastExitAt: null };
    this._pending.add(session);
    session.initPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`agy did not initialize within ${this.initTimeoutMs}ms (agyBin=${this.agyBin})`)), this.initTimeoutMs);
      const onInit = (msg) => {
        if (msg.event !== 'init') return;
        clearTimeout(timer);
        client.off('event', onInit);
        client.off('exit', onExit);
        // The conversation id is only KNOWN once init arrives for a fresh
        // spawn (agy assigns it, not us) -- and init is also the ONLY event
        // carrying it top-level: step_update/result nest it inside their
        // payload (VERIFIED LIVE). Stash the resolved id on the session so
        // every later event correlates, and register the session under it --
        // that registration is what keeps a follow-up sendMessage from
        // spawning a SECOND process for the same conversation.
        session.rawId = conversationId ?? msg.conversation_id;
        this._sessions.set(session.rawId, session);
        this._pending.delete(session);
        this._armReaper();
        this._startWatcher(session);
        // Auto-mode sanity check (VERIFIED LIVE: skip-permissions shows up as
        // init.permission_mode "always-proceed"; headless sessions without
        // the flag show "request-review"). A mismatch is a loud warn, not an
        // error: it means AUTO_APPROVE_PERMISSIONS and the seeded settings
        // disagree, which the operator should know about.
        if (this.autoApprovePermissions && msg.init?.permission_mode !== 'always-proceed') {
          this.emit('warn', `session ${msg.conversation_id} initialized with permission_mode=${msg.init?.permission_mode} -- expected always-proceed (auto mode); tool calls may stall on suppressed prompts`);
        }
        resolve(msg);
      };
      const onExit = (info) => {
        clearTimeout(timer);
        reject(new Error(`agy exited (code=${info.code} signal=${info.signal}${info.error ? ` ${info.error.message}` : ''}) before initializing -- check AGY_BIN and the agy credential under AGY_HOME`));
      };
      client.on('event', onInit);
      client.once('exit', onExit);
      client.on('exit', (info) => this._onChildExit(session, info));
      client.on('event', (msg) => this._onEvent(session, msg));
      client.on('stderr', (text) => this.emit('stderr', text));
      client.on('parseError', (info) => this.emit('warn', `unparseable line from agy: ${info.error.message}: ${info.line.slice(0, 200)}`));
      client.on('agyError', (err) => this._onAgyError(err));
      client.start(conversationId);
    });
    return session;
  }

  // The live child for a session, respawning (resume form: --conversation)
  // when a previous child exited -- after closeConversation, a crash, an
  // effort change, or a SIGTERM cancel. Throws when the respawn itself fails
  // (init never arrives), which startTurn's catch reports to the topic.
  async _runningSession(sessionId) {
    const rawId = rawSessionId(sessionId);
    let session = this._sessions.get(rawId);
    if (!session || !this._isLive(session) || session.cancelPending) {
      // cancelPending: the child was SIGTERM-cancelled and agy exits on a
      // cancel (VERIFIED LIVE, battery (f)) -- but its exit event may still
      // be in flight, so a "live" hit here would write the next turn into a
      // child on its way out (an EPIPE, or a message swallowed by its
      // death). Respawn instead; the dying entry is replaced at init.
      session = await this._spawn({ workspaceDir: session?.workspaceDir ?? this.cwd, effort: session?.effort ?? this.effort, conversationId: rawId });
      await session.initPromise;
    }
    return session;
  }

  _onChildExit(session, info) {
    // The watcher dies with the child too: the --remote-control tunnel is
    // the child's, so nothing can journal new dashboard turns while it is
    // down (a respawn starts a fresh watcher with a fresh tail cursor).
    session.watcher?.stop();
    this._pending.delete(session); // died before init: its cap slot goes back
    session.lastExitAt = Date.now();
    session.closeWhenIdle = null; // the child is already gone; nothing left to close
    session.cancelPending = false; // the doom it recorded has materialized
    // A child exiting mid-turn (crash, OOM, SIGKILL) must end that turn with
    // a failed terminal -- index.js's watchdog is off by default, so without
    // this the topic would sit on its placeholder forever. The normal paths
    // (SIGTERM cancel, stop()) produce a result envelope BEFORE exit; only
    // an exit with no terminal yet emits one here.
    if (session.turn && session.rawId) {
      const turnId = session.turn.id;
      session.turn = null;
      this._emitTelemetry(makeSessionId('antigravity', session.rawId), turnId, 'turn.terminal', {
        status: 'failed',
        errorCode: `agy_exit:code=${info.code},signal=${info.signal}`,
      });
    }
  }

  // Quota errors arrive twice (the AGY_ERROR stderr line and the result
  // envelope's error text); stash the structured one for usage_get. No
  // numeric remaining-quota surface exists headless (VERIFIED LIVE, battery
  // (e): quota state is server-side, /usage is TUI-only) -- this is the
  // "last quota error" half of the antigravity usage_get contract.
  _onAgyError(err) {
    if (err?.status === 'RESOURCE_EXHAUSTED' || /quota|resource.?exhaust/i.test(err?.short_error || '')) {
      this._lastQuotaError = { at: new Date().toISOString(), status: err.status ?? null, error: err.short_error };
      this.emit('warn', `agy quota error: ${err.short_error}`);
    }
  }

  // --- dashboard turns (conversation-store watcher) ---

  // Tails the session's conversation .db for turns typed in the
  // antigravity.google dashboard. MEASURED (conversation-db-notes.md): those
  // turns and their replies never appear on agy's stream-json stdout -- they
  // are journalled only in the SQLite store, and --remote-control sessions
  // run them while this bridge sits idle. Emitted as session/event payloads
  // of kind 'dashboard_message' ({role, origin:'dashboard', text}) which
  // index.js notes into the MCP reply log -- the session's reply stream.
  _startWatcher(session) {
    if (session.watcher) return;
    const watcher = new ConversationWatcher({
      dbPath: conversationDbPath(this.agyHome, session.rawId),
      turnInFlight: () => session.turn != null,
      ownTurnUserTexts: () => session.ownTurnTexts,
      startCursor: this.watchStartCursor,
    });
    watcher.on('dashboard_turn', (turn) => this._emitDashboardTurn(session, turn));
    // Degradations are warnings, never errors: a session that cannot be
    // watched still turns fine over stdin -- the watcher is an ear, not a
    // limb.
    watcher.on('stalled', (m) => this.emit('warn', `conversation store watcher: ${m}`));
    watcher.on('unavailable', (m) => this.emit('warn', `conversation store watcher: ${m}`));
    session.watcher = watcher;
    watcher.start();
  }

  _emitDashboardTurn(session, turn) {
    const sessionId = makeSessionId('antigravity', session.rawId ?? '');
    // turnId is informational (index.js correlates only turns it started);
    // `dashboard:<idx>` names the store row it came from.
    this.emit('event', {
      method: 'session/event',
      params: {
        sessionId,
        turnId: `dashboard:${turn.idx}`,
        payload: { kind: 'dashboard_message', role: turn.role, origin: 'dashboard', text: turn.text, at: turn.at },
      },
    });
  }

  // --- event translation: agy's init/step_update/result -> the shared
  // session/event + v4/telemetry/event vocabulary bridge/backend.js
  // documents ---

  _onEvent(session, msg) {
    // session.rawId is the resolved conversation id (spawn argument, or the
    // id init assigned -- see _spawn). Events before init have no turn to
    // attach to anyway.
    const sessionId = makeSessionId('antigravity', session.rawId ?? '');
    switch (msg.event) {
      case 'init':
        return; // consumed by the spawn-time initPromise; nothing to stream
      case 'step_update':
        return this._onStepUpdate(session, sessionId, msg.step_update ?? {});
      case 'result':
        return this._onResult(session, sessionId, msg.result ?? {});
      default:
        return; // unknown event kinds are ignored deliberately (forward-compat)
    }
  }

  _onStepUpdate(session, sessionId, step) {
    if (!session.turn) return; // a step for a turn we never started (or already ended) -- nothing to attach it to
    const turnId = session.turn.id;
    // VERIFIED LIVE (battery (b)): tool steps come as
    // {step_type:"tool", tool_name, state ACTIVE->DONE, tool_info:{parameters:
    // {CommandLine}, output}} -- full tool visibility, richer than codex
    // items. agent_response steps stream text via repeated `text_delta`s.
    if (step.step_type === 'tool' && step.state === 'ACTIVE') {
      const toolCallId = `${turnId}:step${step.step_index}`;
      session.turn.toolCallIds.set(step.step_index, toolCallId);
      session.turn.toolCallCount++;
      const command = step.tool_info?.parameters?.CommandLine;
      this._emitSession(sessionId, turnId, {
        kind: 'started',
        toolName: step.tool_name ?? 'tool',
        toolCallId,
        ...(command ? { input: { command } } : {}),
      });
      return;
    }
    if (step.step_type === 'tool' && step.state === 'DONE') {
      const toolCallId = session.turn.toolCallIds.get(step.step_index) ?? `${turnId}:step${step.step_index}`;
      this._emitSession(sessionId, turnId, { kind: 'result', toolCallId, toolName: step.tool_name ?? 'tool' });
      return;
    }
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
      this._emitSession(sessionId, turnId, { kind: 'text_delta', delta: step.text_delta });
    }
    // user_input / system_message / agent_response DONE (no delta) carry
    // step-level usage only -- the turn-total usage in the result envelope
    // is the authoritative number (battery (e)) and is what we account on.
  }

  _onResult(session, sessionId, result) {
    const turn = session.turn;
    // THE CANCEL IS THE VERDICT: a SIGTERM was already requested for this
    // turn, so an envelope that races in after the signal -- a SUCCESS that
    // was already in the pipe when the cancel landed -- does not un-cancel
    // it. The turn ends failed/interrupted exactly as the deliberate
    // interrupt envelope would; usage is still accounted (the spend
    // happened either way).
    const cancelled = turn != null && session.cancelPending === true;
    session.turn = null;
    // C1: the idle clock runs from the END of the last turn -- the result
    // event -- not from the turn's start.
    session.idleSince = Date.now();
    // VERIFIED LIVE (battery (a)): the final envelope carries the turn-total
    // usage block: {input_tokens, output_tokens, thinking_tokens,
    // cache_read_tokens, total_tokens}.
    const usage = {
      inputTokens: result.usage?.input_tokens ?? null,
      outputTokens: result.usage?.output_tokens ?? null,
      totalTokens: result.usage?.total_tokens ?? null,
    };
    this._usage.turns++;
    this._usage.inputTokens += usage.inputTokens ?? 0;
    this._usage.outputTokens += usage.outputTokens ?? 0;
    this._usage.totalTokens += usage.totalTokens ?? 0;
    // Quota exhaustion surfaces as an ERROR envelope (design doc §4); stash
    // for usage_get the same way the stderr tap does.
    if (result.status !== 'SUCCESS' && result.error && /quota|resource.?exhaust/i.test(result.error)) {
      this._lastQuotaError = { at: new Date().toISOString(), status: result.status, error: result.error };
    }
    if (!turn) return; // terminal already emitted via _onChildExit; nothing to double-emit
    const success = cancelled ? 'failed' : statusOf(result);
    // The turn's final answer: {response, usage} together is the shared
    // vocabulary's "authoritative full-turn text + cumulative usage" shape
    // (backend.js; index.js reads exactly this pair).
    if (success === 'success') {
      this._emitSession(sessionId, turn.id, { kind: 'result', response: result.response ?? '', usage });
    } else {
      this._emitSession(sessionId, turn.id, { kind: 'result', error: { message: cancelled ? 'interrupted' : (result.error || result.status || 'agy error') } });
    }
    this._emitTelemetry(sessionId, turn.id, 'usage.delta', {
      requestId: turn.id,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    this._emitTelemetry(sessionId, turn.id, 'turn.terminal', {
      status: success,
      errorCode: success === 'success' ? undefined : cancelled ? 'ERROR: interrupted' : [result.status, result.error].filter(Boolean).join(': '),
      durationMs: Number.isFinite(result.duration_seconds) ? Math.round(result.duration_seconds * 1000) : undefined,
      tokenCount: usage.totalTokens ?? undefined,
      toolCallCount: turn.toolCallCount,
    });
    // C2: a creator-gone close parked on this BUSY session fires here, the
    // moment the turn ends. Synchronous on purpose: no turn can start in
    // between (a queued message_send resolves only after this unwind), so
    // the close cannot land on a turn that is already the next caller's.
    if (session.closeWhenIdle && this._isLive(session)) this._gcClose(session, session.closeWhenIdle);
  }

  // --- local usage accounting for usage_get ---

  // Bridge-local token totals since this backend was constructed, plus the
  // last quota error. NO remaining-quota number exists headless (battery
  // (e)): the windows in index.js's antigravityUsageSnapshot carry used=null
  // percentages=null rather than an invented figure, and the description of
  // the usage_get tool says so.
  usageSnapshot() {
    return { ...this._usage, lastQuotaError: this._lastQuotaError };
  }

  _emitSession(sessionId, turnId, payload) {
    this.emit('event', { method: 'session/event', params: { sessionId, turnId, payload } });
  }

  _emitTelemetry(sessionId, turnId, kind, extra = {}) {
    this.emit('event', { method: 'v4/telemetry/event', params: { sessionId, turnId, kind, ...extra } });
  }
}
