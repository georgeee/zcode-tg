// zcode <-> Telegram bridge.
//
// One Telegram forum topic == one zcode session. Sending a message in a
// topic sends it to that session; the reply STREAMS into the topic's
// placeholder message (edited in place, at most once per
// STREAM_EDIT_INTERVAL_MS, prefixed ⌛ while the turn is still running) and
// is finalized there when the turn ends -- with a small usage footer
// (duration · tokens · tool calls). A message sent while a turn is still
// running is queued (persistently) and runs when that turn ends.
// Send /stop (or /cancel) in a busy topic to abort its in-progress turn.
//
// Bridge commands (intercepted before anything reaches the model; anything
// else starting with / is passed through to zcode's own command handling):
//   /usage      Z.ai plan quota, from the account's monitoring endpoint
//   /stop /cancel   cancel the topic's running turn
//   /queue      list this topic's queued messages
//   /clearqueue drop this topic's queued messages
//   /model      list models / switch this topic's model
//   /mode       list modes / switch this topic's session mode
//   /file       send a file from the workspace into this topic
//   /help       the list above
// These are registered with BotFather-style autocomplete (setMyCommands)
// on every boot.
//
// Model replies are rendered from markdown to Telegram HTML (bridge/format.js)
// and split under the 4096-char message cap; if Telegram ever rejects the
// entities, the chunk falls back to plain text rather than being lost.
//
// The model's mid-turn questions (interaction/requestUserInput, the
// AskUserQuestion tool) are posted to the topic as inline-button prompts and
// genuinely answered from Telegram; with no answer within
// USER_INPUT_TIMEOUT_MS they are declined so the turn keeps moving.
//
// Permission requests: sessions run in "yolo" mode (auto-approve) by
// default, and any interaction/requestPermission that still arrives is
// auto-approved with a non-blocking notice posted to the topic. Set
// AUTO_APPROVE_PERMISSIONS=false to fall back to interactive Approve/Deny
// inline-keyboard prompts instead.
//
// Each topic also gets a status message (model · mode · busy/idle · queue),
// pinned if the bot has pin rights, updated whenever that state changes.
//
// Background tasks: when a task started by the agent finishes while the
// session is idle, zcode emits a task-completed session event and then
// auto-starts a "task notification" turn. The bridge posts a 🌀 notice for
// the former and adopts the latter (fresh ⌛ placeholder, normal delivery),
// so the agent's own follow-up on the completed task reaches the topic
// instead of being silently dropped.
//
// Transport is Telegram long-polling only -- no inbound port, no webhook,
// nothing to put behind the TLS cert (that's for the future WebSocket/app
// phase). Run this as a long-lived process (see README.md for the systemd
// unit); it does not daemonize itself.

import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from './env.js';
import { ZcodeClient } from './zcodeClient.js';
import { TelegramClient, TelegramClient as TG } from './telegram.js';
import { Store } from './store.js';
import { renderReply, toPlainText } from './format.js';
import { ReplyStreamer } from './streamer.js';
import { readZaiApiKey, readZaiProvider, fetchUsage, renderUsage } from './usage.js';

// Deliberately NOT ../.env (repo root == the zcode agent's own workspace):
// a session running in this same directory could read that file as part of
// completely ordinary "look at your own code" work and echo the bot token
// back into Telegram, no adversarial intent required. Kept outside the
// workspace instead. ZCODE_MOBILE_ENV overrides for other deployments.
loadEnv(process.env.ZCODE_MOBILE_ENV || `${process.env.HOME}/.config/zcode-mobile-bridge/.env`);

const cfg = {
  telegramToken: need('TELEGRAM_BOT_TOKEN'),
  chatId: Number(need('TELEGRAM_CHAT_ID')),
  allowedUserId: Number(need('TELEGRAM_ALLOWED_USER_ID')),
  nodeBin: process.env.ZCODE_NODE_BIN || process.execPath,
  zcodeBin: need('ZCODE_BIN'),
  workspaceDir: need('ZCODE_WORKSPACE_DIR'),
  defaultModel: process.env.ZCODE_DEFAULT_MODEL || 'zai/glm-5.3',
  storePath: process.env.STORE_PATH || new URL('../data/sessions.json', import.meta.url).pathname,
  permissionTimeoutMs: Number(process.env.PERMISSION_TIMEOUT_MS || 10 * 60 * 1000), // 10 min
  autoApprovePermissions: process.env.AUTO_APPROVE_PERMISSIONS !== 'false', // default: on
  defaultSessionMode: process.env.ZCODE_DEFAULT_MODE || 'yolo',
  // Turns STREAM their reply into the placeholder; this paces those edits
  // (one edit per message per interval, per the agreed Telegram-side
  // contract -- the 20 msg/min group cap is explicitly not a constraint).
  streamEditIntervalMs: Number(process.env.STREAM_EDIT_INTERVAL_MS || 5000),
  // How long a posted AskUserQuestion prompt waits for a button tap before
  // being declined (the turn keeps going either way).
  userInputTimeoutMs: Number(process.env.USER_INPUT_TIMEOUT_MS || 10 * 60 * 1000),
  // /file upload cap (Telegram bots accept up to 50 MB documents).
  maxFileBytes: Number(process.env.MAX_FILE_MB || 45) * 1024 * 1024,
  // Opt-in-only safety net for a turn that's accepted but never emits
  // turn.terminal. DISABLED by default (0) per owner decision 2026-09-01:
  // a 20-minute cap killed real, merely-slow turns (turns here regularly
  // run longer), so /stop is the designated escape hatch instead. Set
  // TURN_TIMEOUT_MS to re-arm it.
  turnTimeoutMs: Number(process.env.TURN_TIMEOUT_MS || 0),
  // /usage reads the key from zcode's own config at call time -- never
  // copied into this process's env or the store.
  zaiConfigPath: process.env.ZAI_CONFIG_PATH || `${process.env.HOME}/.zcode/cli/config.json`,
  maxQueuePerTopic: Number(process.env.MAX_QUEUE_PER_TOPIC || 20),
};

// Registered with Telegram on boot so these show as / autocomplete in the
// client. Keep in sync with the command handling in handleMessage().
const BOT_COMMANDS = [
  { command: 'usage', description: 'Z.ai plan usage & quota' },
  { command: 'stop', description: "Cancel this topic's running turn" },
  { command: 'cancel', description: "Cancel this topic's running turn" },
  { command: 'queue', description: 'Show queued messages in this topic' },
  { command: 'clearqueue', description: 'Drop queued messages in this topic' },
  { command: 'model', description: 'List / switch this topic’s model' },
  { command: 'mode', description: 'List / switch this topic’s mode' },
  { command: 'file', description: 'Send a workspace file into this topic' },
  { command: 'help', description: 'Bridge commands' },
];

function need(key) {
  const v = process.env[key];
  if (!v) throw new Error(`missing required env var: ${key}`);
  return v;
}

const store = new Store(cfg.storePath);
const tg = new TelegramClient({ token: cfg.telegramToken });
const zcode = new ZcodeClient({
  nodeBin: cfg.nodeBin,
  zcodeBin: cfg.zcodeBin,
  cwd: cfg.workspaceDir,
}).start();

zcode.on('exit', ({ code, signal }) => {
  console.error(`[bridge] zcode app-server exited unexpectedly (code=${code} signal=${signal}); exiting so the service manager restarts us`);
  process.exit(1);
});
zcode.on('stderr', (text) => process.stderr.write(`[zcode stderr] ${text}`));
zcode.on('parseError', ({ line, error }) => console.error('[bridge] unparseable line from zcode:', error.message, line.slice(0, 200)));

// Defense in depth only -- every await chain in this file is intended to be
// caught somewhere already (per-update try/catch in main(), try/catches
// around individual RPCs). This is a backstop against a *future* unguarded
// await slipping in unnoticed, not a substitute for handling errors at the
// point they occur: log and keep running rather than let Node's default
// behavior (crash the whole process) turn one bad await into an outage for
// every topic.
process.on('unhandledRejection', (err) => console.error('[bridge] unhandled rejection:', err));

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
function shutdown(signal) {
  // Under systemd this is redundant with the default KillMode=control-group
  // (which already reaps the whole cgroup including the app-server child on
  // stop/restart). It matters for the foreground/dev-loop path README.md
  // documents (`node bridge/index.js`, stopped by something other than a
  // same-terminal Ctrl+C) where nothing else guarantees the child doesn't
  // outlive us as an orphaned, still-authenticated zcode process.
  console.log(`[bridge] received ${signal}, stopping zcode app-server and exiting`);
  zcode.stop();
  process.exit(0);
}

// --- in-memory routing state (rebuilt each process start; durable session
// identities live in `store`) ---
const subscribedSessions = new Set(); // sessionId we've called session/subscribe for, this process
const sessionToTopic = new Map(); // sessionId -> { threadId }
const busySessions = new Set(); // sessionId currently running a turn
const activeTurns = new Map(); // sessionId -> { placeholderMessageId, textBuffer, startedAt, turnId?, streamer, usageSummary?, toolNames, adopted? }
const pendingPermissions = new Map(); // requestId -> { resolve, tokenMap: Map(token->response), chatId, threadId }
const pendingUserInputs = new Map(); // requestId -> { resolve, timer, questions, answers, tokenToChoice, chatId, threadId }
const tokenToRequestId = new Map(); // callback_data token -> requestId ('p_' permissions, 'u_' user input)

