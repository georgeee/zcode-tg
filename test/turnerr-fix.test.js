// Genuine unit tests for turn-error fix round
// F3: mcp failWaiter(key, waiterId, reason) gateway function
// F6: antigravityBackend retry timer handle cancellation on cancel/close/stop

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpGateway } from "../bridge/mcp.js";
import { AntigravityBackend } from "../bridge/backends/antigravityBackend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tmp(name) {
  const dir = path.join(process.env.HOME || "/tmp", `.cache-test-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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
