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
//  4. A mock-default bridge BOOTS: module scope must not touch any backend
//     but the eager default (the index.js:546 boot-crash regression), the
//     MCP unix socket binds, and tools/list answers over it.
//  5. A LAZILY-constructed zcode instance answers
//     session/requestRuntimePreferences -- the handler is registered at
//     zcode-instance construction (factory), not once at module scope.
//  6. EAGER_BACKENDS opts named backends into boot-time construction; an
//     unknown name refuses to boot loudly.
//  7. CODEX_MCP_MODELS narrows the MCP codex model allowlist from env;
//     unset keeps today's three tiers.
//
// Drive: node test/e2e-backend-lifecycle.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
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

// tools/list (etc.) over the production transport: a per-fleet unix socket
// speaking line-delimited JSON-RPC -- the same wire shape mcp-unix.test.js
// asserts in-process, driven here against the REAL booted bridge.
function unixJsonRpc(sock, requests) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock, () => {
      for (const r of requests) c.write(JSON.stringify(r) + '\n');
    });
    let buf = '';
    const lines = [];
    c.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        if (lines.length === requests.length) {
          c.end();
          resolve(lines);
          return;
        }
      }
    });
    c.on('error', reject);
  });
}

// A tools/call helper over the bridge's own ephemeral HTTP MCP listener
// (MCP_HTTP_PORT=0), parsed out of the bridge log the way scenario 3 does.
function httpMcpCaller(log) {
  const m = log.match(/mcp gateway listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
  if (!m) throw new Error('no mcp http listener in the log yet');
  const port = Number(m[1]);
  return async (id, name, args) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    });
    return JSON.parse(await res.text());
  };
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

// --- scenario 4: a mock-default bridge BOOTS (the :546 boot-crash regression),
// binds its MCP unix socket, and answers tools/list over it ---
async function scenario4() {
  console.log('\n--- scenario 4: DEFAULT_BACKEND=mock boots clean; the MCP unix socket binds and answers tools/list ---');
  const { srv, port } = await startFakeTelegram();
  const zcodeMarker = path.join(TMP, 's4-zcode-started.json');
  const sock = path.join(TMP, 's4-state', 'mock-tg', 'mcp.sock');
  const b = startBridge(
    {
      TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ALLOWED_USER_ID: '1',
      DEFAULT_BACKEND: 'mock',
      ZCODE_NODE_BIN: NODE,
      ZCODE_BIN: ZCODE_FIXTURE,
      ZCODE_WORKSPACE_DIR: TMP,
      FIXTURE_ZCODE_MARKER: zcodeMarker, // must NEVER be written: mock-default must not spawn zcode (the bug-#3 property)
      STORE_PATH: path.join(TMP, 's4-store.json'),
      MCP_UNIX_SOCKET: sock,
    },
    's4',
  );
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot');
    // On the pre-fix code this process is ALREADY DEAD here: module scope
    // dereferenced backends.zcode (index.js:546) no matter what
    // DEFAULT_BACKEND said, so a mock-default bridge died with
    // "TypeError: Cannot read properties of undefined (reading
    // 'onServerRequest')" before binding anything.
    check('the bridge process is still alive with DEFAULT_BACKEND=mock', b.proc.exitCode === null, `exitCode=${b.proc.exitCode}\n${b.log.slice(-2000)}`);
    await waitFor(() => b.log.includes(`mcp gateway listening on unix:${sock}`), 15000, 'mcp unix socket bind');
    check('the MCP unix socket file exists', existsSync(sock), b.log.slice(-2000));
    const lines = await unixJsonRpc(sock, [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
    check('tools/list over the unix socket advertises seven tools', lines[0]?.result?.tools?.length === 7, JSON.stringify(lines[0]).slice(0, 300));
    check('zcode was NEVER spawned for a mock-default bridge (no start-marker)', !existsSync(zcodeMarker), b.log.slice(-2000));
  } finally {
    b.proc.kill('SIGKILL');
    srv.close();
  }
}

// --- scenario 5: a LAZILY-constructed zcode instance answers
// session/requestRuntimePreferences -- the handler must be registered for
// every zcode instance at construction (factory), not once at module scope
// for whichever instance happened to exist at boot. Observable: the zcode
// fixture sends that exact server-initiated request and records the bridge's
// reply; a registered handler yields a result (honoring
// NATIVE_SEARCH_ENHANCEMENTS), an unregistered one the blanket -32601. ---
async function scenario5() {
  console.log('\n--- scenario 5: lazy zcode (via MCP session_create) gets the runtime-preferences handler ---');
  const { srv, port } = await startFakeTelegram();
  const zcodeMarker = path.join(TMP, 's5-zcode-started.json');
  const rpReply = path.join(TMP, 's5-rp-reply.json');
  const b = startBridge(
    {
      TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ALLOWED_USER_ID: '1',
      DEFAULT_BACKEND: 'mock', // zcode is NOT the default here; nothing constructs it until asked
      ZCODE_NODE_BIN: NODE,
      ZCODE_BIN: ZCODE_FIXTURE,
      ZCODE_WORKSPACE_DIR: TMP,
      FIXTURE_ZCODE_MARKER: zcodeMarker,
      FIXTURE_ZCODE_RP_REPLY: rpReply,
      NATIVE_SEARCH_ENHANCEMENTS: 'false', // the handler must ECHO this, proving it is the real handler
      MCP_HTTP_PORT: '0',
      STORE_PATH: path.join(TMP, 's5-store.json'),
    },
    's5',
  );
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot');
    check('the bridge boots alive with DEFAULT_BACKEND=mock', b.proc.exitCode === null, `exitCode=${b.proc.exitCode}\n${b.log.slice(-2000)}`);
    const call = await waitFor(() => {
      try {
        return httpMcpCaller(b.log);
      } catch {
        return null;
      }
    }, 15000, 'mcp http listener');
    const created = await call(1, 'session_create', { name: 'lazy-zcode', backend: 'zcode', chat_id: -100111 });
    const createdOk = created?.result?.isError === false;
    check('session_create on the lazy zcode backend completes (fixture answered the createConversation chain)', createdOk, JSON.stringify(created).slice(0, 400));
    check('zcode was spawned lazily, by that request (start-marker written)', existsSync(zcodeMarker), b.log.slice(-2000));
    await waitFor(() => existsSync(rpReply), 10000, 'runtime-preferences reply');
    const reply = JSON.parse(readFileSync(rpReply, 'utf8'));
    check(
      'the lazy zcode instance ANSWERED session/requestRuntimePreferences (a result honoring NATIVE_SEARCH_ENHANCEMENTS=false, not the -32601 default)',
      reply?.result?.nativeSearchEnhancementsEnabled === false,
      JSON.stringify(reply).slice(0, 300),
    );
  } finally {
    b.proc.kill('SIGKILL');
    srv.close();
  }
}

