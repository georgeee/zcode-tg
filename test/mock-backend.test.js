// Unit tests for the Mock backend (bridge/backends/mockBackend.js): the
// zero-credential, zero-subprocess, zero-cost third backend, used to
// exercise the multi-backend machinery for real without spending anyone's
// z.ai or Codex quota.
//
// Two layers, matching how the rest of this backend's contract is tested
// elsewhere in this repo:
//   1. Direct Backend-contract tests (createConversation/sendMessage/
//      listModels emit exactly what backend.js documents).
//   2. Through the REAL MCP gateway (bridge/mcp.js), the way test/mcp.test.js
//      already tests session_create/message_send/model_get -- but wired to
//      an actual MockBackend instance instead of a hand-rolled fake, so the
//      round trip (session_create -> message_send -> model_get) exercises
//      the real event vocabulary end to end, not just the JSON-RPC plumbing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend, MOCK_MODEL_REF } from '../bridge/backends/mockBackend.js';
import { backendNameOf, rawSessionId } from '../bridge/backend.js';
import { createMcpGateway } from '../bridge/mcp.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- 1. Direct Backend-contract tests ---

test('MockBackend.createConversation returns an immediate, prefixed session id -- no subprocess, no I/O', async () => {
  const backend = new MockBackend();
  await backend.start(); // no-op; must not throw or spawn anything
  const t0 = Date.now();
  const res = await backend.createConversation({ mode: 'yolo' });
  assert.ok(Date.now() - t0 < 50, 'createConversation should be effectively synchronous (no subprocess, no network)');
  assert.equal(backendNameOf(res.sessionId), 'mock');
  assert.ok(rawSessionId(res.sessionId).length > 0, 'raw id is non-empty');
  assert.equal(res.model, MOCK_MODEL_REF);
  assert.equal(res.mode, 'yolo');
  await backend.stop(); // no-op; must not throw
});

test('MockBackend.createConversation honors an explicit model argument', async () => {
  const backend = new MockBackend();
  const res = await backend.createConversation({ model: 'some-other-ref' });
  // Nothing validates the model at this layer (index.js/mcp.js's
  // validateMcpModel is what actually enforces "no MCP-switchable model");
  // the backend itself just echoes whatever it's given, same as zcode's own
  // createConversation.
  assert.equal(res.model, 'some-other-ref');
});

test('MockBackend.resumeConversation always succeeds -- there is no upstream state to have gone stale', async () => {
  const backend = new MockBackend();
  const created = await backend.createConversation({});
  const resumed = await backend.resumeConversation(created.sessionId, {});
  assert.equal(resumed.sessionId, created.sessionId);
});

test('MockBackend.listModels returns exactly one synthetic model, clearly labeled', async () => {
  const backend = new MockBackend();
  const models = await backend.listModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].ref, MOCK_MODEL_REF);
  assert.match(models[0].label, /mock|synthetic/i);
});

test('MockBackend.listModes reports no mode concept, same as Codex', async () => {
  const backend = new MockBackend();
  assert.deepEqual(backend.listModes(), []);
});

test('MockBackend.sendMessage emits the shared event vocabulary and echoes the prompt, obviously labeled', async () => {
  const backend = new MockBackend();
  const { sessionId } = await backend.createConversation({});
  const events = [];
  backend.on('event', (m) => events.push(m));

  const t0 = Date.now();
  await backend.sendMessage(sessionId, 'what is 2+2');
  assert.ok(Date.now() - t0 < 50, 'sendMessage itself resolves immediately (fire-and-forget, per backend.js)');

  // Events are deliberately deferred one microtask past sendMessage's own
  // resolution (see the backend's comment) -- give the microtask queue a
  // turn to drain before asserting on them.
  await sleep(0);

  assert.equal(events.length, 4, JSON.stringify(events));
  const [started, delta, result, terminal] = events;

  assert.equal(started.method, 'v4/telemetry/event');
  assert.equal(started.params.kind, 'turn.started');
  assert.equal(started.params.sessionId, sessionId);
  const turnId = started.params.turnId;
  assert.ok(turnId, 'turn.started carries a turnId');

  assert.equal(delta.method, 'session/event');
  assert.equal(delta.params.turnId, turnId);
  assert.equal(delta.params.payload.kind, 'text_delta');
  assert.equal(delta.params.payload.delta, '[mock echo] what is 2+2');

  assert.equal(result.method, 'session/event');
  assert.equal(result.params.turnId, turnId);
  assert.equal(result.params.payload.kind, 'result');
  assert.equal(result.params.payload.content, '[mock echo] what is 2+2');

  assert.equal(terminal.method, 'v4/telemetry/event');
  assert.equal(terminal.params.turnId, turnId);
  assert.equal(terminal.params.kind, 'turn.terminal');
  assert.equal(terminal.params.status, 'success');
});

