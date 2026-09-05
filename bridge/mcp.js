// MCP (Model Context Protocol) gateway for the bridge: a Streamable-HTTP
// JSON-RPC endpoint that lets a SECOND model drive the same conversations
// the Telegram frontend serves -- with every prompt and reply mirrored into
// the Telegram chat from the bot's identity, so the chat remains the shared
// log no matter which frontend typed.
//
// Transport: HTTP POST /mcp with a JSON-RPC 2.0 body; the response is the
// JSON-RPC result (no SSE -- tools/call blocks until the answer is known,
// which is what an MCP client waiting for a reply wants). Bound to
// 127.0.0.1 unless MCP_BIND is set; MCP_TOKEN, when set, requires a
// matching Authorization: Bearer header. Reachable from a laptop via
// `ssh -L` or WireGuard without exposing anything publicly.
//
// The server runs INSIDE the bridge process (wired from index.js) so its
// tools drive the bridge's own machinery -- the same topic store, the same
// session map, the same dispatch pipeline Telegram messages use. Nothing is
// duplicated; MCP messages and Telegram messages are peers by the time they
// reach dispatchUserPrompt.

import { createServer } from 'node:http';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_BODY = 1 << 20; // 1 MiB of JSON-RPC is far beyond any tool call
const WAIT_TIMEOUT_MS = 10 * 60 * 1000; // a real model turn can take minutes
const REPLY_LOG_LIMIT = 200; // per conversation, in memory

export function createMcpGateway({ port, host = '127.0.0.1', token = '', log = () => {} }) {
  // port 0 (an ephemeral listen) is how the tests start the gateway.
  if (port == null) throw new Error('mcp gateway needs a port');

  // Per-conversation state: the reply log (for replies_get) and the waiters
  // that message_send parked until the agent's final reply lands.
  const replyLog = new Map(); // key -> [{ seq, text, at }]
  const waiters = new Map(); // key -> [{ resolve }]
  let replySeq = 0;

  function noteReply(key, text) {
    if (!text || !String(text).trim()) return;
    const entry = { seq: ++replySeq, text: String(text), at: new Date().toISOString() };
    const log = replyLog.get(key) ?? [];
    log.push(entry);
    while (log.length > REPLY_LOG_LIMIT) log.shift();
    replyLog.set(key, log);
    for (const w of waiters.get(key) ?? []) w.resolve(entry);
    waiters.delete(key);
  }

  function waitReply(key) {
    return new Promise((resolve, reject) => {
      const list = waiters.get(key) ?? [];
      const timer = setTimeout(() => {
        const i = (waiters.get(key) ?? []).indexOf(entry);
        if (i >= 0) (waiters.get(key) ?? []).splice(i, 1);
        reject(new Error(`no reply within ${WAIT_TIMEOUT_MS / 1000}s -- the turn may still be running; use replies_get`));
      }, WAIT_TIMEOUT_MS);
      const entry = { resolve: (v) => { clearTimeout(timer); resolve(v); }, timer };
      list.push(entry);
      waiters.set(key, list);
    });
  }

  function repliesSince(key, afterSeq = 0) {
    return (replyLog.get(key) ?? []).filter((r) => r.seq > afterSeq);
  }

  let handlers = null; // wired by index.js: the bridge-side implementations
  function wire(impl) {
    handlers = impl;
  }

  function json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
  }
  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  const TOOL_DEFS = [
    {
      name: 'session_create',
      description:
        'Create a named session: a Telegram forum topic in the target chat plus a fresh agent session bound to it. Messages sent to the topic (by the owner in Telegram, or via message_send) are answered by the agent; replies are mirrored into the topic.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Topic/session name (shown in Telegram).' },
          chat_id: { type: 'number', description: 'Target chat id. Defaults to the bridge home chat.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'session_close',
      description: 'Close a previously created session and its Telegram topic.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Conversation key from session_create.' } },
        required: ['key'],
      },
    },
    {
      name: 'message_send',
      description:
        'Send a message to an agent session and wait for the final reply. The message and the reply are mirrored into the Telegram topic.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Conversation key (from session_create).' },
          text: { type: 'string', description: 'The message (prompt) text.' },
          wait: { type: 'boolean', description: 'Wait for the final reply (default true). false returns immediately after queueing.' },
        },
        required: ['key', 'text'],
      },
    },
    {
      name: 'replies_get',
      description: 'Return the replies already collected for a conversation since a sequence number.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          after_seq: { type: 'number', description: 'Return replies with seq > this (default 0 = all).' },
        },
        required: ['key'],
      },
    },
  ];

  async function callTool(name, args) {
    if (!handlers) throw new Error('mcp gateway not wired to the bridge');
    switch (name) {
      case 'session_create':
        return handlers.sessionCreate(String(args.name), args.chat_id != null ? Number(args.chat_id) : undefined);
      case 'session_close':
        return handlers.sessionClose(String(args.key));
      case 'message_send':
        return handlers.messageSend(String(args.key), String(args.text), args.wait !== false);
      case 'replies_get':
        return handlers.repliesGet(String(args.key), Number(args.after_seq) || 0);
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  async function dispatchRpc(body) {
    if (body.method === 'initialize') {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'cage-pod-zcode-mcp', version: '0.1.0' },
      };
    }
    if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') {
      return undefined; // a notification: no response body
    }
    if (body.method === 'tools/list') {
      return { tools: TOOL_DEFS };
    }
    if (body.method === 'tools/call') {
      const { name, arguments: args = {} } = body.params ?? {};
      try {
        const result = await callTool(name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    }
    if (body.method != null) {
      return rpcError(body.id ?? null, -32601, `method not found: ${body.method}`);
    }
    return undefined;
  }

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found -- POST JSON-RPC to /mcp' }));
      return;
    }
    if (token) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    let raw = '';
    let oversized = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) {
        oversized = true;
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (oversized) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'body too large' }));
        return;
      }
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      // Batched requests (an array) are answered element by element, per the
      // JSON-RPC spec; notifications produce no entry in the response array.
      const bodies = Array.isArray(body) ? body : [body];
      const out = [];
      for (const b of bodies) {
        // eslint-disable-next-line no-await-in-loop
        const r = await dispatchRpc(b);
        if (r !== undefined) out.push({ jsonrpc: '2.0', id: b.id ?? null, ...(r.error ? { error: r.error } : { result: r.result ?? r }) });
      }
      if (!out.length) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
    });
  });

  // listen is asynchronous: `ready` resolves once the socket is bound, and
  // is what callers (and tests) await before the first request.
  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server.address()));
    server.once('error', (e) => reject(e));
  });
  server.listen(port, host, () => {
    const a = server.address(); // the BOUND address -- port 0 (tests) logs the ephemeral port
    log(`mcp gateway listening on http://${a.address}:${a.port}/mcp`);
  });

  return {
    // closeAllConnections: undici keep-alive sockets would hold server.close()
    // open long after the last request -- a shutdown (and a test runner)
    // should not wait on idle clients.
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
    ready,
    noteReply,
    waitReply,
    repliesSince,
    wire,
    __test: { dispatchRpc, callTool, replyLog, server, host, port },
    address: () => server.address(),
  };
}
