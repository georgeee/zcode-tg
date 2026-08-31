// Minimal Telegram Bot API client: long-poll getUpdates + the handful of
// send/edit/answer calls the bridge needs. No dependency, just fetch.

const API_ROOT = 'https://api.telegram.org';

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

  sendMessage({ chatId, messageThreadId, text, replyMarkup, replyToMessageId }) {
    return this._call('sendMessage', {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      text,
      reply_markup: replyMarkup,
      reply_to_message_id: replyToMessageId,
      parse_mode: undefined, // plain text: model output may contain characters that break Markdown/HTML parsing
    });
  }

  editMessageText({ chatId, messageId, text, replyMarkup }) {
    return this._call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup,
    });
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
