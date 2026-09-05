// E2E: LOCAL MCP CLIENT INTEGRATION -- a REAL zcode agent (its own scratch
// app-server) whose workspace .mcp.json points at the bridge's MCP gateway,
// calling session_create + message_send to drive a SECOND agent session:
//   client agent --MCP--> bridge gateway --> dispatch pipeline --> inner
//   session --> real model turn --> reply into the topic --> noteReply -->
//   MCP waiter --> client tool result --> client's final answer.
// Complements test/e2e-mcp.mjs (which drives the gateway directly over
// HTTP); this one proves the zcode-side MCP CLIENT path works against the
// gateway, end to end with real model turns on both sides.
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const H = process.env.HOME;
const WS = `${H}/.cache/e2e-mcp-client-ws`; // inner sessions' workspace (bridge side)
const CWS = `${H}/.cache/e2e-mcp-client-agent`; // the CLIENT agent's workspace (.mcp.json here)
const STORE = `${H}/.cache/e2e-mcp-client-store.json`;
const CHAT = -100777, USER = 42;

const freePort = () =>
  new Promise((res) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

for (const d of [WS, CWS]) rmSync(d, { recursive: true, force: true });
rmSync(STORE, { force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(CWS, { recursive: true });

const calls = { send: [], edit: [], topics: [] };
let nextMsgId = 100;

const srv = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const c of req) body += c;
    const method = req.url.split('/').pop();
    const ok = (result = {}) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === 'getUpdates') return ok([]);
    if (method === 'sendMessage') {
      const p = JSON.parse(body || '{}');
      calls.send.push({ ...p, message_id: nextMsgId });
      return ok({ message_id: nextMsgId++ });
    }
    if (method === 'editMessageText') {
      const p = JSON.parse(body || '{}');
      calls.edit.push(p);
      return ok({ message_id: p.message_id });
    }
    if (method === 'createForumTopic') {
      const p = JSON.parse(body || '{}');
      const t = { message_thread_id: 6000 + calls.topics.length, name: p.name };
      calls.topics.push(t);
      return ok(t);
    }
    return ok();
  } catch (e) {
    console.error('[http] error:', e);
    try { res.statusCode = 500; res.end('{"ok":false}'); } catch {}
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tgPort = srv.address().port;
const mcpPort = await freePort();

// The client's MCP registration -- the "local MCP configured" under test.
// zcode's session/create accepts mcpServers INLINE ({name,type:"http",url};
// schema confirmed in the runtime), which beats config-file approaches: the
// registration lives exactly as long as the test session.
const clientMcp = [{ name: 'bridge', type: 'http', url: `http://127.0.0.1:${mcpPort}/mcp`, headers: [] }];

const bridge = spawn(NODE, [path.join(REPO, 'bridge/index.js')], {
  env: {
    ...process.env,
    TELEGRAM_API_ROOT: `http://127.0.0.1:${tgPort}`,
    TELEGRAM_BOT_TOKEN: 'e2e-fake-token',
    TELEGRAM_CHAT_ID: String(CHAT),
    TELEGRAM_ALLOWED_USER_ID: String(USER),
    ZCODE_NODE_BIN: NODE,
    ZCODE_BIN: ZCODE_BIN,
    ZCODE_WORKSPACE_DIR: WS,
    ZCODE_DEFAULT_MODEL: 'zai/glm-5.3',
    ZCODE_DEFAULT_MODE: 'yolo',
    STORE_PATH: STORE,
    MCP_HTTP_PORT: String(mcpPort),
    HOME: process.env.HOME,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => (bridgeLog += c));
bridge.stderr.on('data', (c) => (bridgeLog += c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(600);
  }
}
let failures = 0;
let clientFinalText = '';
let clientToolsSeen = '';
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

// Raw ZCode-Protocol driver for the CLIENT agent.
function startClientAgent() {
  const proc = spawn(NODE, [ZCODE_BIN, 'app-server'], { cwd: CWS, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ZCODE_DISABLE_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' } });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  let finalText = '';
  let toolsUsed = '';
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method === 'session/event') {
        const pl = msg.params?.payload ?? {};
        if (typeof pl.response === 'string') finalText = pl.response;
        if (typeof pl.content === 'string' && pl.content) finalText = pl.content;
        if (pl.toolName) toolsUsed += `${pl.toolName};`;
      } else if (msg.method) {
        proc.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'client driver declines' } }) + '\n');
      }
    }
  });
  proc.stderr.on('data', () => {});
  const call = (method, params) => {
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };
  return { proc, call, finalText: () => finalText, toolsUsed: () => toolsUsed };
}

