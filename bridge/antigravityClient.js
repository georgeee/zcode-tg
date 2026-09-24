// Thin client for the Antigravity CLI's (`agy`) headless stream-json protocol,
// spoken over newline-delimited JSON on stdio. This is NOT a request/response
// protocol like codex's JSON-RPC app-server: agy in stream-json mode runs one
// process PER SESSION (one process == one conversation), reads user turns from
// stdin (one NDJSON object per line, one turn per line), and pushes progress
// events + a final result envelope onto stdout for every turn. See
// bridge/backends/antigravityBackend.js for the mapping onto the shared
// session/turn vocabulary bridge/backend.js documents.
//
// Protocol facts below are cited by evidence tier, the same discipline
// codexBackend.js uses -- for agy the tiers are:
//   VERIFIED LIVE    -- captured from real `agy` 1.2.9 sessions driven by the
//                       research drivers (work/antigravity/exp-*.mjs) against
//                       George's AI Pro login; transcripts in
//                       work/antigravity/experiments/agy-*.txt.
//   FROM DOCS        -- antigravity.google/docs/cli/headless (the CLI ships
//                       these same pages under builtin/skills).
//   INFERRED         -- flagged inline; nothing here should rest on inference
//                       that a fixture test could pin down instead.
//
// MEASURED, LOAD-BEARING GOTCHAS (do not "simplify" these away):
//   - agy's stdin MUST be a plain pipe held open by this process. A FIFO on
//     agy's stdin breaks its silent auth (DBus secret-service attempt +
//     fallback failing: "authentication failed or timed out"). Measured live
//     (experiments/t2-*.log); the working shape is exactly this file's: spawn
//     with 'pipe' stdio and write turns ourselves.
//   - HOME is the credential store: agy keeps its OAuth token in
//     $HOME/.gemini/antigravity-cli/antigravity-oauth-token (0600, the Linux
//     keyring file-fallback). One login per bridge model account, agent-owned
//     HOME -- the CODEX_HOME analogue, set per spawn below.
//   - `--remote-control` on every session is the owner decision (2026-09-24):
//     the session becomes visible and drivable from the antigravity.google
//     dashboard. It is agy's own session-scoped feature and dies with the
//     process -- it is NOT the Claude `remote-control --session-id`
//     capacity-pinning trap described in the workspace AGENTS.md.
//   - `--effort` must always accompany the bare `--model` slug: bare slug
//     without --effort, or an effort-suffixed slug together with --effort,
//     are both hard-errors (verified live, battery (d)). This file always
//     emits exactly one valid form.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Owner-mandated headless settings for every agy HOME this backend manages
// (owner decisions 2026-09-24, design doc §5/§13): auto mode (matching the
// bridge's yolo default and the --dangerously-skip-permissions flag -- the
// flag is the session-level form, this the account-level one), telemetry and
// all TUI/onboarding chrome off. Applied as a MERGE: keys already present in
// the file keep their other contents, only the keys below are written.
export const AGY_SETTINGS_DEFAULTS = {
  toolPermission: 'always-proceed',
  enableTelemetry: false,
  notifications: false,
  showTips: false,
  showFeedbackSurvey: false,
  colorScheme: 'terminal',
  altScreenMode: 'never',
};

// Idempotent settings seeding for $AGY_HOME/.gemini/antigravity-cli/settings.json.
// MERGE, never clobber: agy owns this file's other keys (modelProvider,
// permissions.allow, custom models...) and may rewrite it under us, so we
// read-modify-write only our keys and leave everything else byte-identical.
export function ensureAgySettings(agyHome, defaults = AGY_SETTINGS_DEFAULTS) {
  const dir = path.join(agyHome, '.gemini', 'antigravity-cli');
  const file = path.join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* missing or unparseable: start from scratch (an unparseable file is
       either agy's own half-write or hand-mangled; our keys must win) */
  }
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) existing = {};
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (existing[k] !== v) {
      existing[k] = v;
      changed = true;
    }
  }
  // A missing file always lands here with changed=true (every default gets
  // written); an already-conforming file is left untouched -- agy may rewrite
  // it at any time and there is nothing to fix.
  if (changed) writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
  return file;
}