// --- scenario 6: EAGER_BACKENDS opts additional backends into boot-time
// construction; unknown names fail the boot loudly; the default (when
// EAGER_BACKENDS is unset) remains the only eager backend (scenarios 1 and 4
// already pin that negative) ---
async function scenario6() {
  console.log('\n--- scenario 6: EAGER_BACKENDS=codex,zcode constructs both at boot; unknown names refuse to boot ---');
  const { srv, port } = await startFakeTelegram();
  const zcodeMarker = path.join(TMP, 's6-zcode-started.json');
  const codexMarker = path.join(TMP, 's6-codex-started.json');
  const rpReply = path.join(TMP, 's6-rp-reply.json');
  const b = startBridge(
    {
      TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ALLOWED_USER_ID: '1',
      DEFAULT_BACKEND: 'codex',
      EAGER_BACKENDS: 'codex,zcode', // the opt-in under test: zcode must now spawn at boot
      ZCODE_NODE_BIN: NODE,
      ZCODE_BIN: ZCODE_FIXTURE,
      ZCODE_WORKSPACE_DIR: TMP,
      CODEX_HOME: TMP,
      CODEX_BIN: CODEX_FIXTURE,
      FIXTURE_ZCODE_MARKER: zcodeMarker,
      FIXTURE_ZCODE_RP_REPLY: rpReply,
      FIXTURE_CODEX_MARKER: codexMarker,
      STORE_PATH: path.join(TMP, 's6-store.json'),
    },
    's6a',
  );
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot');
    await sleep(2000);
    check('the bridge is alive with both backends eagerly started', b.proc.exitCode === null, `exitCode=${b.proc.exitCode}\n${b.log.slice(-2000)}`);
    check('codex (the default) was eagerly started', existsSync(codexMarker), b.log.slice(-2000));
    check('zcode was ALSO eagerly started via EAGER_BACKENDS', existsSync(zcodeMarker), b.log.slice(-2000));
    await waitFor(() => existsSync(rpReply), 10000, 'runtime-preferences reply for the eager zcode');
    const reply = JSON.parse(readFileSync(rpReply, 'utf8'));
    check('the eager zcode instance also got the runtime-preferences handler (real result, not -32601)', reply?.result?.nativeSearchEnhancementsEnabled !== undefined, JSON.stringify(reply).slice(0, 300));
  } finally {
    b.proc.kill('SIGKILL');
    srv.close();
  }

  // Unknown names must fail the boot LOUDLY, like an unknown DEFAULT_BACKEND.
  const b2 = startBridge(
    {
      TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ALLOWED_USER_ID: '1',
      DEFAULT_BACKEND: 'mock',
      EAGER_BACKENDS: 'mock,nonsense',
      ZCODE_NODE_BIN: NODE,
      ZCODE_BIN: ZCODE_FIXTURE,
      ZCODE_WORKSPACE_DIR: TMP,
      STORE_PATH: path.join(TMP, 's6b-store.json'),
    },
    's6b',
  );
  try {
    const exitInfo = await waitFor(() => (b2.proc.exitCode !== null ? { code: b2.proc.exitCode } : null), 15000, 'bridge exit on unknown EAGER_BACKENDS entry');
    check('an unknown EAGER_BACKENDS name refuses to boot (nonzero exit)', exitInfo.code === 1, `exitCode=${exitInfo.code}\n${b2.log.slice(-2000)}`);
    check('the boot failure NAMES the bad entry and the knob', /unknown backend in EAGER_BACKENDS: nonsense/.test(b2.log), b2.log.slice(-2000));
  } finally {
    b2.proc.kill('SIGKILL');
    srv.close();
  }
}

