// Unit tests for the MCP gateway: the JSON-RPC surface (initialize, tools
// list, tools/call), the reply-waiter lifecycle, and the routing into the
// bridge handlers -- with a fake bridge, no Telegram and no model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpGateway } from '../bridge/mcp.js';

async function startGateway(t, impl) {
  const gw = createMcpGateway({ port: 0, log: () => {} });
  gw.wire(impl);
  await gw.ready;
  const port = gw.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    url,
    close: () => gw.close(),
    noteReply: (k, text) => gw.noteReply(k, text),
    waitReply: (k) => gw.waitReply(k),
    failAll: (why) => gw.failWaiters(why),
    replies: (k) => gw.repliesSince(k),
  };
}

async function rpc(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : JSON.parse(await res.text()) };
}

test('initialize handshake returns the protocol version and capabilities', async (t) => {
  const h = await startGateway(t, {});
  t.after(() => h.close());
  const r = await rpc(h.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, '2024-11-05');
  assert.ok(r.body.result.capabilities.tools);
  assert.equal(r.body.result.serverInfo.name, 'cage-pod-zcode-mcp');
});

test('tools/list advertises the six tools with schemas', async (t) => {
  const h = await startGateway(t, {});
  t.after(() => h.close());
  const r = await rpc(h.url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = r.body.result.tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['message_send', 'model_get', 'replies_get', 'session_close', 'session_create', 'usage_get']);
  for (const tool of r.body.result.tools) assert.ok(tool.inputSchema, `${tool.name} carries a schema`);
});

test('model_get is read-only and names the default model', async (t) => {
  const h = await startGateway(t, { modelGet: () => ({ model: 'zai/glm-5.3-flash', switchable: false }) });
  t.after(() => h.close());
  const r = await rpc(h.url, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'model_get', arguments: {} },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.isError, false);
  const payload = JSON.parse(r.body.result.content[0].text);
  assert.equal(payload.model, 'zai/glm-5.3-flash');
  assert.equal(payload.switchable, false);
});

test('usage_get is read-only and reports the account\'s quota windows', async (t) => {
  const h = await startGateway(t, {
    usageGet: () => ({
      level: 'lite',
      windows: [
        { window: 'Short-term (~5h)', used: 127, cap: 2000, remaining: 1873, percentage: 6, resetsAt: '2026-09-01T03:26:57.027Z' },
      ],
      cachedAt: '2026-09-01T03:16:57.027Z',
    }),
  });
  t.after(() => h.close());
  const r = await rpc(h.url, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'usage_get', arguments: {} },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.isError, false);
  const payload = JSON.parse(r.body.result.content[0].text);
  assert.equal(payload.level, 'lite');
  assert.equal(payload.windows.length, 1);
  // FIELD NAMES ARE THE INTERFACE: the API's own `usage`/`currentValue` are
  // swapped from what they sound like, and this tool must never pass that
  // confusion through -- `used` is what was used, `cap` is the ceiling.
  assert.equal(payload.windows[0].used, 127);
  assert.equal(payload.windows[0].cap, 2000);
  assert.equal(payload.windows[0].remaining, 1873);
  assert.ok(payload.cachedAt, 'reports how fresh the figures are');
});

test('usage_get surfaces a fetch failure as a tool error, not a fabricated answer', async (t) => {
  const h = await startGateway(t, {
    usageGet: () => {
      throw new Error('usage has not been fetched yet; retry shortly');
    },
  });
  t.after(() => h.close());
  const r = await rpc(h.url, {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'usage_get', arguments: {} },
  });
  assert.equal(r.status, 200); // JSON-RPC succeeded; the TOOL reports the error
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /not been fetched yet/);
});

test('unknown methods return a JSON-RPC error; notifications return no body', async (t) => {
  const h = await startGateway(t, {});
  t.after(() => h.close());
  const err = await rpc(h.url, { jsonrpc: '2.0', id: 3, method: 'no/such', params: {} });
  assert.equal(err.body.error.code, -32601);
  const res = await fetch(h.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(res.status, 204);
});

test('message_send mirrors the prompt, waits for the reply via the hook, returns it', async (t) => {
  const calls = [];
  const impl = {
    async messageSend(key, text) {
      calls.push({ key, text });
      // The real bridge parks a waitReply BEFORE dispatching (so a fast
      // turn cannot beat the waiter) and finalizeTurn then notes the
      // final reply -- replicate that exact order here.
      const pending = h.waitReply(key);
      h.noteReply(key, 'the agent reply');
      return { reply: (await pending).text };
    },
  };
  const h = await startGateway(t, impl);
  t.after(() => h.close());
  const r = await rpc(h.url, {
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'message_send', arguments: { key: 'c-100999:t7', text: 'the opus prompt' } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.isError, false);
  const payload = JSON.parse(r.body.result.content[0].text);
  assert.equal(payload.reply, 'the agent reply');
  assert.deepEqual(calls, [{ key: 'c-100999:t7', text: 'the opus prompt' }]);
  assert.ok(h.replies('c-100999:t7').some((x) => x.text === 'the agent reply'));
});

test('message_send with wait=false returns without a reply', async (t) => {
  const impl = {
    async messageSend(key, text, wait) { return { queued: !wait, key }; },
  };
  const h = await startGateway(t, impl);
  t.after(() => h.close());
  const r = await rpc(h.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'message_send', arguments: { key: 'k', text: 'x', wait: false } } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body.result.content[0].text).queued, true);
});