export class AntigravityClient extends EventEmitter {
  constructor({ agyBin, agyHome, cwd, model, effort, remoteControl = true, skipPermissions = true, env = {} }) {
    super();
    this.agyBin = agyBin; // 'agy' (resolved on PATH) or an absolute path
    this.agyHome = agyHome; // HOME for the child -- holds the OAuth token file
    this.cwd = cwd; // the workspace the session runs in
    this.model = model; // the BARE slug (e.g. 'gemini-3.8-flash'); effort travels separately
    this.effort = effort; // 'low' | 'medium' | 'high' -- always paired with the bare slug
    this.remoteControl = remoteControl;
    this.skipPermissions = skipPermissions;
    this.env = env;
    this.proc = null;
    this.exited = false;
    this.exitInfo = null;
    this._buf = '';
    // Chunk-safe decoding, same requirement as codexClient.js: streamed
    // text_delta payloads split multibyte UTF-8 characters across reads.
    this._decoder = new StringDecoder('utf8');
    this._stderrBuf = '';
  }

  // The exact argv, factored out so tests (and reviewers) can pin it without
  // spawning anything. Order follows the working research drivers verbatim.
  //
  // SECURITY INVARIANT: never `--add-dir` (nor any other flag attaching the
  // workspace as a project). Measured on agy 1.2.9 under strace: with the
  // workspace attached, agy reads .agents/ (.agent/, _agents/, _agent/)
  // mcp_config.json, hooks.json, plugins -- and execs the MCP servers listed
  // there DIRECTLY, as this (the agent) account, bypassing the executor
  // shim. The workspace is executor-writable, so attaching it hands the
  // executor code execution as the account that holds the credential. With
  // cwd = workspace and no --add-dir, agy opens nothing in cwd.
  buildArgv(conversationId) {
    // FROM DOCS: stream-json input REQUIRES stream-json output (agy refuses
    // the combination otherwise -- --input-format's help text says so).
    const argv = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (this.remoteControl) argv.push('--remote-control');
    if (this.skipPermissions) argv.push('--dangerously-skip-permissions');
    argv.push('--model', this.model, '--effort', this.effort);
    // Resume: agy persists conversations under
    // $HOME/.gemini/antigravity-cli/conversations/<id>.db (SQLite), so a
    // fresh process restores full history from the id alone (VERIFIED LIVE,
    // battery (c): the model recalled the prior turn verbatim).
    if (conversationId) argv.push('--conversation', conversationId);
    return argv;
  }

