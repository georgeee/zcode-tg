import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AntigravityBackend } from '../bridge/backends/antigravityBackend.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-agy.mjs');

function tmp(name) {
  return mkdtempSync(path.join(tmpdir(), `agy-heal-${name}-`));
}

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

async function waitFor(fn, what, ms = 3_000) {
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

function makeRecorderHook(dir, mode = 'normal') {
  const logFile = path.join(dir, 'hook-payloads.jsonl');
  const markerFile = path.join(dir, 'hook-started.log');
  const hookScript = path.join(dir, 'hook.mjs');
  let body = '';
  if (mode === 'hang') {
    body = `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(markerFile)}, 'started\\n');
setInterval(() => {}, 1000);
`;
  } else if (mode === 'fail') {
    body = `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(markerFile)}, 'started\\n');
process.stderr.write('simulated hook error\\n');
process.exit(1);
`;
  } else if (mode === 'delay') {
    body = `
import { readFileSync, appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(markerFile)}, 'started\\n');
const stdin = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(logFile)}, stdin.trim() + '\\n');
await new Promise((r) => setTimeout(r, 300));
`;
  } else {
    body = `
import { readFileSync, appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(markerFile)}, 'started\\n');
const stdin = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(logFile)}, stdin.trim() + '\\n');
`;
  }
  writeFileSync(hookScript, body);
  return { hookScript, logFile, markerFile };
}

function readPayloads(logFile) {
  if (!existsSync(logFile)) return [];
  const text = readFileSync(logFile, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('heal hook fires once with the right payload for each measured write tool (write_to_file, replace_file_content, multi_replace_file_content)', async (t) => {
  const dir = tmp('write-tools');
  const { hookScript, logFile } = makeRecorderHook(dir);
  const hookArgv = [process.execPath, hookScript];

  const prevEnv = process.env.AGY_HEAL_HOOK_ARGV;
  process.env.AGY_HEAL_HOOK_ARGV = JSON.stringify(hookArgv);
  const { backend, events } = makeBackend(dir);
  t.after(async () => {
    if (prevEnv !== undefined) process.env.AGY_HEAL_HOOK_ARGV = prevEnv;
    else delete process.env.AGY_HEAL_HOOK_ARGV;
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const { sessionId } = await backend.createConversation({ workspaceDir: dir });

  // 1. write_to_file with relative path
  await backend.sendMessage(sessionId, 'write_to_file:sub/created.txt');
  await waitFor(() => terminals(events).length >= 1, 'terminal 1');
  await waitFor(() => readPayloads(logFile).length >= 1, 'hook payload 1');

  let payloads = readPayloads(logFile);
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], {
    tool_input: { file_path: path.resolve(dir, 'sub/created.txt') },
  });

  // 2. replace_file_content with relative path
  await backend.sendMessage(sessionId, 'replace_file_content:sub/edited.txt');
  await waitFor(() => terminals(events).length >= 2, 'terminal 2');
  await waitFor(() => readPayloads(logFile).length >= 2, 'hook payload 2');

  payloads = readPayloads(logFile);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[1], {
    tool_input: { file_path: path.resolve(dir, 'sub/edited.txt') },
  });

  // 3. multi_replace_file_content with absolute path
  const absPath = path.join(dir, 'other', 'multi.txt');
  await backend.sendMessage(sessionId, `multi_replace_file_content:${absPath}`);
  await waitFor(() => terminals(events).length >= 3, 'terminal 3');
  await waitFor(() => readPayloads(logFile).length >= 3, 'hook payload 3');

  payloads = readPayloads(logFile);
  assert.equal(payloads.length, 3);
  assert.deepEqual(payloads[2], {
    tool_input: { file_path: absPath },
  });
});

test('heal hook does not fire for run_command', async (t) => {
  const dir = tmp('run-cmd');
  const { hookScript, logFile } = makeRecorderHook(dir);
  const hookArgv = [process.execPath, hookScript];

  const prevEnv = process.env.AGY_HEAL_HOOK_ARGV;
  process.env.AGY_HEAL_HOOK_ARGV = JSON.stringify(hookArgv);
  const { backend, events } = makeBackend(dir);
  t.after(async () => {
    if (prevEnv !== undefined) process.env.AGY_HEAL_HOOK_ARGV = prevEnv;
    else delete process.env.AGY_HEAL_HOOK_ARGV;
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  await backend.sendMessage(sessionId, 'run_command');
  await waitFor(() => terminals(events).length >= 1, 'terminal');
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(readPayloads(logFile).length, 0);
});

test('heal hook does not fire for a failed or cancelled step', async (t) => {
  const dir = tmp('failed-cancel');
  const { hookScript, logFile } = makeRecorderHook(dir);
  const hookArgv = [process.execPath, hookScript];

  const prevEnv = process.env.AGY_HEAL_HOOK_ARGV;
  process.env.AGY_HEAL_HOOK_ARGV = JSON.stringify(hookArgv);
  const { backend, events } = makeBackend(dir);
  t.after(async () => {
    if (prevEnv !== undefined) process.env.AGY_HEAL_HOOK_ARGV = prevEnv;
    else delete process.env.AGY_HEAL_HOOK_ARGV;
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const { sessionId } = await backend.createConversation({ workspaceDir: dir });

  // Failed step
  await backend.sendMessage(sessionId, 'write_to_file:fail.txt FAIL_STEP');
  await waitFor(() => terminals(events).length >= 1, 'terminal');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(readPayloads(logFile).length, 0);

  // Cancelled step
  const rawId = sessionId.replace(/^antigravity:/, '');
  const session = backend._sessions.get(rawId);
  session.cancelPending = true;
  backend._onStepUpdate(session, sessionId, {
    step_type: 'tool',
    tool_name: 'write_to_file',
    state: 'DONE',
    step_index: 99,
    tool_info: { name: 'write_to_file', parameters: { TargetFile: 'cancelled.txt' } },
  });
  session.cancelPending = false;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(readPayloads(logFile).length, 0);
});

test('heal hook unset or invalid env -> never fires, turn unaffected', async (t) => {
  const dir = tmp('unset-invalid');
  const { hookScript, logFile } = makeRecorderHook(dir);

  const prevEnv = process.env.AGY_HEAL_HOOK_ARGV;
  t.after(() => {
    if (prevEnv !== undefined) process.env.AGY_HEAL_HOOK_ARGV = prevEnv;
    else delete process.env.AGY_HEAL_HOOK_ARGV;
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. Unset env
  delete process.env.AGY_HEAL_HOOK_ARGV;
  const { backend: b1, events: e1 } = makeBackend(dir, { healHookArgv: null });
  try {
    const { sessionId: s1 } = await b1.createConversation({ workspaceDir: dir });
    await b1.sendMessage(s1, 'write_to_file:unset.txt');
    const t1 = await waitFor(() => terminals(e1)[0], 'terminal 1');
    assert.equal(t1.params.status, 'success');
    assert.equal(readPayloads(logFile).length, 0);
  } finally {
    await b1.stop();
  }

  // 2. Invalid env
  process.env.AGY_HEAL_HOOK_ARGV = 'not-valid-json{[';
  let warnLogged = false;
  const origWarn = console.warn;
  console.warn = (...args) => {
    if (args.some((a) => String(a).includes('invalid AGY_HEAL_HOOK_ARGV'))) warnLogged = true;
    origWarn(...args);
  };
  let b2;
  try {
    const res = makeBackend(dir);
    b2 = res.backend;
    const { sessionId: s2 } = await b2.createConversation({ workspaceDir: dir });
    await b2.sendMessage(s2, 'write_to_file:invalid.txt');
    const t2 = await waitFor(() => terminals(res.events)[0], 'terminal 2');
    assert.equal(t2.params.status, 'success');
    assert.equal(readPayloads(logFile).length, 0);
    assert.equal(warnLogged, true);
  } finally {
    console.warn = origWarn;
    if (b2) await b2.stop();
  }
});

test('a hook that hangs or exits non-zero does not delay the turn reply', async (t) => {
  const dir = tmp('hang-fail');
  const prevEnv = process.env.AGY_HEAL_HOOK_ARGV;
  t.after(() => {
    if (prevEnv !== undefined) process.env.AGY_HEAL_HOOK_ARGV = prevEnv;
    else delete process.env.AGY_HEAL_HOOK_ARGV;
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. Hanging hook
  const { hookScript: hangHook, markerFile: hangMarker } = makeRecorderHook(dir, 'hang');
  process.env.AGY_HEAL_HOOK_ARGV = JSON.stringify([process.execPath, hangHook]);

  const { backend: b1, events: e1 } = makeBackend(dir);
  try {
    const { sessionId: s1 } = await b1.createConversation({ workspaceDir: dir });
    const t0 = Date.now();
    await b1.sendMessage(s1, 'write_to_file:hang.txt');
    const term1 = await waitFor(() => terminals(e1)[0], 'terminal hang');
    const elapsed = Date.now() - t0;

    assert.equal(term1.params.status, 'success');
    assert.ok(elapsed < 3000, `turn reply took ${elapsed}ms, expected < 3000ms`);
    await waitFor(() => existsSync(hangMarker), 'hang marker to be touched');
  } finally {
    await b1.stop();
  }

  // 2. Failing hook (exit 1)
  const { hookScript: failHook, markerFile: failMarker } = makeRecorderHook(dir, 'fail');
  process.env.AGY_HEAL_HOOK_ARGV = JSON.stringify([process.execPath, failHook]);

  const { backend: b2, events: e2 } = makeBackend(dir);
  try {
    const { sessionId: s2 } = await b2.createConversation({ workspaceDir: dir });
    await b2.sendMessage(s2, 'write_to_file:fail_exit.txt');
    const term2 = await waitFor(() => terminals(e2)[0], 'terminal fail');
    assert.equal(term2.params.status, 'success');
    await waitFor(() => existsSync(failMarker), 'fail marker to be touched');
  } finally {
    await b2.stop();
  }
});

test('at most one concurrent hook per path', async (t) => {
  const dir = tmp('concurrency');
  const { hookScript, logFile } = makeRecorderHook(dir, 'delay');
  const hookArgv = [process.execPath, hookScript];

  const prevEnv = process.env.AGY_HEAL_HOOK_ARGV;
  process.env.AGY_HEAL_HOOK_ARGV = JSON.stringify(hookArgv);
  const { backend } = makeBackend(dir);
  t.after(async () => {
    if (prevEnv !== undefined) process.env.AGY_HEAL_HOOK_ARGV = prevEnv;
    else delete process.env.AGY_HEAL_HOOK_ARGV;
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  const rawId = sessionId.replace(/^antigravity:/, '');
  const session = backend._sessions.get(rawId);

  // Directly emit two step updates with the same target path while the first hook is in flight
  session.turn = { id: `${rawId}:1`, toolCallIds: new Map(), toolCallCount: 0, toolParams: new Map() };
  backend._onStepUpdate(session, sessionId, {
    step_type: 'tool',
    tool_name: 'write_to_file',
    state: 'DONE',
    step_index: 0,
    tool_info: { name: 'write_to_file', parameters: { TargetFile: 'concurrent.txt' } },
  });

  // Second step for the same file before the first exits
  backend._onStepUpdate(session, sessionId, {
    step_type: 'tool',
    tool_name: 'write_to_file',
    state: 'DONE',
    step_index: 1,
    tool_info: { name: 'write_to_file', parameters: { TargetFile: 'concurrent.txt' } },
  });

  // Wait for the slow hook to finish
  await new Promise((r) => setTimeout(r, 600));

  const payloads = readPayloads(logFile);
  assert.equal(payloads.length, 1, 'expected exactly 1 hook execution due to concurrent deduplication');
});
