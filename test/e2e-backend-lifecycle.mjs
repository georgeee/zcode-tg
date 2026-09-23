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
//  8. Cross-backend /model in Telegram (D3): the listing spans every
//     backend (constructed lazily), a ref from another backend switches the
//     topic to a FRESH session on that backend with the picked model
//     (asserted on the fixtures' recorded requests), and an unconfigured
//     backend degrades to a note.
//  9. tools/list advertises the CONFIGURED model list in the
//     model/model_set schemas, not a static enum.
// 10. The /model span (MODEL_BACKENDS): mock excluded by default on a real
//     bridge (never listed, constructed, or resolved to), mock-default
//     bridges see themselves, a named list is honored wholesale, unknown
//     names refuse to boot.
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
// `updates` pre-queues Telegram updates the fake serves on the FIRST
// getUpdates poll; the returned pushUpdate() queues more mid-run, served on
// the next poll (the bridge long-polls with a 1s idle answer, so a pushed
// update is picked up within ~1s). This is how the Telegram-command paths
// (e.g. /model) are driven end to end.
function startFakeTelegram(updates = []) {
  const calls = { send: [], edit: [], topicCreated: [] };
  const pending = [...updates];
  let nextMsgId = 100, nextThreadId = 900;
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const method = req.url.split('/').pop();
    const ok = (result = {}) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
    if (method === 'getUpdates') {
      if (pending.length) {
        const batch = pending.splice(0, pending.length);
        return ok(batch);
      }
      const t = setTimeout(() => ok([]), 1000);
      t.unref?.();
      return;
    }
    if (method === 'sendMessage') { const p = JSON.parse(body); calls.send.push(p); return ok({ message_id: nextMsgId++ }); }
    if (method === 'editMessageText') { const p = JSON.parse(body); calls.edit.push(p); return ok({ message_id: p.message_id }); }
    if (method === 'createForumTopic') { const p = JSON.parse(body); calls.topicCreated.push(p); return ok({ message_thread_id: nextThreadId++, chat_id: p.chat_id, name: p.name }); }
    return ok();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, calls, pushUpdate: (u) => pending.push(u) })));
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

// A Telegram message update as the real API would deliver one, for
// pushUpdate()-ing into the fake Telegram: from the allowed user, in the
// test chat, in a given topic.
let tgUpdateId = 0;
const tgMessage = (threadId, text) => ({
  update_id: ++tgUpdateId,
  message: {
    message_id: 5000 + tgUpdateId,
    from: { id: 1, is_bot: false },
    chat: { id: -100111 },
    message_thread_id: threadId,
    date: Math.floor(Date.now() / 1000),
    text,
  },
});

