#!/usr/bin/env node
// A minimal stand-in for `agy` in headless stream-json mode (the Antigravity
// CLI protocol -- see bridge/antigravityClient.js for the real thing and the
// evidence tiers). Used by the antigravity unit tests and
// test/e2e-backend-lifecycle.mjs so an antigravity-default deployment runs
// with ZERO Google credentials and zero real quota spend.
//
// Speaks the protocol EXACTLY as recorded live (agy 1.2.9,
// work/antigravity/experiments/agy-*.txt): init -> step_update* -> result
// per turn, one turn per stdin line, AGY_ERROR on stderr with exit 3 for
// headless failures, exit 1 for usage/auth/model-selection errors,
// interrupted-on-SIGTERM, --conversation resume.
//
// Directly executable (AntigravityClient spawns agyBin itself) -- created
// as the executor account with mode 0755 for exactly that reason (same as
// fake-codex-app-server.mjs).
//
// Environment knobs (all optional):
//   FIXTURE_AGY_MARKER       single-shot JSON {pid, at, argv, home, cwd}
//                            written at startup -- the eager-start assertion
//   FIXTURE_AGY_MARKER_LOG   JSONL, one line PER SPAWN -- argv assertions
//                            across respawns (resume, effort changes)
//   FIXTURE_AGY_LOG          JSONL, one line per received user turn
//   FIXTURE_AGY_STATE        directory for per-conversation history (the
//                            stand-in for agy's conversations/*.db -- this
//                            is what makes --conversation resume actually
//                            carry memory across processes)
//   FIXTURE_AGY_INIT_DELAY_MS  delay before the init event (init-timeout tests)
//   FIXTURE_AGY_SLOW_MS        how long the AGY-SLOW trigger stalls (cancel tests)
//   FIXTURE_AGY_STUBBORN       set: ignore stdin EOF and SIGTERM -- only
//                              SIGKILL ends the process (GC escalation tests)
//   FIXTURE_AGY_CLOSE_STDIN    set: destroy the stdin READ end and stay
//                              alive -- the parent's next write hits EPIPE
//                              against a live child (client write-guard tests)
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const STUBBORN = !!process.env.FIXTURE_AGY_STUBBORN;
// Ignoring EOF is not enough: with stdin gone and no other pending work the
// process would still exit naturally (code 0). A stubborn session holds the
// event loop, so only SIGKILL ends it -- that is the point of the knob.
if (STUBBORN) setInterval(() => {}, 10_000);

// Unlike STUBBORN (EOF ignored, read end left open), this closes the read
// end itself: fd 0 IS the read end of the pipe the parent writes turns into,
// so closing it makes the kernel refuse the parent's writes with EPIPE while
// the child lives on -- the exact shape of a write racing a dying agy.
// (Measured: process.stdin.destroy() does NOT do this -- without a read the
// handle never opens, the fd stays, and the parent's write just buffers.)
const CLOSE_STDIN = !!process.env.FIXTURE_AGY_CLOSE_STDIN;
if (CLOSE_STDIN) {
  closeSync(0);
  setInterval(() => {}, 10_000);
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const model = value('--model');
const effort = value('--effort');
const conversationArg = value('--conversation');
const skipPermissions = flag('--dangerously-skip-permissions');
const remoteControl = flag('--remote-control');

if (process.env.FIXTURE_AGY_MARKER) {
  writeFileSync(process.env.FIXTURE_AGY_MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), argv, home: process.env.HOME, cwd: process.cwd() }));
}
if (process.env.FIXTURE_AGY_MARKER_LOG) {
  appendFileSync(process.env.FIXTURE_AGY_MARKER_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), argv, home: process.env.HOME, cwd: process.cwd() }) + '\n');
}

// The model-selection rule, reproduced from the real CLI (battery (d)):
// bare slug + --effort is the only valid form; an effort-suffixed slug, or
// the bare slug without --effort, is a hard startup error -- a `result`
// envelope with status ERROR, NO init event, exit 1.
const BARE = 'gemini-3.8-flash';
if (model !== BARE || !['low', 'medium', 'high'].includes(effort)) {
  const why =
    model !== BARE
      ? `invalid model selection: unsupported model "${model ?? ''}"`
      : `invalid model selection (--model "${model}" --effort "${effort ?? ''}"): --model ${BARE} requires --effort (available: low, medium, high)`;
  process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: why, duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } }) + '\n');
  process.stderr.write(`error: ${why}\n`);
  process.exit(1);
}

