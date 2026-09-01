// Throttled streaming editor for a turn's placeholder message.
//
// The user-facing contract (agreed in the Telegram topic, 2026-09-01):
// the reply-to-be lands on ONE message per turn -- the placeholder -- and is
// EDITED in place as the model streams, rather than posting new messages
// per chunk. Telegram's group-wide "20 messages/min" bot cap is explicitly
// not a design constraint here; the pacing rule is simply "don't edit the
// same message more often than once per STREAM_EDIT_INTERVAL_MS (default
// 5s)" -- anything produced inside that window is folded into the next
// flush, and the final delivery on turn.terminal always runs regardless of
// the throttle.
//
// The streaming preview is deliberately the HEAD of the text (first
// renderReply chunk at a reduced budget), prefixed with ⌛ so the last
// message in the topic visibly says "still in progress". The ⌛ and the
// status line (current tool, elapsed time) are dropped when finalizeTurn
// replaces the preview with the authoritative full render.

import { renderReply } from './format.js';

// Leaves room under Telegram's 4096 cap for the ⌛ prefix, the truncation
// marker and the status line the streamer adds around the preview itself.
const PREVIEW_BUDGET = 3200;

export class ReplyStreamer {
  // ({ tg, chatId, messageId, threadId, minEditIntervalMs, heartbeatMs })
  // messageId may be null for "adopted" turns (see index.js) whose
  // placeholder message is still being sent; edits simply wait until it
  // shows up.
  constructor({ tg, chatId, messageId, threadId, minEditIntervalMs = 5000, heartbeatMs = 60000 }) {
    this.tg = tg;
    this.chatId = chatId;
    this.messageId = messageId;
    this.threadId = threadId;
    this.minEditIntervalMs = minEditIntervalMs;
    this.heartbeatMs = heartbeatMs;
    this.text = '';
    this.status = null; // e.g. '🔧 Bash' / '💭 thinking' / '❓ waiting for your answer'
    this.startedAt = Date.now();
    this.lastEditAt = Date.now(); // counts the placeholder send itself as an edit
    this.lastText = null;
    this.dirty = false;
    this.dead = false; // placeholder deleted / unrecoverable -- stop trying
    this._timer = null;
    // update() -- and so a fresh elapsed-time render -- is only ever called
    // from a real protocol event (index.js). A single long-running tool call
    // (a VM boot, a slow test suite, ...) can go many minutes between two
    // such events, and _render()'s "elapsed" is only ever recomputed when a
    // flush actually runs -- so with no heartbeat the displayed "· 117s"
    // just freezes at whatever it was on the LAST event, even though the
    // turn is still genuinely running. Found the hard way (2026-09-01): a
    // task 130+ minutes and 28 tool-call iterations in, one Bash call away
    // from its next update, looked abandoned from a frozen counter that
    // hadn't moved in a long while. This timer periodically marks the state
    // dirty with no new content, purely so elapsed keeps advancing --
    // same throttle/dedupe path as a real update, just self-triggered.
    this._heartbeat = heartbeatMs > 0 ? setInterval(() => {
      if (this.dead) return;
      this.dirty = true;
      this._schedule();
    }, heartbeatMs) : null;
  }

  // Record new streaming state. `text` is the FULL accumulated buffer so far
  // (index.js owns the buffer); `status` the latest activity marker, or null
  // to clear it (text is arriving again).
  update({ text, status }) {
    if (this.dead) return;
    if (text !== undefined) this.text = text;
    if (status !== undefined) this.status = status;
    this.dirty = true;
    this._schedule();
  }

  // Halt pending flushes (called before final delivery replaces the preview).
  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
    this.dirty = false;
  }

  _schedule() {
    if (this._timer) return; // a flush is already scheduled; state will be read then
    const wait = Math.max(0, this.lastEditAt + this.minEditIntervalMs - Date.now());
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush().catch(() => {});
    }, wait);
  }

  async _flush() {
    if (!this.dirty || this.dead) return;
    // Adopted turn whose placeholder hasn't arrived yet -- try again on the
    // next update.
    if (!this.messageId) return;
    const text = this._render();
    if (text === this.lastText) {
      this.dirty = false;
      return;
    }
    this.dirty = false;
    try {
      await this.tg.editMessageText({ chatId: this.chatId, messageId: this.messageId, text, parseMode: 'HTML' });
    } catch (e) {
      // "message is not modified" -- content identical from Telegram's point
      // of view (usually entity-normalization); treat as delivered.
      if (/not modified/i.test(e.message || '')) {
        // fall through
      } else if (/message to edit not found|MESSAGE_ID_INVALID|message to delete not found/i.test(e.message || '')) {
        // User deleted the placeholder mid-turn; final delivery will send a
        // fresh message instead. No point editing further.
        this.dead = true;
        return;
      } else {
        console.error('[streamer] edit failed (will retry on next update):', e.message);
        this.dirty = true;
      }
    }
    this.lastText = text;
    this.lastEditAt = Date.now();
    // State may have advanced while the edit was in flight -- go around again.
    if (this.dirty) this._schedule();
  }

  _render() {
    const elapsed = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
    const statusLine = this.status ? `${this.status} · ${elapsed}s` : `${elapsed}s`;
    if (!this.text) return `⌛ ${statusLine}`;
    // [file: …] markers are stripped inside renderReply (single choke point)
    // -- files are sent as documents at final delivery, never shown as text.
    const chunks = renderReply(this.text, PREVIEW_BUDGET);
    let body = chunks[0];
    // Marker that this is a head-truncated preview, not the whole reply. The
    // +N is the unrendered source length: exact enough to signal magnitude.
    if (chunks.length > 1) body += `\n<i>… +${abbrevNum(this.text.length)} chars streaming</i>`;
    return `⌛ ${body}\n<i>${statusLine}</i>`;
  }
}

function abbrevNum(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
