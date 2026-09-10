// E2E for the auto-picked MCP session_create target (2026-09-10 cage-pod
// failure: a stale TELEGRAM_CHAT_ID made the default target a non-forum
// chat, and Telegram answered "the chat is not a forum"). Reproduces the
// production shape: home chat A configured but NOT a forum, the owner
// active in forum chat B where the bot is admin -- a chat-less
// session_create must land in B, and an explicit chat_id A must still
// surface Telegram's own error. No model turns: a fake app-server answers
// the session lifecycle, a fake Telegram answers the Bot API.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const H = process.env.HOME;
const WS = `${H}/.cache/e2e-chatpick-ws`;
const STORE = `${H}/.cache/e2e-chatpick-store.json`;

// The production shape: A = stale configured home (plain supergroup),
// B = the forum the owner actually uses (bot admin there).
const HOME_CHAT = -100777, FORUM_CHAT = -100888, USER = 42, BOT_ID = 4242;

rmSync(WS, { recursive: true, force: true });
rmSync(STORE, { force: true });
mkdirSync(WS, { recursive: true });

// Fake `zcode app-server`: answers every call with an empty result, except
// session/create which mints a session id. Enough for session_create's
// getOrCreateSession; nothing here ever starts a turn.
const FAKE_ZCODE = path.join(WS, 'fake-zcode.mjs');
writeFileSync(FAKE_ZCODE, [
  "import readline from 'node:readline';",
  'const rl = readline.createInterface({ input: process.stdin });',
  'let n = 0;',
  "rl.on('line', (line) => {",
  "  if (!line.trim()) return;",
  '  let msg; try { msg = JSON.parse(line); } catch { return; }',
  "  if (msg.id === undefined || !msg.method) return;",
  "  const result = msg.method === 'session/create' ? { session: { sessionId: `fake-${++n}` } } : {};",
  "  process.stdout.write(JSON.stringify({ id: msg.id, result }) + '\\n');",
  '});',
].join('\n'));

const CHATS = {
  [HOME_CHAT]: { id: HOME_CHAT, type: 'supergroup', title: 'Stale Home' }, // no is_forum
  [FORUM_CHAT]: { id: FORUM_CHAT, type: 'supergroup', title: 'Pod Forum', is_forum: true },
};

const calls = { topicCreated: [], getChat: [], getChatMember: [], sent: [] };
let nextMsgId = 100, nextThreadId = 77;

const srv = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const method = req.url.split('/').pop();
  const p = body ? JSON.parse(body) : {};
  const ok = (result = {}) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  };
  const fail = (description) => {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, description }));
  };
  if (method === 'getUpdates') {
    // One scripted update: the owner creates a topic by hand in the forum
    // chat (exactly how a real chat becomes known to the bridge), then
    // silence.
    if (p.offset === undefined || p.offset <= 1) {
      return ok([{ update_id: 1, message: {
        message_id: 10,
        from: { id: USER, is_bot: false, first_name: 'Owner' },
        chat: CHATS[FORUM_CHAT],
        date: Math.floor(Date.now() / 1000),
        message_thread_id: 5,
        forum_topic_created: { name: 'manual', icon_color: 0 },
      } }]);
    }
    const timer = setTimeout(() => ok([]), 1500);
    timer.unref?.();
    return;
  }
  if (method === 'getMe') return ok({ id: BOT_ID, is_bot: true, first_name: 'fake' });
  if (method === 'getChat') {
    calls.getChat.push(p.chat_id);
    return CHATS[p.chat_id] ? ok(CHATS[p.chat_id]) : fail('Bad Request: chat not found');
  }
  if (method === 'getChatMember') {
    calls.getChatMember.push({ chat: p.chat_id, user: p.user_id });
    return ok({ status: p.chat_id === FORUM_CHAT ? 'administrator' : 'member' });
  }
  if (method === 'createForumTopic') {
    if (!CHATS[p.chat_id]?.is_forum) return fail('Bad Request: the chat is not a forum');
    calls.topicCreated.push(p);
    return ok({ message_thread_id: nextThreadId++, chat_id: p.chat_id, name: p.name });
  }
  if (method === 'sendMessage') {
    calls.sent.push({ chat: p.chat_id, thread: p.message_thread_id, text: p.text });
    return ok({ message_id: nextMsgId++ });
  }
  return ok(); // editMessageText, pinChatMessage, setMyCommands, ...
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tgPort = srv.address().port;

