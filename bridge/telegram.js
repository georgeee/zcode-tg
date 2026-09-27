// Minimal Telegram Bot API client: long-poll getUpdates + the handful of
// send/edit/answer calls the bridge needs. No dependency, just fetch.
//
// TELEGRAM_API_ROOT exists as a testing seam: the end-to-end harness
// (test/e2e.mjs) points it at a local fake Telegram so the whole bridge --
// real zcode app-server child included -- runs against canned updates
// without touching the live bot (whose getUpdates long-poll tolerates
// exactly one consumer).
//
// The relay design (docs/relay-owned-group-design.md section 2) adds a
// unix: form -- unix:/path/to/sock dials that socket as plain HTTP with the
// SAME /bot<token>/<method> paths -- while the https default and any
// http(s) root stay byte-for-byte today's fetch behavior. fetch cannot dial
// a unix socket, so the unix form goes through unixFetch below.

import http from 'node:http';

const API_ROOT = process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org';

// The socket to dial when API_ROOT is the unix: form; null for the default
// and for http(s) roots, which keep their fetch path unchanged.
const UNIX_SOCKET = API_ROOT.startsWith('unix:') ? API_ROOT.slice('unix:'.length).trim() : null;

// sendMessage's 429 budget: total attempts (the initial try plus retries)
// before the 429 goes back to the caller.
const RATE_LIMIT_ATTEMPTS = 3;

export class TelegramClient {
  constructor({ token }) {
    if (!token) throw new Error('TelegramClient: token required');
    if (UNIX_SOCKET !== null && !UNIX_SOCKET) throw new Error(`TelegramClient: TELEGRAM_API_ROOT='${API_ROOT}' is a unix: root with no socket path -- write it as unix:/path/to/sock.`);
    this.token = token;
    // Over the socket the base is a bare path -- the same /bot<token> prefix
    // (the relay keys the connection by the token alone); on https/http it
    // is the URL fetch dials, exactly as before.
    this.base = `${UNIX_SOCKET ? '' : API_ROOT}/bot${token}`;
  }