  start(conversationId = null) {
    if (this.proc) throw new Error('antigravity client already started');
    this.proc = spawn(this.agyBin, this.buildArgv(conversationId), {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.env,
        // The credential (OAuth token file) lives under this HOME -- read by
        // the agy subprocess itself at its point of use, never by this
        // process. Never logged.
        HOME: this.agyHome,
        // Headless hygiene (design doc §5): no TTY is attached (stdio are
        // pipes), and NO_COLOR keeps any residual color logic out of stdout.
        NO_COLOR: '1',
      },
    });
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => this._onStderr(chunk));
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      this.emit('exit', { code, signal });
    });
    // Spawn-time failures (ENOENT on a misconfigured AGY_BIN) fire 'error',
    // never 'exit' -- convert to the same shape as a real death so the
    // backend sees one event kind. Same fix as codexClient.js's (found via
    // test/e2e-backend-lifecycle.mjs there); without it Node throws the
    // orphaned 'error' event as an uncaught exception.
    this.proc.on('error', (err) => {
      this.emit('stderr', `spawn failed: ${err.message}\n`);
      this.exited = true;
      this.exitInfo = { code: null, signal: null, error: err };
      this.emit('exit', { code: null, signal: null, error: err });
    });
    return this;
  }

  // One user turn object per line (FROM DOCS + VERIFIED LIVE: the drivers
  // send exactly this shape and agy runs a turn per message).
  sendUserTurn(text) {
    if (!this.proc || this.exited) throw new Error('antigravity client is not running');
    this.proc.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n');
  }

  // Cancel = SIGTERM the child. VERIFIED LIVE (battery (f)): mid-turn this
  // makes agy emit a structured result {"status":"ERROR","error":"interrupted"}
  // and exit 1, and the CONVERSATION SURVIVES -- a later
  // `--conversation <id>` respawn continues it. The process IS the turn's
  // transport; there is no finer-grained interrupt on this surface.
  kill(signal = 'SIGTERM') {
    if (this.proc && !this.exited) {
      try {
        this.proc.kill(signal);
      } catch {}
    }
  }

  // THE BOUNDED CLOSE (the one shape every agy child teardown goes through
  // -- GC reaps, the cap eviction, and backend stop() alike): stdin EOF
  // first -- an idle agy exits cleanly on EOF (VERIFIED LIVE) -- then, only
  // if the child is still alive, SIGTERM, then SIGKILL. The whole
  // escalation is bounded: eofGraceMs waiting on the clean EOF exit, then
  // termGraceMs waiting on TERM to land. Resolves once the child is gone
  // (immediately if it already was); the stage timers are unref'd so they
  // never hold the bridge process open by themselves.
  close({ eofGraceMs = 10_000, termGraceMs = 5_000 } = {}) {
    if (!this.proc || this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve();
      };
      let termTimer = null;
      let killTimer = null;
      // OUR 'exit' emission, not the subprocess's: a spawn failure
      // (ENOENT...) emits 'exit' here without the child ever having existed.
      this.once('exit', done);
      if (this.exited) {
        done();
        return;
      }
      try {
        this.proc.stdin.end();
      } catch {}
      termTimer = setTimeout(() => {
        this.kill('SIGTERM');
        killTimer = setTimeout(() => this.kill('SIGKILL'), termGraceMs);
        killTimer.unref?.();
      }, eofGraceMs);
      termTimer.unref?.();
    });
  }

  // Fire-and-forget form of close(). The old body (EOF + a bare 5s TERM
  // fallback) is subsumed: same opening move, plus the KILL backstop a
  // wedged child needs.
  stop() {
    void this.close();
  }

  _onStdout(chunk) {
    // Line-framing: Node's 'data' events are not line-aligned -- buffer and
    // split on '\n' (same as codexClient.js).
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
      // VERIFIED LIVE: every stdout line is {"event":"init"|"step_update"|
      // "result", ...}. Anything else is forwarded for the backend to ignore
      // deliberately rather than silently dropped.
      this.emit('event', msg);
    }
  }

  _onStderr(chunk) {
    const text = chunk.toString('utf8');
    this.emit('stderr', text);
    // agy logs its run log elsewhere (--log-file / the HOME log dir); stderr
    // carries error lines. Headless failures print
    // `AGY_ERROR: {"short_error":...,"status":...,"error_code":...,...}` and
    // exit 3 (exit 1 is usage/auth). VERIFIED LIVE (agy-fake-provider-v4).
    // Tapped as structured data so the backend can stash quota errors for
    // usage_get; the raw text still flows out as 'stderr'.
    this._stderrBuf += text;
    let nl;
    while ((nl = this._stderrBuf.indexOf('\n')) >= 0) {
      const line = this._stderrBuf.slice(0, nl);
      this._stderrBuf = this._stderrBuf.slice(nl + 1);
      if (!line.startsWith('AGY_ERROR:')) continue;
      try {
        this.emit('agyError', JSON.parse(line.slice('AGY_ERROR:'.length)));
      } catch {
        this.emit('agyError', { short_error: line.slice('AGY_ERROR:'.length).trim() });
      }
    }
  }
}