// --- scenario 7: CODEX_MCP_MODELS narrows the MCP model allowlist from env;
// unset keeps today's three. Run A pins the configured list (refusing Luna
// with a message naming exactly what IS allowed); Run B pins the default. ---
async function scenario7() {
  console.log('\n--- scenario 7: CODEX_MCP_MODELS=gpt-5.6-terra pins the MCP allowlist to Terra alone; unset = today\'s three ---');
  const bridgeEnv = (extra, tgPort) => ({
    TELEGRAM_API_ROOT: `http://127.0.0.1:${tgPort}`,
    TELEGRAM_BOT_TOKEN: 'fake',
    TELEGRAM_CHAT_ID: '-100111',
    TELEGRAM_ALLOWED_USER_ID: '1',
    DEFAULT_BACKEND: 'codex',
    ZCODE_NODE_BIN: NODE,
    ZCODE_BIN: ZCODE_FIXTURE,
    ZCODE_WORKSPACE_DIR: TMP,
    CODEX_HOME: TMP,
    CODEX_BIN: CODEX_FIXTURE,
    MCP_HTTP_PORT: '0',
    ...extra,
  });

  const { srv, port } = await startFakeTelegram();
  let b = startBridge(bridgeEnv({ CODEX_MCP_MODELS: 'gpt-5.6-terra', STORE_PATH: path.join(TMP, 's7a-store.json') }, port), 's7a');
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot (run A)');
    const call = await waitFor(() => {
      try {
        return httpMcpCaller(b.log);
      } catch {
        return null;
      }
    }, 15000, 'mcp http listener (run A)');
    const created = await call(1, 'session_create', { name: 'codex-terra-only', backend: 'codex', chat_id: -100111 });
    const createdOk = created?.result?.isError === false;
    check('session_create on the codex backend completes (fixture answered initialize + thread/start)', createdOk, JSON.stringify(created).slice(0, 400));
    const key = createdOk ? JSON.parse(created.result.content[0].text).key : null;
    const refused = key ? await call(2, 'model_set', { key, model: 'gpt-5.6-luna' }) : null;
    check(
      'model_set to gpt-5.6-luna is REFUSED, with the error naming the configured allowed set (Terra alone)',
      refused?.result?.isError === true && /choose one of gpt-5\.6-terra$/.test(refused.result.content?.[0]?.text || ''),
      JSON.stringify(refused).slice(0, 400),
    );
    const accepted = key ? await call(3, 'model_set', { key, model: 'gpt-5.6-terra' }) : null;
    check(
      'model_set to the configured model itself is accepted',
      accepted?.result?.isError === false && JSON.parse(accepted.result.content[0].text).model === 'gpt-5.6-terra',
      JSON.stringify(accepted).slice(0, 400),
    );
  } finally {
    b.proc.kill('SIGKILL');
    srv.close();
  }

  const { srv: srv2, port: port2 } = await startFakeTelegram();
  b = startBridge(bridgeEnv({ STORE_PATH: path.join(TMP, 's7b-store.json') }, port2), 's7b');
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot (run B)');
    const call = await waitFor(() => {
      try {
        return httpMcpCaller(b.log);
      } catch {
        return null;
      }
    }, 15000, 'mcp http listener (run B)');
    const created = await call(1, 'session_create', { name: 'codex-default-list', backend: 'codex', chat_id: -100111 });
    const key = created?.result?.isError === false ? JSON.parse(created.result.content[0].text).key : null;
    const switched = key ? await call(2, 'model_set', { key, model: 'gpt-5.6-luna' }) : null;
    check(
      'with CODEX_MCP_MODELS unset, luna is still accepted -- today\'s three-tier default is unchanged',
      switched?.result?.isError === false && JSON.parse(switched.result.content[0].text).model === 'gpt-5.6-luna',
      JSON.stringify(switched).slice(0, 400),
    );
  } finally {
    b.proc.kill('SIGKILL');
    srv2.close();
  }
}

try {
  // EACH SCENARIO REPORTS ITS OWN FAILURE, so one scenario's throw (which is
  // how a bridge that dies at boot usually surfaces -- a waitFor timeout)
  // doesn't silently skip the scenarios after it: on the :546 boot-crash
  // this file exists to catch, EVERY non-zcode-default scenario is red, and
  // the run must say so rather than stop at the first.
  for (const s of [scenario1, scenario2, scenario3, scenario4, scenario5, scenario6, scenario7]) {
    try {
      await s();
    } catch (e) {
      check(`scenario ${s.name} completed without harness error`, false, e.stack || e.message);
    }
  }
} finally {
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  process.exit(failures === 0 ? 0 : 1);
}