// interaction/requestUserInput (the model's "AskUserQuestion" tool, asking a
// mid-turn clarifying question). The server sends
//   { input, prompt, requestId, sessionId, toolName, turnId,
//     questions: [{ header, multiSelect, question,
//                   options: [{ label, description, value }] }] }
// (field shapes verified against the vendored runtime's emitter, DOi/ROi in
// the bundle: each option's protocol value IS its label) and expects a reply
// matching { action: "accept"|"decline"|"cancel", content?, reason? } --
// where accept+content gets merged back into the tool input as
// content.answers keyed by question text (or answer_0..N). Anything else --
// decline in particular -- must remain a *valid* reply: the runtime's
// default client-request path only degrades gracefully for valid declines,
// and letting the blanket "unregistered method -> error" default answer
// instead rethrows inside the runtime's own race wrapper and most likely
// fails the tool call outright.
//
// The bridge posts one message per question with inline buttons (plus Skip),
// waits up to cfg.userInputTimeoutMs for taps, then answers. Timeout ->
// decline (same as the old auto-decline behavior, just later). One tap per
// question; multiSelect questions are answered single-pick (documented
// limitation -- Telegram buttons don't toggle).
zcode.onServerRequest('interaction/requestUserInput', async (params) => {
  const topic = sessionToTopic.get(params.sessionId);
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (!topic || !questions.length || !questions.every((q) => Array.isArray(q.options) && q.options.length)) {
    return { action: 'decline', reason: 'bridge: question not deliverable to Telegram (no topic or malformed questions)' };
  }

  const tokenToChoice = new Map(); // token -> { question, label, value, skip }
  const state = {
    resolve: null,
    timer: null,
    chatId: cfg.chatId,
    threadId: topic.threadId,
    questions: [],
    answers: {},
    tokenToChoice,
  };

  for (const [qi, q] of questions.entries()) {
    const lines = [`❓ ${q.header || 'Question'}`, q.question || ''].filter(Boolean);
    if (q.multiSelect) lines.push('(multi-select — pick one)');
    if (questions.length > 1) lines.push(`(question ${qi + 1} of ${questions.length})`);
    const buttons = q.options.slice(0, 8).map((opt) => {
      const token = 'u_' + randomBytes(6).toString('hex');
      const label = truncate(opt.label || String(opt.value ?? 'option'), 60);
      tokenToChoice.set(token, { question: q, label, value: opt.value ?? opt.label, skip: false });
      if (opt.description) lines.push(`• ${label} — ${truncate(opt.description, 200)}`);
      return { text: label, data: token };
    });
    const skipToken = 'u_' + randomBytes(6).toString('hex');
    tokenToChoice.set(skipToken, { question: q, skip: true });
    buttons.push({ text: '✖ Skip', data: skipToken });

    let msg;
    try {
      msg = await tg.sendMessage({
        chatId: cfg.chatId,
        messageThreadId: topic.threadId,
        text: lines.join('\n'),
        replyMarkup: TG.inlineKeyboard(buttons),
      });
    } catch (e) {
      // If we can't deliver some of the questions, the request as a whole
      // can't be interactively answered -- clean up what was already posted
      // and decline cleanly rather than leave half a prompt behind.
      console.error('[bridge] failed to post user-input prompt:', e.message);
      for (const posted of state.questions) {
        await tg.editMessageText({ chatId: cfg.chatId, messageId: posted.messageId, text: '⚠️ Not deliverable — question declined.', replyMarkup: { inline_keyboard: [] } }).catch(() => {});
        store.removePendingPermission(userInputStoreKey(params.requestId, posted.index));
      }
      return { action: 'decline', reason: `bridge: failed to deliver the question to Telegram (${e.message})` };
    }
    state.questions.push({ index: qi, key: q.question, messageId: msg.message_id, header: q.header || '' });
    // Reused pendingPermissions storage (see its comment): entries orphaned by
    // a restart get their buttons swept and cleared at next startup.
    store.addPendingPermission(userInputStoreKey(params.requestId, qi), { chatId: cfg.chatId, messageId: msg.message_id, threadId: topic.threadId, kind: 'userInput' });
  }

  // The turn is now blocked on this answer -- say so on the ⌛ placeholder.
  const turn = activeTurns.get(params.sessionId);
  if (turn?.streamer) turn.streamer.update({ status: '❓ waiting for your answer above' });

  return new Promise((resolve) => {
    state.resolve = resolve;
    state.timer = setTimeout(() => {
      finishUserInput(params.requestId, { action: 'decline', reason: 'auto-declined: no answer within timeout' }, (q) => '⏱ Expired — declined.');
    }, cfg.userInputTimeoutMs);
    pendingUserInputs.set(params.requestId, state);
  });
});

function userInputStoreKey(requestId, index) {
  return `${requestId}#q${index}`;
}

function finishUserInput(requestId, response, labelFor) {
  const pending = pendingUserInputs.get(requestId);
  if (!pending) return;
  pendingUserInputs.delete(requestId);
  clearTimeout(pending.timer);
  for (const token of pending.tokenToChoice.keys()) tokenToRequestId.delete(token);
  for (const q of pending.questions) store.removePendingPermission(userInputStoreKey(requestId, q.index));
  pending.resolve(response);
  for (const q of pending.questions) {
    const label = typeof labelFor === 'function' ? labelFor(q, pending.answers[q.key]) : labelFor;
    if (label != null) {
      tg.editMessageText({ chatId: pending.chatId, messageId: q.messageId, text: label, replyMarkup: { inline_keyboard: [] } }).catch((e) => console.error('[bridge] failed to finalize user-input message:', e.message));
    }
  }
}

// A button tap on a user-input question (routed from handleCallbackQuery).
function handleUserInputTap(requestId, token, choice) {
  const pending = pendingUserInputs.get(requestId);
  if (!pending) return null;
  if (choice.skip) {
    finishUserInput(requestId, { action: 'decline', reason: 'declined from Telegram' }, () => '✖ Declined by you.');
    return 'Declined';
  }
  pending.answers[choice.question.question] = choice.value;
  const qState = pending.questions.find((q) => q.key === choice.question.question);
  if (qState) {
    tg.editMessageText({ chatId: pending.chatId, messageId: qState.messageId, text: `✅ ${choice.label}`, replyMarkup: { inline_keyboard: [] } }).catch(() => {});
  }
  const unanswered = pending.questions.filter((q) => pending.answers[q.key] === undefined);
  if (!unanswered.length) {
    finishUserInput(requestId, { action: 'accept', content: { answers: pending.answers } }, (q) => `✅ ${pending.answers[q.key] ?? '—'}`);
    return 'Answered';
  }
  return `Recorded (${unanswered.length} left)`;
}

// --- permission relay: server asks, we answer (auto-approve by default) ---
zcode.onServerRequest('interaction/requestPermission', async (params) => {
  const topic = sessionToTopic.get(params.sessionId);

  if (cfg.autoApprovePermissions) {
    const response = pickAutoApproveOption(params.options);
    if (topic) {
      const reason = truncate(params.reason, 300);
      queueAutoApproveNotice(`🔓 auto-approved: ${params.toolName} (${params.riskLevel})${reason ? ` — ${reason}` : ''}`, topic.threadId);
    }
    return response;
  }

  if (!topic) {
    // Session we don't know about asked for permission (shouldn't happen in
    // practice) -- fail safe rather than hang the turn forever.
    return { decision: 'deny', reason: 'bridge: no Telegram topic mapped for this session' };
  }

  const tokenMap = new Map();
  const buttons = params.options.map((opt) => {
    const token = 'p_' + randomBytes(6).toString('hex');
    tokenMap.set(token, opt.response);
    tokenToRequestId.set(token, params.requestId);
    return { text: opt.name, data: token };
  });

  // reason has no length limit in the protocol (bare Zod string, no
  // .max()); input already goes through the same truncate() below. Left
  // unbounded, a long reason can push this composed message over
  // Telegram's 4096-char cap, which throws *before* the pendingPermissions
  // entry or timeout timer are ever created -- silently killing the whole
  // interactive flow for that request with no Approve/Deny prompt ever
  // reaching the user.
  const inputPreview = safePreview(params.input);
  const reason = truncate(params.reason, 500);
  const text = [
    `🔐 Permission requested`,
    `Tool: ${params.toolName}  ·  risk: ${params.riskLevel}`,
    reason ? `Reason: ${reason}` : null,
    inputPreview ? `Input: ${inputPreview}` : null,
  ].filter(Boolean).join('\n');

  let msg;
  try {
    msg = await tg.sendMessage({
      chatId: cfg.chatId,
      messageThreadId: topic.threadId,
      text,
      replyMarkup: TG.inlineKeyboard(buttons),
    });
  } catch (e) {
    // If posting the prompt itself fails (Telegram unreachable, bot removed
    // from the group, ...), fall through to the generic decline-via-error
    // path in ZcodeClient, which is NOT confirmed safe for this specific
    // method (unlike session/requestRuntimePreferences and
    // interaction/requestOfficialMcpAuthHeaders, which do have a confirmed
    // fallback). Return an explicit, schema-valid deny instead, matching
    // the !topic fail-safe above, so the failure mode is always "cleanly
    // denied" rather than "unverified effect on the in-flight turn."
    console.error('[bridge] failed to post permission prompt:', e.message);
    return { decision: 'deny', reason: `bridge: failed to deliver the permission prompt to Telegram (${e.message})` };
  }

  // Persisted so a request still awaiting a button press when the process
  // dies isn't left as an orphaned message with dead-but-still-clickable
  // buttons forever -- swept and cleaned up on the next startup, below.
  store.addPendingPermission(params.requestId, { chatId: cfg.chatId, messageId: msg.message_id, threadId: topic.threadId });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const denyOpt = params.options.find((o) => o.response?.decision === 'deny');
      finishPermission(params.requestId, denyOpt?.response ?? { decision: 'deny', reason: 'auto-denied: no response within timeout' }, '⏱ Expired — auto-denied (no response in time).');
    }, cfg.permissionTimeoutMs);

    pendingPermissions.set(params.requestId, {
      resolve,
      tokenMap,
      chatId: cfg.chatId,
      messageId: msg.message_id,
      timer,
    });
  });
});

