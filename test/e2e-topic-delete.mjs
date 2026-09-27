// E2E: the relay's synthetic forum_topic_deleted (relay-owned-group design
// §4, "Re-bind and close"). The relay synthesizes a Bot-API-shaped MESSAGE
// update carrying forum_topic_deleted: {} into an agent's getUpdates stream
// when a bound topic moves away (/rebind, /close) or was deleted through the
// Telegram UI. Four real-bridge scenarios against a local fake Telegram --
// no real zcode/Codex CLI or credential involved:
//
//   1. PROXIED (TELEGRAM_API_ROOT=unix: -- a unix-socket fake standing in
//      for the relay proxy): the delete closes the session -- and the NEXT
//      message in the same topic (the topic re-bound back to this agent)
//      starts a FRESH session, not the closed one. closeForumTopic is never
//      called (the topic is no longer ours; the proxy would 403).
//   2. LEGACY (http root): the synthetic delete is IGNORED -- a real
//      Telegram never sends that field, so the one-bridge-one-bot world
//      must not act on it.
//   3. PROXIED, idempotence: a second delete for the already-closed topic is
//      a logged no-op -- the relay's delivery is at-least-once (design §9).
//   4. PROXIED, in-flight turn + queue: the running turn is interrupted
//      (session/stop on the wire) and queued messages are DROPPED -- they
//      were sent to the old conversation and must not run on a fresh one.
//      Then a message after the re-bind back starts a fresh session.
//
// The synthetic update's `from` is deliberately NOT the owner: the handler
// must sit BEFORE the owner gate, its trust boundary being the proxied
// transport, not the message author.
//
// Drive: ZCODE_NODE_BIN=$(command -v node) node test/e2e-topic-delete.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || process.execPath;
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ZCODE_FIXTURE = path.join(REPO, 'test', 'fixtures', 'fake-zcode-app-server.mjs');
const TMP = '/tmp/zbridge-e2e-topic-delete';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

const CHAT = -100111, OWNER = 1, RELAY = 424242; // RELAY: the synthetic identity, deliberately not the owner

// A fake Telegram; for proxied=true it listens on a unix socket (the relay
// proxy's transport, and what makes cfg.proxied true in the bridge), else on
// 127.0.0.1. Records EVERY method call with its params. getUpdates answers
// pending updates on the next poll (the bridge long-polls, so a pushed
// update is picked up within ~1s).
function startFakeTelegram({ proxied, name }) {
  const calls = [];
  const pending = [];
  let nextMsgId = 100;
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const method = req.url.split('/').pop();
    const ok = (result = {}) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
    if (method === 'getUpdates') {
      if (pending.length) return ok(pending.splice(0, pending.length));
      const t = setTimeout(() => ok([]), 1000);
      t.unref?.();
      return;
    }
    const params = body ? JSON.parse(body) : {};
    calls.push({ method, params });
    if (method === 'sendMessage') return ok({ message_id: nextMsgId++ });
    if (method === 'editMessageText') return ok({ message_id: params.message_id });
    if (method === 'createForumTopic') return ok({ message_thread_id: 900, chat_id: params.chat_id, name: params.name });
    return ok();
  });
  return new Promise((resolve) => {
    const done = () => resolve({
      srv,
      calls,
      pushUpdate: (u) => pending.push(u),
      close: () => srv.close(),
    });
    if (proxied) {
      const sock = path.join(TMP, `${name}.sock`);
      srv.listen(sock, done);
    } else {
      srv.listen(0, '127.0.0.1', () => { srv.port = srv.address().port; done(); });
    }
  });
}