const stateDir = process.env.FIXTURE_AGY_STATE;
let conversationId = conversationArg || randomUUID();
function historyPath() { return `${stateDir}/${conversationId}.json`; }
function loadHistory() {
  try { return JSON.parse(readFileSync(historyPath(), 'utf8')); } catch { return []; }
}
function saveHistory(turns) {
  if (!stateDir) return;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(historyPath(), JSON.stringify(turns));
}

const USAGE = (total) => ({ input_tokens: 12001, output_tokens: 42, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: total ?? 12443 });
let turnSeq = 0;
let currentTurn = null; // { convId } while a turn is in flight (for SIGTERM-interrupt)

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
const step = (step_index, state, step_type, extra = {}) => emit({ event: 'step_update', step_update: { conversation_id: conversationId, step_index, state, step_type, ...extra } });

async function runTurn(content) {
  const seq = ++turnSeq;
  currentTurn = { seq };
  const turns = [...loadHistory(), content];
  saveHistory(turns);
  let index = 0;
  step(index++, 'DONE', 'user_input');
  if (content.includes('run_command')) {
    step(index, 'ACTIVE', 'tool', { tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'id -un' } } });
    step(index++, 'DONE', 'tool', { tool_name: 'run_command', duration_seconds: 0.01, tool_info: { name: 'run_command', parameters: { CommandLine: 'id -un' }, output: 'fake-executor-uid\r\n' } });
  }
  step(index, 'DONE', 'agent_response', { duration_seconds: 0.02, usage: USAGE() });
  let response = `FAKE-REPLY: ${content}`;
  if (content === 'AGY-QUOTA') {
    process.stderr.write('AGY_ERROR: {"short_error":"quota exceeded for gemini-3.8-flash","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"fake"}\n');
    emit({ event: 'result', result: { conversation_id: conversationId, status: 'ERROR', response: '', error: 'quota exceeded for gemini-3.8-flash', duration_seconds: 0.1, num_turns: 1, usage: USAGE(0) } });
    currentTurn = null;
    return;
  }
  if (content === 'AGY-SLOW') {
    step(index++, 'ACTIVE', 'agent_response', { text_delta: 'working…' });
    await new Promise((r) => setTimeout(r, Number(process.env.FIXTURE_AGY_SLOW_MS || 60000)));
    response = 'done slowly';
  }
  if (content.includes('RESUME-CHECK')) {
    const first = turns[0] ?? '(empty history)';
    response = `FIRST-WAS: ${first}`;
  }
  emit({ event: 'result', result: { conversation_id: conversationId, status: 'SUCCESS', response, duration_seconds: 0.05, num_turns: seq, usage: USAGE(24886) } });
  currentTurn = null;
}

const initDelay = Number(process.env.FIXTURE_AGY_INIT_DELAY_MS || 10);
setTimeout(() => {
  emit({
    event: 'init',
    conversation_id: conversationId,
    init: {
      model: BARE, // the init echoes the BARE slug when --effort is used (battery (d))
      cwd: process.cwd(),
      tools: ['run_command', 'write_to_file', 'finish'],
      permission_mode: skipPermissions ? 'always-proceed' : 'request-review',
      remote_control: remoteControl,
    },
  });
}, initDelay);

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.event === 'user' && msg.message?.content != null) {
      if (process.env.FIXTURE_AGY_LOG) appendFileSync(process.env.FIXTURE_AGY_LOG, JSON.stringify({ at: Date.now(), conversation: conversationId, text: msg.message.content }) + '\n');
      void runTurn(String(msg.message.content));
    }
  }
});
process.stdin.on('end', () => {
  if (STUBBORN) return; // the whole point: EOF alone does not end this one
  if (CLOSE_STDIN) return; // fd 0 was closed at startup -- this 'end' is that artifact, not a shutdown signal
  process.exit(0);
});

// VERIFIED LIVE (battery (f)): SIGTERM mid-turn -> structured interrupted
// result, exit 1, conversation survives (history is on disk, so a respawn
// with --conversation continues it).
process.on('SIGTERM', () => {
  if (STUBBORN) return; // survives TERM too -- the GC's KILL stage is next
  if (currentTurn) {
    emit({ event: 'result', result: { conversation_id: conversationId, status: 'ERROR', response: '', error: 'interrupted', duration_seconds: 0.1, num_turns: turnSeq, usage: USAGE(0) } });
  }
  process.exit(1);
});
