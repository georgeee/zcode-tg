// Unit tests for bridge/antigravityClient.js: the spawn contract (argv, HOME
// override, cwd), NDJSON event parsing, the AGY_ERROR stderr tap, SIGTERM
// semantics, --conversation resume, the stdin write-guard (a delivery that
// loses the race against the child's death is a rejection, never an
// uncaughtException -- in the bridge that would be every session lost), and
// the settings seeding merge -- all against test/fixtures/fake-agy.mjs,
// which speaks the stream-json protocol exactly as recorded live (see the
// fixture header for the protocol sources).
//
// Run: node --test test/antigravity-client.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AntigravityClient, AGY_SETTINGS_DEFAULTS, ensureAgySettings } from '../bridge/antigravityClient.js';

// Catches the async face of a stdin error without letting it fail the run:
// node:test only crashes the test on an uncaughtException when NO listener
// exists, so this trap plus the assertion below is what turns "the spawn-time
// stdin 'error' listener was removed" red.
function trapUncaught(t) {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  return uncaught;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-agy.mjs');

function tmp(name) {
  return mkdtempSync(path.join(tmpdir(), `agy-client-${name}-`));
}

// Spawn the fixture the way the backend does, and collect its events until
// the (test-supplied) predicate matches or the timeout trips.
function startClient(t, { agyHome, state, cwd, conversationId, marker, extraEnv = {}, ...opts }) {
  const client = new AntigravityClient({
    agyBin: FIXTURE,
    agyHome,
    cwd,
    model: 'gemini-3.8-flash',
    effort: 'medium',
    env: {
      ...(state ? { FIXTURE_AGY_STATE: state } : {}),
      ...(marker ? { FIXTURE_AGY_MARKER: marker, FIXTURE_AGY_MARKER_LOG: marker.replace(/\.json$/, '.jsonl') } : {}),
      ...extraEnv,
    },
    ...opts,
  });
  const events = [];
  const agyErrors = [];
  client.on('event', (msg) => events.push(msg));
  client.on('agyError', (err) => agyErrors.push(err));
  client.start(conversationId ?? null);
  return { client, events, agyErrors };
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

const resultOf = (events) => events.find((e) => e.event === 'result')?.result;

test('buildArgv: the exact spawn contract (stream-json both sides, remote control, auto mode, bare slug + effort)', () => {
  const client = new AntigravityClient({ agyBin: 'agy', agyHome: '/h', cwd: '/w', model: 'gemini-3.8-flash', effort: 'high' });
  assert.deepEqual(client.buildArgv(null), [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--remote-control', '--dangerously-skip-permissions',
    '--model', 'gemini-3.8-flash', '--effort', 'high',
  ]);
  // Resume appends --conversation; nothing else moves (the drivers' argv order).
  assert.deepEqual(client.buildArgv('abc-123'), [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--remote-control', '--dangerously-skip-permissions',
    '--model', 'gemini-3.8-flash', '--effort', 'high',
    '--conversation', 'abc-123',
  ]);
});

test('spawn: init event arrives with conversation id, always-proceed mode, and HOME=agyHome in the child env', async (t) => {
  const dir = tmp('spawn');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agyHome = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const marker = path.join(dir, 'marker.json');
  mkdirSync(agyHome, { recursive: true });
  const { client, events } = startClient(t, { agyHome, state, cwd: dir, marker });
  try {
    const init = await waitFor(() => events.find((e) => e.event === 'init'), 'init');
    assert.ok(init.conversation_id, 'init carries the conversation id');
    assert.equal(init.init.permission_mode, 'always-proceed');
    assert.equal(init.init.model, 'gemini-3.8-flash'); // the BARE slug is echoed
    const m = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(m.home, agyHome, 'the child ran with HOME=agyHome (the credential HOME)');
    assert.ok(m.argv.includes('--remote-control'), 'argv carries --remote-control');
    assert.ok(m.argv.includes('--dangerously-skip-permissions'), 'argv carries --dangerously-skip-permissions');
    assert.ok(!m.argv.includes('--conversation'), 'a fresh spawn does not resume');
  } finally {
    client.stop();
  }
});

test('turn: user turn in, step_update + result envelope out (NDJSON, usage block intact)', async (t) => {
  const dir = tmp('turn');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { client, events } = startClient(t, { agyHome: path.join(dir, 'home'), state: path.join(dir, 'state'), cwd: dir });
  try {
    await waitFor(() => events.find((e) => e.event === 'init'), 'init');
    client.sendUserTurn('Use run_command to execute exactly: id -un');
    const result = await waitFor(() => resultOf(events), 'result');
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.usage.total_tokens, 24886);
    const tool = events.filter((e) => e.event === 'step_update' && e.step_update.step_type === 'tool');
    assert.equal(tool.length, 2, 'ACTIVE then DONE tool steps');
    assert.equal(tool[0].step_update.tool_name, 'run_command');
    assert.match(tool[1].step_update.tool_info.output, /fake-executor-uid/);
  } finally {
    client.stop();
  }
});

test('AGY_ERROR tap: quota failure yields the structured error event AND the ERROR result envelope', async (t) => {
  const dir = tmp('quota');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { client, events, agyErrors } = startClient(t, { agyHome: path.join(dir, 'home'), state: path.join(dir, 'state'), cwd: dir });
  try {
    await waitFor(() => events.find((e) => e.event === 'init'), 'init');
    client.sendUserTurn('AGY-QUOTA');
    const result = await waitFor(() => resultOf(events), 'result');
    assert.equal(result.status, 'ERROR');
    assert.match(result.error, /quota/);
    const quota = await waitFor(() => agyErrors.find((e) => e.status === 'RESOURCE_EXHAUSTED'), 'AGY_ERROR tap');
    assert.match(quota.short_error, /quota/);
  } finally {
    client.stop();
  }
});

test('cancel: SIGTERM mid-turn produces the interrupted result and exit code 1 (conversation survives on disk)', async (t) => {
  const dir = tmp('cancel');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { client, events } = startClient(t, {
    agyHome: path.join(dir, 'home'),
    state: path.join(dir, 'state'),
    cwd: dir,
    extraEnv: { FIXTURE_AGY_SLOW_MS: '30000' },
  });
  const exits = [];
  client.on('exit', (info) => exits.push(info));
  try {
    await waitFor(() => events.find((e) => e.event === 'init'), 'init');
    client.sendUserTurn('AGY-SLOW');
    await waitFor(() => events.some((e) => e.event === 'step_update'), 'turn to start');
    client.kill('SIGTERM');
    const result = await waitFor(() => resultOf(events), 'interrupted result');
    assert.equal(result.status, 'ERROR');
    assert.equal(result.error, 'interrupted');
    const exit = await waitFor(() => exits[0], 'exit');
    assert.equal(exit.code, 1);
  } finally {
    client.stop();
  }
});

test('a send to a child that already exited rejects with the delivery error -- no uncaughtException, no byte reaches the stream', async (t) => {
  const dir = tmp('dead-send');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uncaught = trapUncaught(t);
  // effort: '' is the invalid selection: the fixture writes its refusal and
  // exits(1) at once -- a child dead on arrival, no init to wait for.
  const client = new AntigravityClient({
    agyBin: FIXTURE,
    agyHome: path.join(dir, 'home'),
    cwd: dir,
    model: 'gemini-3.8-flash',
    effort: '',
  });
  const exits = [];
  client.on('exit', (info) => exits.push(info));
  client.start();
  try {
    await waitFor(() => exits[0], 'the child to exit');
    let wrote = false;
    const realWrite = client.proc.stdin.write.bind(client.proc.stdin);
    client.proc.stdin.write = (...a) => { wrote = true; return realWrite(...a); };
    await assert.rejects(client.sendUserTurn('a message for a dead child'), /exited before the message could be delivered/);
    assert.equal(wrote, false, 'the exited guard keeps the write off the dead stream');
    await new Promise((r) => setTimeout(r, 100)); // an async face would have surfaced by now
    assert.deepEqual(uncaught, []);
  } finally {
    client.stop();
  }
});

test('a write the child can never read (stdin read end closed mid-flight, child alive) rejects -- the EPIPE never becomes an uncaughtException', async (t) => {
  const dir = tmp('epipe-send');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uncaught = trapUncaught(t);
  const { client, events } = startClient(t, {
    agyHome: path.join(dir, 'home'),
    state: path.join(dir, 'state'),
    cwd: dir,
    extraEnv: { FIXTURE_AGY_CLOSE_STDIN: '1' }, // the fixture closed its stdin read end before init
  });
  try {
    await waitFor(() => events.find((e) => e.event === 'init'), 'init');
    assert.equal(client.exited, false, 'the child is alive -- this is the mid-flight EPIPE face, not the exited guard');
    await assert.rejects(client.sendUserTurn('into the void'), /exited before the message could be delivered/);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(uncaught, []);
  } finally {
    client.proc?.kill('SIGKILL');
    await waitFor(() => client.exited, 'the fixture to die');
  }
});

test('resume: a respawn with --conversation sees the earlier turns (history survives the process)', async (t) => {
  const dir = tmp('resume');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agyHome = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const first = startClient(t, { agyHome, state, cwd: dir });
  await waitFor(() => first.events.find((e) => e.event === 'init'), 'init (first)');
  const convId = first.events.find((e) => e.event === 'init').conversation_id;
  first.client.sendUserTurn('the magic word is ONYX');
  await waitFor(() => resultOf(first.events), 'result (first)');
  first.client.stop();
  await waitFor(() => first.client.exited, 'first process to exit');

  const second = startClient(t, { agyHome, state, cwd: dir, conversationId: convId });
  try {
    const init = await waitFor(() => second.events.find((e) => e.event === 'init'), 'init (resumed)');
    assert.equal(init.conversation_id, convId, 'resume reopens the SAME conversation');
    second.client.sendUserTurn('RESUME-CHECK: what was the magic word?');
    const result = await waitFor(() => resultOf(second.events), 'result (resumed)');
    assert.match(result.response, /FIRST-WAS: the magic word is ONYX/);
  } finally {
    second.client.stop();
  }
});

test('model-selection rule: bare slug without --effort is refused exactly like the real CLI (result ERROR, exit 1, no init)', async (t) => {
  const dir = tmp('modelrule');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = new AntigravityClient({
    agyBin: FIXTURE,
    agyHome: path.join(dir, 'home'),
    cwd: dir,
    model: 'gemini-3.8-flash',
    effort: '', // the invalid form: bare slug, no effort
  });
  const events = [];
  client.on('event', (e) => events.push(e));
  const exits = [];
  client.on('exit', (info) => exits.push(info));
  client.start();
  const result = await waitFor(() => resultOf(events), 'the refusal envelope');
  assert.equal(result.status, 'ERROR');
  assert.match(result.error, /requires --effort/);
  assert.ok(!events.some((e) => e.event === 'init'), 'no init for an invalid selection');
  const exit = await waitFor(() => exits[0], 'exit');
  assert.equal(exit.code, 1);
});

test('ensureAgySettings: creates the file with the owner-mandated keys', (t) => {
  const dir = tmp('settings-fresh');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = ensureAgySettings(dir);
  assert.equal(file, path.join(dir, '.gemini', 'antigravity-cli', 'settings.json'));
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(settings.toolPermission, 'always-proceed');
  assert.equal(settings.enableTelemetry, false);
  assert.equal(settings.notifications, false);
  assert.equal(settings.showTips, false);
  assert.equal(settings.showFeedbackSurvey, false);
  assert.equal(settings.colorScheme, 'terminal');
  assert.equal(settings.altScreenMode, 'never');
});

test('ensureAgySettings: MERGES -- existing keys (agy-owned) survive, only the mandated keys are written', (t) => {
  const dir = tmp('settings-merge');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dirAgy = path.join(dir, '.gemini', 'antigravity-cli');
  mkdirSync(dirAgy, { recursive: true });
  writeFileSync(
    path.join(dirAgy, 'settings.json'),
    JSON.stringify({ modelProvider: 'gemini', permissions: { allow: ['command(git)'] }, toolPermission: 'strict', enableTelemetry: true }),
  );
  ensureAgySettings(dir);
  const settings = JSON.parse(readFileSync(path.join(dirAgy, 'settings.json'), 'utf8'));
  assert.equal(settings.modelProvider, 'gemini', 'agy-owned keys preserved');
  assert.deepEqual(settings.permissions, { allow: ['command(git)'] }, 'nested agy-owned keys preserved');
  assert.equal(settings.toolPermission, 'always-proceed', 'the mandated toolPermission wins (owner decision: auto mode)');
  assert.equal(settings.enableTelemetry, false, 'the mandated telemetry off wins');
});

test('ensureAgySettings: is idempotent and tolerates a corrupt file', (t) => {
  const dir = tmp('settings-idem');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = ensureAgySettings(dir);
  const before = readFileSync(file, 'utf8');
  ensureAgySettings(dir);
  assert.equal(readFileSync(file, 'utf8'), before, 'a conforming file is not rewritten');
  writeFileSync(file, '{not json');
  ensureAgySettings(dir);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).toolPermission, AGY_SETTINGS_DEFAULTS.toolPermission);
});

// SECURITY INVARIANT (see buildArgv): no flag may attach the executor-writable
// workspace as an agy project -- with it, agy execs .agents/mcp_config.json's
// servers directly as the agent account (measured, agy 1.2.9 under strace).
test('buildArgv: never attaches the workspace (--add-dir or any dir-ish flag), on every path', () => {
  for (const remoteControl of [true, false]) {
    const client = new AntigravityClient({ agyBin: 'agy', agyHome: '/h', cwd: '/w', model: 'gemini-3.8-flash', effort: 'high', remoteControl });
    for (const id of [null, 'abc-123']) {
      const argv = client.buildArgv(id);
      assert.ok(!argv.some((a) => /^--(add-dir|include-directories|dir|workspace|project)\b/.test(a)), `argv attaches a directory: ${argv.join(' ')}`);
      assert.ok(!argv.includes('/w'), `argv carries the workspace path: ${argv.join(' ')}`);
    }
  }
});
