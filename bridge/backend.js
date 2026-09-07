// The backend contract: what bridge/index.js needs from "a thing that runs
// agentic turns" -- extracted from what zcodeClient.js + index.js already
// did implicitly for zcode alone, so a second backend (Codex) can be added
// without index.js caring which one a given topic/session actually runs.
//
// Every backend is a long-lived EventEmitter, one instance per backend KIND
// (not per session) -- exactly like the single `zcode app-server` process
// today: one subprocess multiplexes every session/thread of that kind. A
// session id a backend hands back from createConversation()/resumeConversation()
// is a PREFIXED, globally-unique string ("zcode:<raw-id>", "codex:<raw-id>")
// -- see backendNameOf()/rawSessionId() below -- so index.js's existing
// sessionId-keyed Maps (activeTurns, busySessions, sessionToTopic, ...) keep
// working unchanged regardless of how many backend kinds are live at once,
// with no risk of two backends' own internal ids colliding.
//
// EVENTS: a backend emits 'event' with messages shaped EXACTLY like zcode's
// own wire protocol -- because that shape already carries everything
// index.js's turn/streaming/watchdog/breaker logic needs, and every field it
// reads was already being read off zcode's raw payloads before this
// refactor. This file doesn't invent a new vocabulary; it writes down the
// one index.js already spoke, so a second backend can target it instead of
// index.js inventing a translation layer per backend kind:
//
//   { method: 'session/event', params: { sessionId, turnId, payload } }
//     payload.kind one of:
//       'text_delta'        { delta: string }
//       'reasoning_delta'   {}
//       'started'|'scheduled'|'tool_input_start'  { toolName, toolCallId }
//       'tool_call'         { toolName, toolCallId, input }  (input.block for
//                            the zcode-specific TaskOutput circuit breaker --
//                            harmless no-op for a backend with no such tool)
//       'result'            { toolCallId, toolName?, response?, usage?,
//                              content?, error?, tokenCount?, ... } --
//                            response+usage together mean "turn's final
//                            answer"; content alone means "last assistant
//                            message text, possibly mid-turn"
//       { taskId, status, description?, command? }  (no `kind`: background-
//                            task lifecycle snapshot -- backend-optional,
//                            no-op for a backend with no background-task
//                            concept)
//
//   { method: 'v4/telemetry/event', params: { sessionId, turnId, kind, ... } }
//     kind one of:
//       'turn.started'   -- also the signal index.js uses to adopt a turn it
//                           never itself started (a backend-initiated turn,
//                           e.g. zcode's background-task-notification restart)
//       'turn.terminal'  { status: 'success'|'failed'|..., errorCode?,
//                          durationMs?, tokenCount?, toolCallCount? }
//       'usage.delta'    { requestId, inputTokens, outputTokens }
//
// A backend that has no equivalent for a given field/kind simply never emits
// it -- every read site in index.js already treats these as optional.
//
// PERMISSION / USER-INPUT RELAY: onPermissionRequest(handler) registers a
// handler index.js supplies; the backend calls it whenever ITS OWN protocol
// asks the client to approve/deny a risky action (zcode:
// interaction/requestPermission; Codex: whatever its approval-request
// equivalent turns out to be, if any -- see bridge/backends/codexBackend.js).
// The handler receives a NORMALIZED request:
//   { sessionId, requestId, toolName, riskLevel, reason, input,
//     options: [{ name, response: { decision: 'allow'|'deny', permissionUpdates? } }] }
// and must resolve with the chosen option's `response` verbatim -- backends
// translate their own native approval reply into this {decision,
// permissionUpdates?} shape on the way in, and (if needed) back to their own
// native shape on the way out. zcode's own protocol already speaks exactly
// this shape, which is why it looks zcode-flavored: it's the one real
// backend's shape, formalized as the contract the next one has to match.
//
// onUserInputRequest(handler) is the same idea for the model's mid-turn
// "ask the user a question" tool (zcode: interaction/requestUserInput).
// A backend with no such capability just never calls it -- there is no
// separate "not supported" signal needed since the handler is only ever
// invoked when the backend itself received such a request from its own
// runtime.

import { EventEmitter } from 'node:events';

export class Backend extends EventEmitter {
  constructor(name) {
    super();
    this.name = name; // 'zcode' | 'codex' -- also the sessionId prefix
  }

  async start() {}
  async stop() {}

  // opts: { workspaceDir, workspaceKey, model, mode }
  // -> { sessionId (PREFIXED), model, mode }
  async createConversation(_opts) {
    throw new Error(`${this.name}: createConversation not implemented`);
  }

  // sessionId is PREFIXED (this backend's own). Should raise if the backend
  // has no way to resume (or genuinely can't) -- callers fall back to a
  // fresh createConversation, same as the pre-refactor zcode-only behavor.
  async resumeConversation(_sessionId, _opts) {
    throw new Error(`${this.name}: resumeConversation not implemented`);
  }

  async subscribe(_sessionId) {}

  // Fire-and-forget: the reply streams back as 'event' emissions, ending in
  // a v4/telemetry/event turn.terminal.
  async sendMessage(_sessionId, _text) {
    throw new Error(`${this.name}: sendMessage not implemented`);
  }

  // Abort the in-flight turn (not necessarily anything it's currently
  // executing -- see killLocalToolProcesses for that stronger, optional stop).
  async cancel(_sessionId) {}

  async closeConversation(_sessionId) {}

  // Optional capability: a backend with no background-task concept leaves
  // this a no-op (the base class default).
  async cancelBackgroundTask(_sessionId, _taskId) {}

  // Optional: a backend with no per-session model switch (or none worth
  // exposing) leaves this a no-op rather than faking one up.
  async setModel(_sessionId, _model) {}

  // Optional: ditto for a mode concept Codex has no equivalent of.
  async setMode(_sessionId, _mode) {}

  // -> [{ ref: 'provider/model' | 'model', label, contextWindow? }]
  async listModels(_opts) {
    return [];
  }

  // -> [{ name, note? }] ; empty if the backend has no mode concept.
  listModes() {
    return [];
  }

  onPermissionRequest(_handler) {}
  onUserInputRequest(_handler) {}

  // Optional, stronger-than-cancel stop: kill whatever OS processes this
  // session's turn is CURRENTLY executing (see index.js's /stop handling for
  // why session-level cancel alone can't interrupt a tool call already in
  // flight). Backend-specific because it depends on being able to recognize
  // this session's own subprocesses -- zcode's do, by construction, embed
  // the raw session id on their command line; a backend that can't make the
  // same guarantee just leaves this a no-op rather than risk killing the
  // wrong thing.
  killLocalToolProcesses(_rawSessionId) {}
}

// Session ids handed to index.js are ALWAYS "<backendName>:<raw>" so its
// existing sessionId-keyed Maps stay collision-safe across backend kinds
// with no other code needing to change.
export function makeSessionId(backendName, rawId) {
  return `${backendName}:${rawId}`;
}

export function backendNameOf(sessionId) {
  const i = String(sessionId).indexOf(':');
  return i < 0 ? null : sessionId.slice(0, i);
}

export function rawSessionId(sessionId) {
  const i = String(sessionId).indexOf(':');
  return i < 0 ? sessionId : sessionId.slice(i + 1);
}
