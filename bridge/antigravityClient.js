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
//   - a stdin write can lose the race against the child's death (SIGTERM
//     cancel, crash): the kernel refuses it with EPIPE, and an uncaught
//     EPIPE in the bridge process takes down EVERY session. Writes are
//     guarded (sendUserTurn below) and the stream's 'error' event is
//     swallowed at spawn -- a refused delivery is a rejection, never a
//     crash.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// --- agy's PRIVATE working directory ---
//
// agy never runs with the workspace as its cwd. The workspace is the one
// directory the EXECUTOR writes, and agy -- running as the agent, the account
// that holds the credential -- treats project configuration it finds in an
// attached directory as its own: measured on 1.2.9 with --add-dir, it reads
// .agents/ (.agent/, _agents/, _agent/) mcp_config.json, hooks.json and
// plugins, GEMINI.md, AGENTS.md and .gemini/config.json there, and execs
// the MCP servers listed directly as the agent. Print/stream-json mode with
// cwd = workspace and no --add-dir opened nothing in cwd, but whether a
// dashboard-driven turn on a --remote-control instance (every bridge
// session is one) treats its cwd as a project is UNMEASURED. So the cwd is
// a directory of the agent's own: 0700, outside the workspace, and checked
// for exactly those names before every turn and every spawn (the backend's
// pre-turn gate).
//
// The model still works in the workspace: its tool commands go through the
// executor shim, whose frame carries CAGE_WORKSPACE (set per spawn below);
// the broker cannot enter this 0700 agent directory and falls back to that
// workspace. The model is told where its workspace is on the first turn
// each child receives (workspaceNote), because agy's own idea of "where am
// I" is now this private directory.

// The project-config names agy reads from a directory it treats as a
// project (measured, agy 1.2.9). Any of them present in the private cwd is
// a gate violation -- whatever its content: none of them has an inert form
// worth parsing for.
export const AGY_PROJECT_CONFIG_NAMES = ['.agents', '.agent', '_agents', '_agent', 'GEMINI.md', 'AGENTS.md', path.join('.gemini', 'config.json')];

// The default private cwd, beside the agy HOME: <AGY_HOME's parent>/.local/
// state/agent-cage/agy-bridge/cwd. agent-cage puts AGY_HOME at <home>/.agy,
// so this is <home>/.local/state/agent-cage/agy-bridge/cwd -- the bridge
// twin of the remote-control daemon's agy-remote/cwd. AGY_BRIDGE_CWD
// overrides it (agent-cage renders it explicitly).
export function defaultAgyBridgeCwd(agyHome) {
  return path.join(path.dirname(path.resolve(agyHome)), '.local', 'state', 'agent-cage', 'agy-bridge', 'cwd');
}

// Makes the private cwd if it is missing (0700) and proves it is private:
// a real directory (not a symlink), owned by this process's uid, with no
// group or other permission bits -- the executor must neither write it nor
// enter it (an enterable cwd would also stop the broker's workspace
// fallback). Throws, with the reason, when any of that fails: the caller
// refuses to spawn.
export function ensurePrivateCwd(dir) {
  const refuse = (why) => new Error(`antigravity: refusing to start agy: its private working directory ${dir || '(unset)'} ${why}`);
  if (!dir || !path.isAbsolute(dir)) throw refuse('is not an absolute path (AGY_BRIDGE_CWD)');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw refuse(`could not be made: ${err.message}`);
  }
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    throw refuse(`cannot be inspected: ${err.message}`);
  }
  if (!st.isDirectory()) throw refuse('is not a directory (a symlink or a file stands there)');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw refuse(`is owned by uid ${st.uid}, not this account (${process.getuid()})`);
  if (st.mode & 0o077) throw refuse(`is mode 0${(st.mode & 0o777).toString(8)}; it must be 0700`);
  return dir;
}

// The first project-config path present in dir, or null. lstat, so a
// dangling symlink counts as present. Anything but "provably absent"
// (ENOENT, or ENOTDIR under a .gemini that is a file) is a violation.
export function projectConfigIn(dir) {
  if (!dir) return null;
  for (const name of AGY_PROJECT_CONFIG_NAMES) {
    const p = path.join(dir, name);
    try {
      lstatSync(p);
      return p;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return p;
    }
  }
  return null;
}

// The workspace note, prepended to the first user turn each agy child
// receives: agy's working directory is the private one above, so without it
// the model's idea of its workspace would be an empty directory the
// executor cannot see. Once per child, not once per conversation: a
// respawn-resumed conversation may predate the private cwd, and agy
// describes the cwd afresh to each process.
export function workspaceNote(workspaceDir, cwd) {
  return (
    `[bridge] Your workspace is ${workspaceDir}. Shell commands already run there. ` +
    `Your process's own working directory (${cwd}) is a private, empty directory and not the workspace: ` +
    `read and write files under ${workspaceDir}, by absolute path.\n\n`
  );
}

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

// AGY_DELIVERY_FAILED: the one error a refused stdin write maps to, verbatim
// on the failed turn's terminal by the backend. "retry" is accurate: the
// conversation survives on disk and the next sendMessage respawn-resumes.
export const AGY_DELIVERY_FAILED = 'agy exited before the message could be delivered — retry';

