// Thin client for `codex app-server`'s protocol, spoken over newline-
// delimited JSON on stdio (`--listen stdio://`, the default transport).
// Unlike zcode's "ZCode Protocol" (bridge/zcodeClient.js), this one really
// IS JSON-RPC 2.0: every message this client sends carries "jsonrpc":"2.0",
// and codex's own replies do too. Method names, request/response and
// notification shapes below were established the same way zcode's protocol
// was: `codex app-server generate-json-schema --experimental` /
// `generate-ts --experimental` (the authoritative machine-readable dump --
// see bridge/backends/codexBackend.js for field-shape citations), reading
// the open-source Rust implementation (github.com/openai/codex,
// codex-rs/app-server-protocol and codex-rs/protocol crates) where the dump
// alone left something ambiguous, and finally driving real
// initialize -> thread/start -> turn/start -> turn/completed round trips by
// hand against a live process authenticated with a real ChatGPT-Plus
// credential. Not everything in the schema is used here -- only what the
// bridge needs (see codexBackend.js for the mapping onto the shared
// session/turn vocabulary bridge/backend.js documents).
//
// Same overall shape as zcodeClient.js on purpose: one client = one
// long-lived `codex app-server` process, multiplexing many threads (one per
// Telegram topic, when a topic runs on this backend); request/response
// correlated by numeric id; server-initiated REQUESTS (approval asks) are
// answered via a registered handler; id-less server->client NOTIFICATIONS
// (the turn-lifecycle event stream) are re-emitted as 'event'.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_TIMEOUT_MS = 120_000;

export class CodexClient extends EventEmitter {
  constructor({ codexBin, codexHome, cwd, env = {} }) {
    super();
    this.codexBin = codexBin; // 'codex' (resolved on PATH) or an absolute path
    this.codexHome = codexHome; // CODEX_HOME -- where the login credential lives
    this.cwd = cwd;
    this.env = env;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._buf = '';
    // Same statefulness requirement as zcodeClient.js's decoder, same
    // reason: streamed reply text (item/agentMessage/delta) is exactly the
    // kind of payload that splits a multi-byte UTF-8 character across two
    // stdout reads. See zcodeClient.js's comment for the full explanation.
    this._decoder = new StringDecoder('utf8');
    this._serverRequestHandlers = new Map();
    this.proc = null;
  }

  start() {
    this.proc = spawn(this.codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.env,
        // The real ChatGPT-Plus login credential lives under this directory
        // (auth.json) -- read by the codex subprocess itself at its own
        // point of use, never by this process. Never logged.
        CODEX_HOME: this.codexHome,
      },
    });
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString('utf8')));
    this.proc.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`codex app-server exited (code=${code} signal=${signal}) before responding`));
      }
      this._pending.clear();
    });
    return this;
  }

  stop() {
    // VERIFIED LIVE: codex app-server has no documented shutdown/exit RPC
    // (absent from generate-json-schema's ClientRequest method list) --
    // closing stdin (EOF) is the confirmed-clean way to end it (observed
    // exit code 0, well under a second, in two separate live test runs).
    // The SIGTERM backstop below is defense against a future version that
    // doesn't exit promptly on EOF, not a load-bearing part of the
    // documented protocol.
    if (this.proc && !this.proc.killed) {
      try { this.proc.stdin.end(); } catch {}
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
      }, 5000).unref();
    }
  }

  // Register a handler for a server-initiated request method (an approval
  // ask, e.g. 'item/commandExecution/requestApproval'). Handler receives
  // (params, rawMessage) and must return the object to send back as
  // `result`. Unregistered methods get a JSON-RPC "method not found" --
  // deliberately NOT verified safe the way zcode's decline-path is (see
  // zcodeClient.js); codexBackend.js registers a handler for every approval
  // method this bridge knows about specifically to avoid relying on that.
  onServerRequest(method, handler) {
    this._serverRequestHandlers.set(method, handler);
  }

  call(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`codex call timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  // Client -> server notification (no id, no response expected) -- used for
  // 'initialized' after the initialize handshake.
  notify(method, params = {}) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  _write(obj) {
    // Opposite gotcha from zcodeClient.js: THIS protocol wants the
    // "jsonrpc" key -- every _write call site above includes it.
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _onData(chunk) {
    // Same line-framing hazard as zcodeClient.js: Node's 'data' events are
    // not line-aligned, so buffer and split on '\n' rather than parsing each
    // chunk independently.
    this._buf += this._decoder.write(chunk);
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.emit('parseError', { line, error: e });
        continue;
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    // A response to one of OUR calls: has our id, no method, and either
    // result or error present (checked with `in`, not `!== undefined` --
    // JSON.parse never produces `undefined`, but a genuinely-null result is
    // a valid success value, e.g. turn/interrupt's `{}`).
    if (msg.id !== undefined && !msg.method && ('result' in msg || 'error' in msg)) {
      if (!this._pending.has(msg.id)) return; // already timed out, or duplicate -- ignore
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'codex error'), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // A server-initiated REQUEST (an approval ask) -- must answer.
      this._onServerRequest(msg);
      return;
    }
    if (msg.method) {
      // A notification: the turn-lifecycle event stream.
      this.emit('event', msg);
      this.emit(`event:${msg.method}`, msg.params, msg);
      return;
    }
    this.emit('unknownMessage', msg);
  }

  async _onServerRequest(msg) {
    const handler = this._serverRequestHandlers.get(msg.method);
    if (!handler) {
      this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `bridge does not implement ${msg.method}` } });
      return;
    }
    try {
      const result = await handler(msg.params, msg);
      this._write({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message || String(e) } });
    }
  }
}