function finishPermission(requestId, response, resultLabel) {
  const pending = pendingPermissions.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingPermissions.delete(requestId);
  for (const token of pending.tokenMap.keys()) tokenToRequestId.delete(token);
  store.removePendingPermission(requestId);
  pending.resolve(response);
  // Explicitly clearing reply_markup matters: Telegram's editMessageText
  // only touches the keyboard if you pass one -- omitting it (the previous
  // bug here) leaves the old buttons live and clickable indefinitely, even
  // after the request has already been resolved or has timed out.
  tg.editMessageText({ chatId: pending.chatId, messageId: pending.messageId, text: resultLabel, replyMarkup: { inline_keyboard: [] } }).catch((e) =>
    console.error('[bridge] failed to edit permission message:', e.message),
  );
}

// Sweep permission requests left dangling by a previous process instance
// (in-memory `pendingPermissions` above resets on every restart, but this
// disk-backed record survives it) -- clear their buttons and mark them
// expired rather than leaving them clickable forever with nothing listening
// on the other end anymore.
async function cleanupOrphanedPermissionRequests() {
  const orphans = store.getAllPendingPermissions();
  const requestIds = Object.keys(orphans);
  if (!requestIds.length) return;
  console.log(`[bridge] cleaning up ${requestIds.length} permission request(s) orphaned by a previous restart`);
  for (const requestId of requestIds) {
    const { chatId, messageId } = orphans[requestId];
    await tg
      .editMessageText({ chatId, messageId, text: '⚠️ Expired — bridge restarted before this was answered.', replyMarkup: { inline_keyboard: [] } })
      .catch((e) => console.error(`[bridge] failed to clean up orphaned permission request ${requestId}:`, e.message));
    store.removePendingPermission(requestId);
  }
}

function pickAutoApproveOption(options) {
  // Prefer a broad/persistent allow (avoids repeat prompts within the same
  // session) if the server offers one, then any plain allow, then anything
  // that isn't an explicit denial, then just the first option -- always
  // answer *something* valid rather than leave the turn hanging.
  const chosen =
    options.find((o) => o.response?.decision === 'allow' && o.response?.permissionUpdates?.length) ||
    options.find((o) => o.response?.decision === 'allow') ||
    options.find((o) => o.response?.decision !== 'deny') ||
    options[0];
  return chosen.response;
}

// Auto-approve notices are the traffic pattern most likely to burst --
// potentially one per tool call within a single turn, fired with no human
// pacing them, against Telegram's stricter documented group-wide cap
// ("bots are not able to send more than 20 messages per minute" in a
// group), which is shared across every topic in this one physical group.
// Serializing just this one class of (lowest-priority, audit-only) message
// with a minimum spacing doesn't make the bridge immune to the cap when
// combined with all its other traffic, but it keeps the audit trail itself
// from being the thing that trips it during a busy, unattended turn --
// precisely when auto-approve mode produces the most permission events and
// a human is least likely to be watching to notice a gap.
let autoApproveNoticeQueue = Promise.resolve();
function queueAutoApproveNotice(text, threadId) {
  autoApproveNoticeQueue = autoApproveNoticeQueue
    .then(() => tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text }))
    .catch((e) => console.error('[bridge] failed to post auto-approve notice:', e.message))
    .then(() => sleep(1100));
}

// Codepoint-aware (not UTF-16-code-unit-aware): plain `.slice(0, n)` can
// split an astral character's surrogate pair in half, e.g. splitting an
// emoji right at the truncation boundary. Array.from iterates by codepoint.
function truncate(s, max) {
  if (!s) return s;
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s;
}

function safePreview(input) {
  try {
    const s = JSON.stringify(input);
    if (!s) return null;
    return truncate(s, 300);
  } catch {
    return null;
  }
}

// --- session event routing: zcode -> Telegram ---
zcode.on('event', (msg) => {
  if (process.env.BRIDGE_DEBUG_EVENTS) {
    console.log(`[dbg] ${msg.method} kind=${msg.params?.kind ?? msg.params?.payload?.kind ?? '-'} session=${String(msg.params?.sessionId ?? '').slice(-8)} turn=${String(msg.params?.turnId ?? '').slice(-8)}`);
  }
  const sessionId = msg.params?.sessionId;
  if (!sessionId) return;
  const turn = activeTurns.get(sessionId);

  // activeTurns is keyed by sessionId, and a topic's next turn can start
  // (new activeTurns entry, same sessionId key) essentially the instant
  // finalizeTurn() clears the previous one -- both are driven by
  // independent async I/O (Telegram's poll loop vs. zcode's stdout stream)
  // with nothing else serializing them. A straggling event for the turn
  // that JUST finished (protocol delivery/ordering across these event
  // "kinds" isn't documented as strict) could otherwise bleed into the
  // next turn's buffer. Both session/event and v4/telemetry/event carry
  // turnId at the top level of params; correlate on it once we've learned
  // it from that turn's own turn.started event, and ignore anything that
  // doesn't match.
  if (turn && msg.params.turnId) {
    const isTurnStart = msg.method === 'v4/telemetry/event' && msg.params.kind === 'turn.started';
    if (!turn.turnId) {
      if (isTurnStart) turn.turnId = msg.params.turnId;
      // else: haven't seen turn.started for THIS turn yet -- can't yet tell
      // a genuine early event of this turn from a last straggler of the one
      // we just superseded. Narrow residual race, not fully closed; the
      // common case (turn.started arrives before any content) is handled.
    } else if (turn.turnId !== msg.params.turnId) {
      return; // confirmed straggler from a different turn -- ignore
    }
  }

  if (msg.method === 'session/event') {
    const payload = msg.params.payload;
    if (!turn) {
      // Background-task lifecycle snapshots carry {taskId, status} with no
      // `kind` discriminator, and keep arriving after the turn that started
      // the task has ended. A task reaching a terminal status while the
      // session is idle is the one thing worth acting on here: post the 🌀
      // notice; the notification turn the runtime auto-starts next is picked
      // up by adoptUnclaimedTurn below.
      if (payload?.taskId && payload.status && payload.status !== 'running') void handleBackgroundTaskFinished(sessionId, payload);
      return;
    }

    if (payload?.kind === 'text_delta' && typeof payload.delta === 'string') {
      turn.textBuffer += payload.delta;
      turn.streamer?.update({ text: turn.textBuffer, status: null });
    } else if (payload?.kind === 'reasoning_delta') {
      turn.streamer?.update({ status: '💭' });
    } else if ((payload?.kind === 'started' || payload?.kind === 'scheduled' || payload?.kind === 'tool_input_start') && payload.toolName) {
      if (payload.toolCallId) turn.toolNames.set(payload.toolCallId, payload.toolName);
      turn.streamer?.update({ status: `🔧 ${payload.toolName}` });
    } else if (payload?.kind === 'result') {
      // result payloads carry toolCallId but not toolName; look up the name
      // learned at started/scheduled time.
      const name = payload.toolName ?? (payload.toolCallId && turn.toolNames.get(payload.toolCallId)) ?? 'tool';
      turn.streamer?.update({ status: `🔧 ${name} ✓` });
    } else if (payload?.taskId && payload.status && payload.status !== 'running') {
      // Task finished while THIS turn is still running: the notification is
      // injected into the model's next request anyway; a status hint on the
      // placeholder is enough.
      turn.streamer?.update({ status: `🌀 task ${payload.status}` });
    }

    if (typeof payload?.response === 'string' && payload.usage) {
      // Turn-level final event ({response, tokenCount, usage, toolCallCount,
      // duration, resultType} -- verified live): authoritative full-turn text
      // plus the cumulative usage the footer renders from.
      turn.finalText = payload.response;
      turn.usageSummary = payload.usage;
    } else if (typeof payload?.content === 'string' && payload.content) {
      // Last assistant message's text. The guard matters: a model request
      // that ends in tool calls also emits {content: ""} -- an empty string
      // is NOT nullish and used to blank the reply by overriding the
      // accumulated delta buffer at finalize time.
      turn.finalText = payload.content;
    } else if (payload?.error) {
      turn.error = payload.error;
    }
    return;
  }

  if (msg.method === 'v4/telemetry/event') {
    const kind = msg.params.kind;
    // The runtime auto-starts turns the bridge never sent (verified live:
    // a completed background task injects a <task-notification> input and
    // runs a fresh turn seconds after the previous one ended). Without
    // adoption those turns' events hit the `if (!turn) return` paths and
    // their entire reply is generated, persisted... and never delivered.
    if (kind === 'turn.started' && !turn && !busySessions.has(sessionId) && sessionToTopic.has(sessionId)) {
      void adoptUnclaimedTurn(sessionId, msg.params);
      return;
    }
    // Per-model-request usage, used by the footer as a fallback: the
    // turn-final session event ({response, usage}) is the nicer source but
    // arrives on a different event channel whose ordering vs turn.terminal
    // is NOT guaranteed -- observed live both ways. usage.delta reliably
    // precedes terminal, so accumulating it per requestId covers the case
    // where the response event lands after finalize has already run.
    if (kind === 'usage.delta' && turn && msg.params.requestId) {
      if (!turn.requestUsage) turn.requestUsage = new Map();
      turn.requestUsage.set(msg.params.requestId, { inputTokens: msg.params.inputTokens, outputTokens: msg.params.outputTokens });
      return;
    }
    if (kind === 'turn.terminal') {
      void finalizeTurn(sessionId, msg.params);
    }
  }
});

