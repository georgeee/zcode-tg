// E2E for the eager/lazy backend-startup fix ("bug #3") and the busy-spin/
// bounded-failure fix that goes with it. Three real scenarios, each spawning
// the REAL bridge/index.js as a subprocess against a local fake Telegram --
// no real zcode/Codex CLI or credential involved (see test/fixtures/), so
// this runs anywhere without spending quota or touching the live deployment.
//
//  1. DEFAULT_BACKEND=codex never touches zcode at all: the zcode fixture's
//     start-marker is never written, and the bridge boots and stays alive
//     (proving Codex -- not zcode -- is the one eagerly started).
//  2. DEFAULT_BACKEND=zcode (the live deployment's own config) is BYTE-FOR-
//     BYTE UNCHANGED: zcode's start-marker IS written with nothing ever
//     asking for it (eager), and when it dies, the WHOLE bridge exits
//     (load-bearing) -- the regression test that matters most here.
//  3. A Codex-default deployment whose zcode is lazily started AND
//     misconfigured (ZCODE_BIN pointing at nothing -- the "fake/broken CLI
//     stand-in" for a real auth failure, exercising the exact code path a
//     real expired/missing z.ai credential would hit at spawn time) fails
//     BOUNDED and CLEAN when a topic actually asks for it: the bridge
//     process survives, CPU stays near zero throughout, and the request
//     that triggered it comes back with a clear error instead of hanging.
//
// Drive: node test/e2e-backend-lifecycle.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const FIXTURES = path.join(REPO, 'test', 'fixtures');
const ZCODE_FIXTURE = path.join(FIXTURES, 'fake-zcode-app-server.mjs');
const CODEX_FIXTURE = path.join(FIXTURES, 'fake-codex-app-server.mjs');
const TMP = '/tmp/zbridge-e2e-backend-lifecycle';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

// --- a fresh fake Telegram + bridge subprocess per scenario ---
function startFakeTelegram() {
  const calls = { send: [], edit: [], topicCreated: [] };
  let nextMsgId = 100, nextThreadId = 900;
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
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, calls })));
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

function cpuTicksOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(parts[11]) + Number(parts[12]); // utime + stime
  } catch {
    return null;
  }
}

// --- scenario 1: Codex-default never touches zcode ---
async function scenario1() {
  console.log('\n--- scenario 1: DEFAULT_BACKEND=codex never eagerly touches zcode ---');
  const { srv, port } = await startFakeTelegram();
  const zcodeMarker = path.join(TMP, 's1-zcode-started.json');
  const codexMarker = path.join(TMP, 's1-codex-started.json');
  const b = startBridge({
    TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
    TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: '-100111', TELEGRAM_ALLOWED_USER_ID: '1',
    DEFAULT_BACKEND: 'codex',
    ZCODE_NODE_BIN: NODE, ZCODE_BIN: ZCODE_FIXTURE, ZCODE_WORKSPACE_DIR: TMP,
    CODEX_HOME: TMP, CODEX_BIN: CODEX_FIXTURE,
    FIXTURE_ZCODE_MARKER: zcodeMarker, // must NEVER be written in this scenario
    FIXTURE_CODEX_MARKER: codexMarker,
    STORE_PATH: path.join(TMP, 's1-store.json'),
  }, 's1');
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot');
    // Give it a moment to have eagerly started its default backend and, if
    // it were (wrongly) also touching zcode, to have done that too.
    await sleep(2000);
    check('the bridge process is still alive (codex fixture answered initialize cleanly)', b.proc.exitCode === null, `exitCode=${b.proc.exitCode}\n${b.log.slice(-1500)}`);
    check('codex (the actual default here) WAS eagerly started', existsSync(codexMarker), b.log.slice(-1500));
    check('zcode was NEVER spawned (no start-marker) for a codex-default deployment', !existsSync(zcodeMarker), b.log.slice(-1500));
  } finally {
    b.proc.kill('SIGKILL');
    srv.close();
  }
}

// --- scenario 2: zcode-default is byte-for-byte unchanged (eager + load-bearing) ---
async function scenario2() {
  console.log('\n--- scenario 2: DEFAULT_BACKEND=zcode (or unset) is unchanged: eager AND load-bearing ---');
  const { srv, port } = await startFakeTelegram();
  const zcodeMarker = path.join(TMP, 's2-zcode-started.json');
  const b = startBridge({
    TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
    TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: '-100111', TELEGRAM_ALLOWED_USER_ID: '1',
    // DEFAULT_BACKEND deliberately UNSET here -- proving the live
    // deployment's own config (no DEFAULT_BACKEND env var at all) keeps
    // defaulting to 'zcode', exactly as before this refactor.
    ZCODE_NODE_BIN: NODE, ZCODE_BIN: ZCODE_FIXTURE, ZCODE_WORKSPACE_DIR: TMP,
    FIXTURE_ZCODE_MARKER: zcodeMarker,
    FIXTURE_ZCODE_CRASH_AFTER_MS: '1500', // simulate the app-server dying shortly after boot
    STORE_PATH: path.join(TMP, 's2-store.json'),
  }, 's2');
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot');
    await waitFor(() => existsSync(zcodeMarker), 5000, 'zcode start-marker (eager start)');
    check('zcode was started EAGERLY -- nothing ever asked for it, no topic, no message', existsSync(zcodeMarker));
    const marker = JSON.parse(readFileSync(zcodeMarker, 'utf8'));
    check('the marker was written well before the crash timer (proves it ran at module load, not lazily)', Date.now() - marker.at < 3000, JSON.stringify(marker));
    const exitInfo = await waitFor(() => (b.proc.exitCode !== null ? { code: b.proc.exitCode } : null), 8000, 'bridge exit after zcode dies');
    check('the WHOLE bridge exits when its load-bearing (default) backend dies -- unchanged fatal behavior', exitInfo.code === 1, `exitCode=${exitInfo.code}\n${b.log.slice(-1500)}`);
    check('the exit was logged as the load-bearing-backend-died path, not a crash/uncaught-exception', /zcode app-server exited unexpectedly.*exiting so the service manager restarts us/.test(b.log), b.log.slice(-1500));
  } finally {
    b.proc.kill('SIGKILL');
    srv.close();
  }
}

