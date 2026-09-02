// Milestone-style progress reporting (branch experiment, 2026-09-02).
//
// Owner-directed shape: each milestone is its OWN Telegram message, posted
// when the milestone begins; only the LAST message keeps being edited while
// its milestone runs; earlier messages freeze into a "✅ label + the steps
// that were done" record the moment the next milestone opens. The final
// reply of the turn is delivered separately at turn.terminal, as before.
//
// Where milestones come from -- no inference beyond what the protocol
// already streams: the model narrates between tool batches ("Now let me
// fix X...") and those narration blocks are the milestone boundaries. A
// narration block that follows tool activity opens a new milestone whose
// label is that narration (live, streaming into the message); the tools
// that run beneath it are its "steps" (name + brief detail + duration).
// A turn that never uses tools degenerates to the classic single-
// placeholder flow: the seed message's label grows from the narration and
// the final reply replaces it.
//
// Env: STREAM_PROGRESS=messages (this mode) | preview (the pre-branch
// single-placeholder streaming, still available) | off.

const MAX_MILESTONES = 10; // flood guard: beyond this, narrations fold into the last message
const LABEL_LIVE_BUDGET = 400; // chars of narration shown while the milestone runs
const LABEL_FROZEN_BUDGET = 120; // chars kept when the milestone message freezes
const STEP_DETAIL_BUDGET = 60;
const LIVE_STEPS = 3; // steps shown on the live message
const FROZEN_STEPS = 6; // steps kept when the milestone message freezes

export class ProgressReporter {
  // ({ tg, chatId, threadId, seedMessageId, editIntervalMs })
  // seedMessageId: the turn's initial "⌛ …" message, adopted as milestone #1.
  constructor({ tg, chatId, threadId, seedMessageId, editIntervalMs = 5000 }) {
    this.tg = tg;
    this.chatId = chatId;
    this.threadId = threadId;
    this.editIntervalMs = editIntervalMs;
    this.milestones = [{ messageId: seedMessageId, label: '', steps: [], closed: false }];
    this.startedAt = Date.now();
    this._toolsSinceText = false;
    this._dirty = false;
    this._dead = false;
    this._timer = null;
    this._lastEditAt = Date.now(); // counts the seed post itself
    this._postChain = Promise.resolve(); // keeps milestone posts in order
  }

  get current() {
    return this.milestones[this.milestones.length - 1];
  }

  currentMessageId() {
    return this.current?.messageId ?? null;
  }

  // A narration text delta. If tools ran since the last text, this delta
  // opens the next milestone; otherwise it just extends the current label.
  narration(delta) {
    if (this._dead || typeof delta !== 'string' || !delta) return;
    if (this._toolsSinceText && this.milestones.length < MAX_MILESTONES) {
      this._freezeCurrent();
      this._openMilestone();
      this._toolsSinceText = false;
    }
    const m = this.current;
    m.label = (m.label + delta).slice(0, LABEL_LIVE_BUDGET);
    this._touch();
  }

  // tool_call payload ({toolName, input, toolCallId}) -- full input is the
  // best source for the step's human detail.
  toolCall({ toolName, input, toolCallId }) {
    if (this._dead) return;
    this._toolsSinceText = true;
    const m = this.current;
    m.steps = m.steps.filter((s) => s.toolCallId !== toolCallId); // idempotent per call id
    m.steps.push({ tool: toolName || 'tool', detail: stepDetail(toolName, input), toolCallId, startedAt: Date.now(), done: false });
    this._touch();
  }

  toolResult({ toolCallId }) {
    if (this._dead) return;
    for (const m of this.milestones) {
      const s = m.steps.find((x) => x.toolCallId === toolCallId);
      if (s) {
        s.done = true;
        s.durationMs = Date.now() - s.startedAt;
        break;
      }
    }
    this._touch();
  }

  // Close everything at turn end. Returns (after all freeze edits have been
  // sent, so ordering vs the final reply message is deterministic) the
  // message id the final reply should REPLACE -- the degenerate
  // single-milestone, tool-less case -- or null when the reply should go
  // out as its own message after the milestone trail.
  async settle() {
    this._freezeCurrent();
    this._cancelTimer();
    await this._postChain.catch(() => {});
    const only = this.milestones.length === 1 && this.milestones[0].steps.length === 0;
    return only ? this.milestones[0].messageId : null;
  }

