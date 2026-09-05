// Unit tests for the MCP gateway: the JSON-RPC surface (initialize, tools
// list, tools/call), the reply-waiter lifecycle, and the routing into the
// bridge handlers -- with a fake bridge, no Telegram and no model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpGateway } from '../bridge/mcp.js';

async function startGateway(t, impl, { token = '' } = {}) {
  const gw = createMcpGateway({ port: 0, token, log: () => {} });
  gw.wire(impl);
  await gw.ready;
  const port = gw.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    url,
    close: () => gw.close(),
    noteReply: (k, text) => gw.noteReply(k, text),
    waitReply: (k) => gw.waitReply(k),
    replies: (k) => gw.repliesSince(k),
  };
}

async function rpc(url, body, token = '') {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

test('tools/list advertises the four tools with schemas', async (t) => {
  const h = await startGateway(t, {});
  t.after(() => h.close());
  const r = await rpc(h.url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = r.body.result.tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['message_send', 'replies_get', 'session_close', 'session_create']);
  for (const tool of r.body.result.tools) assert.ok(tool.inputSchema, `${tool.name} carries a schema`);
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

test('token auth rejects mismatches before the body is read', async (t) => {
  const h = await startGateway(t, {}, { token: 'sekrit' });
  t.after(() => h.close());
  const res = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(res.status, 401);
});
