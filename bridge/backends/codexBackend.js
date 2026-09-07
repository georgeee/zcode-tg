// The Codex Backend: talks to `codex app-server` (real JSON-RPC 2.0, over
// stdio) via bridge/codexClient.js, and translates its "threads and turns"
// model onto the shared session/turn vocabulary bridge/backend.js documents
// -- the same one zcodeBackend.js already speaks, so bridge/index.js's
// streaming/watchdog/breaker/queueing logic works unchanged regardless of
// which backend a given topic runs on.
//
// Protocol facts below are cited by evidence tier, exactly as they were
// established (see the parent task's research pass):
//   VERIFIED LIVE    -- personally sent/received this exact shape against a
//                       real `codex app-server` (0.153.4), authenticated
//                       with a real ChatGPT-Plus credential.
//   FROM SCHEMA DUMP -- `codex app-server generate-json-schema --experimental`
//                       / `generate-ts --experimental`, the authoritative
//                       machine-readable protocol definition.
//   FROM SOURCE      -- read directly from github.com/openai/codex
//                       (codex-rs/app-server-protocol, codex-rs/protocol).
//   INFERRED         -- not directly verified; flagged inline.

import { readFileSync } from 'node:fs';
import { Backend, makeSessionId, rawSessionId } from '../backend.js';
import { CodexClient } from '../codexClient.js';