function startBridge(env, label) {
  const bridge = spawn(NODE, [path.join(REPO, 'bridge/index.js')], {
    env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  bridge.stdout.on('data', (c) => { log += c; if (process.env.E2E_DEBUG) process.stdout.write(`[${label}] ${c}`); });
  bridge.stderr.on('data', (c) => { log += c; if (process.env.E2E_DEBUG) process.stderr.write(`[${label}-err] ${c}`); });
  return { proc: bridge, get log() { return log; } };
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

let tgUpdateId = 0;
const userMessage = (threadId, text) => ({
  update_id: ++tgUpdateId,
  message: {
    message_id: 5000 + ++tgUpdateId,
    from: { id: OWNER, is_bot: false },
    chat: { id: CHAT },
    message_thread_id: threadId,
    date: Math.floor(Date.now() / 1000),
    text,
  },
});
// The relay's synthetic deletion: Bot-API-shaped message, forum_topic_deleted
// is NOT a real Bot API field (Telegram has forum_topic_closed -- reversible,
// deliberately ignored); `from` is the relay's synthetic identity, NOT the
// owner -- handling it before the owner gate is part of what's under test.
const relayTopicDeleted = (threadId) => ({
  update_id: ++tgUpdateId,
  message: {
    message_id: 5000 + ++tgUpdateId,
    from: { id: RELAY, is_bot: false, first_name: 'relay', username: 'relay_synthetic_bot' },
    chat: { id: CHAT },
    message_thread_id: threadId,
    date: Math.floor(Date.now() / 1000),
    forum_topic_deleted: {},
  },
});

const createdSessions = (log, backend = 'mock') => [...log.matchAll(new RegExp(`created ${backend} session (\\S+)`, 'g'))].map((m) => m[1]);
const linesWith = (log, needle) => log.split('\n').filter((l) => l.includes(needle));

async function withBridge({ proxied, name, extraEnv = {} }, run) {
  const fake = await startFakeTelegram({ proxied, name });
  const root = proxied ? `unix:${path.join(TMP, `${name}.sock`)}` : `http://127.0.0.1:${fake.srv.port}`;
  const store = path.join(TMP, `${name}-store.json`);
  mkdirSync(path.join(TMP, `${name}-ws`), { recursive: true }); // the backends spawn with cwd=workspaceDir; a missing dir surfaces as spawn ENOENT
  const b = startBridge({
    TELEGRAM_API_ROOT: root,
    TELEGRAM_BOT_TOKEN: proxied ? 'virtual-relay-token' : 'legacy-token',
    TELEGRAM_CHAT_ID: String(CHAT),
    TELEGRAM_ALLOWED_USER_ID: String(OWNER),
    // The bridge demands a ZCODE_BIN at boot even on a mock-default
    // deployment (config.js); the fixture stand-in satisfies it without a
    // real zcode install -- the mock scenarios never spawn it.
    ZCODE_NODE_BIN: NODE,
    ZCODE_BIN: ZCODE_FIXTURE,
    ZCODE_WORKSPACE_DIR: path.join(TMP, `${name}-ws`),
    STORE_PATH: store,
    ...extraEnv,
  }, name);
  try {
    await waitFor(() => b.log.includes('[bridge] starting.'), 25000, `${name} boot`);
    await run({ fake, bridge: b, log: () => b.log });
  } finally {
    b.proc.kill('SIGKILL');
    fake.close();
    await sleep(200);
    for (const f of [store, `${store}.lock`]) { try { rmSync(f, { force: true }); } catch {} }
  }
}

// --- scenario 1: proxied delete closes the session; the topic coming back
// to this agent starts a FRESH session; closeForumTopic is never called ---
async function scenario1() {
  console.log('\n--- scenario 1: proxied delete closes; re-bound topic starts FRESH; no closeForumTopic ---');
  await withBridge({ proxied: true, name: 's1-proxied', extraEnv: { DEFAULT_BACKEND: 'mock' } }, async ({ fake, log }) => {
    fake.pushUpdate(userMessage(77, 'hello'));
    await waitFor(() => createdSessions(log()).length === 1, 25000, 'first mock session created');
    const first = createdSessions(log())[0];

    fake.pushUpdate(relayTopicDeleted(77));
    await waitFor(() => log().includes('closing session for topic'), 25000, 'delete handled');

    fake.pushUpdate(userMessage(77, 'hello again'));
    await waitFor(() => createdSessions(log()).length === 2, 25000, 'second (fresh) mock session created');
    const second = createdSessions(log())[1];

    check('a fresh session was created after the re-bind (not a resume of the closed one)', second !== first, `${first} vs ${second}\n${log().slice(-2000)}`);
    check('closeForumTopic was NEVER called (the topic is no longer ours; the proxy would 403)', !fake.calls.some((c) => c.method === 'closeForumTopic'), JSON.stringify(fake.calls.map((c) => c.method)));
    check('the topic still answers after the fresh start (the fresh conversation delivered its reply)', fake.calls.some((c) => c.method === 'editMessageText' && /mock echo.*hello again/s.test(c.params.text)) || fake.calls.some((c) => c.method === 'sendMessage' && /mock echo.*hello again/s.test(c.params.text)), JSON.stringify(fake.calls.filter((c) => /echo/.test(JSON.stringify(c.params)))));
    check('the closed mark was lifted for the live conversation (no "already closed" refusal logged)', !log().includes('is closed'), log().slice(-1500));
  });
}

// --- scenario 2: legacy mode ignores the synthetic delete ---
async function scenario2() {
  console.log('\n--- scenario 2: legacy (http root) ignores forum_topic_deleted ---');
  await withBridge({ proxied: false, name: 's2-legacy', extraEnv: { DEFAULT_BACKEND: 'mock' } }, async ({ fake, log }) => {
    fake.pushUpdate(userMessage(77, 'hello'));
    await waitFor(() => createdSessions(log()).length === 1, 25000, 'first mock session created');
    const first = createdSessions(log())[0];

    fake.pushUpdate(relayTopicDeleted(77));
    await waitFor(() => log().includes('not in proxied mode'), 25000, 'the ignore logged');
    await sleep(1000); // give a wrongly-eager handler every chance to act

    check('the delete was ignored with the proxied-mode sentence', linesWith(log(), 'ignoring forum_topic_deleted').length === 1, log().slice(-1500));
    fake.pushUpdate(userMessage(77, 'still here'));
    await waitFor(() => /mock echo.*still here/s.test(JSON.stringify(fake.calls)), 25000, 'reply to the post-delete message');
    check('the ORIGINAL session kept serving the topic (no fresh session, no resume failure)', createdSessions(log()).length === 1 && createdSessions(log())[0] === first, log().slice(-2000));
    check('no session was closed in legacy mode', !log().includes('closing session for topic'), log().slice(-1500));
  });
}

// --- scenario 3: idempotence -- a duplicate delete is a logged no-op ---
async function scenario3() {
  console.log('\n--- scenario 3: proxied delete is idempotent ---');
  await withBridge({ proxied: true, name: 's3-idempotent', extraEnv: { DEFAULT_BACKEND: 'mock' } }, async ({ fake, log }) => {
    fake.pushUpdate(userMessage(77, 'hello'));
    await waitFor(() => createdSessions(log()).length === 1, 25000, 'first mock session created');

    fake.pushUpdate(relayTopicDeleted(77));
    await waitFor(() => log().includes('closing session for topic'), 25000, 'delete handled');
    fake.pushUpdate(relayTopicDeleted(77));
    await waitFor(() => log().includes('already closed -- ignoring duplicate'), 25000, 'duplicate ignored');

    check('exactly ONE close ran for two deletes', linesWith(log(), 'closing session for topic').length === 1, linesWith(log(), 'closing session').join(' | '));
    check('the duplicate was logged as a no-op', linesWith(log(), 'already closed -- ignoring duplicate').length === 1, log().slice(-1500));
    check('still no closeForumTopic', !fake.calls.some((c) => c.method === 'closeForumTopic'), JSON.stringify(fake.calls.map((c) => c.method)));

    fake.pushUpdate(userMessage(77, 'after dup'));
    await waitFor(() => createdSessions(log()).length === 2, 25000, 'fresh session after re-bind despite duplicate delete');
    check('the topic re-binding back still gets a fresh session', createdSessions(log()).length === 2, log().slice(-1500));
  });
}

// --- scenario 4: in-flight turn interrupted, queued messages dropped ---
async function scenario4() {
  console.log('\n--- scenario 4: proxied delete interrupts the running turn and drops the queue ---');
  const zlog = path.join(TMP, 's4-zcode.jsonl'); // the fixture's request log: session/send + session/stop on the wire
  await withBridge({
    proxied: true,
    name: 's4-inflight',
    extraEnv: {
      DEFAULT_BACKEND: 'zcode',
      ZCODE_BIN: ZCODE_FIXTURE,
      FIXTURE_ZCODE_LOG: zlog,
    },
  }, async ({ fake, log }) => {
    const zrequests = () => (existsSync(zlog) ? readFileSync(zlog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const sends = () => zrequests().filter((r) => r.method === 'session/send');

    fake.pushUpdate(userMessage(77, 'task one'));
    await waitFor(() => sends().some((r) => r.params.content === 'task one'), 30000, 'turn one running (session/send on the wire)');

    // Busy now: a second message must QUEUE (this is the queue the delete must drop).
    fake.pushUpdate(userMessage(77, 'task two'));
    await waitFor(() => fake.calls.some((c) => c.method === 'sendMessage' && /Queued/.test(c.params.text)), 25000, 'second message queued');
    const callsAtDelete = fake.calls.length;

    fake.pushUpdate(relayTopicDeleted(77));
    await waitFor(() => log().includes('interrupting in-flight turn'), 25000, 'in-flight turn interrupted');

    check('the turn was cancelled on the wire (session/stop)', zrequests().some((r) => r.method === 'session/stop'), JSON.stringify(zrequests().map((r) => r.method)));
    check('the queued message was DROPPED with the reason logged', log().includes('dropped 1 queued message(s)'), log().slice(-1500));
    await sleep(1000);
    check('the dropped message was never sent to any session', !sends().some((r) => r.params.content === 'task two'), JSON.stringify(sends().map((r) => r.params.content)));
    check('no new Queued notice after the delete (nothing re-queued behind the interrupt)', !fake.calls.slice(callsAtDelete).some((c) => c.method === 'sendMessage' && /Queued/.test(c.params.text)), JSON.stringify(fake.calls.slice(callsAtDelete)));

    // The topic re-binds back to this agent: the next message starts a FRESH session.
    fake.pushUpdate(userMessage(77, 'task three'));
    await waitFor(() => sends().some((r) => r.params.content === 'task three'), 30000, 'post-rebind turn running');
    check('a FRESH session served the post-rebind message (second session/create on the wire)', zrequests().filter((r) => r.method === 'session/create').length === 2, JSON.stringify(zrequests().map((r) => r.method)));
    check('closeForumTopic was never called', !fake.calls.some((c) => c.method === 'closeForumTopic'), JSON.stringify(fake.calls.map((c) => c.method)));
  });
}

const scenarios = [scenario1, scenario2, scenario3, scenario4];
for (const s of scenarios) {
  try {
    await s();
  } catch (e) {
    check(`${s.name} completed without harness timeout`, false, e.message);
  }
}
console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