// Read a fixture's JSONL request log ({at, method, params} lines).
function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
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
    // The ADVERTISED SET, BY NAME -- not a count (a count went stale when
    // session_close joined and nobody could tell what drifted). A tool added
    // or removed fails here naming the difference.
    const ADVERTISED_TOOLS = ['session_create', 'session_close', 'message_send', 'replies_get', 'progress_get', 'model_get', 'usage_get', 'model_set'];
    const advertised = (lines[0]?.result?.tools ?? []).map((t) => t.name).sort();
    const missing = ADVERTISED_TOOLS.filter((n) => !advertised.includes(n));
    const unexpected = advertised.filter((n) => !ADVERTISED_TOOLS.includes(n));
    check(
      `tools/list over the unix socket advertises exactly the agreed tool set by name`,
      missing.length === 0 && unexpected.length === 0,
      `missing: [${missing}] unexpected: [${unexpected}] -- advertised: [${advertised.join(', ')}]`,
    );
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
// --- scenario 8: cross-backend /model in Telegram (D3). A codex-default
// topic lists BOTH backends (zcode constructed lazily by the command),
// picking a zai/* ref moves the topic to a fresh zcode session opened with
// that model, symmetrically codex-ward, and an unconfigured backend degrades
// to a one-line note. Model assertions are on the FIXTURES' RECORDED
// requests, not on reply text. ---
async function scenario8() {
  console.log('\n--- scenario 8: cross-backend /model — list both backends, switch both ways, degrade cleanly ---');
  const { srv, port, calls, pushUpdate } = await startFakeTelegram();
  const zcodeMarker = path.join(TMP, 's8-zcode-started.json');
  const zcodeLog = path.join(TMP, 's8-zcode-log.jsonl');
  const codexLog = path.join(TMP, 's8-codex-log.jsonl');
  const storePath = path.join(TMP, 's8-store.json');
  const b = startBridge(
    {
      TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ALLOWED_USER_ID: '1',
      DEFAULT_BACKEND: 'codex',
      ZCODE_NODE_BIN: NODE,
      ZCODE_BIN: ZCODE_FIXTURE,
      ZCODE_WORKSPACE_DIR: TMP,
      CODEX_HOME: TMP,
      CODEX_BIN: CODEX_FIXTURE,
      FIXTURE_ZCODE_MARKER: zcodeMarker,
      FIXTURE_ZCODE_LOG: zcodeLog,
      FIXTURE_CODEX_LOG: codexLog,
      STORE_PATH: storePath,
      MCP_HTTP_PORT: '0',
    },
    's8',
  );
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot');
    const call = await waitFor(() => {
      try {
        return httpMcpCaller(b.log);
      } catch {
        return null;
      }
    }, 15000, 'mcp http listener');

    // (a) the listing: a codex-default topic's /model shows both backends
    const created = await call(1, 'session_create', { name: 'tg-cross', backend: 'codex', chat_id: -100111 });
    const threadA = JSON.parse(created.result.content[0].text).thread_id;
    pushUpdate(tgMessage(threadA, '/model'));
    const listing = await waitFor(
      () => calls.send.find((m) => m.message_thread_id === threadA && /Models across backends/.test(m.text || '')),
      20000,
      '(a) the /model listing reply',
    );
    check('(a) the listing shows the codex fixture models AND the zcode fixture zai/* models', /gpt-5\.6-terra/.test(listing.text) && /zai\/glm-5\.3-flash/.test(listing.text), listing.text);
    check('(a) the listing marks the topic\u2019s current backend+model (codex · terra, \u25b6)', /current: codex · gpt-5\.6-terra/.test(listing.text) && /▶ gpt-5\.6-terra/.test(listing.text), listing.text);
    check('(a) nothing was unavailable', !/unavailable/.test(listing.text), listing.text);
    check('(a) zcode was constructed lazily by that command (start-marker now exists)', existsSync(zcodeMarker), b.log.slice(-2000));

    // (b) picking a zai/* ref from the codex topic: fresh zcode session
    pushUpdate(tgMessage(threadA, '/model zai/glm-5.3-flash'));
    const switchReplyB = await waitFor(() => calls.send.find((m) => m.message_thread_id === threadA && /fresh session/.test(m.text || '')), 20000, '(b) the fresh-session switch reply');
    check('(b) the reply says a new session began because backends do not share history', /fresh session starts on your next message/.test(switchReplyB.text) && /don't share/.test(switchReplyB.text), switchReplyB.text);
    // The next turn: wait for ANY further send to this topic (the turn's
    // placeholder), then judge the fixture records -- so the assertions
    // below are clean ❌ lines when the model went to the WRONG backend,
    // not harness timeouts.
    const sendsBeforeTurn = calls.send.length;
    pushUpdate(tgMessage(threadA, 'hello over there'));
    await waitFor(() => calls.send.length > sendsBeforeTurn, 20000, '(b) the next turn to start');
    const zreqs = readJsonl(zcodeLog);
    check('(b) the fresh zcode session was created (fixture-recorded session/create)', zreqs.some((r) => r.method === 'session/create'), JSON.stringify(zreqs.map((r) => r.method)));
    check(
      '(b) that session was created WITH the picked model (fixture-recorded setModel {providerId:zai, modelId:glm-5.3-flash})',
      zreqs.some((r) => r.method === 'session/setModel' && r.params?.model?.providerId === 'zai' && r.params?.model?.modelId === 'glm-5.3-flash'),
      JSON.stringify(zreqs),
    );
    const storeDoc = JSON.parse(readFileSync(storePath, 'utf8'));
    const topicA = Object.values(storeDoc.topics ?? {}).find((t) => t.threadId === threadA);
    check('(b) the topic now stores backend=zcode and the picked model', topicA?.backend === 'zcode' && topicA?.model === 'zai/glm-5.3-flash', JSON.stringify(topicA));

    // (c) symmetric: a zcode-default topic picks a codex ref. LUNA, not
    // terra -- terra is the codex DEFAULT (cfg.codexDefaultModel), so a
    // thread/start carrying luna can only come from a session actually
    // opened by this switch; a terra assertion would pass off the default
    // alone.
    const created2 = await call(4, 'session_create', { name: 'tg-zcode-side', backend: 'zcode', chat_id: -100111 });
    const threadB = JSON.parse(created2.result.content[0].text).thread_id;
    pushUpdate(tgMessage(threadB, '/model gpt-5.6-luna'));
    const switchReplyC = await waitFor(() => calls.send.find((m) => m.message_thread_id === threadB && /fresh session/.test(m.text || '')), 20000, '(c) the fresh-session switch reply');
    check('(c) the zcode topic\u2019s switch to a codex model announces the fresh session', /runs gpt-5\.6-luna on 'codex'/.test(switchReplyC.text), switchReplyC.text);
    const sendsBeforeTurnC = calls.send.length;
    pushUpdate(tgMessage(threadB, 'hello again'));
    await waitFor(() => calls.send.length > sendsBeforeTurnC, 20000, '(c) the next turn to start');
    const creqs = readJsonl(codexLog);
    check(
      '(c) the new codex session opened WITH the picked model (fixture-recorded thread/start params.model=gpt-5.6-luna)',
      creqs.some((r) => r.method === 'thread/start' && r.params?.model === 'gpt-5.6-luna'),
      JSON.stringify(creqs.map((r) => ({ method: r.method, model: r.params?.model }))),
    );
    const storeDocC = JSON.parse(readFileSync(storePath, 'utf8'));
    const topicB = Object.values(storeDocC.topics ?? {}).find((t) => t.threadId === threadB);
    check('(c) the topic now stores backend=codex and the picked model', topicB?.backend === 'codex' && topicB?.model === 'gpt-5.6-luna', JSON.stringify(topicB));
  } finally {
    b.proc.kill('SIGKILL');
    srv.close();
  }

  // (d) an unconfigured backend degrades to a note; the rest still lists
  const { srv: srvD, port: portD, calls: callsD, pushUpdate: pushUpdateD } = await startFakeTelegram();
  const b2 = startBridge(
    {
      TELEGRAM_API_ROOT: `http://127.0.0.1:${portD}`,
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ALLOWED_USER_ID: '1',
      DEFAULT_BACKEND: 'zcode',
      CODEX_HOME: '', // UNCONFIGURED -- the factory must refuse it without killing the bridge
      ZCODE_NODE_BIN: NODE,
      ZCODE_BIN: ZCODE_FIXTURE,
      ZCODE_WORKSPACE_DIR: TMP,
      FIXTURE_ZCODE_MARKER: path.join(TMP, 's8d-zcode-started.json'),
      STORE_PATH: path.join(TMP, 's8d-store.json'),
      MCP_HTTP_PORT: '0',
    },
    's8d',
  );
  try {
    await waitFor(() => b2.log.includes('starting.'), 15000, 'bridge boot (d)');
    pushUpdateD(tgMessage(950, '/model'));
    const listingD = await waitFor(
      () => callsD.send.find((m) => /Models across backends/.test(m.text || '')),
      20000,
      '(d) the /model listing reply with codex unconfigured',
    );
    check('(d) the unconfigured backend is a one-line note naming why', /codex: unavailable/.test(listingD.text) && /CODEX_HOME/.test(listingD.text), listingD.text);
    check('(d) the zcode list still shows', /zai\/glm-5\.3-flash/.test(listingD.text), listingD.text);
    check('(d) the bridge is still alive after the refused construction', b2.proc.exitCode === null, `exitCode=${b2.proc.exitCode}\n${b2.log.slice(-2000)}`);
  } finally {
    b2.proc.kill('SIGKILL');
    srvD.close();
  }
}

