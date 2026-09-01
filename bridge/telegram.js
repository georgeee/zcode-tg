// Minimal Telegram Bot API client: long-poll getUpdates + the handful of
// send/edit/answer calls the bridge needs. No dependency, just fetch.
//
// TELEGRAM_API_ROOT exists as a testing seam: the end-to-end harness
// (test/e2e.mjs) points it at a local fake Telegram so the whole bridge --
// real zcode app-server child included -- runs against canned updates
// without touching the live bot (whose getUpdates long-poll tolerates
// exactly one consumer).

const API_ROOT = process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org';

export class TelegramClient {
  constructor({ token }) {
    if (!token) throw new Error('TelegramClient: token required');
    this.token = token;
    this.base = `${API_ROOT}/bot${token}`;
  }

  async _call(method, body) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`telegram ${method} failed: ${json.description || res.status}`);
    }
    return json.result;
  }

  // Long-poll. Telegram holds the connection open up to `timeout` seconds
  // waiting for something to happen -- this is what makes polling cheap and
  // near-real-time without a webhook or any inbound port.
  getUpdates({ offset, timeout = 30, allowedUpdates = ['message', 'callback_query'] } = {}) {
    return this._call('getUpdates', { offset, timeout, allowed_updates: allowedUpdates });
  }

  // parseMode is opt-in per call: model output goes through bridge/format.js
  // and is sent as 'HTML'; everything the bridge composes itself stays plain
  // text so an accidental entity in our own strings can't bounce a notice.
  sendMessage({ chatId, messageThreadId, text, replyMarkup, replyToMessageId, parseMode }) {
    return this._call('sendMessage', {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      text,
      reply_markup: replyMarkup,
      reply_to_message_id: replyToMessageId,
      parse_mode: parseMode,
    });
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
    const res = await fetch(`${this.base}/sendDocument`, {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (messageThreadId) form.append('message_thread_id', String(messageThreadId));
        if (caption) form.append('caption', caption);
        form.append('document', blob, filename);
        return form;
      })(),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`telegram sendDocument failed: ${json.description || res.status}`);
    return json.result;
  }

  // Pinning needs admin (can_pin_messages) in the chat; callers treat a
  // failure as "stay unpinned", not an error worth retrying.
  pinChatMessage({ chatId, messageId, disableNotification = true }) {
    return this._call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: disableNotification });
  }

  // Registers the bridge's own commands so Telegram's client offers them as
  // autocomplete when a / is typed in the chat. Idempotent; safe to call on
  // every boot. chat scope = the one forum group this bridge serves, so the
  // command list doesn't leak into whatever other chats the bot ever joins.
  setMyCommands({ commands, scope }) {
    return this._call('setMyCommands', { commands, scope });
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
