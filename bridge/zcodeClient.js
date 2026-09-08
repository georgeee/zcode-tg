// Thin client for zcode's "ZCode Protocol" (`zcode app-server`), spoken over
// newline-delimited JSON on stdio. Not JSON-RPC 2.0 -- messages are plain
// {id, method, params} / {id, result|error}, and the server also sends
// *server-initiated* requests (id like "server-N") that the client must
// answer. See README.md for how these behaviors were established.
//
// One instance = one long-lived `app-server` process, multiplexing many
// sessions (one per Telegram topic).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_TIMEOUT_MS = 120_000;

export class ZcodeClient extends EventEmitter {
  constructor({ nodeBin, zcodeBin, cwd, env = {} }) {
    super();
    this.nodeBin = nodeBin;
    this.zcodeBin = zcodeBin;
    this.cwd = cwd;
    this.env = env;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._buf = '';
    // Buffer#toString('utf8') is stateless per call: if a multi-byte UTF-8
    // character straddles two stdout reads (routine here -- large
    // responses like session/send/session/subscribe already split
    // unpredictably across 'data' events, which is exactly the condition
    // needed for this), decoding each chunk independently replaces the
    // split character with U+FFFD instead of holding the trailing partial
    // bytes back to combine with the next chunk. StringDecoder is stateful
    // across calls and handles this correctly. JSON syntax itself can't be
    // corrupted this way (its delimiters are single-byte ASCII) so this
    // silently corrupted only *string content* -- e.g. CJK text or emoji in
    // the model's own replies, posted straight to Telegram with no error
    // logged anywhere.
    this._decoder = new StringDecoder('utf8');
    this._serverRequestHandlers = new Map(); // method -> async (params, rawMsg) => resultObject
    this.proc = null;
    // Set once the process is known gone (spawn failure OR a real exit) --
    // see call()'s guard below. Without this, a FUTURE call() issued after
    // the process has already died (e.g. bridge/index.js's createConversation
    // calling session/create on a ZcodeBackend whose subprocess failed to
    // spawn moments earlier) has nothing to reject it: the 'error'/'exit'
    // handlers above only reject calls that were ALREADY pending at the
    // instant they fired, and this process will never emit either event a
    // second time. Left unguarded, that call would sit doing nothing at all
    // until its own DEFAULT_TIMEOUT_MS (120s) elapses -- not a busy spin,
    // but not the "clear, FAST failure" a misconfigured backend should give
    // either (found and fixed via test/e2e-backend-lifecycle.mjs, which
    // caught this exact 120s-shaped gap in the first version of this fix).
    this._deadError = null;
  }

  start() {
    this.proc = spawn(this.nodeBin, [this.zcodeBin, 'app-server'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.env,
        ZCODE_DISABLE_UPDATE_CHECK: '1',
        NO_UPDATE_NOTIFIER: '1',
      },
    });
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString('utf8')));
    this.proc.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      const err = new Error(`zcode app-server exited (code=${code} signal=${signal}) before responding`);
      this._deadError = err;
      this._rejectAllPending(err);
    });
    // ROOT CAUSE of a real busy/hang-shaped failure (found investigating
    // "bug #3" in the multi-backend refactor): child_process's 'error' event
    // (spawn-time failures like ENOENT/EACCES -- e.g. a misconfigured
    // ZCODE_NODE_BIN/ZCODE_BIN on a deployment that never touches zcode) is
    // NOT followed by 'exit' -- the OS process never existed, so there's
    // nothing to exit. Before this handler existed, nothing here ever
    // listened for 'error', so Node's EventEmitter did what it always does
    // for an unhandled 'error' event: threw synchronously, crashing the
    // whole bridge process the instant it was thrown -- which, because this
    // client is constructed and started at MODULE LOAD time (see
    // bridge/index.js), happened before main() ever ran, before the Codex
    // MCP socket had a chance to bind, and (under the live systemd unit's
    // Restart=always/RestartSec=3) repeated forever: spawn, crash, restart,
    // spawn, crash... every 3 seconds, indefinitely, with the MCP socket
    // never once coming up. That is a crash-loop, not literally a CPU spin,
    // but it matches the reported symptom exactly ("indefinite", "the MCP
    // socket never binds") and is the only spawn-time failure mode this
    // client could actually hit. Converting it into a normal 'exit'-shaped
    // event lets it flow through the SAME bounded, already-safe handling
    // wireBackend() (bridge/index.js) gives every other backend death:
    // logged, and fatal only if this is the deployment's load-bearing
    // backend -- never an uncaught crash, never a silent hang.
    this.proc.on('error', (err) => {
      this.emit('stderr', `spawn failed: ${err.message}\n`);
      this.emit('exit', { code: null, signal: null, error: err });
      // Also fail fast: a call already in flight (e.g. session/create issued
      // right after start()) would otherwise sit until DEFAULT_TIMEOUT_MS
      // (120s) elapses, since a process that never spawned never answers and
      // never fires the ordinary 'exit' path above either. No pending call
      // should ever have to wait out a timer for a failure that's already
      // fully known.
      const dead = new Error(`zcode app-server failed to start: ${err.message}`);
      this._deadError = dead;
      this._rejectAllPending(dead);
    });
    return this;
  }

  _rejectAllPending(err) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  stop() {
    if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
  }

  // Register a handler for a server-initiated request method, e.g.
  // 'interaction/requestPermission'. Handler receives (params, rawMessage)
  // and must return the object to send back as `result`. If it throws, an
  // error response is sent instead. Unregistered methods are declined
  // automatically (see _onServerRequest) -- this has been verified safe for
  // session/create to still complete.
  onServerRequest(method, handler) {
    this._serverRequestHandlers.set(method, handler);
  }

  // Fire off a client->server call, get the matching response back.
  call(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    // Fail immediately for a process already known dead (see _deadError's
    // definition above) rather than register a pending call nothing will
    // ever settle except its own DEFAULT_TIMEOUT_MS timer -- the specific
    // gap a first version of this fix left open (a spawn failure was
    // reported instantly, but any call issued AFTER it still took 120s to
    // fail). A caller retrying against a permanently-broken backend gets the
    // same clear, fast error on every attempt, not just the first.
    if (this._deadError) return Promise.reject(this._deadError);
    const id = String(this._nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`zcode call timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._write({ id, method, params });
    });
  }

  _write(obj) {
    // IMPORTANT: this protocol rejects a "jsonrpc" key outright -- do not add one.
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _onData(chunk) {
    // Node's 'data' events are NOT guaranteed line-aligned. A naive
    // per-chunk JSON.parse silently drops any message that spans more than
    // one read (this bit us hard during development -- session/send and
    // session/subscribe responses are large enough to split, session/create
    // usually isn't, which made the bug look method-specific at first).
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
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'zcode error'), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      this._onServerRequest(msg);
      return;
    }
    if (msg.method) {
      this.emit('event', msg);
      this.emit(`event:${msg.method}`, msg.params, msg);
      return;
    }
    this.emit('unknownMessage', msg);
  }

  async _onServerRequest(msg) {
    const handler = this._serverRequestHandlers.get(msg.method);
    if (!handler) {
      // Declining unimplemented client capabilities (runtime preferences,
      // official MCP auth headers, etc.) is safe: verified session/create
      // and session/send both complete normally when these are declined.
      this._write({ id: msg.id, error: { code: -32601, message: `bridge does not implement ${msg.method}` } });
      return;
    }
    try {
      const result = await handler(msg.params, msg);
      this._write({ id: msg.id, result });
    } catch (e) {
      this._write({ id: msg.id, error: { code: -32000, message: e.message || String(e) } });
    }
  }
}
