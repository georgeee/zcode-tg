// MCP (Model Context Protocol) gateway for the bridge: a Streamable-HTTP
// JSON-RPC endpoint that lets a SECOND model drive the same conversations
// the Telegram frontend serves -- with every prompt and reply mirrored into
// the Telegram chat from the bot's identity, so the chat remains the shared
// log no matter which frontend typed.
//
// Transport: HTTP POST /mcp with a JSON-RPC 2.0 body; the response is the
// JSON-RPC result (no SSE -- tools/call blocks until the answer is known,
// which is what an MCP client waiting for a reply wants). The client --
// the second model -- runs on the SAME host, inside the same agent, so the
// listener binds loopback and carries no auth of its own: the trust
// boundary is the host account, the same one that can read the bridge's
// credentials anyway.
//
// The server runs INSIDE the bridge process (wired from index.js) so its
// tools drive the bridge's own machinery -- the same topic store, the same
// session map, the same dispatch pipeline Telegram messages use. Nothing is
// duplicated; MCP messages and Telegram messages are peers by the time they
// reach dispatchUserPrompt.

import fs from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_BODY = 1 << 20; // 1 MiB of JSON-RPC is far beyond any tool call
const WAIT_TIMEOUT_MS = 10 * 60 * 1000; // a real model turn can take minutes
const REPLY_LOG_LIMIT = 200; // per conversation, in memory