async function adoptUnclaimedTurn(sessionId, params) {
  const topic = sessionToTopic.get(sessionId);
  if (!topic) return;
  busySessions.add(sessionId);
  // Registered before the placeholder send so early events of this turn have
  // something to land on; placeholderMessageId fills in once posted.
  const entry = { placeholderMessageId: null, textBuffer: '', startedAt: Date.now(), turnId: params.turnId, toolNames: new Map(), adopted: true };
  activeTurns.set(sessionId, entry);
  let msg;
  try {
    msg = await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: topic.threadId, text: '⌛ 🌀 …' });
  } catch (e) {
    console.error(`[bridge] failed to post placeholder for auto-started turn ${params.turnId}; dropping it:`, e.message);
    activeTurns.delete(sessionId);
    busySessions.delete(sessionId);
    return;
  }
  entry.placeholderMessageId = msg.message_id;
  entry.streamer = new ReplyStreamer({ tg, chatId: cfg.chatId, messageId: msg.message_id, threadId: topic.threadId, minEditIntervalMs: cfg.streamEditIntervalMs });
  entry.streamer.update({ text: entry.textBuffer, status: '🌀 processing' });
  updateTopicStatus(topic.threadId, 'busy').catch(() => {});
  console.log(`[bridge] adopted auto-started turn ${params.turnId} on session ${sessionId}`);
}

async function handleBackgroundTaskFinished(sessionId, payload) {
  const topic = sessionToTopic.get(sessionId);
  if (!topic) return;
  const label = truncate(payload.description || payload.command || payload.taskId, 120);
  const icon = payload.status === 'completed' ? '✅' : '⚠️';
  await tg
    .sendMessage({ chatId: cfg.chatId, messageThreadId: topic.threadId, text: `🌀 Background task ${icon} ${label} — ${payload.status}` })
    .catch((e) => console.error('[bridge] failed to post background-task notice:', e.message));
}

async function finalizeTurn(sessionId, terminalParams) {
  const turn = activeTurns.get(sessionId);
  activeTurns.delete(sessionId);
  busySessions.delete(sessionId);
  const topic = sessionToTopic.get(sessionId);
  if (turn) {
    turn.streamer?.stop();
    let text;
    if (terminalParams.status === 'success') {
      text = turn.finalText ?? turn.textBuffer ?? '';
    } else {
      const err = turn.error;
      text = `⚠️ Turn failed: ${terminalParams.errorCode || 'unknown_error'}${err?.message ? `\n${err.message}` : ''}`;
    }
    if (turn.adopted && !text.trim()) {
      // Auto-started notification turns sometimes produce no user-facing
      // text; a quiet label beats spamming "(no reply text)".
      if (turn.placeholderMessageId) {
        await tg
          .editMessageText({ chatId: cfg.chatId, messageId: turn.placeholderMessageId, text: '🌀 Background task notification processed.' })
          .catch(() => {});
      }
    } else {
      const footer = terminalParams.status === 'success' ? usageFooter(turn, terminalParams) : '';
      await deliverReply(turn.placeholderMessageId, topic?.threadId, text.trim() ? text : '(no reply text)', footer);
    }
  }
  if (topic) {
    // Skip the idle write when a queued message immediately re-busies the
    // topic (drainQueue -> startTurn writes "busy") -- two racing edits of
    // the same status message can land out of order.
    if (!store.getQueue(topic.threadId).length) updateTopicStatus(topic.threadId, 'idle').catch(() => {});
  }
  // Whatever the user queued behind this turn runs now -- success, failure,
  // and the "!turn" early-return case all lead here for one reason: the
  // session is no longer busy, and the queue's whole contract is "runs when
  // the current message finishes".
  if (topic) void drainQueue(topic.threadId);
}

// Cost/steps footer appended to the delivered reply (agreed tier-1 item).
// Sources, in preference order: the turn-final session event's cumulative
// usage (verified live: {inputTokens, outputTokens, totalTokens, ...}), the
// sum of per-request usage.delta telemetry (same numbers, ordering-proof),
// and turn.terminal's durationMs/tokenCount/toolCallCount. No dollar figure
// exists anywhere in the protocol -- the plan is credit-based, /usage has
// the quota view.
function usageFooter(turn, terminal) {
  const u = turn.usageSummary ?? aggregateRequestUsage(turn.requestUsage);
  const parts = [];
  if (terminal?.durationMs != null) parts.push(`⏱ ${fmtDuration(terminal.durationMs)}`);
  if (u && (u.inputTokens != null || u.outputTokens != null)) {
    const total = terminal?.tokenCount ?? u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    parts.push(`${abbrev(total)} tok · ${abbrev(u.inputTokens)} in / ${abbrev(u.outputTokens)} out`);
  } else if (terminal?.tokenCount != null) {
    parts.push(`${abbrev(terminal.tokenCount)} tok`);
  }
  if (terminal?.toolCallCount) parts.push(`${terminal.toolCallCount} tool call${terminal.toolCallCount === 1 ? '' : 's'}`);
  return parts.length ? `\n\n<i>${parts.join(' · ')}</i>` : '';
}

function aggregateRequestUsage(map) {
  if (!map || !map.size) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const v of map.values()) {
    inputTokens += v.inputTokens ?? 0;
    outputTokens += v.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

function abbrev(n) {
  if (n == null) return '?';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

// Render the model's markdown as Telegram HTML, put the first chunk into the
// turn's placeholder, and follow with additional messages if it didn't fit.
// A Telegram entity-parse failure (a renderer bug we didn't foresee) falls
// back to tag-stripped plain text for that chunk: delivered unformatted beats
// not delivered. A null placeholderMessageId (adopted turns whose placeholder
// could not be posted) sends the first chunk as a fresh message instead.
async function deliverReply(placeholderMessageId, threadId, text, footerHtml = '') {
  const chunks = renderReply(text);
  if (!chunks.length || !chunks[0]) {
    chunks.length = 0;
    chunks.push('(no reply text)');
  }
  if (footerHtml) chunks[chunks.length - 1] += footerHtml;
  try {
    if (placeholderMessageId) {
      await tg.editMessageText({ chatId: cfg.chatId, messageId: placeholderMessageId, text: chunks[0], parseMode: 'HTML' });
    } else {
      await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: chunks[0], parseMode: 'HTML' });
    }
  } catch (e) {
    await sendChunkFallback(placeholderMessageId ? 'edit' : 'send', placeholderMessageId, threadId, chunks[0], e);
  }
  for (let i = 1; i < chunks.length; i++) {
    await sleep(350);
    try {
      await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: chunks[i], parseMode: 'HTML' });
    } catch (e) {
      await sendChunkFallback('send', null, threadId, chunks[i], e);
    }
  }
}

async function sendChunkFallback(method, messageId, threadId, chunk, originalError) {
  const isParseError = /parse entities|can't parse/i.test(originalError.message || '');
  if (!isParseError) {
    console.error(`[bridge] failed to deliver reply chunk (${method}):`, originalError.message);
    return;
  }
  console.error('[bridge] Telegram rejected rendered HTML, falling back to plain text:', originalError.message);
  const plain = truncate(toPlainText(chunk), 4000);
  try {
    if (method === 'edit') await tg.editMessageText({ chatId: cfg.chatId, messageId, text: plain });
    else await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: plain });
  } catch (e) {
    console.error('[bridge] plain-text fallback also failed:', e.message);
  }
}

