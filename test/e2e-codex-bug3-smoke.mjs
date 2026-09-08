// LIVE smoke test for "bug #3": a Codex-primary deployment
// (DEFAULT_BACKEND=codex) with NO zcode credential configured at all must
// boot cleanly, bind the MCP socket, and answer a REAL Codex turn -- without
// the (now-lazy, never-touched) zcode backend hanging or spinning CPU and
// taking the process down with it. Uses a REAL `codex app-server` (a real
// ChatGPT-Plus login, .secrets/codex-home) for one short, cheap gpt-5.6-luna
// turn; Telegram is faked (this is a backend-lifecycle proof, not a
// Telegram-integration test -- test/e2e-codex-tg.mjs already covers the real
// Telegram + real Codex round trip).
//
// "No zcode credential configured" is arranged by running the bridge with
// an isolated, brand-new $HOME (so ~/.zcode/cli/config.json cannot exist)
// -- ZCODE_BIN/ZCODE_NODE_BIN still point at a real install (per
// agent-cage's own finding: a Codex-only deployment still stages a real
// zcode binary; it's the CREDENTIAL that's genuinely absent, not the CLI).
// Before the eager/lazy fix this would have made zcode try to eagerly start
// with no credential at boot; with it, zcode is lazy and this test never
// even asks for it -- which IS the point being proven.
//
// Drive:  node test/e2e-codex-bug3-smoke.mjs
// Spends: exactly ONE real, short Codex turn (gpt-5.6-luna).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SECRETS = '/srv/agent-cage/etheron-bare/agent/etheron-bare/.secrets';
const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const ZCODE_BIN = process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js';
const CODEX_HOME = process.env.CODEX_HOME || `${SECRETS}/codex-home`; // never read/printed

const TMP = '/tmp/zbridge-codex-bug3-smoke';
const ISOLATED_HOME = path.join(TMP, 'home'); // deliberately fresh -- no ~/.zcode here, ever
const WS = path.join(TMP, 'ws');
const STORE = path.join(TMP, 'store.json');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(ISOLATED_HOME, { recursive: true });
mkdirSync(WS, { recursive: true });

const CHAT = -100999, USER = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

function cpuTicksOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(parts[11]) + Number(parts[12]);
  } catch {
    return null;
  }
}

// --- fake Telegram (this test is about backend lifecycle, not Telegram) ---
const calls = { send: [], edit: [], topicCreated: [] };
let nextMsgId = 100, nextThreadId = 700;
const srv = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const method = req.url.split('/').pop();
  const ok = (result = {}) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
  if (method === 'getUpdates') { const t = setTimeout(() => ok([]), 1000); t.unref?.(); return; }
  if (method === 'sendMessage') { const p = JSON.parse(body); calls.send.push(p); return ok({ message_id: nextMsgId++ }); }
  if (method === 'editMessageText') { const p = JSON.parse(body); calls.edit.push(p); return ok({ message_id: p.message_id }); }
  if (method === 'createForumTopic') { const p = JSON.parse(body); calls.topicCreated.push(p); return ok({ message_thread_id: nextThreadId, chat_id: p.chat_id, name: p.name }); }
  return ok();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tgPort = srv.address().port;

// --- spawn the real bridge inside a real nix shell (codex on PATH) --------
// Same process-group signal-handling requirement as test/e2e-codex-tg.mjs --
// `nix shell ... -c` execs into a bwrap sandbox without --die-with-parent,
// so cleanup must signal the whole GROUP, not just the spawned pid. See that
// file's comment for the full explanation; not repeated in depth here.
const env = {
  ...process.env,
  HOME: ISOLATED_HOME, // <-- the whole point: no ~/.zcode/cli/config.json can exist here
  TELEGRAM_API_ROOT: `http://127.0.0.1:${tgPort}`,
  TELEGRAM_BOT_TOKEN: 'fake-smoke-token',
  TELEGRAM_CHAT_ID: String(CHAT),
  TELEGRAM_ALLOWED_USER_ID: String(USER),
  DEFAULT_BACKEND: 'codex',
  ZCODE_NODE_BIN: NODE,
  ZCODE_BIN, // required at boot even though this run should NEVER touch it (that's the proof)
  ZCODE_WORKSPACE_DIR: WS,
  STORE_PATH: STORE,
  MCP_HTTP_PORT: '0',
  CODEX_BIN: 'codex', // resolved on PATH *inside* the nix shell
  CODEX_HOME,
  CODEX_DISALLOW_ASTRA: 'true',
  ZCODE_TG_ENV: '/nonexistent/zcode-tg-bug3-smoke.env', // never pick up a real deployment's .env by accident
};
delete env.ZCODE_MOBILE_ENV;

