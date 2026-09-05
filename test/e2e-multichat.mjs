// Focused e2e for multi-chat owner scoping: the bridge serves ANY chat an
// owner speaks in (the configured TELEGRAM_CHAT_ID is just the home), ignores
// non-owners everywhere, and LEAVES a group it was added to by a non-owner.
// No model assertions: the app-server spawn is left broken on purpose, so an
// owner message surfaces the bridge's own "couldn't start a session" notice
// -- posted to the RIGHT chat is the thing under test.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const HOME = '/tmp/zbridge-multichat-home';
const STORE = '/tmp/zbridge-multichat-store.json';
const HOME_CHAT = -100777; // the configured home chat (legacy shape)
const FOREIGN_GROUP = -100999; // a group the owner drags the bot into
const FOREIGN_TOPIC = 7; // a topic inside that group
const DM = 42; // the owner's DM
const OWNER = 42, STRANGER = 999;

rmSync(HOME, { recursive: true, force: true });
rmSync(STORE, { force: true });
mkdirSync(HOME, { recursive: true });
// The bridge reads the z.ai config at boot (provider warm-up + /usage); a
// dummy key is enough for the routing assertions.
mkdirSync(path.join(HOME, '.zcode', 'cli'), { recursive: true });
writeFileSync(
  path.join(HOME, '.zcode', 'cli', 'config.json'),
  JSON.stringify({ provider: { zai: { options: { apiKey: 'dummy-key-for-routing-e2e', baseURL: 'https://api.z.ai' } } } }),
);

const calls = { send: [], leave: [] };
let updateId = 1;
const updateQueue = [];
const waiting = new Set();

const srv = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const method = req.url.split('/').pop();
  const ok = (result = {}) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  };
  if (method === 'getUpdates') {
    const p = JSON.parse(body || '{}');
    while (updateQueue.length && updateQueue[0].update_id < p.offset) updateQueue.shift();
    if (updateQueue.length) { return ok(updateQueue.splice(0, 10)); }
    // A done flag per long poll: the timeout and a pushed update must not
    // both write a response (node throws on the second -- measured).
    let done = false;
    const respond = (batch) => { if (done) return; done = true; ok(batch); };
    // THE WRAPPER REMOVES ITSELF ON FIRST INVOCATION, whichever path fires
    // it. Otherwise a timed-out poll's wrapper lingers in the set and every
    // later push re-invokes it -- the splice argument eats the fresh update
    // before the done-guard can discard the stale response (measured).
    const wrapper = () => {
      waiting.delete(wrapper);
      clearTimeout(timer);
      if (done) return;
      respond(updateQueue.splice(0, 10));
    };
    const timer = setTimeout(() => { waiting.delete(wrapper); respond([]); }, 1500);
    waiting.add(wrapper);
    return;
  }
  if (method === 'sendMessage') {
    const p = JSON.parse(body);
    calls.send.push({ chat: p.chat_id, thread: p.message_thread_id, text: p.text });
    return ok({ message_id: Math.floor(Math.random() * 1e6) });
  }
  if (method === 'leaveChat') {
    calls.leave.push(JSON.parse(body).chat_id);
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
    TELEGRAM_CHAT_ID: String(HOME_CHAT), // the configured home -- the tests happen elsewhere
    TELEGRAM_ALLOWED_USER_ID: String(OWNER),
    ZCODE_WORKSPACE_DIR: HOME,
    STORE_PATH: STORE,
    HOME,
    // No ZCODE_BIN on purpose: session start cannot succeed, so every owner
    // message must surface the bridge's own failure notice in the RIGHT chat.
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => { bridgeLog += c; });
bridge.stderr.on('data', (c) => { bridgeLog += c; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}\nbridge: ${bridgeLog}`);
    await sleep(300);
  }
}
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};
const sendsTo = (chat, needle) => calls.send.find((s) => s.chat === chat && (!needle || s.text.includes(needle)));
const push = (update) => { const id = updateId++; updateQueue.push({ update_id: id, ...update }); for (const w of [...waiting]) w(); };
const ownerText = (chat, text, thread) => ({
  message: { message_id: Math.floor(Math.random() * 1e6), from: { id: OWNER, is_bot: false }, chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private' }, ...(thread ? { message_thread_id: thread } : {}), text },
});

try {
  await waitFor(() => bridgeLog.includes('starting.'), 15000, 'boot');
  await sleep(300);

  // 1. QUIET CONVERSATION FIRST: the owner's DM. Session creation cannot
  //    succeed (no zcode binary), but the failure notice must land in the DM.
  push({ message: { message_id: 2, from: { id: OWNER, is_bot: false }, chat: { id: DM, type: 'private' }, text: 'hello from my dm' } });
  await waitFor(() => sendsTo(DM), 30000, 'a reply in the DM');
  check('owner DM is served in the DM', !!sendsTo(DM));

  // 2. The owner speaks in a FOREIGN TOPIC (group + thread, not the home):
  //    same -- served there.
  push(ownerText(FOREIGN_GROUP, 'hello from a foreign topic', FOREIGN_TOPIC));
  await waitFor(() => sendsTo(FOREIGN_GROUP, undefined, FOREIGN_TOPIC), 30000, 'a reply in the foreign topic');
  check('owner message in a foreign topic is served in that chat', !!sendsTo(FOREIGN_GROUP));

  // 3. A non-owner in the same foreign topic: ignored entirely.
  const before = calls.send.length;
  push({ message: { message_id: 3, from: { id: STRANGER, is_bot: false }, chat: { id: FOREIGN_GROUP, type: 'supergroup' }, message_thread_id: FOREIGN_TOPIC, text: 'i am not the owner' } });
  await sleep(2500);
  check('non-owner messages are ignored', calls.send.length === before);

  // 4. The bot is added to a group by a non-owner: it says why and leaves.
  push({
    my_chat_member: {
      from: { id: STRANGER, is_bot: false },
      chat: { id: -101111, type: 'supergroup', title: 'Strangers' },
      old_chat_member: { status: 'left' },
      new_chat_member: { status: 'member', user: { id: 777000, is_bot: true } },
    },
  });
  await waitFor(() => calls.leave.map(Number).includes(-101111), 20000, 'leaveChat for the foreign group');
  check('added by a non-owner: says why and leaves', calls.leave.map(Number).includes(-101111));

  // 5. The bot is added by the OWNER: it stays.
  push({
    my_chat_member: {
      from: { id: OWNER, is_bot: false },
      chat: { id: -101222, type: 'supergroup', title: 'Owners' },
      old_chat_member: { status: 'left' },
      new_chat_member: { status: 'member', user: { id: 777000, is_bot: true } },
    },
  });
  await sleep(2500);
  check('added by the owner: the bot stays', !calls.leave.includes(-101222));

  // 6. The home chat still works (legacy store keys preserved).
  push(ownerText(HOME_CHAT, 'hello home'));
  await waitFor(() => sendsTo(HOME_CHAT), 30000, 'a reply in the home chat');
  check('the configured home chat still works (legacy keys)', !!sendsTo(HOME_CHAT));
} catch (e) {
  failures++;
  console.log('❌', e.message);
  console.log('sends captured:', JSON.stringify(calls.send, null, 1).slice(0, 1500));
  console.log('leaves captured:', JSON.stringify(calls.leave));
}

bridge.kill('SIGTERM');
console.log(failures === 0 ? '\n==== ALL PASS ====' : `\n==== ${failures} FAILURE(S) ====`);
process.exit(failures === 0 ? 0 : 1);