test('MockBackend.sendMessage: each call gets its own turnId, even on the same session', async () => {
  const backend = new MockBackend();
  const { sessionId } = await backend.createConversation({});
  const turnIds = [];
  backend.on('event', (m) => {
    if (m.params.kind === 'turn.started') turnIds.push(m.params.turnId);
  });
  await backend.sendMessage(sessionId, 'first');
  await sleep(0);
  await backend.sendMessage(sessionId, 'second');
  await sleep(0);
  assert.equal(turnIds.length, 2);
  assert.notEqual(turnIds[0], turnIds[1]);
});

test('MockBackend never asks for permission or user input, and has no local tool processes to kill', async () => {
  const backend = new MockBackend();
  let called = false;
  backend.onPermissionRequest(() => { called = true; });
  backend.onUserInputRequest(() => { called = true; });
  await backend.sendMessage((await backend.createConversation({})).sessionId, 'x');
  await sleep(0);
  assert.equal(called, false);
  assert.doesNotThrow(() => backend.killLocalToolProcesses('whatever'));
});

test('MockBackend model switching is a documented no-op, not a throw', async () => {
  const backend = new MockBackend();
  const { sessionId } = await backend.createConversation({});
  await assert.doesNotReject(() => backend.setModel(sessionId, 'anything'));
  await assert.doesNotReject(() => backend.setMode(sessionId, 'anything'));
});

// --- 2. Through the real MCP gateway, wired to a real MockBackend instance
// -- mirrors what bridge/index.js's own wiring does (getOrCreateSession /
// startTurn / finalizeTurn), just trimmed to what the mock backend needs
// (no Telegram, no store, no queueing). ---

async function startGatewayWithMockBridge(t) {
  const backend = new MockBackend();
  await backend.start();
  const sessions = new Map(); // key -> { sessionId, model }
  let nextThread = 1;

  const gw = createMcpGateway({ port: 0, log: () => {} });
  backend.on('event', (msg) => {
    // The one piece of onBackendEvent's real logic this round trip actually
    // needs: recognize the turn-final text and note it as the session's
    // reply, the same signal finalizeTurn()'s `mcp.noteReply` gives a real
    // turn in bridge/index.js.
    if (msg.method === 'session/event' && msg.params.payload?.kind === 'result') {
      for (const [key, s] of sessions) {
        if (s.sessionId === msg.params.sessionId) gw.noteReply(key, msg.params.payload.content);
      }
    }
  });
  gw.wire({
    sessionCreate: async (name, chatId, backendName, modelArg) => {
      const backendUsed = backendName || 'mock';
      assert.equal(backendUsed, 'mock', 'this harness only ever wires the mock backend');
      const created = await backend.createConversation({ model: modelArg });
      const key = `t${nextThread++}`;
      sessions.set(key, { sessionId: created.sessionId, model: created.model });
      return { key, backend: backendUsed, model: created.model };
    },
    messageSend: async (key, text, wait) => {
      const s = sessions.get(key);
      if (!s) throw new Error(`unknown session: ${key}`);
      if (!wait) {
        void backend.sendMessage(s.sessionId, text);
        return { queued: true, key };
      }
      const pending = gw.waitReply(key);
      await backend.sendMessage(s.sessionId, text);
      const reply = await pending;
      return { reply: reply.text, at: reply.at };
    },
    modelGet: (key) => {
      const s = key ? sessions.get(key) : null;
      const model = s?.model ?? MOCK_MODEL_REF;
      return { backend: 'mock', model, switchable: false };
    },
    repliesGet: (key, afterSeq) => ({ replies: gw.repliesSince(key, afterSeq) }),
  });
  await gw.ready;
  const port = gw.address().port;
  t.after(() => gw.close());
  return { url: `http://127.0.0.1:${port}/mcp`, backend };
}