function truncate(s, max) {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Tool-ish ThreadItem types (FROM SCHEMA DUMP, ThreadItem.ts's discriminated
// union) -- worth a streamed "🔧 …" status line and a turn.toolCallCount tick,
// the same way zcode's tool_call/result events are. userMessage/agentMessage/
// reasoning/plan items are handled via their own dedicated notifications
// (item/agentMessage/delta, item/reasoning/*Delta) instead.
const TOOL_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall']);

function toolLabelFor(item) {
  if (item.type === 'commandExecution') return truncate(item.command || 'shell', 60);
  if (item.type === 'fileChange') return 'file_change';
  if (item.type === 'mcpToolCall') return `${item.server}.${item.tool}`;
  if (item.type === 'dynamicToolCall') return item.tool || 'tool';
  return item.type;
}

export class CodexBackend extends Backend {
  constructor({ codexBin, codexHome, cwd, autoApprovePermissions }) {
    super('codex');
    this.cwd = cwd;
    this.autoApprovePermissions = autoApprovePermissions;
    this.client = new CodexClient({ codexBin, codexHome, cwd });
    this._activeTurn = new Map(); // rawThreadId -> current turnId
    this._toolCallCounts = new Map(); // rawThreadId -> count, reset per turn
    this._modelOverride = new Map(); // rawThreadId -> model, set by setModel()

    this.client.on('event', (msg) => this._onEvent(msg));
    this.client.on('exit', (info) => this.emit('exit', info));
    this.client.on('stderr', (text) => this.emit('stderr', text));
    this.client.on('parseError', (info) => this.emit('parseError', info));
  }

  async start() {
    this.client.start();
    // initialize handshake (VERIFIED LIVE): clientInfo is required,
    // capabilities was omitted in the verified call and the server accepted
    // it fine, so it's left out here rather than guessing a shape for it.
    await this.client.call('initialize', {
      clientInfo: { name: 'zcode-tg-bridge', version: '0.1.0', title: null },
    });
    // The 'initialized' notification is the only ClientNotification variant
    // (FROM SCHEMA DUMP) and is MCP-handshake-shaped; not proven mandatory
    // (a probe's thread/start succeeded either way), sent anyway since it
    // costs nothing and matches the convention it appears to follow.
    this.client.notify('initialized', {});
    return this;
  }

  async stop() {
    this.client.stop();
  }

  // --- session lifecycle ---

  async createConversation({ workspaceDir, model }) {
    // approvalPolicy/sandbox here are this backend's OWN realization of the
    // bridge's existing cross-backend safety knob (autoApprovePermissions,
    // "run yolo-equivalent") -- not an attempt to map zcode's unrelated mode
    // enum onto Codex's sandbox model (see codexBackend's header + README).
    // Default codex behavior (approvalPolicy 'on-request', sandbox
    // 'read-only' -- VERIFIED LIVE) blocks every shell/file-write action on
    // a mid-turn approval request; 'never' + 'danger-full-access' is the
    // explicit choice that makes Codex sessions behave like zcode's yolo
    // default. When auto-approve is off, Codex's own defaults stand, and
    // onPermissionRequest's interactive Telegram flow (shared with zcode)
    // is the fallback -- mirroring AUTO_APPROVE_PERMISSIONS=false there.
    const params = {
      cwd: workspaceDir,
      ...(model ? { model } : {}),
      ...(this.autoApprovePermissions ? { approvalPolicy: 'never', sandbox: 'danger-full-access' } : {}),
    };
    const res = await this.client.call('thread/start', params);
    const rawId = res.thread.id;
    if (model) this._modelOverride.set(rawId, model);
    return { sessionId: makeSessionId('codex', rawId), model: res.model ?? model, mode: undefined };
  }

  async resumeConversation(sessionId, { model }) {
    const rawId = rawSessionId(sessionId);
    // excludeTurns: true per the schema's own deprecation notice ("Full-
    // history hydration is deprecated for paginated threads") -- confirmed
    // live: emits a deprecationNotice notification when NOT set. The bridge
    // doesn't need turn history back from resume; the thread itself
    // (context) is what's being reattached, exactly like zcode's
    // session/resume.
    const res = await this.client.call('thread/resume', {
      threadId: rawId,
      excludeTurns: true,
      ...(model ? { model } : {}),
    });
    if (model) this._modelOverride.set(rawId, model);
    return { sessionId: makeSessionId('codex', res.thread?.id ?? rawId) };
  }

  // No explicit subscribe call exists in this protocol (FROM SCHEMA DUMP: no
  // such method) -- thread/turn notifications stream over the one
  // connection unconditionally once a thread is started/resumed on it.
  async subscribe() {}

  async sendMessage(sessionId, text) {
    const rawId = rawSessionId(sessionId);
    const model = this._modelOverride.get(rawId);
    // NOTE (VERIFIED LIVE, worth flagging for anyone touching this): calling
    // turn/start again on a thread whose previous turn hasn't yet emitted
    // turn/completed does NOT start a new turn -- it steers the existing
    // one. Not a problem here because index.js's busySessions guard never
    // calls sendMessage again for a session until its current turn's
    // terminal event has fired.
    await this.client.call('turn/start', {
      threadId: rawId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(model ? { model } : {}),
    });
  }

  async cancel(sessionId) {
    const rawId = rawSessionId(sessionId);
    const turnId = this._activeTurn.get(rawId);
    if (!turnId) return; // nothing running -- turn/interrupt needs a turnId
    await this.client.call('turn/interrupt', { threadId: rawId, turnId });
  }

  async closeConversation() {
    // No destructive action taken: an idle Codex thread costs nothing (no
    // evidence otherwise, unlike zcode's session/close which the runtime
    // treats as a real lifecycle event) and thread/archive's effect on a
    // resumability wasn't verified -- leaving threads alone is the
    // conservative choice until that's checked.
  }

  async cancelBackgroundTask() {
    // Codex has no equivalent to zcode's background-task concept.
  }

  async setModel(sessionId, model) {
    // No dedicated "set the thread's model" RPC independent of running a
    // turn (FROM SCHEMA DUMP: thread/start's docstring for the analogous
    // field says a turn/start override applies "for this turn and
    // subsequent turns" -- there's no bare setter). Cached and applied as a
    // per-turn override on the next sendMessage() instead of forcing a turn
    // to be sent just to change a setting.
    this._modelOverride.set(rawSessionId(sessionId), model);
  }

  async setMode() {
    // Deliberately a no-op: Codex has no concept resembling zcode's mode
    // enum (plan/edit/yolo/...), and approval/sandbox policy -- the nearest
    // adjacent concept -- is already exposed on its own terms via
    // createConversation's autoApprovePermissions handling above. Mapping
    // "mode" onto it would be exactly the fake mapping the task said not to
    // force. index.js's /mode command reports "not supported" for a Codex
    // session rather than pretending this did something.
  }

  async listModels() {
    const res = await this.client.call('model/list', {});
    return (res.data ?? []).map((m) => ({ ref: m.model, label: m.displayName || m.model }));
  }

  listModes() {
    return []; // no mode concept -- see setMode()
  }

  // --- event translation: Codex's threads/turns/items -> the shared
  // session/event + v4/telemetry/event vocabulary bridge/backend.js
  // documents (the one zcode's own protocol already speaks natively). ---
  _onEvent({ method, params }) {
    switch (method) {
      case 'turn/started': {
        // TurnStartedNotification = {threadId, turn} (FROM SCHEMA DUMP).
        const sessionId = makeSessionId('codex', params.threadId);
        this._activeTurn.set(params.threadId, params.turn.id);
        this._toolCallCounts.set(params.threadId, 0);
        this._emitTelemetry(sessionId, params.turn.id, 'turn.started');
        return;
      }
      case 'item/started': {
        const item = params.item;
        if (!TOOL_ITEM_TYPES.has(item.type)) return;
        const n = (this._toolCallCounts.get(params.threadId) ?? 0) + 1;
        this._toolCallCounts.set(params.threadId, n);
        this._emitSession(makeSessionId('codex', params.threadId), params.turnId, {
          kind: 'started',
          toolName: toolLabelFor(item),
          toolCallId: item.id,
        });
        return;
      }
      case 'item/completed': {
        const item = params.item;
        const sessionId = makeSessionId('codex', params.threadId);
        if (TOOL_ITEM_TYPES.has(item.type)) {
          this._emitSession(sessionId, params.turnId, { kind: 'result', toolCallId: item.id, toolName: toolLabelFor(item) });
        } else if (item.type === 'agentMessage' && item.text) {
          // Authoritative final text for this message item -- emitted
          // alongside the deltas already accumulated (mirrors zcode's own
          // {content} fallback event, which the generic dispatch in
          // index.js already knows how to treat as "the reply text").
          this._emitSession(sessionId, params.turnId, { kind: 'result', content: item.text });
        }
        return;
      }
      case 'item/agentMessage/delta': {
        // AgentMessageDeltaNotification = {threadId, turnId, itemId, delta}.
        this._emitSession(makeSessionId('codex', params.threadId), params.turnId, { kind: 'text_delta', delta: params.delta });
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        this._emitSession(makeSessionId('codex', params.threadId), params.turnId, { kind: 'reasoning_delta' });
        return;
      }
      case 'thread/tokenUsage/updated': {
        // ThreadTokenUsageUpdatedNotification = {threadId, turnId,
        // tokenUsage: {total, last, modelContextWindow}} (FROM SCHEMA DUMP,
        // ThreadTokenUsage.ts / TokenUsageBreakdown.ts). `last` is this
        // turn's own breakdown (not the thread-cumulative `total`) -- using
        // it keyed by turnId means a later event for the same turn simply
        // overwrites with the latest, correct final tally, the same way
        // zcode's usage.delta-per-requestId accumulation already works.
        const last = params.tokenUsage?.last;
        if (!last) return;
        this._emitTelemetry(makeSessionId('codex', params.threadId), params.turnId, 'usage.delta', {
          requestId: params.turnId,
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
        });
        return;
      }
      case 'turn/completed': {
        // TurnCompletedNotification = {threadId, turn: Turn}.
        const { threadId, turn } = params;
        const sessionId = makeSessionId('codex', threadId);
        const toolCallCount = this._toolCallCounts.get(threadId) ?? 0;
        this._activeTurn.delete(threadId);
        this._toolCallCounts.delete(threadId);
        const success = turn.status === 'completed';
        this._emitTelemetry(sessionId, turn.id, 'turn.terminal', {
          status: success ? 'success' : 'failed',
          errorCode: success ? undefined : (turn.status ?? 'unknown_error'),
          durationMs: turn.durationMs ?? undefined,
          toolCallCount,
        });
        if (!success && turn.error) {
          const message = typeof turn.error === 'string' ? turn.error : turn.error.message;
          this._emitSession(sessionId, turn.id, { kind: 'result', error: { message } });
        }
        return;
      }
      case 'error': {
        // ErrorNotification = {error, willRetry, threadId, turnId}.
        this._emitSession(makeSessionId('codex', params.threadId), params.turnId, {
          error: { message: typeof params.error === 'string' ? params.error : params.error?.message },
        });
        return;
      }
      default:
        return; // everything else (mcpServer/*, account/*, thread/status/changed, ...) is not needed by index.js today
    }
  }

  _emitSession(sessionId, turnId, payload) {
    this.emit('event', { method: 'session/event', params: { sessionId, turnId, payload } });
  }

  _emitTelemetry(sessionId, turnId, kind, extra = {}) {
    this.emit('event', { method: 'v4/telemetry/event', params: { sessionId, turnId, kind, ...extra } });
  }

  // --- approval relay ---
  // Default createConversation() config (approvalPolicy:'never', sandbox:
  // 'danger-full-access') should mean these rarely if ever fire -- wired
  // anyway as the same "second, independent safety net" zcode's bridge
  // keeps for interaction/requestPermission (see README's "Permissions /
  // safety model"). Every method here is a server-initiated REQUEST (has an
  // id, expects a response), confirmed live for item/commandExecution/
  // requestApproval; the rest are FROM SCHEMA DUMP only.
  onPermissionRequest(handler) {
    this.client.onServerRequest('item/commandExecution/requestApproval', async (params) => {
      const sessionId = makeSessionId('codex', params.threadId);
      const chosen = await handler({
        sessionId,
        requestId: `codex:cmd:${params.itemId}:${params.approvalId ?? ''}`,
        toolName: 'shell',
        riskLevel: 'unknown',
        reason: params.reason || `run: ${truncate(params.command || '(unknown command)', 300)}`,
        input: { command: params.command, cwd: params.cwd },
        options: [
          { name: 'Allow', response: { decision: 'allow' } },
          { name: 'Deny', response: { decision: 'deny' } },
        ],
      });
      return { decision: chosen?.decision === 'allow' ? 'accept' : 'decline' };
    });

    this.client.onServerRequest('item/fileChange/requestApproval', async (params) => {
      const sessionId = makeSessionId('codex', params.threadId);
      const chosen = await handler({
        sessionId,
        requestId: `codex:filechange:${params.itemId}`,
        toolName: 'file_change',
        riskLevel: 'unknown',
        reason: params.reason || 'apply a file change',
        input: {},
        options: [
          { name: 'Allow', response: { decision: 'allow' } },
          { name: 'Deny', response: { decision: 'deny' } },
        ],
      });
      return { decision: chosen?.decision === 'allow' ? 'accept' : 'decline' };
    });

    // Legacy pair (FROM SCHEMA DUMP, explicitly documented there as "used
    // for Turns started via the legacy APIs" -- kept anyway since they cost
    // little and the schema still defines them for this version).
    this.client.onServerRequest('execCommandApproval', async (params) => {
      const sessionId = makeSessionId('codex', params.conversationId);
      const chosen = await handler({
        sessionId,
        requestId: `codex:execlegacy:${params.callId}`,
        toolName: 'shell',
        riskLevel: 'unknown',
        reason: params.reason || `run: ${truncate((params.command || []).join(' '), 300)}`,
        input: { command: params.command, cwd: params.cwd },
        options: [
          { name: 'Allow', response: { decision: 'allow' } },
          { name: 'Deny', response: { decision: 'deny' } },
        ],
      });
      return { decision: chosen?.decision === 'allow' ? 'approved' : { denied: { rejection: 'bridge auto-declined' } } };
    });

    this.client.onServerRequest('applyPatchApproval', async (params) => {
      const sessionId = makeSessionId('codex', params.conversationId);
      const chosen = await handler({
        sessionId,
        requestId: `codex:patchlegacy:${params.callId}`,
        toolName: 'file_change',
        riskLevel: 'unknown',
        reason: params.reason || 'apply a file patch',
        input: {},
        options: [
          { name: 'Allow', response: { decision: 'allow' } },
          { name: 'Deny', response: { decision: 'deny' } },
        ],
      });
      return { decision: chosen?.decision === 'allow' ? 'approved' : { denied: { rejection: 'bridge auto-declined' } } };
    });

    // item/permissions/requestApproval exists in the schema (a mid-turn
    // request for additional filesystem/network permissions) but its exact
    // params/response shape was not verified live or read from source in
    // the time available -- UNVERIFIED best-effort fallback: decline in a
    // shape that matches the sibling *ApprovalDecision enums (a bare
    // "decline" string). Flagged for whoever next touches this: confirm the
    // real response shape before relying on this path.
    this.client.onServerRequest('item/permissions/requestApproval', async () => ({ decision: 'decline' }));
  }

  // No onUserInputRequest wiring: Codex's nearest equivalent
  // (item/tool/requestUserInput) is marked EXPERIMENTAL in the schema dump
  // and its live shape was not established -- left unimplemented rather
  // than guessed. A base-class no-op means it simply never fires for a
  // Codex session; see this repo's PR/report for the open-question note.

  killLocalToolProcesses() {
    // Not implemented: unlike zcode's runtime, nothing confirms Codex's own
    // subprocess command lines embed a recognizable session/thread id, so a
    // /proc-based hard-kill here would risk matching the wrong process
    // entirely. turn/interrupt (cancel(), above) is the real stop signal;
    // see this repo's report for what this means for Telegram's hard /stop
    // on a Codex session specifically.
  }
}
