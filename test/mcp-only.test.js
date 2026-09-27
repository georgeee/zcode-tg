// MCP-only boot (shared-group design section 6, work item 6): the bridge
// must serve zcode/codex as MCPs with NO Telegram -- no bot, no group, no
// polling, no setMyCommands, no TelegramClient at all.
//
// These tests drive the REAL bridge process: index.js exports nothing and
// cannot be imported without booting (the repo's standing policy), so the
// harness spawns it with MCP_HTTP_PORT and the zero-subprocess mock backend,
// points TELEGRAM_API_ROOT at a counting fake that RECORDS EVERY REQUEST,
// and asserts that count stays at exactly zero across the whole MCP
// lifecycle. The mock backend needs no credentials and no other binary, so
// the suite runs anywhere node runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const MCP_ONLY_LOG = 'MCP-only: no Telegram transport configured (TELEGRAM_BOT_TOKEN absent)';

// The counting fake: every request to it is a Telegram API call the bridge
// should NOT be making in MCP-only mode. getUpdates is answered honestly
// (empty, after a tick) so a mutant that boots the poll loop still boots --
// and is caught by the count, not by a hang.
const fake = { hits: 0, methods: [] };
const fakeTg = createServer(async (req, res) => {
  fake.hits += 1;
  fake.methods.push(req.url.split('/').pop());
  let body = '';
  for await (const c of req) body += c;
  void body;
  const ok = (result = {}) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  };
  if (req.url.endsWith('/getUpdates')) {
    const timer = setTimeout(() => ok([]), 1500);
    timer.unref?.();
    return;
  }
  ok({ message_id: 4242 });
});
await new Promise((r) => fakeTg.listen(0, '127.0.0.1', r));

function childEnv(ws, extra = {}) {
  // Deliberately NOT spreading process.env: a machine with TELEGRAM_* in its
  // own environment (or a real ~/.config/zcode-tg/.env) would silently turn
  // the child into a Telegram bridge. ZCODE_TG_ENV points at a path that
  // does not exist, so loadEnv() no-ops too.
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: ws,
    ZCODE_TG_ENV: path.join(ws, 'does-not-exist.env'),
    ZCODE_NODE_BIN: process.execPath,
    ZCODE_BIN: 'true', // never invoked: the only backend here is the in-process mock
    ZCODE_WORKSPACE_DIR: ws,
    ZCODE_DEFAULT_MODE: 'yolo',
    DEFAULT_BACKEND: 'mock',
    STORE_PATH: path.join(ws, 'sessions.json'),
    TELEGRAM_API_ROOT: `http://127.0.0.1:${fakeTg.address().port}`,
    MCP_HTTP_PORT: '0', // ephemeral; the bound port is read from the boot log
    ...extra,
  };
}