export function createMcpGateway({ port, unixSocket, host = '127.0.0.1', log = () => {} }) {
  // Two listeners, one JSON-RPC core:
  // - unixSocket: a per-fleet unix domain socket speaking LINE-delimited
  //   JSON-RPC (the stdio-MCP wire format, one request per line, one response
  //   per line). This is the production transport: the socket file lives in
  //   the agent's own state directory, so its permissions ARE the
  //   authentication — only the account that runs the bridge can connect,
  //   there is no wire to encrypt, and per-fleet paths cannot collide.
  // - port: loopback HTTP POST /mcp, for tests and curl. Off unless set.
  if (port == null && !unixSocket) throw new Error('mcp gateway needs a port or a unixSocket');

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
          backend: {
            type: 'string',
            enum: ['zcode', 'codex', 'mock'],
            description:
              "Which backend runs this session. Defaults to the bridge's own default backend (normally 'zcode'). 'codex' requires the bridge to have CODEX_HOME configured. 'mock' needs no configuration at all -- an in-process, zero-credential, zero-subprocess echo backend for exercising this MCP machinery without spending real API/credit usage; its reply is always a synthetic '[mock echo] <prompt>' echo, never a real model.",
          },
          model: {
            type: 'string',
            enum: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
            description:
              "Codex only (ignored/rejected for zcode, which has no MCP-switchable model at all). Picks which of Codex's three everyday tiers this session runs -- Luna (fastest/cheapest), Terra (balanced, the strong default if omitted), or Sol (Codex's flagship). gpt-6-astra (Codex's newest, most expensive model) is deliberately NOT offered here: MCP is not a channel for reaching it.",
          },
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
    {
      name: 'model_get',
      description:
        "Return the backend and model a session runs, and whether model_set can change it (true for codex, always false for zcode and mock -- both are single-model/no-switching backends, for different reasons: zcode's own MCP contract never offered a switch, mock has only ever had the one synthetic model). The backend itself is still only chosen at session_create time. Omit `key` to get the bridge's own defaults instead of a specific session's.",
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Conversation key from session_create. Omit for the bridge-wide default backend/model.' } },
      },
    },
    {
      name: 'model_set',
      description:
        "Switch a session's model. Codex only, and only among the same three tiers session_create offers (gpt-5.6-luna/terra/sol) -- zcode and mock sessions, and gpt-6-astra, all refuse with a clear error, not a silent no-op.",
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Conversation key from session_create.' },
          model: { type: 'string', enum: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] },
        },
        required: ['key', 'model'],
      },
    },
  ];

  async function callTool(name, args) {
    if (!handlers) throw new Error('mcp gateway not wired to the bridge');
    switch (name) {
      case 'session_create':
        return handlers.sessionCreate(
          String(args.name),
          args.chat_id != null ? Number(args.chat_id) : undefined,
          args.backend ? String(args.backend) : undefined,
          args.model ? String(args.model) : undefined,
        );
      case 'session_close':
        return handlers.sessionClose(String(args.key));
      case 'message_send':
        return handlers.messageSend(String(args.key), String(args.text), args.wait !== false);
      case 'replies_get':
        return handlers.repliesGet(String(args.key), Number(args.after_seq) || 0);
      case 'model_get':
        return handlers.modelGet(args.key ? String(args.key) : undefined);
      case 'model_set':
        return handlers.modelSet(String(args.key), String(args.model));
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
    if (req.url.split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found -- POST JSON-RPC to /mcp' }));
      return;
    }
    if (req.method !== 'POST') {
      // The Streamable-HTTP spec: a server that offers no stream answers
      // GET with 405. A 404 here reads to real MCP clients (the vendored
      // SDK included) as "endpoint dead".
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'POST JSON-RPC to /mcp' }));
      return;
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

  // The TCP listener is conditional: production runs on the unix socket
  // alone, and a fixed port on a multi-fleet host would both collide and
  // hand the endpoint to every local account.
  let tcpReady = null;
  if (port != null) {
    tcpReady = new Promise((resolve, reject) => {
      server.once('listening', () => resolve(server.address()));
      server.once('error', (e) => reject(e));
    });
    server.listen(port, host, () => {
      const a = server.address(); // the BOUND address -- port 0 (tests) logs the ephemeral port
      log(`mcp gateway listening on http://${a.address}:${a.port}/mcp`);
    });
  }

  // THE UNIX LISTENER: line-delimited JSON-RPC, the stdio-MCP wire format,
  // so the client side is a dumb pipe (cage zcode-mcp <socket>) and Claude
  // sees a stdio server it already knows how to spawn. One request per
  // line; one response per line, except notifications, which are answered
  // with nothing. Permissions on the socket file are the authentication:
  // the listener chmods it 0600 and the parent directory is the agent's.
  let unixReady = null;
  let unixSrv = null;
  const unixConns = new Set();
  if (unixSocket) {
    unixSrv = createNetServer((conn) => {
      unixConns.add(conn);
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let body;
          try {
            body = JSON.parse(line);
          } catch {
            conn.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
            continue;
          }
          dispatchRpc(body)
            .then((res) => {
              if (res !== undefined) conn.write(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, ...(res.error ? { error: res.error } : { result: res.result ?? res }) }) + '\n');
            })
            .catch(() => {
              conn.write(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32603, message: 'internal error' } }) + '\n');
            });
        }
      });
      conn.on('error', () => {});
      conn.on('close', () => unixConns.delete(conn));
    });
    try {
      fs.rmSync(unixSocket, { force: true }); // a stale socket from a killed bridge would fail bind
    } catch {}
    unixReady = new Promise((resolve, reject) => {
      unixSrv.once('error', (e) => reject(e));
      unixSrv.listen(unixSocket, () => {
        try {
          fs.chmodSync(unixSocket, 0o600); // owner read/write, nobody else
        } catch {}
        log(`mcp gateway listening on unix:${unixSocket}`);
        resolve(unixSocket);
      });
    });
    unixSrv.on('error', () => {}); // handled through unixReady
  }

  // ready resolves when EVERY requested listener is bound.
  const listeners = [];
  if (tcpReady) listeners.push(tcpReady);
  if (unixReady) listeners.push(unixReady);
  const ready = Promise.all(listeners).then(([first]) => first);

  return {
    // closeAllConnections: undici keep-alive sockets would hold server.close()
    // open long after the last request -- a shutdown (and a test runner)
    // should not wait on idle clients.
    close: () => {
      server.closeAllConnections();
      for (const conn of unixConns) conn.destroy();
      if (unixSocket) {
        try { fs.rmSync(unixSocket, { force: true }); } catch {}
      }
      const jobs = [new Promise((r) => server.close(r))];
      if (unixSrv) jobs.push(new Promise((r) => unixSrv.close(() => r())));
      return Promise.all(jobs).then(() => undefined);
    },
    ready,
    noteReply,
    waitReply,
    repliesSince,
    wire,
    address: () => server.address(),
    unixSocket,
  };
}