  // Hard stop (turn cancelled / watchdog / shutdown): freeze quietly, no
  // more edits from this reporter.
  stop() {
    this._dead = true;
    this._cancelTimer();
  }

  // --- internals ---

  _openMilestone() {
    const m = { messageId: null, label: '', steps: [], closed: false };
    this.milestones.push(m);
    this._postChain = this._postChain
      .then(() => this.tg.sendMessage({ chatId: this.chatId, messageThreadId: this.threadId, text: '⏳ …' }))
      .then((msg) => {
        m.messageId = msg.message_id;
        this._touch();
      })
      .catch((e) => {
        // Could not post (Telegram down, bot kicked): fold back into the
        // previous milestone instead of losing the narration.
        console.error('[progress] failed to post milestone message:', e.message);
        this.milestones = this.milestones.filter((x) => x !== m);
      });
  }

  _freezeCurrent() {
    const m = this.current;
    if (!m || m.closed) return;
    m.closed = true;
    const text = frozenText(m);
    if (m.messageId == null) return; // post still in flight; label lives on only in memory
    this._postChain = this._postChain.then(() =>
      this.tg.editMessageText({ chatId: this.chatId, messageId: m.messageId, text }).catch((e) => {
        if (!/not modified/i.test(e.message || '')) console.error('[progress] failed to freeze milestone:', e.message);
      }),
    );
  }

  _touch() {
    if (this._dead || this._timer || this.current?.messageId == null) return;
    const wait = Math.max(0, this._lastEditAt + this.editIntervalMs - Date.now());
    this._dirty = true;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush().catch(() => {});
    }, wait);
  }

  _cancelTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._dirty = false;
  }

  async _flush() {
    const m = this.current;
    if (this._dead || !m || m.closed || !this._dirty || m.messageId == null) return;
    this._dirty = false;
    const text = liveText(m, this.startedAt);
    try {
      await this.tg.editMessageText({ chatId: this.chatId, messageId: m.messageId, text });
    } catch (e) {
      const msg = e.message || '';
      if (/message to edit not found|MESSAGE_ID_INVALID/i.test(msg)) {
        this._dead = true; // user deleted the live message; stop editing (freeze path still allowed)
        return;
      }
      if (!/not modified/i.test(msg)) {
        console.error('[progress] edit failed (will retry on next update):', msg);
        this._dirty = true;
      }
    }
    this._lastEditAt = Date.now();
    if (this._dirty) this._touch();
  }
}

function liveText(m, turnStartedAt) {
  const elapsed = elapsedLabel(Date.now() - turnStartedAt);
  const label = oneLine(m.label) || 'Working…';
  const steps = m.steps.slice(-LIVE_STEPS).map((s) => `▪ ${s.done ? '✓' : '▶'} ${s.tool}${s.detail ? ` · ${s.detail}` : ''}`);
  return [`⏳ ${label}`, ...steps, elapsed].join('\n');
}

function frozenText(m) {
  const label = oneLine(m.label) || 'Working…';
  const steps = m.steps.slice(-FROZEN_STEPS).map((s) => `▪ ${s.tool}${s.detail ? ` · ${s.detail}` : ''}${s.durationMs ? ` (${Math.max(1, Math.round(s.durationMs / 1000))}s)` : ''}`);
  const more = m.steps.length > FROZEN_STEPS ? [`▪ +${m.steps.length - FROZEN_STEPS} more`] : [];
  return [`✅ ${truncate(label, LABEL_FROZEN_BUDGET)}`, ...steps, ...more].join('\n');
}

function stepDetail(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  const t = (toolName || '').toLowerCase();
  if (t === 'bash' && typeof input.command === 'string') return truncate(input.command.split('\n')[0], STEP_DETAIL_BUDGET);
  if (typeof input.file_path === 'string') return truncate(input.file_path.split('/').slice(-2).join('/'), STEP_DETAIL_BUDGET);
  if (typeof input.path === 'string') return truncate(input.path.split('/').slice(-2).join('/'), STEP_DETAIL_BUDGET);
  if (typeof input.pattern === 'string') return truncate(input.pattern, STEP_DETAIL_BUDGET);
  if (typeof input.query === 'string') return truncate(input.query, STEP_DETAIL_BUDGET);
  if (typeof input.description === 'string') return truncate(input.description, STEP_DETAIL_BUDGET);
  if (typeof input.url === 'string') return truncate(input.url, STEP_DETAIL_BUDGET);
  return '';
}

function oneLine(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function truncate(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s;
}

function elapsedLabel(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