// Force-clears any turn that's been open longer than cfg.turnTimeoutMs with
// no turn.terminal ever seen. DISABLED BY DEFAULT (turnTimeoutMs=0, owner
// decision 2026-09-01): real agentic turns here regularly exceed 20 minutes,
// and the cap killed a correct one mid-work; /stop below is the designated
// escape hatch for a genuinely wedged topic. Set TURN_TIMEOUT_MS to re-arm.
//
// IMPORTANT: this must call session/stop before clearing local state, not
// just wipe bookkeeping and walk away. Found the hard way: a turn that's
// merely SLOW (not actually hung -- e.g. a long agentic task doing real
// work) keeps running server-side even after the bridge stops tracking it.
// If it later completes, its events arrive with no `activeTurns` entry to
// attach to (the session/event handler's `if (!turn) return` silently
// drops them, including the final content), so the real, successful answer
// is generated and persisted in zcode's own history but never reaches
// Telegram -- exactly the "task performed well but didn't report" failure
// mode this was built to prevent, just relocated one level deeper. Calling
// session/stop here makes a watchdog timeout behave like /stop: the turn
// actually ends, instead of continuing to run unobserved.
setInterval(() => {
  if (!cfg.turnTimeoutMs) return; // default: watchdog off, /stop is the hatch
  const now = Date.now();
  for (const [sessionId, turn] of activeTurns) {
    if (now - turn.startedAt <= cfg.turnTimeoutMs) continue;
    console.error(`[bridge] turn on session ${sessionId} exceeded ${cfg.turnTimeoutMs}ms with no turn.terminal event -- stopping it and force-clearing`);
    turn.streamer?.stop();
    zcode.call('session/stop', { sessionId }).catch((e) => console.error(`[bridge] session/stop on watchdog timeout failed for ${sessionId} (state is cleared locally regardless):`, e.message));
    activeTurns.delete(sessionId);
    busySessions.delete(sessionId);
    const topic = sessionToTopic.get(sessionId);
    tg
      .editMessageText({
        chatId: cfg.chatId,
        messageId: turn.placeholderMessageId,
        text: '⚠️ No response after a long time — the turn has been stopped. Send another message to try again (or /stop next time to cancel earlier).',
      })
      .catch((e) => console.error('[bridge] failed to edit watchdog-timeout notice:', e.message))
      .finally(() => topic && drainQueue(topic.threadId));
  }
}, 60_000);

// --- workspace model-catalog warm-up + explicit runtimeModel (the actual
// fix for resumed sends -- see below for why warming the catalog ALONE,
// which is what this used to do, is not sufficient) ---
// A brand-new `zcode app-server` process starts with an EMPTY model catalog
// for every workspace key: the per-workspace catalog is only ever filled by
// `workspace/updateProviderRegistry`, which is part of the desktop app's
// workspace-open flow -- a flow this bridge never runs. Without it,
// `session/resume` (no runtimeModel param, persisted model not in the
// catalog) takes its "deferred model adapter" path: resume reports success,
// and every subsequent `session/send` on that session rejects with
// ZCODE_RUNTIME_MODEL_UNAVAILABLE ("历史任务使用的模型已不可用") -- the bug this
// used to be worked around with a fresh-session fallback (history lost).
// session/setModel does NOT clear it.
//
// An EARLIER version of this fix only pushed the registry (via
// workspace/updateProviderRegistry) and then called plain session/resume,
// on the theory that a warmed catalog would be enough for resume's own
// "is this model available" check to pass. It reported success in scratch
// testing, shipped, and then still failed in production: reproduced by
// hand afterward -- workspace/updateProviderRegistry visibly applies (the
// returned workspaceState really does show the model as available) and yet
// the very next session/resume + session/send on that same session still
// hits the same ZCODE_RUNTIME_MODEL_UNAVAILABLE error. Root cause: the
// deferred-adapter decision inside resume isn't re-evaluated against
// whatever the catalog looks like at call time -- it's short-circuited
// specifically by an *explicit* `runtimeModel` param on the resume call
// itself. Passing one bypasses the broken availability check entirely,
// and this path is the one actually confirmed to preserve conversation
// context across a real process kill and restart (see git history).
//
// Two traps found empirically while building this, both costly to
// discover, worth recording:
// - The registry push must carry source:"user" -- the registry handler
//   silently filters out pushes that claim source:"builtin".
// - `runtimeModel.provider` must be OUR OWN provider object (the one we
//   just pushed, which still has the real `apiKey`), not the one echoed
//   back in updateProviderRegistry's response: the server converts our
//   inline apiKey into an internal `apiKeyRef` pointer for its own
//   bookkeeping, and (a) `apiKeyRef` isn't even a field runtimeModel.provider's
//   schema accepts -- passing it verbatim is a validation error -- and
//   (b) if you strip it without restoring a real `apiKey`, resume succeeds
//   but the *next* send fails with "Model provider is missing an API key"
//   -- a different, easy-to-mistake-for-progress failure mode.
//
// The apiKey is read at call time and only ever written to the child's
// stdin (a pipe to a process that already reads the same config file
// itself); never logged.
const workspaceRuntimeModels = new Map(); // workspaceKey -> runtimeModel object, cached per process
async function warmWorkspaceCatalog(workspaceKey, modelRef) {
  const cached = workspaceRuntimeModels.get(workspaceKey);
  if (cached) return cached;
  const workspace = { workspacePath: cfg.workspaceDir, workspaceKey };
  try {
    const state = await zcode.call('workspace/readState', { workspace });
    const models = state.modelCatalog?.providers?.find((p) => p.providerId === 'zai')?.models;
    const zai = readZaiProvider(cfg.zaiConfigPath);
    if (!models?.length) throw new Error('readState returned no zai models');
    const provider = {
      providerId: zai.providerId,
      kind: zai.kind,
      source: 'user',
      label: zai.label,
      baseURL: zai.baseURL,
      apiKey: { source: 'inline', value: zai.apiKey },
      models,
    };
    const res = await zcode.call('workspace/updateProviderRegistry', {
      workspace,
      registry: { revision: `bridge-warm-${Date.now()}`, generatedAt: Date.now(), providers: [provider] },
    });
    if (res.status !== 'applied' || res.providerCount < 1) throw new Error(`registry push not applied (status=${res.status}, providerCount=${res.providerCount})`);
    console.log(`[bridge] warmed model catalog for workspace key ${workspaceKey} (${res.providerCount} provider)`);
    const runtimeModel = {
      revision: res.appliedProviderRevision,
      generatedAt: Date.now(),
      model: parseModelRef(modelRef),
      provider, // ours, not res.workspaceState's echoed version -- see comment above
    };
    workspaceRuntimeModels.set(workspaceKey, runtimeModel);
    return runtimeModel;
  } catch (e) {
    // Not fatal: sends on resumed sessions may still fail with
    // ZCODE_RUNTIME_MODEL_UNAVAILABLE and fall back to a fresh session --
    // the pre-fix behavior, degraded but working.
    console.error(`[bridge] failed to warm model catalog for workspace key ${workspaceKey} (resumed sessions may still fail):`, e.message);
    return null;
  }
}

// --- get-or-create the zcode session for a Telegram topic ---
// Returns { sessionId, resumed }. `resumed: true` means this call reloaded
// a session that already existed before this process started (as opposed
// to creating a brand new one) -- see the caller in handleMessage for why
// that distinction matters despite session/resume itself having succeeded.
async function getOrCreateSession(threadId, { forceFresh = false } = {}) {
  let entry = forceFresh ? null : store.getTopic(threadId);
  let resumed = false;

  if (entry && !subscribedSessions.has(entry.sessionId)) {
    // Every bridge start spawns a brand-new `zcode app-server` child
    // process (zcodeClient.js) -- there is no reconnection to a lingering
    // daemon. That fresh process's live session registry is empty; a
    // session persisted from a *previous* process is unknown to it until
    // reloaded. session/resume is exactly the mechanism for that reload.
    // Without calling it, session/subscribe (and session/send) reject
    // every pre-existing topic's session with -32004 "Session is not
    // active" -- forever, on every single restart, since store.js keeps
    // returning the same now-permanently-dead sessionId on every future
    // message. Confirmed by tracing the vendored runtime: session/subscribe
    // and session/send both resolve the session via a bare Map lookup that
    // throws if it isn't already resident; only session/resume's handler
    // falls back to loading the persisted record from disk.
    try {
      const workspaceKey = `tg-topic-${threadId}`;
      const runtimeModel = await warmWorkspaceCatalog(workspaceKey, entry.model);
      await zcode.call('session/resume', {
        sessionId: entry.sessionId,
        // Both fields are required together for the fix to actually take:
        // runtimeModel is what bypasses the broken deferred-adapter check,
        // but the runtime still needs `workspace` on this same call to know
        // which workspace's (just-warmed) catalog to resolve it against.
        ...(runtimeModel ? { workspace: { workspacePath: cfg.workspaceDir, workspaceKey }, runtimeModel } : {}),
      });
      resumed = true;
    } catch (e) {
      // Session is genuinely gone upstream (not just "not yet reloaded into
      // this process") -- start fresh rather than have this topic loop on
      // the same error on every future message forever. History is lost;
      // said so below.
      console.error(`[bridge] topic ${threadId}: session/resume failed for ${entry.sessionId}, starting a fresh session (history lost):`, e.message);
      entry = null;
    }
  }

  if (!entry) {
    const created = await zcode.call('session/create', {
      workspace: { workspacePath: cfg.workspaceDir, workspaceKey: `tg-topic-${threadId}` },
    });
    const sessionId = created.session.sessionId;
    // /model or /mode issued before the session existed is honored here.
    const stored = store.getTopic(threadId);
    const model = stored?.model || cfg.defaultModel;
    const mode = stored?.mode || cfg.defaultSessionMode;
    try {
      await zcode.call('session/setModel', { sessionId, model: parseModelRef(model) });
      await zcode.call('session/setMode', { sessionId, mode });
    } catch (e) {
      // Session exists server-side but we're about to throw before ever
      // recording it anywhere (store, sessionToTopic, subscribedSessions) --
      // best-effort close it rather than leak an abandoned, never-subscribed
      // session on every retry of what might be a persistent misconfiguration
      // (e.g. a typo'd model ref this account isn't entitled to).
      await zcode.call('session/close', { sessionId }).catch(() => {});
      throw e;
    }
    entry = { sessionId, model, mode };
    store.setTopic(threadId, entry);
    console.log(`[bridge] topic ${threadId}: created session ${sessionId} (${model}, mode=${mode})`);
  }

  sessionToTopic.set(entry.sessionId, { threadId });
  if (!subscribedSessions.has(entry.sessionId)) {
    await zcode.call('session/subscribe', { sessionId: entry.sessionId, deliveryKind: 'web-remote-replayable' });
    subscribedSessions.add(entry.sessionId);
  }
  return { sessionId: entry.sessionId, resumed };
}