// --- scenario 3: a lazily-started, misconfigured zcode fails bounded, not hung/spinning ---
async function scenario3() {
  console.log('\n--- scenario 3: lazy zcode with a broken CLI (ENOENT stand-in for a real auth failure) fails bounded -- no busy-spin ---');
  const { srv, port } = await startFakeTelegram();
  const b = startBridge({
    TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
    TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: '-100111', TELEGRAM_ALLOWED_USER_ID: '1',
    DEFAULT_BACKEND: 'codex', // codex is the healthy, load-bearing default here
    CODEX_HOME: TMP, CODEX_BIN: CODEX_FIXTURE,
    // The "fake/broken CLI stand-in" for a real zcode misconfiguration
    // (missing/expired credential, or -- as here -- a completely broken
    // install): a path that doesn't exist. This is exactly the spawn-time
    // ENOENT path zcodeClient.js's 'error' handler (this task's fix) now
    // catches instead of leaving unhandled.
    ZCODE_NODE_BIN: '/nonexistent/node-binary-does-not-exist',
    ZCODE_BIN: '/nonexistent/zcode.js-does-not-exist',
    ZCODE_WORKSPACE_DIR: TMP,
    MCP_HTTP_PORT: '0',
    STORE_PATH: path.join(TMP, 's3-store.json'),
  }, 's3');
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot');
    const m = await waitFor(() => b.log.match(/mcp gateway listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/), 15000, 'mcp gateway boot');
    const mcpPort = Number(m[1]);

    // Ask for the BROKEN backend over MCP -- this is the moment zcode is
    // lazily constructed and started for the first time in this process.
    const mcpCall = async (body) => {
      const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: res.status === 204 ? null : JSON.parse(await res.text()) };
    };

    const ticksBefore = cpuTicksOf(b.proc.pid);
    const t0 = Date.now();
    const r = await Promise.race([
      mcpCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_create', arguments: { name: 'broken-zcode', backend: 'zcode' } } }),
      sleep(20000).then(() => ({ timedOut: true })),
    ]);
    const elapsedMs = Date.now() - t0;

    check('session_create for the broken backend returns (does not hang for 20s+)', !r.timedOut, JSON.stringify(r));
    check('...and returns QUICKLY -- a bounded failure, not a long timeout-driven one', elapsedMs < 10000, `${elapsedMs}ms`);
    if (!r.timedOut) {
      const isErr = r.body?.result?.isError === true || r.body?.error;
      check('the failure is reported as a clear error, not a silent/ambiguous success', !!isErr, JSON.stringify(r.body).slice(0, 400));
    }

    // Repeat the SAME request a few more times (a caller retrying against a
    // permanently-broken backend, or several topics all trying it) -- this
    // is exactly the scenario the "fail future calls fast, not just
    // already-pending ones" fix (see zcodeClient.js's _deadError) targets:
    // without it, only the FIRST call after the spawn failure was fast, and
    // every call after that quietly waited out DEFAULT_TIMEOUT_MS (120s).
    for (let i = 0; i < 3; i++) {
      const t1 = Date.now();
      const r2 = await Promise.race([
        mcpCall({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'session_create', arguments: { name: `broken-zcode-${i}`, backend: 'zcode' } } }),
        sleep(20000).then(() => ({ timedOut: true })),
      ]);
      check(`repeat attempt #${i + 1} against the same broken backend also fails fast (not just the first one)`, !r2.timedOut && Date.now() - t1 < 10000, `${Date.now() - t1}ms, ${JSON.stringify(r2)}`);
    }

    // Now check CPU consumption across a quiet window -- a genuine busy-spin
    // would show up as steadily climbing ticks even with nothing new asked
    // of it; a clean bounded failure should be flat.
    await sleep(2000);
    const ticksAfter = cpuTicksOf(b.proc.pid);
    const totalTicksUsed = ticksBefore != null && ticksAfter != null ? ticksAfter - ticksBefore : null;
    // 100 ticks/sec is the common USER_HZ; a healthy bridge doing this little
    // work over several seconds (four session_create attempts plus ~2s idle)
    // should use a small fraction of one second of CPU time, generously
    // bounded here at under 2 CPU-seconds total.
    check('the bridge process did not busy-spin CPU while/after the broken backend failed', totalTicksUsed != null && totalTicksUsed < 200, `ticks used=${totalTicksUsed} (before=${ticksBefore}, after=${ticksAfter})`);
    check('the bridge process itself is still alive throughout (zcode is NOT the default here)', b.proc.exitCode === null, `exitCode=${b.proc.exitCode}\n${b.log.slice(-1500)}`);
  } finally {
    b.proc.kill('SIGKILL');
    srv.close();
  }
}

try {
  await scenario1();
  await scenario2();
  await scenario3();
} catch (e) {
  check('scenario completed without harness error', false, e.stack || e.message);
} finally {
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  process.exit(failures === 0 ? 0 : 1);
}