test('unknown tool names an error', async (t) => {
  const h = await startGateway(t, {});
  t.after(() => h.close());
  const r = await rpc(h.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /unknown tool/);
});

// A PARKED CALLER MUST BE TOLD, NOT LEFT TO TIME OUT.
//
// message_send blocks for up to ten minutes waiting for the agent's reply.
// When the runtime dies under it -- OOM kill, crash, a redeploy -- there will
// never be a reply, and the two things that used to happen instead were both
// worse than useless: the bridge exited and the caller saw a dropped socket,
// or (if it survived) the caller waited out all ten minutes and was told "the
// turn may still be running", which by then is false.
//
// Driven through the real JSON-RPC surface rather than by calling the waiter
// directly, because what is being tested is what a SUPERVISING MODEL reads.
test('a parked message_send is failed with a stated reason when the runtime dies', async (t) => {
  let released;
  const h = await startGateway(t, {
    // Never resolves on its own: this is the turn that will never come back.
    messageSend: async (key, text, wait) => {
      if (!wait) return { queued: true, key };
      const reply = await h.waitReply(key);
      return { reply: reply.text, at: reply.at };
    },
  });
  t.after(() => h.close());

  const call = rpc(h.url, {
    jsonrpc: '2.0', id: 40, method: 'tools/call',
    params: { name: 'message_send', arguments: { key: '-100:7', text: 'status?', wait: true } },
  });
  // Let the request reach the handler and park before failing it.
  await new Promise((r) => setTimeout(r, 50));
  released = h.failAll('the zcode runtime exited while this turn was running (code=null signal=SIGKILL). ' +
    'The bridge does not know why.');
  assert.equal(released, 1, 'the parked caller was not found');

  const r = await call;
  const text = JSON.stringify(r.body);
  assert.match(text, /SIGKILL/, 'the reason never reached the caller');
  assert.match(text, /does not know why/, 'the caller is not told the cause is unknown');
});

// AND NOTHING IS FAILED THAT IS NOT WAITING. failWaiters runs on every
// runtime exit, including the ordinary ones with no MCP traffic at all.
test('failing the waiters when nobody is waiting is a no-op', async (t) => {
  const h = await startGateway(t, {});
  t.after(() => h.close());
  assert.equal(h.failAll('anything'), 0);
});

// A FAILED WAITER MUST NOT BE FIRED TWICE. A second failure, or a reply that
// lands after one, would settle an already-settled promise -- harmless in
// JavaScript, but it also means the waiter was left in the map, which leaks
// one entry per dead turn for the life of the process.
test('a failed waiter is forgotten, not left in the map', async (t) => {
  const h = await startGateway(t, {});
  t.after(() => h.close());
  const pending = h.waitReply('-100:9');
  pending.catch(() => {});
  assert.equal(h.failAll('gone'), 1);
  assert.equal(h.failAll('gone again'), 0, 'the waiter survived being failed');
  // A reply arriving late must not throw on a cleared waiter list.
  h.noteReply('-100:9', 'a late reply');
  assert.equal(h.replies('-100:9').length, 1);
});

// THE TIMEOUT PATH, AT A SPEED A TEST CAN OBSERVE. Two things are pinned:
// that an unanswered wait ends in a stated error rather than hanging forever,
// and that a waiter failed for another reason stays settled afterwards even
// once its original deadline passes. (The clearTimeout that makes the second
// one tidy is not itself observable -- a late timer merely rejects an
// already-settled promise -- so this covers the behaviour, not that line.)
test('an unanswered wait ends in a stated timeout, and a failed one stays failed', async () => {
  const { createMcpGateway } = await import('../bridge/mcp.js');
  const gw = createMcpGateway({ port: 0, log: () => {}, waitTimeoutMs: 60 });
  gw.wire({});
  await gw.ready;
  try {
    await assert.rejects(gw.waitReply('-100:1'), /no reply within 0.06s/);

    const failed = gw.waitReply('-100:2');
    failed.catch(() => {});
    assert.equal(gw.failWaiters('the runtime died'), 1);
    await assert.rejects(failed, /the runtime died/);
    // Past the timeout: if the timer were still armed it would fire here.
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    await gw.close();
  }
});
