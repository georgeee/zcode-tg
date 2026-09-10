// E2E for the MCP unix-socket contract (2026-09-10 handout), automated as
// the handout's own manual verification: parent directory auto-created,
// socket mode 0600 under umask 002, line-delimited JSON-RPC with
// chunk-split multibyte characters surviving, rebind across a restart, and
// the store-lock namespace fix (a foreign-format lock from a "previous
// container" is reclaimed, not held). No model turns: initialize and
// tools/list need no agent.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';

const NODE = process.env.ZCODE_NODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/toolchain/node/bin/node';
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const H = process.env.HOME;
const WS = `${H}/.cache/e2e-unixmcp-ws`;
const STORE = `${H}/.cache/e2e-unixmcp-store.json`;
const SOCKDIR = `${H}/.cache/e2e-unixmcp-sock/deep/parent`; // parent dirs deliberately absent
const SOCK = `${SOCKDIR}/mcp.sock`;
const CHAT = -100777, USER = 42;

for (const d of [WS, `${H}/.cache/e2e-unixmcp-sock`]) rmSync(d, { recursive: true, force: true });
rmSync(STORE, { force: true });
mkdirSync(WS, { recursive: true });

const srv = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const method = req.url.split('/').pop();
  const ok = (result = {}) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  };
  if (method === 'getUpdates') return ok([]);
  return ok();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tgPort = srv.address().port;

const bridgeEnv = (extra = {}) => ({
  ...process.env,
  TELEGRAM_API_ROOT: `http://127.0.0.1:${tgPort}`,
  TELEGRAM_BOT_TOKEN: 'e2e-fake-token',
  TELEGRAM_CHAT_ID: String(CHAT),
  TELEGRAM_ALLOWED_USER_ID: String(USER),
  ZCODE_NODE_BIN: NODE,
  ZCODE_BIN: process.env.ZCODE_BIN || '/srv/agent-cage/etheron-bare/agent/etheron-bare/work/zcode-probe/package/bin/zcode.js',
  ZCODE_WORKSPACE_DIR: WS,
  STORE_PATH: STORE,
  MCP_UNIX_SOCKET: SOCK,
  HOME: process.env.HOME,
  ...extra,
});

const startBridge = () => {
  const b = spawn(NODE, [path.join(REPO, 'bridge/index.js')], { env: bridgeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  b.stdout.on('data', (c) => (log += c));
  b.stderr.on('data', (c) => (log += c));
  return { b, log: () => log };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(300);
  }
}

// One line-delimited JSON-RPC conversation over the socket; sends lines with
// optional deliberate byte-splitting of a multibyte character.
function rpc(lines, { splitMultibyte = false } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCK);
    const out = [];
    let buf = '';
    sock.on('connect', () => {
      for (const l of lines) {
        const s = JSON.stringify(l) + '\n';
        if (splitMultibyte && s.includes('…')) {
          const i = s.indexOf('…');
          sock.write(Buffer.from(s.slice(0, i), 'utf8'));
          setTimeout(() => sock.write(Buffer.from(s.slice(i), 'utf8')), 120);
        } else {
          sock.write(s);
        }
      }
    });
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
      if (out.length >= lines.filter((l) => l.id != null).length) sock.end();
    });
    sock.on('error', reject);
    sock.on('close', () => resolve(out));
    setTimeout(() => reject(new Error('rpc timeout')), 20000);
  });
}

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

let bridge = null;
process.on('SIGTERM', () => { bridge?.b.kill('SIGKILL'); process.exit(1); });

try {
  const oldUmask = process.umask(0o002); // the inherited umask the handout calls out
  bridge = startBridge();
  await waitFor(() => bridge.log().includes('mcp gateway listening on unix:'), 20000, 'bind log');
  check('bind logged naming the path', bridge.log().includes(`unix:${SOCK}`));
  check('parent directory was created by the bridge (nobody else creates it)', existsSync(SOCKDIR));

  await waitFor(() => existsSync(SOCK), 10000, 'socket file');
  const mode = (statSync(SOCK).mode & 0o777).toString(8);
  check(`socket mode is 600 under umask 002 (got ${mode})`, mode === '600');
  process.umask(oldUmask);

  const init = await rpc([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
  check('initialize answered over the socket', init[0]?.result?.serverInfo?.name === 'cage-pod-zcode-mcp', JSON.stringify(init).slice(0, 100));
  const tools = await rpc([
    { jsonrpc: '2.0', method: 'notifications/initialized' }, // notification: answered with NOTHING
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  check('notifications produce no response; tools/list answers', tools.length === 1 && tools[0]?.id === 2 && tools[0]?.result?.tools?.length >= 4, JSON.stringify(tools).slice(0, 120));

  const split = await rpc([{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_close', arguments: { key: 'nonexistent-…-ключ' } } }], { splitMultibyte: true });
  check('a multibyte char split across writes survives (no parse error, tools/call answered)', split[0]?.id === 3 && split[0]?.result != null, JSON.stringify(split).slice(0, 140));

  // Rebind across a restart, socket left in place (EADDRINUSE case).
  bridge.b.kill('SIGTERM');
  await waitFor(() => bridge.b.exitCode !== null || bridge.b.signalCode === 'SIGTERM', 15000, 'bridge exit');
  await sleep(500);
  bridge = startBridge();
  await waitFor(() => bridge.log().includes('mcp gateway listening on unix:'), 20000, 'rebind log');
  const mode2 = (statSync(SOCK).mode & 0o777).toString(8);
  check('rebound after restart without deleting the socket', mode2 === '600');

  // Store lock: a lock naming a pid that EXISTS in this namespace but is a
  // different process (the pod crash-loop shape) must be reclaimed.
  bridge.b.kill('SIGTERM');
  await waitFor(() => bridge.b.exitCode !== null || bridge.b.signalCode === 'SIGTERM', 15000, 'bridge exit 2');
  await sleep(500);
  const foreign = { pid: 1, bootId: '00000000-0000-0000-0000-000000000000', startTime: 1 }; // pid 1 exists, identity differs
  writeFileSync(STORE + '.lock', JSON.stringify(foreign));
  bridge = startBridge();
  await waitFor(() => bridge.log().includes('[bridge] starting.'), 20000, 'boot after foreign lock');
  check('namespace-mismatched lock reclaimed (no crash loop)', !bridge.log().includes('another instance already has'));
  await waitFor(() => bridge.log().includes('mcp gateway listening on unix:'), 20000, 'bind after reclaim');
} catch (e) {
  check('scenario completed without harness timeout', false, e.message);
} finally {
  console.log(bridge ? bridge.log().split('\n').filter((l) => l.includes('mcp') || l.includes('lock')).slice(-4).join('\n') : '(no bridge)');
  console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ====`);
  bridge?.b.kill('SIGTERM');
  srv.close();
  await sleep(1200);
  try { rmSync(STORE, { force: true }); rmSync(STORE + '.lock', { force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
