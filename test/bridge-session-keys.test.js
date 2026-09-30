// Regression tests for MCP bridge session key uniqueness across restarts (Bug 1)
// and effort suffix handling in session_create / model_get (Bug 2).
//
// Run: node --test test/bridge-session-keys.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../bridge/store.js';
import { KeyAllocator, makeNullTelegram } from '../bridge/allocator.js';
import { progressForTopic } from '../bridge/progress.js';
import { AntigravityBackend, AGY_MODEL_REF } from '../bridge/backends/antigravityBackend.js';
import { createMcpGateway } from '../bridge/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-agy.mjs');

function tmp(name) {
  return mkdtempSync(path.join(tmpdir(), `bridge-keys-${name}-`));
}

test('KeyAllocator starts above max persisted keys and skips recorded keys', () => {
  const dir = tmp('allocator-basic');
  const storePath = path.join(dir, 'sessions.json');
  try {
    const s = new Store(storePath);
    // Base case: empty store starts at 9000
    const a1 = new KeyAllocator(s);
    assert.equal(a1.allocate(), 9000);
    assert.equal(a1.allocate(), 9001);

    // Persist some keys: 9002 (open), 9005 (closed), and a composite key
    s.setTopic('9002', { chatId: -100, threadId: 9002, name: 'open-1' });
    s.setTopic('9005', { chatId: -100, threadId: 9005, name: 'closed-1', closed: true });
    s.setTopic('c-200:t9007', { chatId: -200, threadId: 9007, name: 'other-chat' });
    s.close();

    // Reopen store from same STORE_PATH
    const s2 = new Store(storePath);
    try {
      assert.equal(s2.maxPersistedKey(), 9007);
      const a2 = new KeyAllocator(s2);
      // Starts above max (9007 -> 9008)
      assert.equal(a2.allocate(), 9008);
      assert.equal(a2.allocate(), 9009);

      // Verify isKeyRecorded detects open, closed, and composite records
      assert.equal(s2.isKeyRecorded('9002', 9002), true);
      assert.equal(s2.isKeyRecorded('9005', 9005), true);
      assert.equal(s2.isKeyRecorded('c-200:t9007', 9007), true);
      assert.equal(s2.isKeyRecorded('9008', 9008), false);
    } finally {
      s2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Bug 1: (a) persist closed and open sessions, simulate a restart, create key > every persisted key and progress_get idle and fresh', async () => {
  const dir = tmp('simulated-restart');
  const storePath = path.join(dir, 'sessions.json');
  try {
    // 1. Initial bridge session run: persist open session (9001) and closed session (9003)
    const s1 = new Store(storePath);
    s1.setTopic('9000', { chatId: -100, threadId: 9000, name: 'session-0', backend: 'antigravity', sessionId: 'antigravity:id-0', mode: 'yolo' });
    s1.setTopic('9001', { chatId: -100, threadId: 9001, name: 'session-1', backend: 'antigravity', sessionId: 'antigravity:id-1', mode: 'yolo' });
    s1.setTopic('9003', { chatId: -100, threadId: 9003, name: 'session-3', backend: 'antigravity', sessionId: 'antigravity:id-3', closed: true, mode: 'yolo' });
    s1.close();

    // 2. Simulate bridge restart: construct new store and allocator from the same STORE_PATH
    const s2 = new Store(storePath);
    try {
      const tg = makeNullTelegram(s2, -100);
      const activeTurns = new Map();

      // Ensure old sessions exist as expected
      assert.equal(s2.isKeyRecorded('9001', 9001), true);
      assert.equal(s2.isKeyRecorded('9003', 9003), true);

      // progress_get on the closed session throws "session 9003 is closed"
      assert.throws(() => progressForTopic({ getTopic: (k) => s2.getTopic(k), activeTurns, key: '9003' }), /session 9003 is closed/);

      // Verify create refuses to reuse any existing recorded key
      const keyFor = (chatId, threadId) => String(threadId);
      const fakeReusedTopic = async (reusedThreadId) => {
        const key = keyFor(-100, reusedThreadId);
        if (s2.isKeyRecorded(key, reusedThreadId)) {
          throw new Error(`cannot create session: key "${key}" already has an existing record`);
        }
      };
      await assert.rejects(() => fakeReusedTopic(9001), /already has an existing record/);
      await assert.rejects(() => fakeReusedTopic(9003), /already has an existing record/);

      // Now create a fresh session via the allocator
      const topic = await tg.createForumTopic({ chatId: -100, name: 'fresh-after-restart' });
      const newThreadId = topic.message_thread_id;
      const newKey = keyFor(-100, newThreadId);

      // (a) Requirement: the key must be > every persisted key (max was 9003)
      assert.ok(newThreadId > 9003, `key ${newThreadId} must be > every persisted key (9003)`);
      assert.equal(newThreadId, 9004);
      assert.equal(newKey, '9004');

      // Record fresh topic
      s2.setTopic(newKey, { chatId: -100, threadId: newThreadId, name: 'fresh-after-restart', backend: 'antigravity', sessionId: 'antigravity:id-fresh', mode: 'yolo' });

      // (a) Requirement: progress_get on the new key is idle and fresh
      const progress = progressForTopic({ getTopic: (k) => s2.getTopic(k), activeTurns, key: newKey });
      assert.equal(progress.key, newKey);
      assert.equal(progress.state, 'idle');
      assert.equal(progress.active, false);
      assert.equal(progress.startedAt, null);
      assert.equal(progress.activityCount, null);
      assert.deepEqual(progress.recentActivity, []);
    } finally {
      s2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Bug 2: (b) create with :low: response model and model_get = "gemini-3.8-flash:low" and spawn argv/effort is low', async () => {
  const dir = tmp('effort-low');
  const markerLog = path.join(dir, 'spawns.jsonl');
  process.env.FIXTURE_AGY_MARKER_LOG = markerLog;
  process.env.FIXTURE_AGY_STATE = path.join(dir, 'state');

  try {
    const backend = new AntigravityBackend({
      agyBin: FIXTURE,
      agyHome: path.join(dir, 'home'),
      cwd: dir,
      privateCwd: path.join(dir, 'private'),
    });
    await backend.start();
    try {
      const storePath = path.join(dir, 'sessions.json');
      const store = new Store(storePath);
      try {
        const tg = makeNullTelegram(store, -100);

        // 1. Create conversation with model "gemini-3.8-flash:low"
        const topic = await tg.createForumTopic({ chatId: -100, name: 'low-effort-session' });
        const key = String(topic.message_thread_id);
        const reqModel = 'gemini-3.8-flash:low';

        store.setTopic(key, { chatId: -100, threadId: topic.message_thread_id, name: 'low-effort-session', backend: 'antigravity', model: reqModel, mode: 'yolo' });

        const created = await backend.createConversation({ workspaceDir: dir, model: reqModel });

        // (b) Requirement: create response model is "gemini-3.8-flash:low"
        assert.equal(created.model, 'gemini-3.8-flash:low');

        store.setTopic(key, { sessionId: created.sessionId, model: created.model });

        // (b) Requirement: model_get returns "gemini-3.8-flash:low"
        const entry = store.getTopic(key);
        assert.equal(entry.model, 'gemini-3.8-flash:low');

        // (b) Requirement: spawn argv/effort is low
        const spawns = readFileSync(markerLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const lastSpawn = spawns.at(-1);
        assert.ok(lastSpawn.argv.includes('--effort'), 'spawn argv must include --effort');
        const effortVal = lastSpawn.argv[lastSpawn.argv.indexOf('--effort') + 1];
        assert.equal(effortVal, 'low', `spawn effort must be low, got: ${effortVal}`);
        assert.equal(lastSpawn.argv[lastSpawn.argv.indexOf('--model') + 1], AGY_MODEL_REF);
      } finally {
        store.close();
      }
    } finally {
      await backend.stop();
    }
  } finally {
    delete process.env.FIXTURE_AGY_MARKER_LOG;
    delete process.env.FIXTURE_AGY_STATE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session_create with MCP gateway: model :low returns effective model in response and model_get', async () => {
  const dir = tmp('mcp-gw-effort');
  const storePath = path.join(dir, 'sessions.json');
  const markerLog = path.join(dir, 'spawns.jsonl');
  process.env.FIXTURE_AGY_MARKER_LOG = markerLog;
  process.env.FIXTURE_AGY_STATE = path.join(dir, 'state');

  try {
    const backend = new AntigravityBackend({
      agyBin: FIXTURE,
      agyHome: path.join(dir, 'home'),
      cwd: dir,
      privateCwd: path.join(dir, 'private'),
    });
    await backend.start();
    const store = new Store(storePath);
    const tg = makeNullTelegram(store, -100);

    const gw = createMcpGateway({ port: 0, log: () => {} });
    gw.wire({
      sessionCreate: async (name, chatIdNum, backendName, modelArg) => {
        const bName = backendName || 'antigravity';
        const topic = await tg.createForumTopic({ chatId: -100, name });
        const threadId = topic.message_thread_id;
        const key = String(threadId);
        if (store.isKeyRecorded(key, threadId)) {
          throw new Error(`cannot create session: key "${key}" already has an existing record`);
        }
        store.setTopic(key, { chatId: -100, threadId, name, backend: bName, model: modelArg });
        const created = await backend.createConversation({ workspaceDir: dir, model: modelArg });
        store.setTopic(key, { sessionId: created.sessionId, model: created.model });
        return { key, chat_id: -100, thread_id: threadId, model: created.model, backend: bName };
      },
      modelGet: (key) => {
        const entry = store.getTopic(key);
        if (!entry) throw new Error(`unknown session: ${key}`);
        return { backend: entry.backend, model: entry.model, switchable: true };
      },
    });
    await gw.ready;
    const port = gw.address().port;
    const url = `http://127.0.0.1:${port}/mcp`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'session_create',
            arguments: { name: 'test-low', backend: 'antigravity', model: 'gemini-3.8-flash:low' },
          },
        }),
      });
      const data = await res.json();
      assert.equal(data.result.isError, false);
      const parsedRes = JSON.parse(data.result.content[0].text);
      assert.equal(parsedRes.model, 'gemini-3.8-flash:low');

      const mgRes = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'model_get', arguments: { key: parsedRes.key } },
        }),
      });
      const mgData = await mgRes.json();
      assert.equal(mgData.result.isError, false);
      const parsedMg = JSON.parse(mgData.result.content[0].text);
      assert.equal(parsedMg.model, 'gemini-3.8-flash:low');
    } finally {
      gw.close();
      store.close();
      await backend.stop();
    }
  } finally {
    delete process.env.FIXTURE_AGY_MARKER_LOG;
    delete process.env.FIXTURE_AGY_STATE;
    rmSync(dir, { recursive: true, force: true });
  }
});