  async _call(method, body) {
    const res = UNIX_SOCKET
      ? await unixFetch({
          socketPath: UNIX_SOCKET,
          path: `${this.base}/${method}`,
          method: 'POST',
          headers: { 'content-type': 'application/json', host: 'api.telegram.org' },
          body: JSON.stringify(body ?? {}),
        })
      : await fetch(`${this.base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
    const json = await res.json();
    if (!json.ok) {
      const err = new Error(`telegram ${method} failed: ${json.description || res.status}`);
      // 429 carries the wait Telegram demands, structured in parameters (and
      // echoed in the description text). Attached to the error so sendMessage
      // can honor it with a bounded retry; every other caller sees a plain
      // error, as before.
      if (json.error_code === 429) {
        const parsed = json.parameters?.retry_after ?? (json.description || '').match(/retry after (\d+)/i)?.[1];
        err.retryAfterS = Number(parsed ?? 1);
      }
      throw err;
    }
    return json.result;
  }

  // Long-poll. Telegram holds the connection open up to `timeout` seconds
  // waiting for something to happen -- this is what makes polling cheap and
  // near-real-time without a webhook or any inbound port.
  getUpdates({ offset, timeout = 30, allowedUpdates = ['message', 'callback_query', 'my_chat_member'] } = {}) {
    return this._call('getUpdates', { offset, timeout, allowed_updates: allowedUpdates });
  }

  // parseMode is opt-in per call: model output goes through bridge/format.js
  // and is sent as 'HTML'; everything the bridge composes itself stays plain
  // text so an accidental entity in our own strings can't bounce a notice.
  leaveChat({ chatId }) {
    return this._call('leaveChat', { chat_id: chatId });
  }

  // The one call the bridge floods hardest (prompt mirrors, placeholders,
  // notices, reply chunks) is also the one Telegram rate-limits hardest, and
  // an unanswered 429 used to fail the caller outright. Honor retry_after:
  // wait what the API demanded (bounded), retry, and only surface the 429
  // after RATE_LIMIT_ATTEMPTS total attempts. Non-429 failures are not
  // retried -- a 400 will fail identically forever.
  async sendMessage({ chatId, messageThreadId, text, replyMarkup, replyToMessageId, parseMode }) {
    const body = {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      text,
      reply_markup: replyMarkup,
      reply_to_message_id: replyToMessageId,
      parse_mode: parseMode,
    };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this._call('sendMessage', body);
      } catch (e) {
        if (e.retryAfterS == null || attempt >= RATE_LIMIT_ATTEMPTS) throw e;
        await sleep(Math.min(e.retryAfterS, 30) * 1000);
      }
    }
  }

  createForumTopic({ chatId, name, iconColor, iconCustomEmojiId }) {
    return this._call('createForumTopic', {
      chat_id: chatId,
      name,
      icon_color: iconColor,
      icon_custom_emoji_id: iconCustomEmojiId,
    });
  }

  // Who we are on the Telegram side -- the id getChatMember needs to ask
  // about the bot's own admin status. Fetched once and cached by the caller.
  getMe() {
    return this._call('getMe', {});
  }

  // Live chat facts: getChat's ChatFullInfo carries is_forum for
  // supergroups, which is exactly what a default topic-creation target
  // must be checked for (stale config or a toggled setting, not trusted).
  getChat({ chatId }) {
    return this._call('getChat', { chat_id: chatId });
  }

  getChatMember({ chatId, userId }) {
    return this._call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  closeForumTopic({ chatId, messageThreadId }) {
    return this._call('closeForumTopic', { chat_id: chatId, message_thread_id: messageThreadId });
  }

  editMessageText({ chatId, messageId, text, replyMarkup, parseMode }) {
    return this._call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup,
      parse_mode: parseMode,
    });
  }

  // Multipart document upload for /file. Node 22 has the fetch/FormData/Blob
  // globals this needs; no dependency. Telegram caps bot uploads at 50 MB.
  async sendDocument({ chatId, messageThreadId, blob, filename, caption }) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (messageThreadId) form.append('message_thread_id', String(messageThreadId));
    if (caption) form.append('caption', caption);
    form.append('document', blob, filename);
    let res;
    if (UNIX_SOCKET) {
      // Over the socket there is no fetch to serialize the form, so stage it
      // through Response(form): undici's own encoder, handing back exactly
      // the bytes and the multipart content-type (boundary included) fetch
      // would have put on the wire.
      const staged = new Response(form);
      res = await unixFetch({
        socketPath: UNIX_SOCKET,
        path: `${this.base}/sendDocument`,
        method: 'POST',
        headers: { 'content-type': staged.headers.get('content-type'), host: 'api.telegram.org' },
        body: Buffer.from(await staged.arrayBuffer()),
      });
    } else {
      res = await fetch(`${this.base}/sendDocument`, { method: 'POST', body: form });
    }
    const json = await res.json();
    if (!json.ok) throw new Error(`telegram sendDocument failed: ${json.description || res.status}`);
    return json.result;
  }

  // Pinning needs admin (can_pin_messages) in the chat; callers treat a
  // failure as "stay unpinned", not an error worth retrying.
  pinChatMessage({ chatId, messageId, disableNotification = true }) {
    return this._call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: disableNotification });
  }

  // Bots may delete their own messages in groups regardless of age -- used
  // to replace a status message that has aged out of Telegram's 48h edit
  // window so exactly one exists at a time.
  deleteMessage({ chatId, messageId }) {
    return this._call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  // Registers the bridge's own commands so Telegram's client offers them as
  // autocomplete when a / is typed in the chat. Idempotent; safe to call on
  // every boot. chat scope = the one forum group this bridge serves, so the
  // command list doesn't leak into whatever other chats the bot ever joins.
  setMyCommands({ commands, scope }) {
    return this._call('setMyCommands', { commands, scope });
  }

  // Inbound files: getFile maps a message's file_id to a downloadable
  // file_path (valid ~1h), downloadFile fetches the bytes from the /file/
  // route. Bots can download files up to 20 MB -- larger documents can be
  // SENT in chat but not fetched, so the bridge rejects them by size first.
  getFile({ fileId }) {
    return this._call('getFile', { file_id: fileId });
  }

  async downloadFile(filePath) {
    const res = UNIX_SOCKET
      ? await unixFetch({
          socketPath: UNIX_SOCKET,
          path: `/file/bot${this.token}/${filePath}`,
          method: 'GET',
          headers: { host: 'api.telegram.org' },
        })
      : await fetch(`${API_ROOT}/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new Error(`telegram file download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  answerCallbackQuery({ callbackQueryId, text, showAlert = false }) {
    return this._call('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });
  }

  // Telegram caps inline button callback_data at 64 bytes, so we never
  // encode the full permission payload in it -- just a short opaque token
  // the bridge looks up in its own in-memory map.
  static inlineKeyboard(buttons) {
    // buttons: [{ text, data }, ...] -> one button per row (permission
    // prompts read better stacked than crammed side by side on mobile).
    return { inline_keyboard: buttons.map((b) => [{ text: b.text, callback_data: b.data }]) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The whole unix: transport (docs/relay-owned-group-design.md section 2):
// fetch cannot dial a unix socket; http.request can, via socketPath. Plain
// HTTP over the relay socket, the same path the https form builds, Host
// header included (the relay ignores it; some servers require one), plus
// content-length like fetch always sends. Resolves a minimal fetch-Response-
// shaped object -- status/ok/json/arrayBuffer, the only members the call
// sites use -- so everything below the dispatch (the 429 parsing, the
// result unwrapping) is shared with the fetch path and unchanged.
function unixFetch({ socketPath, path, method, headers, body }) {
  const wire = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path, method, headers: wire ? { ...headers, 'content-length': wire.length } : headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json: async () => JSON.parse(buffer.toString('utf8')),
            arrayBuffer: async () => buffer,
          });
        });
      }
    );
    req.on('error', reject);
    if (wire) req.write(wire);
    req.end();
  });
}
