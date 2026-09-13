// Unit tests for the Telegram client's 429 handling: sendMessage honors
// retry_after with a bounded retry instead of failing the caller outright --
// the shape that, measured live on 2026-09-12, made a rate-limited prompt
// mirror fail (or silently lose) whole message_send calls. Everything else
// (non-429 errors, other methods) must behave exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Per-test fake Telegram: each test installs a `respond` and reads
// `attempts` afterwards. retry_after: 0 keeps the retry sleeps instant --
// the tests pin the RETRY DECISIONS, not the wall-clock waiting.
const state = { attempts: 0, respond: null };
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    state.attempts++;
    await state.respond(req, res, JSON.parse(body || '{}'));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
// UNREF'D, OR THE RUN NEVER ENDS: node --test waits for the event loop to
// drain, and a listening server pins it open after the last assertion --
// measured as a 300 s timeout with every test in this file already passed.
srv.unref();

// TELEGRAM_API_ROOT is read at import time, so the env must be set first.
process.env.TELEGRAM_API_ROOT = `http://127.0.0.1:${srv.address().port}`;
const { TelegramClient } = await import('../bridge/telegram.js');

const tooMany = (retryAfter) => (req, res) => {
  res.statusCode = 429;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfter}`, parameters: { retry_after: retryAfter } }));
};
const send = (t) => t.sendMessage({ chatId: -100777, messageThreadId: 55, text: 'mirror me' });

test('sendMessage honors retry_after: two 429s, then the send goes through', async () => {
  state.attempts = 0;
  state.respond = tooMany(0);
  let seen = 0;
  const realRespond = state.respond;
  state.respond = async (req, res, body) => {
    seen++;
    if (seen <= 2) return realRespond(req, res, body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  const t = new TelegramClient({ token: 'unit' });
  const sent = await send(t);
  assert.deepEqual(sent, { message_id: 1 }, 'the retried send did not return the result');
  assert.equal(state.attempts, 3, `expected 2 refused attempts + 1 success, saw ${state.attempts}`);
});

test('sendMessage gives up after three total attempts and rethrows the 429', async () => {
  state.attempts = 0;
  state.respond = tooMany(0);
  const t = new TelegramClient({ token: 'unit' });
  await assert.rejects(send(t), /Too Many Requests/);
  assert.equal(state.attempts, 3, 'the 429 budget was not bounded');
});

test('sendMessage does not retry non-429 failures', async () => {
  state.attempts = 0;
  state.respond = (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
  };
  const t = new TelegramClient({ token: 'unit' });
  await assert.rejects(send(t), /chat not found/);
  assert.equal(state.attempts, 1, 'a permanent error was retried');
});

test('other methods are untouched: getUpdates does not retry a 429', async () => {
  state.attempts = 0;
  state.respond = tooMany(0);
  const t = new TelegramClient({ token: 'unit' });
  await assert.rejects(t.getUpdates({ offset: 0 }), /Too Many Requests/);
  assert.equal(state.attempts, 1, 'getUpdates grew a retry it never had');
});