function parseModelRef(ref) {
  const [providerId, modelId] = ref.split('/');
  return { providerId, modelId };
}

// --- per-topic pinned status message (agreed tier-2 item) ---
// One message per topic showing model · mode · busy/idle · queue depth,
// edited in place whenever that state changes (never re-sent), pinned if
// the bot has pin rights in the group -- pinning needs admin, so a failure
// is logged exactly once and the message lives on unpinned.
const topicStatus = new Map(); // threadId -> { messageId, pinFailed }
async function updateTopicStatus(threadId, state) {
  const entry = store.getTopic(threadId);
  if (!entry) return; // no session yet -- nothing to report
  const lines = [
    '📌 Topic status',
    `model: ${entry.model || cfg.defaultModel}`,
    `mode: ${entry.mode || cfg.defaultSessionMode}`,
    `state: ${state === 'busy' ? '⌛ busy — turn running' : 'idle'}`,
    `queued: ${store.getQueue(threadId).length}`,
  ];
  const text = lines.join('\n');
  let st = topicStatus.get(threadId);
  if (st?.messageId) {
    await tg.editMessageText({ chatId: cfg.chatId, messageId: st.messageId, text }).catch((e) => {
      // Deleted by someone / too old to edit: fall back to a fresh message.
      if (/message to edit not found|MESSAGE_ID_INVALID/i.test(e.message || '')) {
        topicStatus.delete(threadId);
      } else {
        console.error('[bridge] failed to update topic status:', e.message);
      }
    });
    if (topicStatus.has(threadId)) return;
  }
  st = { messageId: null, pinFailed: false };
  topicStatus.set(threadId, st);
  try {
    const msg = await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text });
    st.messageId = msg.message_id;
    store.setTopic(threadId, { statusMessageId: msg.message_id });
    if (!st.pinFailed) {
      await tg.pinChatMessage({ chatId: cfg.chatId, messageId: msg.message_id }).catch((e) => {
        st.pinFailed = true;
        console.error(`[bridge] pinChatMessage failed (bot needs admin pin rights; status stays unpinned): ${e.message}`);
      });
    }
  } catch (e) {
    topicStatus.delete(threadId);
    console.error('[bridge] failed to post topic status:', e.message);
  }
}

// Re-adopt status message ids persisted by a previous process (the map above
// is in-memory) so a restart keeps editing the same message instead of
// posting a second one.
function restoreTopicStatuses() {
  for (const [threadId, entry] of Object.entries(store.data.topics)) {
    if (entry.statusMessageId) topicStatus.set(threadId, { messageId: entry.statusMessageId, pinFailed: false });
  }
}

// --- /model: list / switch the topic's model ---
// Validated against workspace/readState's modelCatalog.available (verified
// live: [{ref:{providerId,modelId}, label, contextWindow, ...}]).
async function handleModelCommand(threadId, arg) {
  const workspaceKey = `tg-topic-${threadId}`;
  let available;
  try {
    const state = await zcode.call('workspace/readState', { workspace: { workspacePath: cfg.workspaceDir, workspaceKey } });
    available = state.modelCatalog?.available ?? [];
  } catch (e) {
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: `⚠️ /model failed: ${e.message}` });
    return;
  }
  const refs = available.map((m) => `${m.ref.providerId}/${m.ref.modelId}`);

  if (!arg) {
    const current = store.getTopic(threadId)?.model || cfg.defaultModel;
    const rows = available.map((m) => {
      const ref = `${m.ref.providerId}/${m.ref.modelId}`;
      const ctx = m.contextWindow >= 1000000 ? `${m.contextWindow / 1000000}M` : `${Math.round(m.contextWindow / 1000)}k`;
      return `${ref === current ? '▶' : '•'} ${ref} — ${m.label || m.ref.modelId} (${ctx} ctx)`;
    });
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: ['Models available:', ...rows, '', 'Switch: /model <name>'].join('\n') });
    return;
  }

  // Accept both 'glm-5.3' (default provider) and 'zai/glm-5.3'.
  const ref = arg.includes('/') ? arg : `zai/${arg}`;
  if (!refs.includes(ref)) {
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: `⚠️ Unknown model "${arg}". /model with no argument lists what's available.` });
    return;
  }
  const entry = store.getTopic(threadId) || {};
  store.setTopic(threadId, { ...entry, model: ref });
  // The cached runtimeModel for this workspace was built for the OLD model;
  // drop it so the next resume warms with the new one.
  workspaceRuntimeModels.delete(workspaceKey);
  if (entry.sessionId && subscribedSessions.has(entry.sessionId)) {
    try {
      await zcode.call('session/setModel', { sessionId: entry.sessionId, model: parseModelRef(ref) });
    } catch (e) {
      await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: `⚠️ Stored for this topic, but the live session rejected the switch: ${e.message}` });
      return;
    }
  }
  await updateTopicStatus(threadId, busySessions.has(entry.sessionId) ? 'busy' : 'idle').catch(() => {});
  await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: `✅ Model for this topic: ${ref}` });
}

// --- /mode: list / switch the topic's session mode ---
// The runtime's mode enum, from the vendored bundle. Only a sane subset is
// advertised in the listing, but any enum value is accepted typed out.
const MODES = ['default', 'plan', 'edit', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'autoEdit', 'build', 'yolo'];
const MODE_NOTES = {
  default: 'confirm risky tool calls',
  yolo: 'auto-approve everything (bridge default)',
  plan: 'read-only planning',
  edit: 'plan + apply edits',
};

async function handleModeCommand(threadId, arg) {
  const entry = store.getTopic(threadId) || {};
  const current = entry.mode || cfg.defaultSessionMode;
  if (!arg) {
    const rows = MODES.map((m) => `• ${m}${MODE_NOTES[m] ? ` — ${MODE_NOTES[m]}` : ''}`);
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: [`Modes (current: ${current}):`, ...rows, '', 'Switch: /mode <name>'].join('\n') });
    return;
  }
  if (!MODES.includes(arg)) {
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: `⚠️ Unknown mode "${arg}". /mode with no argument lists valid modes.` });
    return;
  }
  store.setTopic(threadId, { ...entry, mode: arg });
  if (entry.sessionId && subscribedSessions.has(entry.sessionId)) {
    try {
      await zcode.call('session/setMode', { sessionId: entry.sessionId, mode: arg });
    } catch (e) {
      await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: `⚠️ Stored for this topic, but the live session rejected the switch: ${e.message}` });
      return;
    }
  }
  await updateTopicStatus(threadId, busySessions.has(entry.sessionId) ? 'busy' : 'idle').catch(() => {});
  await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: `✅ Mode for this topic: ${arg}` });
}

