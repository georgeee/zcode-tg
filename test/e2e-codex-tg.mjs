// REAL Telegram, REAL Codex e2e: drives an actual Codex conversation through
// the bridge over the ACTUAL "Yak test 2" Telegram group with the ACTUAL
// yak_test_02_bot -- no TELEGRAM_API_ROOT seam, no fake app-server. This is
// the live-wire counterpart to test/e2e-mcp.mjs (which proves the same MCP
// contract against a fake Telegram + a real-but-throwaway zcode session);
// here BOTH ends are real: the model backend (a real ChatGPT-Plus Codex
// login) and the chat transport (the real Telegram Bot API, a real group, a
// real bot identity). It spends real ChatGPT-Plus usage -- kept to a small,
// fixed number of short gpt-5.6-luna (Codex's cheapest/fastest tier) turns.
//
// Unlike every other e2e script in this repo, this one deliberately does
// NOT close the Telegram topic or delete anything it creates: George asked
// explicitly that real-Telegram test runs stay visible in the app
// afterward for review. Only local-only state (this harness's own
// processes, its scratch workspace dir, its scratch session-store file) is
// cleaned up in `finally` -- never anything Telegram-visible.
//
// Drive:  node test/e2e-codex-tg.mjs
//         SKIP_SHELL_TURN=1 node test/e2e-codex-tg.mjs   (skip the 2nd real turn)
//
// Credentials are read directly from .secrets/ -- never printed, never
// logged, never interpolated into a string this script writes to stdout.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SECRETS = '/srv/agent-cage/etheron-bare/agent/etheron-bare/.secrets';
const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const CODEX_HOME = process.env.CODEX_HOME || `${SECRETS}/codex-home`;

// "Yak test 2": yak_test_02_bot + yak_test_03_bot, topics on. See the
// codex-integration-master-plan memory for how this group was set up and
// confirmed live. bot03 was investigated as a possible independent
// Telegram-side observer for verification (it's also a member of this
// group) but an empirical precheck showed bots do NOT see other bots'
// messages via getUpdates here (privacy-mode/admin asymmetry: only
// human-authored messages showed up in bot03's own getUpdates backlog,
// never bot02's own sendMessage calls) -- so it adds nothing for THIS
// test and is not used. See the verification section at the bottom for
// what's used instead.
const CHAT_ID = -1004307226992;
const OWNER_USER_ID = 166514873; // George's real Telegram user id
const BOT_TOKEN = readFileSync(`${SECRETS}/tg-test02-bot`, 'utf8').trim();

const WS = '/tmp/zbridge-codex-tg-e2e-ws';
const STORE = '/tmp/zbridge-codex-tg-e2e-store.json';
rmSync(WS, { recursive: true, force: true });
rmSync(STORE, { force: true });
rmSync(STORE + '.lock', { force: true });
mkdirSync(WS, { recursive: true });

// A run id makes every artifact this run leaves in the real chat
// unambiguous -- repeated runs of this script over time all land in the
// same group, and George reviewing the app later should be able to tell
// them apart at a glance.
const RUN = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
const TOPIC_NAME = `codex-tg-e2e-${RUN}`;
const MARK1 = `CODEX-TG-E2E-REPLY-${RUN}`;
const MARK2 = `CODEX-TG-E2E-SHELL-${RUN}`;
// Set SKIP_SHELL_TURN=1 to spend one fewer real Codex turn (drops the
// shell-command proof, keeps the plain-reply proof).
const RUN_SHELL_TURN = process.env.SKIP_SHELL_TURN !== '1';

console.log(`[harness] run id ${RUN} -- topic "${TOPIC_NAME}" in chat ${CHAT_ID} ("Yak test 2")`);

