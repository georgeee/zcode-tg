// Unit tests for the unix: form of TELEGRAM_API_ROOT (relay-owned-group
// design, section 2, zcode-tg commit 1): every request goes over the socket
// as plain HTTP with the SAME /bot<token>/<method> paths, while the https
// default and any http(s) root stay byte-for-byte on fetch. The fake is a
// real http server listening on a temp-dir unix socket that records
// method/path/headers/body and answers Bot-API-shaped JSON -- no network,
// no Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UNIT_TOKEN = 'unit-unix';

// The per-test fake Telegram on the socket: each test installs a `handler`
// and reads `calls` afterwards. Every call is recorded as
// { method, path, headers, body } with the body kept as raw bytes so the
// multipart assertions can compare them byte for byte.
const state = { calls: [], handler: null };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-unix-'));
const sockPath = path.join(dir, 'tg.sock');
const srv = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const call = { method: req.method, path: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks) };
    state.calls.push(call);
    state.handler(call, res);
  });
});
await new Promise((r) => srv.listen(sockPath, r));
// UNREF'D, OR THE RUN NEVER ENDS (see test/telegram.test.js): a listening
// server pins the event loop after the last assertion.
srv.unref();
test.after(() => {
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const okJson = (result) => (call, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, result }));
};
const errJson = (code, description, parameters) => (call, res) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: false, error_code: code, description, parameters }));
};

// TELEGRAM_API_ROOT is read at import time, so each variant sets the env and
// then imports its own copy of the module (the query string busts the cache).
process.env.TELEGRAM_API_ROOT = `unix:${sockPath}`;
const { TelegramClient } = await import('../bridge/telegram.js');
process.env.TELEGRAM_API_ROOT = 'https://api.telegram.org';
const { TelegramClient: HttpsTelegramClient } = await import('../bridge/telegram.js?https-root');
process.env.TELEGRAM_API_ROOT = 'unix:';
const { TelegramClient: MalformedRootTelegramClient } = await import('../bridge/telegram.js?malformed-root');

test('_call dials the socket with the /bot<token>/<method> path and parses the result', async () => {
  state.calls.length = 0;
  state.handler = okJson({ id: 42, username: 'relay_bot' });
  const t = new TelegramClient({ token: UNIT_TOKEN });
  const me = await t.getMe();
  assert.deepEqual(me, { id: 42, username: 'relay_bot' }, 'the socket answer did not come back parsed');
  assert.equal(state.calls.length, 1);
  const call = state.calls[0];
  assert.equal(call.path, `/bot${UNIT_TOKEN}/getMe`, 'the /bot<token> prefix was lost on the socket path');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers.host, 'api.telegram.org', 'no Host header on the socket request');
  assert.deepEqual(JSON.parse(call.body.toString('utf8')), {});
});

test('429 + retry_after over the socket triggers the same bounded retry as over http', async () => {
  state.calls.length = 0;
  const tooMany = errJson(429, 'Too Many Requests: retry after 0', { retry_after: 0 });
  let seen = 0;
  state.handler = (call, res) => {
    seen++;
    if (seen <= 2) return tooMany(call, res);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  };
  const t = new TelegramClient({ token: UNIT_TOKEN });
  const sent = await t.sendMessage({ chatId: -100777, messageThreadId: 55, text: 'via the socket' });
  assert.deepEqual(sent, { message_id: 7 }, 'the retried send did not return the result');
  assert.equal(state.calls.length, 3, `expected 2 refused attempts + 1 success, saw ${state.calls.length}`);
  assert.ok(state.calls.every((c) => c.path === `/bot${UNIT_TOKEN}/sendMessage`), 'a retry changed the request');
});

test('sendDocument puts the multipart on the socket intact: boundary, fields, file bytes', async () => {
  state.calls.length = 0;
  state.handler = okJson({ message_id: 9, document: { file_name: 'report.pdf' } });
  // Binary-ish bytes, including NUL, CR LF and 0xFF, and NOT ending in CRLF
  // so the part-framing strip below cannot eat a real byte.
  const fileBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x0d, 0x0a, 0xff]);
  const t = new TelegramClient({ token: UNIT_TOKEN });
  await t.sendDocument({
    chatId: -100777,
    messageThreadId: 55,
    blob: new Blob([fileBytes], { type: 'application/pdf' }),
    filename: 'report.pdf',
    caption: 'the report',
  });
  assert.equal(state.calls.length, 1);
  const call = state.calls[0];
  assert.equal(call.path, `/bot${UNIT_TOKEN}/sendDocument`);
  const contentType = call.headers['content-type'] || '';
  assert.match(contentType, /^multipart\/form-data; boundary=/, 'the multipart content-type was lost');
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  // latin1 maps one byte to one char, so this round-trips arbitrary bytes.
  const raw = call.body.toString('latin1');
  assert.ok(raw.startsWith(`--${boundary}\r\n`), 'the body is not framed by the header boundary');
  assert.ok(raw.endsWith(`--${boundary}--\r\n`), 'the closing boundary is missing');
  const { fields, files } = parseMultipart(raw, boundary);
  assert.equal(fields.chat_id, '-100777');
  assert.equal(fields.message_thread_id, '55');
  assert.equal(fields.caption, 'the report');
  assert.equal(files.document.filename, 'report.pdf');
  assert.equal(files.document.contentType, 'application/pdf');
  assert.deepEqual(files.document.bytes, fileBytes, 'the file bytes did not survive the socket intact');
});

test('downloadFile fetches /file/bot<token>/<path> over the socket and returns the bytes', async () => {
  state.calls.length = 0;
  const payload = Buffer.from([0x00, 0x01, 0xfe, 0x66, 0x69, 0x6c, 0x65, 0x0a]);
  state.handler = (call, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    res.end(payload);
  };
  const t = new TelegramClient({ token: UNIT_TOKEN });
  const got = await t.downloadFile('documents/report.pdf');
  assert.deepEqual(got, payload);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].path, `/file/bot${UNIT_TOKEN}/documents/report.pdf`, 'the /file/ route was not built as designed');
});

test('an https root never touches the socket: the transport stays fetch', async () => {
  const before = state.calls.length;
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { id: 42 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const t = new HttpsTelegramClient({ token: UNIT_TOKEN });
    const me = await t.getMe();
    assert.deepEqual(me, { id: 42 });
    assert.equal(fetchCalls.length, 1, 'the https root did not go over fetch');
    assert.equal(state.calls.length, before, 'the https root dialed the unix socket');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a unix: root with no socket path is refused at construction', () => {
  assert.throws(() => new MalformedRootTelegramClient({ token: UNIT_TOKEN }), /unix:.*socket path/);
});

// Splits a multipart body (latin1-decoded, so byte-preserving) into its
// string fields and file parts, using the boundary from the content-type.
function parseMultipart(raw, boundary) {
  const fields = {};
  const files = {};
  for (const part of raw.split(`--${boundary}`).slice(1, -1)) {
    const seg = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const headEnd = seg.indexOf('\r\n\r\n');
    const headers = seg.slice(0, headEnd);
    const body = seg.slice(headEnd + 4);
    const disposition = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/.exec(headers);
    const contentType = /Content-Type: (.+)/.exec(headers)?.[1];
    if (disposition[2] != null) files[disposition[1]] = { filename: disposition[2], contentType, bytes: Buffer.from(body, 'latin1') };
    else fields[disposition[1]] = body;
  }
  return { fields, files };
}
