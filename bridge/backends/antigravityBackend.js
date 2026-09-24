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

import { Backend, makeSessionId, rawSessionId } from '../backend.js';
import { AntigravityClient, AGY_SETTINGS_DEFAULTS, ensureAgySettings } from '../antigravityClient.js';
import { ConversationWatcher, conversationDbPath } from '../conversationStore.js';

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

export class AntigravityBackend extends Backend {
  constructor({ agyBin, agyHome, cwd, effort = 'medium', autoApprovePermissions = true, remoteControl = true, initTimeoutMs = 90_000, watchStartCursor = null }) {
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
    // rawId (conversation uuid) -> session state:
    //   { client, effort, turnSeq, turn: {id, toolCallIds: Map} | null,
    //     ownTurnTexts: Set (our recent stdin texts -- the watcher's
    //     late-poll guard), watcher: ConversationWatcher | null }
    this._sessions = new Map();
    this._usage = { since: Date.now(), turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this._lastQuotaError = null;
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

  async stop() {
    for (const [, s] of this._sessions) {
      s.watcher?.stop();
      s.client.stop();
    }
  }

  // --- session lifecycle ---

  // Spawns a fresh agy conversation and waits for its `init` event (the only
  // place the conversation id comes from -- VERIFIED LIVE: init carries
  // {conversation_id, init:{model, cwd, tools, permission_mode}}).
  async createConversation({ workspaceDir, model } = {}) {
    const parsed = parseAgyModelRef(model ?? AGY_MODEL_REF);
    if (!parsed) throw this._badModelRefError(model);
    const session = this._spawn({ workspaceDir: workspaceDir ?? this.cwd, effort: parsed.effort ?? this.effort });
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
    if (existing && !existing.client.exited) return { sessionId };
    const parsed = parseAgyModelRef(model ?? AGY_MODEL_REF);
    if (!parsed) throw this._badModelRefError(model);
    const session = this._spawn({
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

  // Fire-and-forget per the Backend contract: writes ONE user turn object to
  // the session's stdin; the reply streams back as 'event' emissions ending
  // in v4/telemetry/event turn.terminal.
  async sendMessage(sessionId, text) {
    const session = await this._runningSession(sessionId);
    const turnId = `${rawSessionId(sessionId)}:${++session.turnSeq}`;
    session.turn = { id: turnId, toolCallIds: new Map(), toolCallCount: 0 };
    // The watcher's late-poll guard needs our recent stdin texts: a poll
    // landing after this turn finished would otherwise read its user row as
    // dashboard-origin (no turn in flight any more). Capped -- it is a
    // membership set, not a transcript.
    session.ownTurnTexts.add(text);
    if (session.ownTurnTexts.size > 16) session.ownTurnTexts.delete(session.ownTurnTexts.values().next().value);
    // turn.started FIRST: index.js correlates a turn's events on the turnId
    // learned from this event, and adopts backend-initiated turns from it.
    this._emitTelemetry(makeSessionId('antigravity', rawSessionId(sessionId)), turnId, 'turn.started');
    session.client.sendUserTurn(text);
  }

  // Abort the in-flight turn: SIGTERM. agy answers with a structured
  // {"status":"ERROR","error":"interrupted"} result (VERIFIED LIVE, battery
  // (f)) which flows through the normal result -> turn.terminal path; the
  // conversation survives for later turns.
  async cancel(sessionId) {
    const session = this._sessions.get(rawSessionId(sessionId));
    if (session && session.turn) session.client.kill('SIGTERM');
  }

  // Stop the child but keep the conversation: agy's state is the SQLite db
  // under the HOME, so closing costs nothing upstream (an idle agy process
  // is the only thing being released). A later sendMessage respawn-resumes.
  async closeConversation(sessionId) {
    const rawId = rawSessionId(sessionId);
    const session = this._sessions.get(rawId);
    if (session) {
      session.watcher?.stop();
      session.client.stop();
      this._sessions.delete(rawId);
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
      session.watcher?.stop();
      session.client.stop();
      this._sessions.delete(rawId);
    }
    const fresh = this._spawn({ workspaceDir, effort: parsed.effort, conversationId: rawId });
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
  _spawn({ workspaceDir, effort, conversationId = null }) {
    const client = new AntigravityClient({
      agyBin: this.agyBin,
      agyHome: this.agyHome,
      cwd: workspaceDir,
      model: AGY_MODEL_REF,
      effort,
      remoteControl: this.remoteControl,
      skipPermissions: this.autoApprovePermissions,
    });
    const session = { client, effort, turnSeq: 0, turn: null, workspaceDir, rawId: conversationId, initPromise: null, ownTurnTexts: new Set(), watcher: null };
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
  // when a previous child exited -- after closeConversation, a crash, or an
  // effort change. Throws when the respawn itself fails (init never
  // arrives), which startTurn's catch reports to the topic.
  async _runningSession(sessionId) {
    const rawId = rawSessionId(sessionId);
    let session = this._sessions.get(rawId);
    if (!session || session.client.exited) {
      session = this._spawn({ workspaceDir: session?.workspaceDir ?? this.cwd, effort: session?.effort ?? this.effort, conversationId: rawId });
      await session.initPromise;
    }
    return session;
  }

  _onChildExit(session, info) {
    // The watcher dies with the child too: the --remote-control tunnel is
    // the child's, so nothing can journal new dashboard turns while it is
    // down (a respawn starts a fresh watcher with a fresh tail cursor).
    session.watcher?.stop();
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
    session.turn = null;
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
    const success = statusOf(result);
    // The turn's final answer: {response, usage} together is the shared
    // vocabulary's "authoritative full-turn text + cumulative usage" shape
    // (backend.js; index.js reads exactly this pair).
    if (success === 'success') {
      this._emitSession(sessionId, turn.id, { kind: 'result', response: result.response ?? '', usage });
    } else {
      this._emitSession(sessionId, turn.id, { kind: 'result', error: { message: result.error || result.status || 'agy error' } });
    }
    this._emitTelemetry(sessionId, turn.id, 'usage.delta', {
      requestId: turn.id,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    this._emitTelemetry(sessionId, turn.id, 'turn.terminal', {
      status: success,
      errorCode: success === 'success' ? undefined : [result.status, result.error].filter(Boolean).join(': '),
      durationMs: Number.isFinite(result.duration_seconds) ? Math.round(result.duration_seconds * 1000) : undefined,
      tokenCount: usage.totalTokens ?? undefined,
      toolCallCount: turn.toolCallCount,
    });
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