// --- /file: send a workspace file into the topic as a document ---
// Restricted to the workspace subtree: the bridge account can read files
// (e.g. ~/.zcode credentials) that must not become one tap away from chat.
async function handleFileCommand(threadId, arg) {
  if (!arg) {
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: 'Usage: /file <path-inside-workspace>' });
    return;
  }
  const abs = path.resolve(cfg.workspaceDir, arg);
  let real;
  try {
    real = await realpath(abs);
    const root = await realpath(cfg.workspaceDir); // so symlinked prefixes compare correctly
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error(`⚠️ ${arg} resolves outside the workspace -- /file only serves files under it.`);
    }
    const st = await stat(real);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > cfg.maxFileBytes) throw new Error(`file is ${Math.round(st.size / 1024 / 1024)} MB; cap is ${Math.round(cfg.maxFileBytes / 1024 / 1024)} MB`);
    const buf = await readFile(real);
    await tg.sendDocument({
      chatId: cfg.chatId,
      messageThreadId: threadId,
      blob: new Blob([buf]),
      filename: path.basename(real),
      caption: `${arg} (${abbrev(st.size)} B)`,
    });
  } catch (e) {
    const msg = /outside the workspace/.test(e.message || '')
      ? e.message
      : `⚠️ /file failed: ${/ENOENT/.test(e.message || '') ? 'not found' : e.message}`;
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: msg }).catch(() => {});
    return;
  }
}

// --- Telegram message handling ---

// '/usage@botname arg' -> 'usage'; null for anything that isn't a command.
// Only the bridge's OWN commands are intercepted below -- anything else
// starting with '/' (zcode's /init, /memo, ...) passes through to the model
// as ordinary input.
function parseCommand(text) {
  const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/);
  return m ? m[1].toLowerCase() : null;
}

async function handleUsageCommand(threadId) {
  let text;
  try {
    const apiKey = readZaiApiKey(cfg.zaiConfigPath);
    text = renderUsage(await fetchUsage({ apiKey }));
  } catch (e) {
    text = `⚠️ /usage failed: ${e.message}`;
  }
  await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text }).catch((e) => console.error('[bridge] failed to post usage:', e.message));
}

function helpText() {
  return [
    'Bridge commands (each scoped to this topic):',
    '/usage — Z.ai plan usage & quota',
    '/stop, /cancel — cancel the running turn',
    '/queue — show queued messages',
    '/clearqueue — drop queued messages',
    '/model [name] — list / switch this topic’s model',
    '/mode [name] — list / switch this topic’s mode',
    '/file <path> — send a workspace file here',
    '',
    'Anything else is sent to the model. Replies stream into the ⌛ placeholder message. Messages sent while a turn is running are queued and run in order; reply to any message to quote it to the model.',
  ].join('\n');
}

async function handleMessage(message) {
  if (message.from?.is_bot) return;
  if (message.chat?.id !== cfg.chatId) return;
  if (message.from?.id !== cfg.allowedUserId) {
    console.warn(`[bridge] ignoring message from unauthorized user ${message.from?.id}`);
    return;
  }
  if (message.forum_topic_created) {
    console.log(`[bridge] topic created: "${message.forum_topic_created.name}" (thread ${message.message_thread_id})`);
    return;
  }
  const threadId = message.message_thread_id;
  if (!threadId) return; // ignore messages outside any topic
  if (!message.text) return; // ignore non-text (stickers, photos, ...) for v0

  // Bridge-own commands that never need a session run before anything else,
  // so a stray /usage in a brand-new topic doesn't spawn a zcode session.
  const command = parseCommand(message.text);
  if (command === 'usage') {
    await handleUsageCommand(threadId);
    return;
  }
  if (command === 'model') {
    await handleModelCommand(threadId, message.text.split(/\s+/).slice(1).join(' ').trim());
    return;
  }
  if (command === 'mode') {
    await handleModeCommand(threadId, (message.text.split(/\s+/)[1] || '').trim());
    return;
  }
  if (command === 'file') {
    await handleFileCommand(threadId, message.text.split(/\s+/).slice(1).join(' ').trim());
    return;
  }
  if (command === 'help') {
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: helpText() });
    return;
  }
  if (command === 'queue') {
    const q = store.getQueue(threadId);
    const text = q.length
      ? ['📥 Queued in this topic:', ...q.map((it, i) => `${i + 1}. ${truncate((it.text || '').split('\n')[0], 80)}`)].join('\n')
      : 'Queue for this topic is empty.';
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text });
    return;
  }
  if (command === 'clearqueue') {
    const q = store.getQueue(threadId);
    store.setQueue(threadId, []);
    for (const it of q) {
      await tg.editMessageText({ chatId: cfg.chatId, messageId: it.placeholderMessageId, text: '🗑 Dropped from queue.' }).catch(() => {});
    }
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: q.length ? `🗑 Dropped ${q.length} queued message(s).` : 'Queue was already empty.' });
    return;
  }
  // /stop and /cancel are NOT handled here: they need the topic's sessionId,
  // resolved below.

  // Replying to an earlier message quotes it into the prompt (agreed tier-3
  // item): the model otherwise has no way to know which of the topic's many
  // messages the user is pointing at. Composed before the busy-queue branch
  // so a queued reply-to keeps its quote too.
  let promptText = message.text;
  const quoted = message.reply_to_message?.text;
  if (quoted && quoted.trim()) {
    const q = truncate(quoted, 600);
    promptText = `[replying to this earlier message in the topic]\n${q.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${message.text}`;
  }

  let session;
  try {
    session = await getOrCreateSession(threadId);
  } catch (e) {
    // Without this, a failure here (e.g. session/create rejecting) is
    // completely silent to the user: message sent, nothing ever happens,
    // only a server-side log line. The per-update catch in main() logs it
    // but was never going to tell them anything.
    console.error(`[bridge] topic ${threadId}: failed to get/create session:`, e);
    await tg
      .sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: `⚠️ Couldn't start a session: ${e.message}` })
      .catch((sendErr) => console.error('[bridge] failed to post session-creation failure notice:', sendErr.message));
    return;
  }
  let sessionId = session.sessionId;

  if (busySessions.has(sessionId)) {
    if (command === 'stop' || command === 'cancel') {
      await zcode.call('session/stop', { sessionId }).catch((e) => console.error('[bridge] session/stop failed:', e.message));
      const turn = activeTurns.get(sessionId);
      busySessions.delete(sessionId);
      activeTurns.delete(sessionId);
      turn?.streamer?.stop();
      updateTopicStatus(threadId, 'idle').catch(() => {});
      const queued = store.getQueue(threadId).length;
      const label = `🛑 Cancelled.${queued ? ` ${queued} queued message(s) will run next.` : ''}`;
      if (turn) {
        await tg.editMessageText({ chatId: cfg.chatId, messageId: turn.placeholderMessageId, text: label }).catch((e) => console.error('[bridge] failed to edit cancelled placeholder:', e.message));
      } else {
        await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: label });
      }
      void drainQueue(threadId);
      return;
    }

    // Busy + ordinary message: queue it. The notice we post becomes the
    // turn's placeholder when the message is dequeued, so the reply lands on
    // the message the user already saw accepted.
    const queue = store.getQueue(threadId);
    if (queue.length >= cfg.maxQueuePerTopic) {
      await tg.sendMessage({
        chatId: cfg.chatId,
        messageThreadId: threadId,
        text: `⚠️ Queue for this topic is full (${cfg.maxQueuePerTopic}) — this message was dropped. /stop to cancel the running turn.`,
      });
      return;
    }
    const notice = await tg.sendMessage({
      chatId: cfg.chatId,
      messageThreadId: threadId,
      text: `📥 Queued (position ${queue.length + 1}) — runs when the current message finishes. /clearqueue to drop.`,
    });
    store.setQueue(threadId, [...queue, { text: promptText, placeholderMessageId: notice.message_id }]);
    return;
  }

  if (command === 'stop' || command === 'cancel') {
    await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: 'Nothing is running in this topic.' });
    return;
  }

  const placeholder = await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: '⌛ …' });
  await startTurn(threadId, session, promptText, placeholder.message_id);
}