export class AntigravityClient extends EventEmitter {
  constructor({ agyBin, agyHome, cwd, workspaceDir = null, model, effort, remoteControl = true, skipPermissions = true, env = {} }) {
    super();
    this.agyBin = agyBin; // 'agy' (resolved on PATH) or an absolute path
    this.agyHome = agyHome; // HOME for the child -- holds the OAuth token file
    this.cwd = cwd; // agy's PRIVATE working directory -- never the workspace (see AGY_PROJECT_CONFIG_NAMES's block)
    this.workspaceDir = workspaceDir; // the workspace the model works in -- CAGE_WORKSPACE for the executor shim
    this.model = model; // the BARE slug (e.g. 'gemini-3.8-flash'); effort travels separately
    this.effort = effort; // 'low' | 'medium' | 'high' -- always paired with the bare slug
    this.remoteControl = remoteControl;
    this.skipPermissions = skipPermissions;
    this.env = env;
    this.proc = null;
    this.exited = false;
    this.exitInfo = null;
    this._buf = '';
    // Last error the child's stdin stream reported (EPIPE when the child died
    // under a write, ERR_STREAM_DESTROYED on a closed pipe). Swallowed at the
    // spawn-time listener below -- sendUserTurn turns it into a rejection.
    this._stdinError = null;
    // Chunk-safe decoding, same requirement as codexClient.js: streamed
    // text_delta payloads split multibyte UTF-8 characters across reads.
    this._decoder = new StringDecoder('utf8');
    this._stderrBuf = '';
  }

  // The exact argv, factored out so tests (and reviewers) can pin it without
  // spawning anything. Order follows the working research drivers verbatim.
  //
  // SECURITY INVARIANT: the workspace is never agy's project -- neither
  // attached (`--add-dir`, or any other flag naming it) nor its cwd.
  // Measured on agy 1.2.9 under strace: with the workspace attached, agy
  // reads .agents/ (.agent/, _agents/, _agent/) mcp_config.json, hooks.json,
  // plugins, GEMINI.md, AGENTS.md and .gemini/config.json -- and execs the
  // MCP servers listed there DIRECTLY, as this (the agent) account,
  // bypassing the executor shim. The workspace is executor-writable, so
  // attaching it hands the executor code execution as the account that
  // holds the credential. With cwd = workspace and no --add-dir, print mode
  // opened nothing in cwd -- but a --remote-control session's
  // dashboard-driven turns are unmeasured, so the cwd is agy's own private
  // 0700 directory (this.cwd; ensurePrivateCwd/projectConfigIn above, and
  // the backend's pre-turn gate) and the workspace reaches the model only
  // as CAGE_WORKSPACE and the workspace note.
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
        // Where the model's commands land: the executor shim sends this in
        // every frame, and the broker -- unable to enter the private cwd --
        // falls back to it. The SESSION's workspace, spelled per spawn, not
        // whatever the bridge process happened to inherit.
        ...(this.workspaceDir ? { CAGE_WORKSPACE: this.workspaceDir } : {}),
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
    // THE EPIPE SWALLOWER, attached before anything can write: a write that
    // races the child's death surfaces as an async 'error' on this stream,
    // and with no listener Node turns that into an uncaughtException -- in
    // the bridge that is the whole process dying, every session with it.
    // Recorded instead; sendUserTurn's write callback (and its exited guard)
    // is what maps it to a rejection the backend can act on. Covers close()'s
    // stdin.end() landing on a child that died first, too.
    this.proc.stdin.on('error', (err) => {
      this._stdinError = err;
    });
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
  // send exactly this shape and agy runs a turn per message). Returns a
  // promise -- it NEVER throws and NEVER emits: a write to a child that is
  // dead or dying (this.exited, an already-broken pipe, EPIPE or
  // ERR_STREAM_DESTROYED surfacing under the write, or a write that landed
  // in the pipe buffer of a child that exited before reading it) rejects
  // with AGY_DELIVERY_FAILED, which the backend maps to a failed turn. The
  // spawn-time stdin 'error' listener is what keeps the EPIPE itself from
  // becoming an uncaught exception; this wrapper is what turns it into a
  // rejection with a caller-facing message.
  sendUserTurn(text) {
    if (!this.proc || this.exited || this._stdinError) {
      return Promise.reject(new Error(AGY_DELIVERY_FAILED));
    }
    return new Promise((resolve, reject) => {
      try {
        this.proc.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n', (err) => {
          // err: the kernel refused the write (EPIPE) or the stream was
          // already destroyed. No err but exited: the write landed in the
          // pipe buffer of a child that died before reading it (the
          // SIGTERM-cancel race) -- the message is lost either way.
          if (err) reject(new Error(AGY_DELIVERY_FAILED, { cause: err }));
          else if (this.exited) reject(new Error(AGY_DELIVERY_FAILED));
          else resolve();
        });
      } catch (err) {
        // Synchronous refusal (stream already ended): same contract.
        reject(new Error(AGY_DELIVERY_FAILED, { cause: err }));
      }
    });
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
      // The try/catch covers the synchronous face; the spawn-time stdin
      // 'error' listener covers the async one (EOF on a child that died
      // first). Either way the escalation timers below still run.
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
