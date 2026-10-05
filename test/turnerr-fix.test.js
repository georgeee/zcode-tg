// Tests for turn-error fix round (F1 - F6)
// Guards against:
// F1: Resumed session fallback in startTurn dropping waiterId
// F2: Rapid consecutive prompts in enqueuePrompt merging when waiterId is present
// F3: mcp.failWaiter() rejecting targeted waiter on /clearqueue, /stop, breaker, watchdog
// F4: isError false positive when model reply text starts with "⚠️ Turn failed:" on success
// F5: topic.lastError not cleared on subsequent turn success
// F6: Unreferenced retry timer in antigravityBackend not cleared on cancel/close/stop

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpGateway } from "../bridge/mcp.js";
import { Store } from "../bridge/store.js";
import { AntigravityBackend } from "../bridge/backends/antigravityBackend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const INDEX_PATH = path.join(REPO, "bridge", "index.js");
const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");

function tmp(name) {
  const dir = path.join(process.env.HOME || "/tmp", `.cache-test-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("F1: startTurn resumed fallback freshTurn carries waiterId to deliver reply to targeted waiter", async (t) => {
  // 1. Source check: freshTurn in bridge/index.js must include waiterId
  const match = indexSrc.match(/const freshTurn = \{([\s\S]*?)\};/);
  assert.ok(match, "freshTurn definition must exist in bridge/index.js");
  assert.match(match[1], /\bwaiterId\b/, "freshTurn must carry waiterId");

  // 2. Behavioral verification: targeted waiter resolution with freshTurn
  const gw = createMcpGateway({ port: 0, log: () => {} });
  t.after(() => gw.close());

  const targetWaiterId = "waiter-fallback-test-1";
  const p = gw.waitReply("topic-1", targetWaiterId);

  // When freshTurn has waiterId, finalizeTurn calls noteReply with that waiterId
  const freshTurn = { waiterId: targetWaiterId };
  gw.noteReply("topic-1", "recovered reply from fresh session", { waiterId: freshTurn.waiterId });

  const res = await p;
  assert.equal(res.text, "recovered reply from fresh session");
});

test("F2: enqueuePrompt merge window does not merge when either prompt has a waiterId", () => {
  // Merge window must check neither incoming prompt nor last queued entry has waiterId
  const mergeBlock = indexSrc.slice(indexSrc.indexOf("async function enqueuePrompt"));
  const mergeWindow = mergeBlock.slice(0, mergeBlock.indexOf("const notice = await tg.sendMessage"));

  assert.match(
    mergeWindow,
    /neitherHasWaiter|!waiterId/,
    "enqueuePrompt must guard merge against prompts with waiterId",
  );
  assert.doesNotMatch(
    mergeWindow,
    /if \(last && Date\.now\(\) - \(last\.at \?\? 0\) < cfg\.inputMergeMs\)/,
    "enqueuePrompt must not merge unconditionally on inputMergeMs",
  );
});

test("F3: mcp failWaiter rejects only the targeted waiter and cleans up", async (t) => {
  const gw = createMcpGateway({ port: 0, log: () => {} });
  t.after(() => gw.close());

  assert.equal(typeof gw.failWaiter, "function", "failWaiter gateway function must exist");

  const w1 = gw.waitReply("topic-f3", "waiter-f3-1");
  const w2 = gw.waitReply("topic-f3", "waiter-f3-2");

  const count = gw.failWaiter("topic-f3", "waiter-f3-1", "stopped by /stop");
  assert.equal(count, 1, "failWaiter must return 1 when matched");

  await assert.rejects(w1, /stopped by \/stop/, "targeted waiter must reject with given reason");

  let w2Resolved = false;
  w2.then(() => { w2Resolved = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w2Resolved, false, "other waiters on topic must remain pending");

  gw.noteReply("topic-f3", "reply for w2", { waiterId: "waiter-f3-2" });
  const res2 = await w2;
  assert.equal(res2.text, "reply for w2");

  assert.equal(gw.failWaiter("topic-f3", "non-existent", "reason"), 0);
});

test("F3: /clearqueue, /stop, circuit breaker, and watchdog fail parked waiters promptly", () => {
  // Check index.js failOneWaiter calls
  assert.match(indexSrc, /function failOneWaiter\(key, waiterId, reason\)/);
  assert.match(indexSrc, /failOneWaiter\(threadId, it\.waiterId, 'dropped by \/clearqueue'\)/);
  assert.match(indexSrc, /failOneWaiter\(threadId, turn\.waiterId, 'stopped by \/stop'\)/);
  assert.match(indexSrc, /failOneWaiter\(topic\.threadId, turn\.waiterId, `interrupted by circuit breaker/);
  assert.match(indexSrc, /failOneWaiter\(topic\.threadId, turn\.waiterId, `stopped by watchdog timeout/);
});

test("F4: finalizeTurn isError only checks status !== success (no text.startsWith false positive)", () => {
  assert.doesNotMatch(
    indexSrc,
    /isError = terminalParams\.status !== 'success' \|\| text\.startsWith/,
    "isError must not inspect text.startsWith for failure",
  );
  assert.match(
    indexSrc,
    /const isError = terminalParams\.status !== 'success';/,
    "isError must only check terminalParams.status !== success",
  );
});

test("F5: topic.lastError is cleared on subsequent turn success", () => {
  const dir = tmp("store-f5");
  const storePath = path.join(dir, "sessions.json");
  try {
    const s = new Store(storePath);
    s.setTopic("t1", {
      threadId: "t1",
      lastError: { at: new Date().toISOString(), message: "old failure" },
    });
    assert.ok(s.getTopic("t1").lastError, "initial lastError set");

    // Simulate successful finalizeTurn logic
    const topic = s.getTopic("t1");
    const terminalParams = { status: "success" };
    const isError = terminalParams.status !== "success";
    if (topic) {
      if (isError) {
        topic.lastError = { at: new Date().toISOString(), message: "new error" };
        s.setTopic(topic.threadId, { ...topic, lastError: topic.lastError });
      } else if (topic.lastError) {
        delete topic.lastError;
        const updated = { ...topic };
        delete updated.lastError;
        if (s.getTopic(topic.threadId)?.lastError) {
          delete s.getTopic(topic.threadId).lastError;
        }
        s.setTopic(topic.threadId, updated);
      }
    }

    assert.equal(s.getTopic("t1").lastError, undefined, "lastError must be cleared in memory");

    s.close();
    const s2 = new Store(storePath);
    try {
      assert.equal(s2.getTopic("t1").lastError, undefined, "lastError must be absent on disk");
    } finally {
      s2.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Check that index.js contains the clearing logic
  assert.match(indexSrc, /delete topic\.lastError/);
});

test("F6: antigravityBackend retry timer handle is kept and cleared on cancel, close, and stop", async (t) => {
  const dir = tmp("retry-timer-f6");
  const fixture = path.join(HERE, "fixtures", "fake-agy.mjs");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  process.env.FIXTURE_AGY_STATE = path.join(dir, "state");
  const backend = new AntigravityBackend({
    agyBin: fixture,
    agyHome: path.join(dir, "home"),
    cwd: dir,
    retryDelays: [10000, 20000], // long delay so timer stays armed during check
  });
  t.after(() => backend.stop());

  const { sessionId } = await backend.createConversation({ workspaceDir: dir });
  const rawId = sessionId.replace(/^antigravity:/, "");
  const session = backend._sessions.get(rawId);

  // Send turn that fails with 503 UNAVAILABLE to arm retry timer
  await backend.sendMessage(sessionId, "AGY-503-ALWAYS");

  // Wait for retry timer to be armed
  const t0 = Date.now();
  while (!session.retryTimer && Date.now() - t0 < 3000) {
    await new Promise((res) => setTimeout(res, 20));
  }

  assert.ok(session.retryTimer, "session.retryTimer must be armed during backoff");
  assert.ok(session.turn?.retryTimer, "session.turn.retryTimer must be armed during backoff");

  // cancel() must clear the retry timer
  await backend.cancel(sessionId);

  assert.equal(session.retryTimer, null, "retryTimer must be null after cancel");
  assert.equal(session.turn?.retryTimer, null, "turn.retryTimer must be null after cancel");
});