// Send one turn's prompt to its session and own every failure path of the
// send -- including the one-shot fresh-session retry for the known zcode
// "resumed session rejects sends" quirk (see getOrCreateSession). Split out
// of handleMessage so the queue drain starts turns through the exact same
// code path a live-typed message takes.
async function startTurn(threadId, session, text, placeholderMessageId) {
  const sessionId = session.sessionId;
  busySessions.add(sessionId);
  const turn = {
    placeholderMessageId,
    textBuffer: '',
    startedAt: Date.now(),
    toolNames: new Map(), // toolCallId -> toolName (result events don't repeat the name)
    streamer: new ReplyStreamer({ tg, chatId: cfg.chatId, messageId: placeholderMessageId, threadId, minEditIntervalMs: cfg.streamEditIntervalMs }),
  };
  activeTurns.set(sessionId, turn);
  updateTopicStatus(threadId, 'busy').catch(() => {});

  try {
    await zcode.call('session/send', { sessionId, content: text });
  } catch (e) {
    // session/send itself rejecting outright (as opposed to the turn later
    // completing with status "failed") is a different failure mode --
    // finalizeTurn() is never reached for it, so without this catch
    // busySessions/activeTurns for this session would stay set for the
    // rest of the process's life and the topic would be stuck on the
    // placeholder forever. (In practice this call site is effectively
    // unreachable for -32010 "already running": the busySessions guard
    // above and main()'s strictly-sequential per-update processing already
    // prevent two concurrent session/send calls on the same session within
    // one process. This catch remains as a backstop for whatever else could
    // make session/send itself reject, e.g. the app-server process dying
    // mid-call.)
    busySessions.delete(sessionId);
    activeTurns.delete(sessionId);
    turn.streamer?.stop();
    updateTopicStatus(threadId, 'idle').catch(() => {});

    if (session.resumed) {
      // Confirmed by direct testing (see git history), not speculation: a
      // cold-resumed session can report session/resume AND session/subscribe
      // as successful, yet still reject session/send with "the historical
      // task's model is no longer available" -- its model adapter stays
      // permanently deferred/unmaterialized. Neither session/setModel,
      // switching models away and back, nor supplying `workspace` on the
      // resume call itself unstick it. Rather than leave the topic
      // permanently broken, fall back once to a fresh session (conversation
      // history is lost) and retry this same message before giving up.
      console.error(`[bridge] topic ${threadId}: send failed on a resumed session, retrying once with a fresh session (history lost):`, e.message);
      let freshSessionId;
      try {
        const fresh = await getOrCreateSession(threadId, { forceFresh: true });
        freshSessionId = fresh.sessionId;
        busySessions.add(freshSessionId);
        activeTurns.set(freshSessionId, {
          placeholderMessageId,
          textBuffer: '',
          startedAt: Date.now(),
          toolNames: new Map(),
          streamer: new ReplyStreamer({ tg, chatId: cfg.chatId, messageId: placeholderMessageId, threadId, minEditIntervalMs: cfg.streamEditIntervalMs }),
        });
        await zcode.call('session/send', { sessionId: freshSessionId, content: text });
        return; // retry accepted -- the normal event-driven flow takes it from here
      } catch (retryErr) {
        // Clears the FRESH session's routing state -- the original
        // sessionId was already cleared above. (The pre-queue version of
        // this path cleared the original id twice and never the fresh one,
        // leaving the fresh session in busySessions forever: a latent
        // topic-wedging bug this restructure fixes.)
        if (freshSessionId) {
          busySessions.delete(freshSessionId);
          activeTurns.delete(freshSessionId);
        }
        console.error(`[bridge] topic ${threadId}: retry with a fresh session also failed:`, retryErr);
        e = retryErr;
      }
    }

    await tg
      .editMessageText({ chatId: cfg.chatId, messageId: placeholderMessageId, text: `⚠️ Failed to send: ${e.message}` })
      .catch((editErr) => console.error('[bridge] failed to edit failure notice:', editErr.message));
    // The message behind this failed one doesn't deserve to wait forever
    // just because its predecessor's send was rejected.
    void drainQueue(threadId);
  }
}

// Runs the next queued message for a topic, if any -- called from every path
// that marks a topic's session not-busy (turn finished, failed, cancelled,
// watchdog-timed-out, send rejected), and once at startup for queues
// restored from disk. Callers `void` it: draining must never block the
// delivery of the outcome the user is currently reading.
async function drainQueue(threadId) {
  const queue = store.getQueue(threadId);
  if (!queue.length) return;
  const [next, ...rest] = queue;
  store.setQueue(threadId, rest);

  let session;
  try {
    session = await getOrCreateSession(threadId);
  } catch (e) {
    console.error(`[bridge] topic ${threadId}: failed to get/create session for a queued message:`, e);
    await tg
      .editMessageText({ chatId: cfg.chatId, messageId: next.placeholderMessageId, text: `⚠️ Couldn't start a session: ${e.message}` })
      .catch(() => {});
    await drainQueue(threadId); // give the one behind it the same chance
    return;
  }
  if (busySessions.has(session.sessionId)) {
    // Only reachable if something re-busied the session between the turn
    // ending and this drain. Put the item back at the front rather than
    // risk a concurrent session/send (-32010).
    store.setQueue(threadId, [next, ...store.getQueue(threadId)]);
    return;
  }
  await tg
    .editMessageText({ chatId: cfg.chatId, messageId: next.placeholderMessageId, text: '⌛ …' })
    .catch((e) => console.error('[bridge] failed to promote queued notice to placeholder:', e.message));
  await startTurn(threadId, session, next.text, next.placeholderMessageId);
}

async function handleCallbackQuery(cq) {
  if (cq.from?.id !== cfg.allowedUserId) {
    await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'Not authorized.', showAlert: true });
    return;
  }
  if (cq.message?.chat?.id !== cfg.chatId) {
    // Mirrors handleMessage's chat_id check. Not currently exploitable
    // (callback tokens are unguessable 48-bit random values, minted only
    // when a permission prompt is sent to cfg.chatId, and Telegram doesn't
    // carry inline keyboards across forwards to another chat) but there's
    // no reason for this check to be asymmetric with handleMessage's.
    await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'Not authorized.', showAlert: true });
    return;
  }
  const token = cq.data;
  const requestId = tokenToRequestId.get(token);
  // 'u_' tokens are AskUserQuestion taps; 'p_' tokens permission prompts.
  if (token?.startsWith('u_')) {
    const input = requestId && pendingUserInputs.get(requestId);
    if (!input) {
      if (cq.message) {
        await tg.editMessageText({ chatId: cq.message.chat.id, messageId: cq.message.message_id, text: '⚠️ Expired.', replyMarkup: { inline_keyboard: [] } }).catch(() => {});
      }
      await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'This question already expired.' });
      return;
    }
    const choice = input.tokenToChoice.get(token);
    if (!choice) {
      await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'Unknown option.' });
      return;
    }
    const label = handleUserInputTap(requestId, token, choice);
    await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: label || 'Recorded' });
    return;
  }
  const pending = requestId && pendingPermissions.get(requestId);
  if (!pending) {
    // Not tracked (already resolved, timed out, or -- for anything sent
    // before the orphan-cleanup/reply_markup fixes existed -- simply never
    // tracked at all). Either way, Telegram hands us the original message on
    // every callback_query regardless of our own state, so we can still
    // clear its now-meaningless buttons right here rather than leave them
    // clickable forever.
    if (cq.message) {
      await tg
        .editMessageText({ chatId: cq.message.chat.id, messageId: cq.message.message_id, text: '⚠️ Expired.', replyMarkup: { inline_keyboard: [] } })
        .catch(() => {}); // best-effort; e.g. text may already be identical if two clicks race
    }
    await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'This request already expired.' });
    return;
  }
  const response = pending.tokenMap.get(token);
  const label = response?.decision === 'deny' ? '❌ Denied' : `✅ ${response?.decision ?? 'resolved'}`;
  finishPermission(requestId, response, `${label} by you.`);
  await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: label });
}

// --- main poll loop ---
async function main() {
  console.log(`[bridge] starting. chat=${cfg.chatId} workspace=${cfg.workspaceDir} model=${cfg.defaultModel}`);
  restoreTopicStatuses();
  await cleanupOrphanedPermissionRequests();

  // Command autocomplete: idempotent, safe on every boot. The chat scope is
  // the one forum group this bridge serves (so the list shows exactly there);
  // the default scope covers a 1:1 chat with the bot. Failure is logged and
  // non-fatal -- the commands still work typed out in full.
  try {
    await tg.setMyCommands({ commands: BOT_COMMANDS, scope: { type: 'chat', chat_id: cfg.chatId } });
    await tg.setMyCommands({ commands: BOT_COMMANDS });
  } catch (e) {
    console.error('[bridge] setMyCommands failed (no / autocomplete; commands still work):', e.message);
  }

  // Queues persisted by a previous process instance: their "📥 Queued"
  // Telegram messages are still sitting in their topics -- resume draining.
  // (A message whose turn was killed MID-FLIGHT by that restart is in no
  // queue and is simply gone; its placeholder stays "⌛" forever. Known gap,
  // listed in README's known issues.)
  const restoredQueues = store.getQueues();
  const restoredThreadIds = Object.keys(restoredQueues);
  if (restoredThreadIds.length) {
    console.log(`[bridge] restoring queues: ${restoredThreadIds.map((t) => `topic ${t} (${restoredQueues[t].length})`).join(', ')}`);
    for (const threadId of restoredThreadIds) await drainQueue(threadId);
  }

  let offset = store.getOffset();
  for (;;) {
    let updates;
    try {
      updates = await tg.getUpdates({ offset, timeout: 30 });
    } catch (e) {
      console.error('[bridge] getUpdates failed, retrying in 5s:', e.message);
      await sleep(5000);
      continue;
    }
    for (const update of updates) {
      try {
        if (update.message) await handleMessage(update.message);
        else if (update.callback_query) await handleCallbackQuery(update.callback_query);
      } catch (e) {
        console.error('[bridge] error handling update:', e);
      }
      // Persist per-update, not once per batch: if the process dies partway
      // through a batch, only the update actually in flight gets redelivered
      // and reprocessed on restart, not everything already handled before it.
      offset = update.update_id + 1;
      try {
        store.setOffset(offset);
      } catch (e) {
        // Unlike the try/catch around message handling two lines up, a
        // failure here (e.g. a transient disk write error) used to be
        // completely unguarded and would propagate all the way out of
        // main(), taking down the whole process over what could be one
        // transient write failure -- inconsistent with the deliberate
        // catch-and-continue policy for everything else in this loop.
        console.error('[bridge] failed to persist update offset (will retry next update):', e.message);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('[bridge] fatal:', e);
  process.exit(1);
});