console.log('[harness] spawning the real bridge (DEFAULT_BACKEND=codex, isolated $HOME, real CODEX_HOME) inside `nix shell nixpkgs#codex`');
const bridge = spawn('nix', ['shell', 'nixpkgs#codex', '-c', NODE, path.join(REPO, 'bridge/index.js')], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
});
let bridgeLog = '';
bridge.stdout.on('data', (c) => { bridgeLog += c; process.stdout.write(`[bridge] ${c}`); });
bridge.stderr.on('data', (c) => { bridgeLog += c; process.stderr.write(`[bridge-err] ${c}`); });

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}\nbridge tail:\n${bridgeLog.slice(-3000)}`);
    await sleep(300);
  }
}

async function mcp(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : JSON.parse(await res.text()) };
}
const tool = (port, name, args, id) => mcp(port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

async function cleanup() {
  if (bridge.pid) {
    try { process.kill(-bridge.pid, 'SIGTERM'); } catch (e) { console.log(`[harness] SIGTERM to -${bridge.pid} failed (may already be gone): ${e.message}`); }
    await sleep(4000);
    let alive = true;
    try { process.kill(-bridge.pid, 0); } catch { alive = false; }
    if (alive) { try { process.kill(-bridge.pid, 'SIGKILL'); } catch {} await sleep(1000); }
  }
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  srv.close();
}

try {
  console.log('[harness] waiting for bridge boot (nix shell + codex resolve can take a few seconds on a cold store)');
  const t0 = Date.now();
  await waitFor(() => bridgeLog.includes('starting.'), 30000, 'boot');
  const m = await waitFor(() => bridgeLog.match(/mcp gateway listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/), 20000, 'mcp gateway boot');
  const bootMs = Date.now() - t0;
  const mcpPort = Number(m[1]);
  check(`bridge booted and bound the MCP socket in ${bootMs}ms (not hung/crash-looping)`, true);
  check('nothing logged a zcode spawn/crash during boot (lazy -- never touched)', !/zcode app-server/.test(bridgeLog), bridgeLog.slice(-1500));

  // Sample CPU across the boot + idle window before ever touching Codex.
  const ticksAtBoot = cpuTicksOf(bridge.pid);
  await sleep(1500);
  const ticksIdle = cpuTicksOf(bridge.pid);

  console.log('[harness] -- session_create (backend: codex, model: gpt-5.6-luna) --');
  const created = await tool(mcpPort, 'session_create', { name: 'bug3-smoke', backend: 'codex', model: 'gpt-5.6-luna' }, 1);
  check('session_create succeeded', created.body?.result && !created.body.result.isError, JSON.stringify(created.body).slice(0, 400));
  const c1 = created.body?.result ? JSON.parse(created.body.result.content[0].text) : null;
  check('session runs on codex/gpt-5.6-luna', c1?.backend === 'codex' && c1?.model === 'gpt-5.6-luna', JSON.stringify(c1));

  console.log('[harness] -- message_send: ONE short, cheap real Codex turn --');
  const t1 = Date.now();
  const sent = c1 ? await Promise.race([
    tool(mcpPort, 'message_send', { key: c1.key, text: 'Reply with exactly: BUG3-SMOKE-OK' }, 2),
    sleep(60000).then(() => ({ timedOut: true })),
  ]) : { timedOut: true };
  const turnMs = Date.now() - t1;
  check('the real Codex turn returned (did not hang)', !sent.timedOut, JSON.stringify(sent).slice(0, 400));
  check('...within a reasonable bound for a short turn', turnMs < 45000, `${turnMs}ms`);
  if (!sent.timedOut) {
    const payload = JSON.parse(sent.body.result.content[0].text);
    check('the real model actually answered as asked', /BUG3-SMOKE-OK/.test(payload.reply ?? ''), JSON.stringify(payload).slice(0, 300));
  }

  const ticksAfterTurn = cpuTicksOf(bridge.pid);
  const idleTicksUsed = ticksAtBoot != null && ticksIdle != null ? ticksIdle - ticksAtBoot : null;
  check('the bridge did not busy-spin CPU while idle before the turn', idleTicksUsed != null && idleTicksUsed < 100, `ticks used=${idleTicksUsed}`);
  check('the bridge process is still alive after the real turn (zcode never took it down)', bridge.exitCode === null, `exitCode=${bridge.exitCode}`);
  console.log(`[harness] cpu ticks -- at boot: ${ticksAtBoot}, after idle wait: ${ticksIdle}, after real turn: ${ticksAfterTurn}`);
} catch (e) {
  check('scenario completed without harness error', false, e.stack || e.message);
} finally {
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
}