// --- spawn the REAL bridge, wrapped in a real nix shell --------------------
// This host's real /nix only exists inside a nix shell / nix-run bwrap
// sandbox -- CODEX_BIN pointing at a resolved /nix/store path goes stale
// the moment that path is garbage-collected (and isn't resolvable at all
// outside a nix shell to begin with), so the WHOLE node process -- not just
// the codex binary it later spawns -- is launched from inside
// `nix shell nixpkgs#codex -c <node> ...`.
//
// IMPORTANT, hard-won by direct experiment while building this test:
// `nix shell ... -c cmd` execs into a bwrap sandbox WITHOUT
// --die-with-parent. Sending SIGTERM to just the spawned pid (the outer
// bwrap/nix process) does NOT propagate into the sandbox -- confirmed by
// controlled test, the inner node process never even sees the signal and
// is left running, silently reparented to pid 1, forever. `detached: true`
// plus signaling the whole process GROUP (`process.kill(-bridge.pid, ...)`)
// is what actually tears down every layer (the bwrap wrapper(s), the inner
// node process, and whatever it spawned) -- see cleanup() below. Do not
// "simplify" this back to a plain `bridge.kill()`.
const env = {
  ...process.env,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: String(CHAT_ID),
  TELEGRAM_ALLOWED_USER_ID: String(OWNER_USER_ID),
  ZCODE_NODE_BIN: NODE,
  ZCODE_BIN, // required at boot even though this run only touches the codex backend
  ZCODE_WORKSPACE_DIR: WS,
  ZCODE_DEFAULT_MODE: 'yolo',
  STORE_PATH: STORE,
  MCP_HTTP_PORT: '0', // ephemeral loopback MCP; the harness reads the bound port from the boot log
  CODEX_BIN: 'codex', // resolved on PATH *inside* the nix shell, not an absolute store path
  CODEX_HOME,
  CODEX_DISALLOW_ASTRA: 'true', // a test bot should never be able to spend Astra-tier usage
  // Explicit, nonexistent path: never let this pick up the real live
  // deployment's ~/.config/zcode-tg/.env by accident (CLAUDE.md's "always
  // set env overrides explicitly, never rely on defaults" lesson, learned
  // from a real production incident on this branch).
  ZCODE_TG_ENV: '/nonexistent/zcode-tg-e2e-codex-tg.env',
};
// Deliberately absent: TELEGRAM_API_ROOT -- that's the fake-Telegram seam
// every other test/e2e-*.mjs script uses; this test wants the real
// api.telegram.org, so make sure nothing in the ambient shell environment
// smuggles a stale override in.
delete env.TELEGRAM_API_ROOT;
delete env.ZCODE_MOBILE_ENV;