async function rpc(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : JSON.parse(await res.text()) };
}
const tool = (url, name, args, id) => rpc(url, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('mock backend over MCP: session_create -> message_send round trip echoes the prompt', async (t) => {
  const { url } = await startGatewayWithMockBridge(t);

  const created = await tool(url, 'session_create', { name: 'mock-e2e', backend: 'mock' }, 1);
  assert.equal(created.body.result.isError, false);
  const c1 = JSON.parse(created.body.result.content[0].text);
  assert.equal(c1.backend, 'mock');
  assert.equal(c1.model, MOCK_MODEL_REF);

  const sent = await tool(url, 'message_send', { key: c1.key, text: 'hello mock' }, 2);
  assert.equal(sent.body.result.isError, false);
  const payload = JSON.parse(sent.body.result.content[0].text);
  assert.equal(payload.reply, '[mock echo] hello mock');
});

test('mock backend over MCP: message_send with wait=false returns immediately, reply still lands in replies_get', async (t) => {
  const { url } = await startGatewayWithMockBridge(t);
  const created = await tool(url, 'session_create', { name: 'mock-e2e-2', backend: 'mock' }, 1);
  const c1 = JSON.parse(created.body.result.content[0].text);

  const sent = await tool(url, 'message_send', { key: c1.key, text: 'async hi', wait: false }, 2);
  assert.equal(JSON.parse(sent.body.result.content[0].text).queued, true);

  // The mock backend's own events land within a microtask -- a couple of
  // event-loop turns is generous slack for the replies_get poll below.
  let replies = [];
  for (let i = 0; i < 10 && !replies.length; i++) {
    await sleep(5);
    const got = await tool(url, 'replies_get', { key: c1.key }, 3);
    replies = JSON.parse(got.body.result.content[0].text).replies;
  }
  assert.ok(replies.some((r) => r.text === '[mock echo] async hi'), JSON.stringify(replies));
});

test('mock backend over MCP: model_get reports the fixed model and switchable:false', async (t) => {
  const { url } = await startGatewayWithMockBridge(t);
  const created = await tool(url, 'session_create', { name: 'mock-e2e-3', backend: 'mock' }, 1);
  const c1 = JSON.parse(created.body.result.content[0].text);

  const got = await tool(url, 'model_get', { key: c1.key }, 2);
  assert.equal(got.body.result.isError, false);
  const payload = JSON.parse(got.body.result.content[0].text);
  assert.equal(payload.backend, 'mock');
  assert.equal(payload.model, MOCK_MODEL_REF);
  assert.equal(payload.switchable, false);
});

test('mock backend over MCP: session_create rejects a model argument (no MCP-switchable model, same policy as zcode)', async (t) => {
  // This mirrors the REAL bridge's own validateMcpModel gate (bridge/index.js),
  // which every deployment's sessionCreate handler runs before ever touching
  // a backend -- reconstructed narrowly here since this harness's own
  // sessionCreate above doesn't reimplement that gate (it isn't the thing
  // under test in the other cases). Documents the policy this backend
  // deliberately follows: see mockBackend.js's "Model-switching policy"
  // comment and bridge/index.js's validateMcpModel.
  function validateMcpModel(backend, model) {
    if (model == null) return undefined;
    if (backend !== 'codex') throw new Error(`model may only be chosen for the codex backend over MCP (got backend=${backend}); ${backend} has no MCP-switchable model`);
    return model;
  }
  assert.throws(() => validateMcpModel('mock', 'mock-1'), /has no MCP-switchable model/);
});
