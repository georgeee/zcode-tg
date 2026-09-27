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
// STREAMING MODE (env knobs read here, once at construction -- this backend
// keeps no entry in bridge/config.js, the same way telegram.js owns its own
// TELEGRAM_API_ROOT read):
//   MOCK_STREAM_CHUNKS       int, default 0. 0 (or <= 0) is TODAY'S instant
//                            single-burst reply, byte for byte. N > 0 streams
//                            the same echo as N incremental text_delta events
//                            spaced MOCK_STREAM_INTERVAL_MS apart, so the
//                            bridge's real streaming machinery (streamer /
//                            milestone reporter, coalescing, the terminal-
//                            render handoff) gets exercised end to end; the
//                            final result text is IDENTICAL to the instant
//                            echo (a prompt shorter than N yields empty
//                            trailing deltas -- harmless, they only mark the
//                            preview dirty).
//   MOCK_STREAM_INTERVAL_MS  int, default 500 -- the spacing above.
// The final events ride the LAST delta's timer, in the instant path's exact
// order, so a streamed turn ends with the identical result + turn.terminal
// tail. cancel()/closeConversation() clear any still-pending streaming timers:
// once the knobs make this backend stateful, a stopped turn must actually
// stop (the property /stop and the topic-delete path rely on for real
// backends).
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
const DEFAULT_STREAM_INTERVAL_MS = 500;

function intKnob(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class MockBackend extends Backend {
  // Both knobs are injectable for unit tests; absent injection, they come
  // from the env (deployment config, read once -- a running bridge does not
  // change its mind mid-turn).
  constructor({ streamChunks, streamIntervalMs } = {}) {
    super('mock');
    this._turnSeq = 0;
    this._streamChunks = streamChunks ?? Math.trunc(intKnob(process.env.MOCK_STREAM_CHUNKS, 0));
    this._streamIntervalMs = Math.max(
      0,
      streamIntervalMs ?? intKnob(process.env.MOCK_STREAM_INTERVAL_MS, DEFAULT_STREAM_INTERVAL_MS),
    );
    // Pending streaming timers per session: what cancel()/closeConversation()
    // clear so a stopped streamed turn emits nothing further.
    this._streamTimers = new Map(); // sessionId -> Set<Timeout>
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

    // Streaming mode (MOCK_STREAM_CHUNKS > 0): turn.started up front (still
    // deferred one microtask, preserving the register-before-events guarantee
    // the instant path documents), then the echo in N deltas on real timers,
    // the LAST delta's timer carrying the identical result + turn.terminal
    // tail. The 'result' event -- not the deltas -- is what finalizeTurn
    // renders, so the final delivery is byte-identical to the instant path;
    // the deltas only feed the live preview.
    if (this._streamChunks > 0) {
      const chunks = this._streamChunks;
      const interval = this._streamIntervalMs;
      const base = Math.floor(reply.length / chunks);
      const rem = reply.length % chunks;
      const pending = this._streamTimersFor(sessionId);
      const startedAt = Date.now();
      queueMicrotask(() => this._emitTelemetry(sessionId, turnId, 'turn.started'));
      for (let i = 0, at = 0; i < chunks; i++) {
        const take = base + (i < rem ? 1 : 0);
        const delta = reply.slice(at, at + take);
        at += take;
        const last = i === chunks - 1;
        const t = setTimeout(() => {
          pending.delete(t);
          this._emitSession(sessionId, turnId, { kind: 'text_delta', delta });
          if (!last) return;
          this._emitSession(sessionId, turnId, { kind: 'result', content: reply });
          this._emitTelemetry(sessionId, turnId, 'turn.terminal', {
            status: 'success',
            durationMs: Date.now() - startedAt,
            // Synthetic (character counts, not real tokens) -- clearly not real
            // usage, matching this backend's overall "obviously not a real
            // model" spirit (see the module comment).
            tokenCount: text.length + reply.length,
            toolCallCount: 0,
          });
        }, interval * (i + 1));
        pending.add(t);
      }
      return;
    }

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

  // A cancelled or closed streamed turn must emit nothing further -- with the
  // streaming knobs this backend finally has in-flight state to release.
  _cancelStreamTimers(sessionId) {
    const pending = this._streamTimers.get(sessionId);
    if (!pending) return;
    for (const t of pending) clearTimeout(t);
    this._streamTimers.delete(sessionId);
  }

  _streamTimersFor(sessionId) {
    let pending = this._streamTimers.get(sessionId);
    if (!pending) {
      pending = new Set();
      this._streamTimers.set(sessionId, pending);
    }
    return pending;
  }

  async cancel(sessionId) {
    this._cancelStreamTimers(sessionId); // nothing else ever runs long enough to need cancelling
  }

  async closeConversation(sessionId) {
    this._cancelStreamTimers(sessionId); // no upstream resource to release
  }
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