function spawnBridge(env) {
  const child = spawn(process.execPath, [path.join(REPO, 'bridge/index.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (c) => (child.log += c));
  child.stderr.on('data', (c) => (child.log += c));
  return child;
}

async function waitFor(fn, timeoutMs, label, scratch) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timeout waiting for ${label}\n---- child output ----\n${scratch}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function mcpPortOf(log) {
  return (log.match(/mcp gateway listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/) || [])[1];
}

async function toolCall(port, name, args, id) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.equal(body.error, undefined, `tools/call ${name} transport error: ${JSON.stringify(body)}`);
  // A successful result's text is the JSON payload; an error result's text
  // is the plain error sentence (the gateway's isError convention).
  let payload;
  try {
    payload = JSON.parse(body.result.content[0].text);
  } catch {
    payload = undefined;
  }
  return {
    isError: body.result.isError,
    text: body.result.content[0].text,
    payload,
  };
}

test('MCP-only bridge: boots, serves the MCP lifecycle, and never touches Telegram', async (t) => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'zbridge-mcponly-'));
  const child = spawnBridge(childEnv(ws));
  t.after(() => {
    child.kill('SIGTERM');
    rmSync(ws, { recursive: true, force: true });
  });

  await t.test('boot: exactly one MCP-only line, an MCP listener, and zero Telegram requests', async () => {
    await waitFor(() => (mcpPortOf(child.log) ? mcpPortOf(child.log) : null), 15000, 'the MCP gateway to bind', child.log);
    // A mutant that constructs a client anyway (e.g. with a placeholder
    // token) still binds the gateway -- but immediately calls Telegram
    // (getMe warm-up, getUpdates polling). Give any such traffic time to
    // land, then let the COUNT be the witness before even requiring the
    // mode line.
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(fake.hits, 0, `expected zero Telegram API calls, saw: ${fake.methods.join(', ') || '(none)'}`);
    await waitFor(() => child.log.includes(MCP_ONLY_LOG), 5000, 'the MCP-only boot line', child.log);
    const lines = child.log.split('\n').filter((l) => l.includes(MCP_ONLY_LOG));
    assert.equal(lines.length, 1, 'the mode is announced exactly once');
    assert.equal(fake.hits, 0, `expected zero Telegram API calls, saw: ${fake.methods.join(', ') || '(none)'}`);
  });

  const port = mcpPortOf(child.log);
  assert.ok(port, 'the MCP port is known from here on');

  await t.test('session_create mints an m-key, reports telegram:false, and makes zero Telegram calls', async () => {
    const r = await toolCall(port, 'session_create', { name: 'alpha', backend: 'mock' }, 1);
    assert.equal(r.isError, false, r.text);
    assert.match(r.payload.key, /^m\d+$/, `key ${r.payload.key} is the synthetic m<N> form`);
    assert.equal(r.payload.telegram, false);
    assert.equal(r.payload.backend, 'mock');
    assert.equal(r.payload.model, 'mock-1');
    assert.equal(r.payload.chat_id, undefined, 'no chat exists -- none is claimed');
    assert.equal(r.payload.thread_id, undefined);
    const second = await toolCall(port, 'session_create', { name: 'beta', backend: 'mock' }, 2);
    assert.notEqual(second.payload.key, r.payload.key, 'two sessions never share a key');
    assert.equal(fake.hits, 0, `session_create must not call Telegram; saw: ${fake.methods.join(', ') || '(none)'}`);
  });

  const key = (await toolCall(port, 'session_create', { name: 'gamma', backend: 'mock' }, 3)).payload.key;

  await t.test('message_send delivers the reply with zero Telegram calls; replies_get sees it too', async () => {
    const r = await toolCall(port, 'message_send', { key, text: 'hello agent', wait: true }, 4);
    assert.equal(r.isError, false, r.text);
    assert.match(r.payload.reply, /\[mock echo\] hello agent/);
    assert.equal(fake.hits, 0, `message_send must not call Telegram; saw: ${fake.methods.join(', ') || '(none)'}`);
    const replies = await toolCall(port, 'replies_get', { key }, 5);
    assert.equal(replies.isError, false, replies.text);
    assert.ok(replies.payload.replies.some((x) => x.text.includes('[mock echo] hello agent')), 'the reply is in the log');
    // And the wait:false shape queues without a Telegram notice as well.
    const queued = await toolCall(port, 'message_send', { key, text: 'second', wait: false }, 6);
    assert.deepEqual(queued.payload, { queued: true, key });
    assert.equal(fake.hits, 0, `queued message_send must not call Telegram; saw: ${fake.methods.join(', ') || '(none)'}`);
  });

  await t.test('progress_get, model_get and session_close work unchanged, still zero Telegram calls', async () => {
    const prog = await toolCall(port, 'progress_get', { key }, 7);
    assert.equal(prog.isError, false, prog.text);
    const model = await toolCall(port, 'model_get', { key }, 8);
    assert.equal(model.isError, false, model.text);
    assert.deepEqual(model.payload, { backend: 'mock', model: 'mock-1', switchable: false });
    const closed = await toolCall(port, 'session_close', { key }, 9);
    assert.equal(closed.isError, false, closed.text);
    assert.deepEqual(closed.payload, { ok: true });
    const after = await toolCall(port, 'replies_get', { key }, 10);
    assert.equal(after.isError, true, 'a closed session is an error, not a hollow []');
    assert.match(after.text, /is closed/);
    assert.equal(fake.hits, 0, `close/lifecycle must not call Telegram; saw: ${fake.methods.join(', ') || '(none)'}`);
  });

  await t.test('session_create with a chat_id refuses: it names a chat that cannot exist here', async () => {
    const r = await toolCall(port, 'session_create', { name: 'delta', backend: 'mock', chat_id: -100777 }, 11);
    assert.equal(r.isError, true);
    assert.match(r.text, /chat_id names a Telegram chat/);
    assert.match(r.text, /MCP-only/);
  });
});

test('a token present keeps the trio required: the boot refuses without TELEGRAM_CHAT_ID', async (t) => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'zbridge-trio-'));
  const child = spawnBridge(childEnv(ws, { TELEGRAM_BOT_TOKEN: 'e2e-fake-token', MCP_HTTP_PORT: '0' }));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const code = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  assert.notEqual(code, 0, 'the boot must be refused');
  assert.match(child.log, /missing required env var: TELEGRAM_CHAT_ID/);
});

test('neither token nor MCP transport: the refusal sentence names both ways out', async (t) => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'zbridge-neither-'));
  // No MCP_HTTP_PORT / MCP_UNIX_SOCKET, no TELEGRAM_BOT_TOKEN: the base env's
  // ephemeral MCP listener is explicitly switched back off with ''.
  const child = spawnBridge(childEnv(ws, { MCP_HTTP_PORT: '' }));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const code = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  assert.equal(code, 1);
  assert.match(child.log, /missing required env var: TELEGRAM_BOT_TOKEN/);
  assert.match(child.log, /set TELEGRAM_BOT_TOKEN \(with TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_ID\)/);
  assert.match(child.log, /set MCP_UNIX_SOCKET \(or MCP_HTTP_PORT\) for an MCP-only bridge with no Telegram at all/);
});

test('cleanup: the counting fake Telegram shuts down', async () => {
  await new Promise((r) => fakeTg.close(r));
});
