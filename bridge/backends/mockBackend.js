// The Mock Backend: a junior-agent backend that needs ZERO credentials,
// ZERO external processes, and ZERO real API cost -- purpose-built for
// exercising the multi-backend MCP machinery (session_create, message_send,
// model_get/model_set, the /backend Telegram command) for real without
// touching anyone's z.ai or Codex quota. Modeled on zcodeBackend.js/
// codexBackend.js's SHAPE (the Backend contract, bridge/backend.js) but
// trivial in substance: no subprocess, no protocol, no network.
//
// createConversation hands back an immediate, synthetic session id.
// sendMessage immediately (well, next microtask -- see below) emits the
// shared event vocabulary a real backend would (session/event text_delta +
// v4/telemetry/event turn.terminal), echoing the prompt back prefixed
// "[mock echo] " so a reply is never mistaken for a real model's output --
// exactly the requirement this backend exists to satisfy: obviously
// distinguishable, not a best-effort simulation of a real reply.
//
// listModels() returns exactly one synthetic model ref ('mock-1'). Model-
// switching policy, decided here and documented for the next person who
// adds a backend (see CLAUDE.md's "Model policy differs by backend"
// section): switchable is ALWAYS false. Not because MCP forbids switching
// (Codex proves it can support real switching) but because there is
// nothing to switch TO or FROM -- a single-model backend making "switching"
// a no-op that reports success would be a worse contract than refusing
// outright, exactly the reasoning zcode's own "no MCP-switchable model"
// policy already documents. setModel() is left a no-op (Backend's own
// default) rather than throwing, matching how a session's stored `model`
// field is set once at createConversation() and never legitimately needs to
// change again for this backend.

import { randomUUID } from 'node:crypto';
import { Backend, makeSessionId } from '../backend.js';

// The one and only model this backend ever runs. A single constant (not a
// list some future change could accidentally grow) is itself part of the
// "switchable: false" contract -- see the module comment.
export const MOCK_MODEL_REF = 'mock-1';
const MOCK_MODEL_LABEL = 'Mock Echo Model (synthetic, no real inference)';

export class MockBackend extends Backend {
  constructor() {
    super('mock');
    this._turnSeq = 0;
  }

  // No subprocess to spawn -- these exist only for symmetry with the real
  // backends' lifecycle (index.js calls start()/stop() uniformly on every
  // backend kind without knowing which one it's holding).
  async start() {
    return this;
  }

  async stop() {}

  async createConversation({ model, mode } = {}) {
    const rawId = randomUUID();
    return { sessionId: makeSessionId('mock', rawId), model: model || MOCK_MODEL_REF, mode };
  }

  // Nothing upstream to reattach to -- the session id IS the entire state
  // (there is none), so resuming one always trivially "succeeds", unlike
  // zcode/Codex where a previous process's session/thread may genuinely be
  // gone and this must be allowed to fail (see backend.js's contract
  // comment: callers fall back to a fresh createConversation on failure).
  async resumeConversation(sessionId) {
    return { sessionId };
  }

  async subscribe() {}

  // Fire-and-forget, exactly the contract backend.js documents: the caller
  // gets an immediate resolution; the actual reply arrives as 'event'
  // emissions ending in v4/telemetry/event turn.terminal. Deferred by one
  // microtask (not emitted synchronously before this function returns) so
  // that a caller which -- like index.js's startTurn() -- registers the turn
  // in its own bookkeeping (activeTurns) immediately after CALLING
  // sendMessage() but before its promise settles is guaranteed to have done
  // so before any event for this turn arrives. Every real backend gets this
  // ordering for free (a network round trip always takes longer than a
  // synchronous Map.set); this backend has to arrange it deliberately since
  // it does no I/O at all.
  async sendMessage(sessionId, text) {
    const turnId = `mock-turn-${++this._turnSeq}`;
    const reply = `[mock echo] ${text}`;
    queueMicrotask(() => {
      this._emitTelemetry(sessionId, turnId, 'turn.started');
      this._emitSession(sessionId, turnId, { kind: 'text_delta', delta: reply });
      // Final-text event: {kind: 'result', content} -- the SAME shape
      // codexBackend.js uses for its own final agentMessage (see its
      // item/completed case), not zcode's alternate {response, usage} shape
      // (backend.js documents both as valid ways to say "turn's final
      // answer"; this backend follows Codex's since it, like Codex, tracks
      // usage/tokenCount separately on turn.terminal below rather than
      // bundling it here).
      this._emitSession(sessionId, turnId, { kind: 'result', content: reply });
      this._emitTelemetry(sessionId, turnId, 'turn.terminal', {
        status: 'success',
        durationMs: 0,
        // Synthetic (character counts, not real tokens) -- clearly not real
        // usage, matching this backend's overall "obviously not a real
        // model" spirit (see the module comment).
        tokenCount: text.length + reply.length,
        toolCallCount: 0,
      });
    });
  }

  async cancel() {} // nothing ever runs long enough to need cancelling
  async closeConversation() {} // no upstream resource to release
  async cancelBackgroundTask() {} // no background-task concept

  // Deliberately a no-op, not a throw -- see the module comment's "Model-
  // switching policy" section. index.js's /model command and the MCP
  // model_set path both already refuse to CALL this for a backend whose
  // listModels() offers nothing else to switch to / whose model_get reports
  // switchable:false, so reaching here at all would mean an unusual caller
  // (a Telegram admin's /model with the one existing ref, no-op-ing onto
  // itself) rather than an unexpected request to actually switch models.
  async setModel() {}

  async setMode() {} // no mode concept, same reasoning as codexBackend.js

  async listModels() {
    return [{ ref: MOCK_MODEL_REF, label: MOCK_MODEL_LABEL }];
  }

  listModes() {
    return []; // no mode concept
  }

  onPermissionRequest() {} // never asks -- there is nothing risky to gate
  onUserInputRequest() {} // never asks -- no mid-turn questions exist

  killLocalToolProcesses() {} // no subprocess, nothing to kill

  _emitSession(sessionId, turnId, payload) {
    this.emit('event', { method: 'session/event', params: { sessionId, turnId, payload } });
  }

  _emitTelemetry(sessionId, turnId, kind, extra = {}) {
    this.emit('event', { method: 'v4/telemetry/event', params: { sessionId, turnId, kind, ...extra } });
  }
}