// --- scenario 9: tools/list is honest about the configured model list --
// the model/model_set inputSchema enums must be derived from the bridge's
// CODEX_MCP_MODELS, not a static three (a tool schema is an output too). ---
async function scenario9() {
  console.log('\n--- scenario 9: tools/list advertises exactly the configured CODEX_MCP_MODELS enum ---');
  const sock = path.join(TMP, 's9-state', 'mock-tg', 'mcp.sock');
  const b = startBridge(
    {
      TELEGRAM_API_ROOT: 'http://127.0.0.1:1', // never reached; no Telegram call precedes tools/list
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ALLOWED_USER_ID: '1',
      DEFAULT_BACKEND: 'mock',
      ZCODE_NODE_BIN: NODE,
      ZCODE_BIN: ZCODE_FIXTURE,
      ZCODE_WORKSPACE_DIR: TMP,
      STORE_PATH: path.join(TMP, 's9-store.json'),
      MCP_UNIX_SOCKET: sock,
      CODEX_MCP_MODELS: 'gpt-5.6-terra',
    },
    's9',
  );
  try {
    await waitFor(() => b.log.includes(`mcp gateway listening on unix:${sock}`), 15000, 'mcp unix socket bind');
    const lines = await unixJsonRpc(sock, [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
    const tools = lines[0]?.result?.tools ?? [];
    const sc = tools.find((t) => t.name === 'session_create');
    const ms = tools.find((t) => t.name === 'model_set');
    check(
      'tools/list: session_create\u2019s model enum is exactly the configured list',
      JSON.stringify(sc?.inputSchema?.properties?.model?.enum) === JSON.stringify(['gpt-5.6-terra']),
      JSON.stringify(sc?.inputSchema?.properties?.model),
    );
    check(
      'tools/list: model_set\u2019s model enum is exactly the configured list',
      JSON.stringify(ms?.inputSchema?.properties?.model?.enum) === JSON.stringify(['gpt-5.6-terra']),
      JSON.stringify(ms?.inputSchema?.properties?.model),
    );
  } finally {
    b.proc.kill('SIGKILL');
  }

  // And with the knob unset, the schemas still carry today's three tiers.
  const sockB = path.join(TMP, 's9b-state', 'mock-tg', 'mcp.sock');
  const b2 = startBridge(
    {
      TELEGRAM_API_ROOT: 'http://127.0.0.1:1',
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ALLOWED_USER_ID: '1',
      DEFAULT_BACKEND: 'mock',
      ZCODE_NODE_BIN: NODE,
      ZCODE_BIN: ZCODE_FIXTURE,
      ZCODE_WORKSPACE_DIR: TMP,
      STORE_PATH: path.join(TMP, 's9b-store.json'),
      MCP_UNIX_SOCKET: sockB,
    },
    's9b',
  );
  try {
    await waitFor(() => b2.log.includes(`mcp gateway listening on unix:${sockB}`), 15000, 'mcp unix socket bind (default run)');
    const lines = await unixJsonRpc(sockB, [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
    const ms = (lines[0]?.result?.tools ?? []).find((t) => t.name === 'model_set');
    check(
      'with CODEX_MCP_MODELS unset the enum is today\u2019s three tiers',
      JSON.stringify(ms?.inputSchema?.properties?.model?.enum) === JSON.stringify(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']),
      JSON.stringify(ms?.inputSchema?.properties?.model),
    );
  } finally {
    b2.proc.kill('SIGKILL');
  }
}

// --- scenario 10: the /model span (MODEL_BACKENDS). A real bridge must not
// list, construct, or resolve to mock; a mock-default bridge sees itself; a
// named list is honored wholesale; unknown names refuse to boot. ---
async function scenario10() {
  console.log('\n--- scenario 10: MODEL_BACKENDS — mock excluded by default, named lists honored, unknown names refuse ---');

  // (i) codex-default, MODEL_BACKENDS unset: no mock in the listing, mock
  // never constructed, zcode still there
  {
    const { srv, port, calls, pushUpdate } = await startFakeTelegram();
    const zcodeMarker = path.join(TMP, 's10a-zcode-started.json');
    const b = startBridge(
      {
        TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
        TELEGRAM_BOT_TOKEN: 'fake',
        TELEGRAM_CHAT_ID: '-100111',
        TELEGRAM_ALLOWED_USER_ID: '1',
        DEFAULT_BACKEND: 'codex',
        ZCODE_NODE_BIN: NODE,
        ZCODE_BIN: ZCODE_FIXTURE,
        ZCODE_WORKSPACE_DIR: TMP,
        CODEX_HOME: TMP,
        CODEX_BIN: CODEX_FIXTURE,
        FIXTURE_ZCODE_MARKER: zcodeMarker,
        STORE_PATH: path.join(TMP, 's10a-store.json'),
        MCP_HTTP_PORT: '0',
      },
      's10a',
    );
    try {
      await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot (i)');
      const call = await waitFor(() => {
        try {
          return httpMcpCaller(b.log);
        } catch {
          return null;
        }
      }, 15000, 'mcp http listener (i)');
      const created = await call(1, 'session_create', { name: 'span-check', backend: 'codex', chat_id: -100111 });
      const thread = JSON.parse(created.result.content[0].text).thread_id;
      pushUpdate(tgMessage(thread, '/model'));
      const listing = await waitFor(() => calls.send.find((m) => /Models across backends/.test(m.text || '')), 20000, '(i) the /model listing');
      check('(i) the listing has NO mock entries (no mock-1, no mock: group)', !/mock/i.test(listing.text), listing.text);
      check('(i) mock is not reported as unavailable either — it is simply not in the span', !/unavailable/.test(listing.text), listing.text);
      check('(i) the zcode models are still listed', /zai\/glm-5\.3-flash/.test(listing.text), listing.text);
      check('(i) zcode was still constructed lazily by that command', existsSync(zcodeMarker), b.log.slice(-2000));
    } finally {
      b.proc.kill('SIGKILL');
      srv.close();
    }
  }

  // (ii) mock-default: the bridge is a test bridge and sees itself
  {
    const { srv, port, calls, pushUpdate } = await startFakeTelegram();
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
        STORE_PATH: path.join(TMP, 's10b-store.json'),
        MCP_HTTP_PORT: '0',
      },
      's10b',
    );
    try {
      await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot (ii)');
      pushUpdate(tgMessage(920, '/model'));
      const listing = await waitFor(() => calls.send.find((m) => /Models across backends/.test(m.text || '')), 20000, '(ii) the /model listing');
      check('(ii) a mock-default bridge lists mock', /mock-1/.test(listing.text) && /mock:/.test(listing.text), listing.text);
    } finally {
      b.proc.kill('SIGKILL');
      srv.close();
    }
  }

  // (iv) an unknown MODEL_BACKENDS name refuses to boot, naming entry+knob
  // (runs before (iii) so a (iii) timeout can't skip it)
  {
    const { srv, port } = await startFakeTelegram();
    const b = startBridge(
      {
        TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
        TELEGRAM_BOT_TOKEN: 'fake',
        TELEGRAM_CHAT_ID: '-100111',
        TELEGRAM_ALLOWED_USER_ID: '1',
        DEFAULT_BACKEND: 'mock',
        MODEL_BACKENDS: 'mock,nonsense',
        ZCODE_NODE_BIN: NODE,
        ZCODE_BIN: ZCODE_FIXTURE,
        ZCODE_WORKSPACE_DIR: TMP,
        STORE_PATH: path.join(TMP, 's10d-store.json'),
        MCP_HTTP_PORT: '0',
      },
      's10d',
    );
    try {
      const exitInfo = await waitFor(() => (b.proc.exitCode !== null ? { code: b.proc.exitCode } : null), 15000, 'bridge exit on unknown MODEL_BACKENDS entry');
      check('(iv) an unknown MODEL_BACKENDS name refuses to boot (nonzero exit)', exitInfo.code === 1, `exitCode=${exitInfo.code}\n${b.log.slice(-2000)}`);
      check('(iv) the boot failure NAMES the bad entry and the knob', /unknown backend in MODEL_BACKENDS: nonsense/.test(b.log), b.log.slice(-2000));
    } finally {
      b.proc.kill('SIGKILL');
      srv.close();
    }
  }

  // (iii) MODEL_BACKENDS=codex alone: only codex lists; a zai/* ref and a
  // mock: qualified ref are both refused as unknown -- never constructed
  {
    const { srv, port, calls, pushUpdate } = await startFakeTelegram();
    const zcodeMarker = path.join(TMP, 's10c-zcode-started.json');
    const b = startBridge(
      {
        TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
        TELEGRAM_BOT_TOKEN: 'fake',
        TELEGRAM_CHAT_ID: '-100111',
        TELEGRAM_ALLOWED_USER_ID: '1',
        DEFAULT_BACKEND: 'codex',
        MODEL_BACKENDS: 'codex',
        ZCODE_NODE_BIN: NODE,
        ZCODE_BIN: ZCODE_FIXTURE,
        ZCODE_WORKSPACE_DIR: TMP,
        CODEX_HOME: TMP,
        CODEX_BIN: CODEX_FIXTURE,
        FIXTURE_ZCODE_MARKER: zcodeMarker, // must stay unwritten: zcode is outside the span
        STORE_PATH: path.join(TMP, 's10c-store.json'),
        MCP_HTTP_PORT: '0',
      },
      's10c',
    );
    try {
      await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot (iii)');
      const call = await waitFor(() => {
        try {
          return httpMcpCaller(b.log);
        } catch {
          return null;
        }
      }, 15000, 'mcp http listener (iii)');
      const created = await call(1, 'session_create', { name: 'codex-only-span', backend: 'codex', chat_id: -100111 });
      const thread = JSON.parse(created.result.content[0].text).thread_id;
      pushUpdate(tgMessage(thread, '/model'));
      const listing = await waitFor(() => calls.send.find((m) => /Models across backends/.test(m.text || '')), 20000, '(iii) the /model listing');
      check('(iii) the listing shows ONLY the named backend', /codex:/.test(listing.text) && !/zai\//.test(listing.text) && !/mock/i.test(listing.text), listing.text);
      check('(iii) zcode was never constructed (outside the span, no start-marker)', !existsSync(zcodeMarker), b.log.slice(-2000));
      pushUpdate(tgMessage(thread, '/model zai/glm-5.3-flash'));
      const zaiRefusal = await waitFor(() => calls.send.find((m) => /unknown model "zai\/glm-5\.3-flash"/.test(m.text || '')), 20000, '(iii) the zai refusal');
      check('(iii) a zai/* ref is refused as unknown', !!zaiRefusal, zaiRefusal?.text);
      pushUpdate(tgMessage(thread, '/model mock:mock-1'));
      const mockRefusal = await waitFor(() => calls.send.find((m) => /unknown backend "mock"/.test(m.text || '')), 20000, '(iii) the mock: refusal');
      check('(iii) a mock: qualified ref is refused as an unknown backend (not constructed to answer)', !!mockRefusal, mockRefusal?.text);
    } finally {
      b.proc.kill('SIGKILL');
      srv.close();
    }
  }
}

// --- scenario 11: a Telegram-served mock-default bridge needs NO zcode
// credential and never spawns zcode -- and with MOCK_STREAM_CHUNKS it
// STREAMS: the ReplyStreamer edits a live preview, then the final render
// lands with the identical echo text ---
async function scenario11() {
  console.log('\n--- scenario 11: mock-default + MOCK_STREAM_CHUNKS: no zcode anything, real streaming preview ---');
  const { srv, port, calls, pushUpdate } = await startFakeTelegram();
  const zcodeMarker = path.join(TMP, 's11-zcode-started.json');
  const b = startBridge(
    {
      TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ALLOWED_USER_ID: '1',
      DEFAULT_BACKEND: 'mock',
      // ZCODE_BIN/ZCODE_WORKSPACE_DIR are demanded by config.js for every
      // boot mode -- but for a mock-default bridge they are never USED: the
      // fixture stand-in satisfies the variable and (asserted below) is
      // never spawned, and no zcode credential exists anywhere in this run.
      ZCODE_NODE_BIN: NODE,
      ZCODE_BIN: ZCODE_FIXTURE,
      ZCODE_WORKSPACE_DIR: TMP,
      FIXTURE_ZCODE_MARKER: zcodeMarker, // must NEVER be written here
      STORE_PATH: path.join(TMP, 's11-store.json'),
      // The streaming knobs under test + a preview throttle small enough to
      // flush mid-stream (the production default 5000ms would outlast it).
      MOCK_STREAM_CHUNKS: '4',
      MOCK_STREAM_INTERVAL_MS: '150',
      STREAM_PROGRESS: 'preview',
      STREAM_EDIT_INTERVAL_MS: '200',
    },
    's11',
  );
  try {
    await waitFor(() => b.log.includes('starting.'), 15000, 'bridge boot');
    check('the bridge boots Telegram-served with DEFAULT_BACKEND=mock and no zcode credential', b.proc.exitCode === null, `exitCode=${b.proc.exitCode}\n${b.log.slice(-2000)}`);
    pushUpdate(tgMessage(77, 'stream this prompt'));
    const final = await waitFor(
      () => calls.edit.find((e) => (e.text || '').includes('[mock echo] stream this prompt')),
      20000,
      'the final render',
    );
    check('the streamed turn delivered the final render with the IDENTICAL echo text', !!final, JSON.stringify(calls.edit.map((e) => (e.text || '').slice(0, 50))));
    const previewIdx = calls.edit.findIndex((e) => (e.text || '').startsWith('⌛'));
    check('a live ⌛ preview edit landed BEFORE the final render (the ReplyStreamer streamed)', previewIdx >= 0 && previewIdx < calls.edit.indexOf(final), JSON.stringify(calls.edit.map((e) => (e.text || '').slice(0, 40))));
    const previews = calls.edit.filter((e) => (e.text || '').startsWith('⌛'));
    check('more than one preview edit (the deltas actually streamed, spaced apart)', previews.length >= 2, `${previews.length} preview edits`);
    check('zcode was NEVER spawned (no credential, no install -- the fixture path is never executed)', !existsSync(zcodeMarker), b.log.slice(-2000));
    check('no codex was involved either (mock-default touches nothing else)', !/codex/i.test(b.log), b.log.slice(-1000));
  } finally {
    b.proc.kill('SIGKILL');
    srv.close();
  }
}

// EACH SCENARIO REPORTS ITS OWN FAILURE, so one scenario's throw (which is
// how a bridge that dies at boot usually surfaces -- a waitFor timeout)
// doesn't silently skip the scenarios after it: on the :546 boot-crash
// this file exists to catch, EVERY non-zcode-default scenario is red, and
// the run must say so rather than stop at the first.
for (const s of [scenario1, scenario2, scenario3, scenario4, scenario5, scenario6, scenario7, scenario8, scenario9, scenario10, scenario11]) {
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