const bridge = spawn(NODE, [path.join(REPO, 'bridge/index.js')], {
  env: {
    ...process.env,
    TELEGRAM_API_ROOT: `http://127.0.0.1:${tgPort}`,
    TELEGRAM_BOT_TOKEN: 'e2e-fake-token',
    TELEGRAM_CHAT_ID: String(HOME_CHAT), // the stale value, exactly as on cage-pod
    TELEGRAM_ALLOWED_USER_ID: String(USER),
    ZCODE_NODE_BIN: NODE,
    ZCODE_BIN: FAKE_ZCODE,
    ZCODE_WORKSPACE_DIR: WS,
    STORE_PATH: STORE,
    MCP_HTTP_PORT: '0',
    HOME: process.env.HOME,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => { bridgeLog += c; });
bridge.stderr.on('data', (c) => { bridgeLog += c; process.stderr.write(`[bridge-err] ${c}`); });

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

async function mcp(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : JSON.parse(await res.text()) };
}
const tool = (port, name, args, id) => mcp(port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

try {
  await waitFor(() => bridgeLog.includes('starting.'), 15000, 'boot');
  const m = await waitFor(() => bridgeLog.match(/mcp gateway listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/), 15000, 'mcp gateway boot');
  const mcpPort = Number(m[1]);
  await mcp(mcpPort, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await mcp(mcpPort, { jsonrpc: '2.0', method: 'notifications/initialized' });

  // The owner's manual topic in chat B is what makes B a known candidate.
  await waitFor(() => bridgeLog.includes('topic created: "manual"'), 15000, 'the owner update to be processed');

  // The scenario that failed on cage-pod: no chat_id, stale TELEGRAM_CHAT_ID.
  const created = await tool(mcpPort, 'session_create', { name: 'auto-picked' }, 2);
  const c1 = JSON.parse(created.body.result.content[0].text);
  check('chat-less session_create auto-picked the forum chat', c1.chat_id === FORUM_CHAT && c1.auto_picked === true, JSON.stringify(c1));
  check('the composite conversation key names chat and thread', c1.key === `c${FORUM_CHAT}:t77`, JSON.stringify(c1));
  check('createForumTopic went to the forum chat, not the configured home', calls.topicCreated.length === 1 && calls.topicCreated[0].chat_id === FORUM_CHAT, JSON.stringify(calls.topicCreated));
  check('the stale home chat was examined and rejected, not trusted', calls.getChat.includes(HOME_CHAT) && calls.getChat.includes(FORUM_CHAT), JSON.stringify(calls.getChat));
  check('admin was checked for the bot itself', calls.getChatMember.some((x) => x.chat === FORUM_CHAT && x.user === BOT_ID), JSON.stringify(calls.getChatMember));
  check('the pick was logged', /no chat_id given -- picked chat -100888 \("Pod Forum"\)/.test(bridgeLog), bridgeLog.slice(-600));

  // An explicit chat_id still targets exactly what the caller named --
  // including Telegram's own verdict when that chat is not a forum.
  const explicit = await tool(mcpPort, 'session_create', { name: 'explicit-bad', chat_id: HOME_CHAT }, 3);
  check('explicit chat_id to a non-forum surfaces Telegram\'s error', explicit.body.result.isError === true && /the chat is not a forum/.test(explicit.body.result.content[0].text), JSON.stringify(explicit.body).slice(0, 300));
  check('only the auto-picked topic was actually created', calls.topicCreated.length === 1, JSON.stringify(calls.topicCreated));

  // The registry survives what created it: a second chat-less create lands
  // in the same place without needing another owner update.
  const again = await tool(mcpPort, 'session_create', { name: 'second' }, 4);
  const c2 = JSON.parse(again.body.result.content[0].text);
  check('a second chat-less create reuses the remembered forum', c2.chat_id === FORUM_CHAT && calls.topicCreated.filter((t) => t.chat_id === FORUM_CHAT).length === 2, JSON.stringify(c2));
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