const bridge = spawn('nix', ['shell', 'nixpkgs#codex', '-c', NODE, path.join(REPO, 'bridge/index.js')], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => { bridgeLog += c; process.stdout.write(`[bridge] ${c}`); });
bridge.stderr.on('data', (c) => { bridgeLog += c; process.stderr.write(`[bridge-err] ${c}`); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}\nbridge tail:\n${bridgeLog.slice(-3000)}`);
    await sleep(300);
  }
}
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

// --- a minimal MCP client over Streamable HTTP, exactly what a second
// model's MCP client puts on the wire ---
async function mcp(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : JSON.parse(await res.text()) };
}
const tool = (port, name, args, id) => mcp(port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

// --- direct, real Telegram Bot API calls the harness makes ITSELF,
// completely independent of the bridge process -- used only for the
// post-test verification section below (see its own comment for why). ---
async function tgCall(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

// The live bridge's own streaming edits (placeholder updates during a real
// turn) share this same small test group's per-chat rate limit, so a
// direct call made moments after the bridge stops can land in a short 429
// window it opened. Telegram's own response names exactly how long to
// wait (retry_after, seconds) -- honor it rather than guessing a backoff.
async function tgCallWithRetry(method, params, maxAttempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const result = await tgCall(method, params);
    if (result.ok || attempt >= maxAttempts || result.error_code !== 429) return result;
    const waitS = result.parameters?.retry_after ?? 5;
    console.log(`[harness] ${method} rate-limited (429), retrying after ${waitS}s as Telegram asked (attempt ${attempt}/${maxAttempts})`);
    await sleep((waitS + 1) * 1000);
  }
}

// --- cleanup: kill the ENTIRE process group the nix/bwrap/node tree
// belongs to (see the big comment above spawn()), then remove local-only
// scratch state. Never touches anything Telegram-visible. ---
async function cleanup() {
  if (bridge.pid) {
    try {
      process.kill(-bridge.pid, 'SIGTERM');
    } catch (e) {
      console.log(`[harness] SIGTERM to process group -${bridge.pid} failed (may already be gone): ${e.message}`);
    }
    await sleep(4000);
    let stillAlive = true;
    try {
      process.kill(-bridge.pid, 0); // throws ESRCH if the whole group is gone
    } catch {
      stillAlive = false;
    }
    if (stillAlive) {
      console.log(`[harness] process group -${bridge.pid} survived SIGTERM; sending SIGKILL`);
      try { process.kill(-bridge.pid, 'SIGKILL'); } catch {}
      await sleep(1000);
    }
    try {
      process.kill(-bridge.pid, 0);
      console.log(`[harness] ⚠️ process group -${bridge.pid} may still have members after SIGKILL`);
    } catch {
      console.log(`[harness] process group -${bridge.pid} fully torn down`);
    }
  }
  try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); } catch {}
  try { rmSync(WS, { recursive: true, force: true }); } catch {}
}

let sessionInfo = null; // filled in once session_create succeeds, used by the verification section

try {
  console.log('[harness] waiting for bridge boot (nix shell + codex resolve can take a few seconds on a cold store)');
  await waitFor(() => bridgeLog.includes('starting.'), 30000, 'boot');
  const m = await waitFor(() => bridgeLog.match(/mcp gateway listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/), 20000, 'mcp gateway boot');
  const mcpPort = Number(m[1]);
  console.log(`[harness] mcp gateway on 127.0.0.1:${mcpPort}`);

  console.log('[harness] -- initialize + tools/list');
  const init = await mcp(mcpPort, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  check('initialize handshake', init.body?.result?.protocolVersion === '2024-11-05', JSON.stringify(init.body));
  await mcp(mcpPort, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await mcp(mcpPort, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolNames = (list.body?.result?.tools ?? []).map((t) => t.name);
  check('tools/list advertises all six tools', toolNames.length === 6, JSON.stringify(toolNames));

  console.log(`[harness] -- session_create (backend: codex, model: gpt-5.6-luna, real topic "${TOPIC_NAME}")`);
  const created = await tool(mcpPort, 'session_create', { name: TOPIC_NAME, backend: 'codex', model: 'gpt-5.6-luna' }, 3);
  console.log('session_create raw:', JSON.stringify(created.body));
  check('session_create returned a result (not an MCP-level error)', created.body?.result && !created.body.result.isError, JSON.stringify(created.body).slice(0, 500));
  sessionInfo = JSON.parse(created.body.result.content[0].text);
  check('session_create succeeded on the codex backend', sessionInfo.backend === 'codex', JSON.stringify(sessionInfo));
  check('session_create picked gpt-5.6-luna', sessionInfo.model === 'gpt-5.6-luna', JSON.stringify(sessionInfo));
  check('session_create returned the real chat id', sessionInfo.chat_id === CHAT_ID, JSON.stringify(sessionInfo));
  check('session_create returned a real Telegram thread_id', Number.isInteger(sessionInfo.thread_id) && sessionInfo.thread_id > 0, JSON.stringify(sessionInfo));

  console.log('[harness] -- model_get(key) reports codex/luna for this session');
  const mg = await tool(mcpPort, 'model_get', { key: sessionInfo.key }, 9);
  const mgv = JSON.parse(mg.body.result.content[0].text);
  check('model_get reports backend=codex, model=gpt-5.6-luna, switchable=true', mgv.backend === 'codex' && mgv.model === 'gpt-5.6-luna' && mgv.switchable === true, JSON.stringify(mgv));

  console.log('[harness] -- message_send #1 (REAL Codex turn over REAL Telegram -- spends real usage)');
  const r1 = await tool(mcpPort, 'message_send', { key: sessionInfo.key, text: `Reply with exactly ${MARK1} and nothing else.` }, 4);
  console.log('message_send #1 raw:', JSON.stringify(r1.body).slice(0, 500));
  check('message_send #1 returns a reply (not an MCP-level error)', r1.body?.result && !r1.body.result.isError, JSON.stringify(r1.body).slice(0, 500));
  let reply1 = '';
  if (r1.body?.result && !r1.body.result.isError) {
    reply1 = JSON.parse(r1.body.result.content[0].text).reply ?? '';
    check('the reply text came back through MCP', reply1.includes(MARK1), JSON.stringify(reply1).slice(0, 300));
  }

  let reply2 = '';
  if (RUN_SHELL_TURN) {
    console.log('[harness] -- message_send #2 (REAL Codex turn, actually runs a shell command -- proves the sandbox/approval config lets Codex act)');
    const r2 = await tool(
      mcpPort,
      'message_send',
      { key: sessionInfo.key, text: `Run the shell command: echo ${MARK2}\nThen reply with exactly its stdout output and nothing else.` },
      5,
    );
    console.log('message_send #2 raw:', JSON.stringify(r2.body).slice(0, 500));
    check('message_send #2 returns a reply (not an MCP-level error)', r2.body?.result && !r2.body.result.isError, JSON.stringify(r2.body).slice(0, 500));
    if (r2.body?.result && !r2.body.result.isError) {
      reply2 = JSON.parse(r2.body.result.content[0].text).reply ?? '';
      check('the shell command actually ran (its real stdout came back through MCP)', reply2.includes(MARK2), JSON.stringify(reply2).slice(0, 300));
    }
  } else {
    console.log('[harness] SKIP_SHELL_TURN=1 -- skipping the shell-command turn');
  }

  console.log('[harness] -- replies_get confirms the reply log');
  const got = await tool(mcpPort, 'replies_get', { key: sessionInfo.key }, 6);
  const log = JSON.parse(got.body.result.content[0].text);
  const expectedReplies = RUN_SHELL_TURN ? 2 : 1;
  check(`replies_get returns ${expectedReplies} collected repl${expectedReplies === 1 ? 'y' : 'ies'}`, (log.replies ?? []).length === expectedReplies, JSON.stringify(log).slice(0, 500));

  // Deliberately NO session_close here -- see the file header. The topic
  // and every message in it stay exactly as Telegram shows them.

  // --- independent, post-hoc verification: real calls to the real
  // Telegram Bot API, made by THIS harness directly (not through the
  // bridge, not trusting anything the bridge/MCP said about itself) -----
  //
  // Hard platform constraint discovered while designing this: the Bot API
  // gives a bot no way to read back messages IT sent (getUpdates only
  // delivers events the bot didn't originate -- confirmed by direct
  // experiment: a probe message sent from this same bot token never
  // appeared in that bot's own subsequent getUpdates), and there is no
  // "list chat history" method for bots at all. So "verify via the
  // Telegram Bot API directly" here means: (a) confirm the chat/topic is
  // real and still open by asking Telegram about it, and (b) post one
  // clearly-labeled verification message -- via a call this script makes
  // itself, after the bridge process is already dead, so it cannot be the
  // bridge quietly vouching for itself -- into the exact real thread_id
  // MCP handed back, quoting the exact reply text captured above. Success
  // of that call is Telegram's own server telling us, independently, that
  // the topic genuinely exists, is not closed, and belongs to this chat.
  if (sessionInfo) {
    console.log('[harness] -- post-test independent verification (direct Telegram Bot API calls, bridge already stopped)');
    await cleanup(); // stop the bridge FIRST so this section can't be the bridge answering for itself
    const chat = await tgCallWithRetry('getChat', { chat_id: CHAT_ID });
    check('getChat (direct, independent call): chat is real, is_forum, matches', chat.ok && chat.result?.is_forum === true && chat.result?.id === CHAT_ID, JSON.stringify(chat).slice(0, 400));

    const verifyText =
      `✅ e2e-codex-tg.mjs independent verification (run ${RUN})\n` +
      `Posted directly via the Bot API by the test harness, after stopping the bridge process -- ` +
      `not something the bridge said about itself.\n` +
      `Turn 1 real Codex reply: ${JSON.stringify(reply1)}\n` +
      (RUN_SHELL_TURN ? `Turn 2 real Codex reply (ran a real shell command): ${JSON.stringify(reply2)}\n` : '') +
      `This topic and every message above are left in place intentionally.`;
    const posted = await tgCallWithRetry('sendMessage', { chat_id: CHAT_ID, message_thread_id: sessionInfo.thread_id, text: verifyText });
    check('direct sendMessage into the real topic succeeded (topic exists, is open, accepts messages)', posted.ok === true && Number.isInteger(posted.result?.message_id), JSON.stringify(posted).slice(0, 400));
    if (posted.ok) {
      console.log(`[harness] verification message posted: chat=${CHAT_ID} thread=${sessionInfo.thread_id} message_id=${posted.result.message_id}`);
    }
  }
} catch (e) {
  check('scenario completed without harness timeout', false, e.message);
} finally {
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  await cleanup(); // idempotent -- already-stopped bridge just reports "fully torn down" again
  process.exit(failures === 0 ? 0 : 1);
}