const killList = [];
process.on('SIGTERM', () => { for (const k of killList) k('SIGKILL'); process.exit(1); });

try {
  await waitFor(() => bridgeLog.includes('[bridge] starting.'), 15000, 'bridge boot');
  await waitFor(() => bridgeLog.includes('mcp gateway listening'), 15000, 'mcp gateway listening');

  const client = startClientAgent();
  killList.push((sig) => client.proc.kill(sig));
  clientFinalText = ''; clientToolsSeen = '';
  const created = await client.call('session/create', { workspace: { workspacePath: CWS, workspaceKey: 'mcp-e2e-client' }, mcpServers: clientMcp });
  const sid = created.session.sessionId;
  await client.call('session/setModel', { sessionId: sid, model: { providerId: 'zai', modelId: 'glm-5.3' } });
  await client.call('session/setMode', { sessionId: sid, mode: 'yolo' });
  await client.call('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });
  await client.call('session/send', {
    sessionId: sid,
    content:
      'You have an MCP server named "bridge" available. Use its tools exactly as follows, in order: ' +
      '(1) session_create with name "mcp-e2e"; ' +
      '(2) message_send to that conversation with the text "Reply with exactly: HELLO-FROM-MCP and nothing else"; ' +
      '(3) report the reply text you received verbatim. If the MCP tools are not available, reply with exactly: MCP-TOOLS-MISSING.',
  });

  const diagTimer = setInterval(() => { clientFinalText = client.finalText(); clientToolsSeen = client.toolsUsed(); }, 2000);
  const topic = await waitFor(() => (calls.topics.length ? calls.topics[0] : null), 150000, 'topic created via session_create');
  check('session_create made a new forum topic', topic?.name === 'mcp-e2e', JSON.stringify(calls.topics));
  const mirroredPrompt = await waitFor(() => calls.send.find((s) => s.message_thread_id === topic.message_thread_id && /HELLO-FROM-MCP/.test(s.text)), 150000, 'mirrored prompt in topic');
  check('message_send mirrored the prompt into the topic (bot identity)', !!mirroredPrompt);
  const innerReply = await waitFor(
    () => calls.edit.concat(calls.send.map((s) => ({ text: s.text }))).find((e) => /HELLO-FROM-MCP/.test(e.text) && e.text !== mirroredPrompt.text),
    180000,
    'inner agent reply in topic',
  );
  check('inner session replied into the topic (ordinary delivery flow)', !!innerReply);
  const clientFinal = await waitFor(() => (/HELLO-FROM-MCP/.test(client.finalText()) ? client.finalText() : null), 300000, 'client final answer carrying the MCP reply');
  check('client agent round-tripped the reply through MCP', !!clientFinal, client.finalText().slice(0, 120));
  check('client actually used MCP tools (not guessed)', /bridge/i.test(client.toolsUsed()), client.toolsUsed().slice(0, 120));
  clearInterval(diagTimer);
  client.proc.kill('SIGTERM');
} catch (e) {
  check('scenario completed without harness timeout', false, e.message);
  console.log('client final text so far:', JSON.stringify((clientFinalText || '').slice(0, 300)));
  console.log('client tools seen:', clientToolsSeen || '(none)');
} finally {
  console.log('--- bridge log tail ---');
  console.log(bridgeLog.split('\n').filter((l) => l.trim()).slice(-5).join('\n'));
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  for (const k of killList) k('SIGTERM');
  srv.close();
  bridge.kill('SIGTERM');
  await sleep(1200);
  try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
