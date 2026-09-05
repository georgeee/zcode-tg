// Integration e2e for the MCP gateway: a real bridge (real scratch
// app-server, real model turn) with a fake Telegram, driven entirely through
// the MCP endpoint the way a second model would drive it --
// session_create -> message_send (mirrored into the topic, replied by a real
// turn) -> replies_get -> session_close. The chat sees every prompt and
// reply from the bot's identity; MCP sees them as tool results.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const WS = '/tmp/zbridge-e2emcp-ws';
const STORE = '/tmp/zbridge-e2emcp-store.json';
const CHAT = -100777, USER = 42;

rmSync(WS, { recursive: true, force: true });
rmSync(STORE, { force: true });
mkdirSync(WS, { recursive: true });

const calls = { send: [], edit: [], topicCreated: [], topicClosed: [] };
let nextMsgId = 100, updateId = 1, nextThreadId = 55;

const srv = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const method = req.url.split('/').pop();
  const ok = (result = {}) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  };
  if (method === 'getUpdates') {
    // Nothing ever arrives from Telegram; just keep the long poll honest.
    const timer = setTimeout(() => ok([]), 1500);
    timer.unref?.();
    return;
  }
  if (method === 'sendMessage') {
    const p = JSON.parse(body);
    calls.send.push({ chat: p.chat_id, thread: p.message_thread_id, text: p.text });
    return ok({ message_id: nextMsgId++ });
  }
  if (method === 'editMessageText') {
    const p = JSON.parse(body);
    calls.edit.push(p);
    return ok({ message_id: p.message_id });
  }
  if (method === 'createForumTopic') {
    const p = JSON.parse(body);
    calls.topicCreated.push(p);
    return ok({ message_thread_id: nextThreadId, chat_id: p.chat_id, name: p.name });
  }
  if (method === 'closeForumTopic') {
    const p = JSON.parse(body);
    calls.topicClosed.push(p);
    return ok(true);
  }
  return ok();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const bridge = spawn(NODE, [path.join(REPO, 'bridge/index.js')], {
  env: {
    ...process.env,
    TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
    TELEGRAM_BOT_TOKEN: 'e2e-fake-token',
    TELEGRAM_CHAT_ID: String(CHAT),
    TELEGRAM_ALLOWED_USER_ID: String(USER),
    ZCODE_NODE_BIN: NODE,
    ZCODE_BIN,
    ZCODE_WORKSPACE_DIR: WS,
    ZCODE_DEFAULT_MODEL: 'zai/glm-5.3',
    ZCODE_DEFAULT_MODE: 'yolo',
    STORE_PATH: STORE,
    MCP_HTTP_PORT: '0', // ephemeral; the e2e reads the bound port from the boot log
    HOME: process.env.HOME, // the real z.ai credential, same as e2e-file
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => { bridgeLog += c; process.stdout.write(`[bridge] ${c}`); });
bridge.stderr.on('data', (c) => { bridgeLog += c; process.stderr.write(`[bridge-err] ${c}`); });
const step = (s) => console.log(`[harness] -- ${s}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}\nbridge: ${bridgeLog.slice(-2000)}`);
    await sleep(300);
  }
}
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

// A minimal MCP client over Streamable HTTP: exactly what a second model's
// MCP client puts on the wire.
async function mcp(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : JSON.parse(await res.text()) };
}
const tool = (port, name, args, id) =>
  mcp(port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

try {
  step('waiting for bridge boot');
  await waitFor(() => bridgeLog.includes('starting.'), 15000, 'boot');
  const m = await waitFor(() => bridgeLog.match(/mcp gateway listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/), 15000, 'mcp gateway boot');
  const mcpPort = Number(m[1]);
  step(`mcp gateway on 127.0.0.1:${mcpPort}`);

  // Handshake + tool discovery, as a client does on connect.
  const init = await mcp(mcpPort, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  check('initialize handshake', init.body?.result?.protocolVersion === '2024-11-05', JSON.stringify(init));
  await mcp(mcpPort, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await mcp(mcpPort, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  check('tools/list advertises the four tools', list.body?.result?.tools?.length === 4, JSON.stringify(list.body));

  // session_create: a named topic appears in the chat, a session is born.
  step('session_create');
  const created = await tool(mcpPort, 'session_create', { name: 'mcp-e2e' }, 3);
  const c1 = JSON.parse(created.body.result.content[0].text);
  // Home-chat topics key as just the thread id (keyFor's legacy-home shape).
  check('session_create returns key/chat/thread', c1.key === String(nextThreadId) && c1.thread_id === nextThreadId, JSON.stringify(c1));
  check('session_create created a Telegram topic', calls.topicCreated.length === 1 && calls.topicCreated[0].name === 'mcp-e2e', JSON.stringify(calls.topicCreated));

  // message_send with wait: the prompt is mirrored into the topic from the
  // bot's identity, and a REAL turn answers through MCP.
  step('message_send (real turn)');
  const r = await tool(mcpPort, 'message_send', { key: c1.key, text: 'Reply with exactly MCP-E2E-OK and nothing else.' }, 4);
  check('message_send returns a reply', r.body?.result && !r.body.result.isError, JSON.stringify(r.body).slice(0, 300));
  const sent = JSON.parse(r.body.result.content[0].text);
  check('the reply text came back through MCP', /MCP-E2E-OK/.test(sent.reply ?? ''), JSON.stringify(sent).slice(0, 300));
  const mirrored = calls.send.find((s) => s.chat === CHAT && s.thread === nextThreadId && (s.text ?? '').includes('MCP-E2E-OK'));
  check('the prompt was mirrored into the topic', !!mirrored, JSON.stringify(calls.send));
  // The chat mirror is eventual: noteReply resolves the MCP waiter BEFORE
  // finalizeTurn delivers the reply into the topic, so wait for it here.
  const replyInChat = await waitFor(
    () => [...calls.send, ...calls.edit].find((x) => (x.text ?? '').includes('MCP-E2E-OK') && !(x.text ?? '').includes('Reply with')),
    20000,
    'the reply mirrored into the chat',
  );
  check('the reply also landed in the chat', !!replyInChat, JSON.stringify(calls.edit.map((e) => e.text?.slice(0, 60))));

  // replies_get: the reply log serves catch-up reads.
  const got = await tool(mcpPort, 'replies_get', { key: c1.key }, 5);
  const log = JSON.parse(got.body.result.content[0].text);
  check('replies_get returns the collected replies', (log.replies ?? []).some((x) => /MCP-E2E-OK/.test(x.text)), JSON.stringify(log).slice(0, 300));

  // session_close: the topic closes, the key is marked closed.
  const closed = await tool(mcpPort, 'session_close', { key: c1.key }, 6);
  check('session_close closes the Telegram topic', closed.body?.result && calls.topicClosed.length === 1 && Number(calls.topicClosed[0].message_thread_id) === nextThreadId, JSON.stringify(calls.topicClosed));
  const after = await tool(mcpPort, 'message_send', { key: c1.key, text: 'anyone there?', wait: false }, 7);
  check('message_send to a closed session names the error', after.body?.result?.isError === true && /closed/.test(after.body.result.content[0].text), JSON.stringify(after.body).slice(0, 300));
} catch (e) {
  check('scenario completed without harness timeout', false, e.message);
} finally {
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  srv.close();
  bridge.kill('SIGTERM');
  await sleep(1000);
  try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
