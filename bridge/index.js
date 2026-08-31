// zcode <-> Telegram bridge.
//
// One Telegram forum topic == one zcode session. Sending a message in a
// topic sends it to that session; the final reply lands as an edited
// placeholder message in the same topic. Send /stop (or /cancel) in a busy
// topic to abort its in-progress turn.
//
// Permission requests: sessions run in "yolo" mode (auto-approve) by
// default, and any interaction/requestPermission that still arrives is
// auto-approved with a non-blocking notice posted to the topic. Set
// AUTO_APPROVE_PERMISSIONS=false to fall back to interactive Approve/Deny
// inline-keyboard prompts instead.
//
// Transport is Telegram long-polling only -- no inbound port, no webhook,
// nothing to put behind the TLS cert (that's for the future WebSocket/app
// phase). Run this as a long-lived process (see README.md for the systemd
// unit); it does not daemonize itself.

import { randomBytes } from 'node:crypto';
import { loadEnv } from './env.js';
import { ZcodeClient } from './zcodeClient.js';
import { TelegramClient, TelegramClient as TG } from './telegram.js';
import { Store } from './store.js';

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
  // Safety net for a turn that's accepted but never emits turn.terminal (a
  // dropped event, an upstream hang that doesn't crash the app-server
  // process outright, or a zcode-side bug) -- without this, the topic would
  // otherwise be stuck showing the busy placeholder for the rest of the
  // process's life with no recovery short of restarting the whole bridge.
  turnTimeoutMs: Number(process.env.TURN_TIMEOUT_MS || 20 * 60 * 1000), // 20 min
};

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
const activeTurns = new Map(); // sessionId -> { placeholderMessageId, textBuffer, startedAt, turnId? }
const pendingPermissions = new Map(); // requestId -> { resolve, tokenMap: Map(token->response), chatId, threadId }
const tokenToRequestId = new Map(); // callback_data token -> requestId

// interaction/requestUserInput (the model's "AskUserQuestion" tool, asking a
// mid-turn clarifying question) needs an explicit handler, unlike most
// other server-initiated requests: the runtime's default client-request
// path only has a graceful fallback (-> decision:"deny") for a *valid*
// decline reply matching {action:"accept"|"decline"|"cancel"}. Leaving it
// to the bridge's blanket "unregistered method -> JSON-RPC error" default
// makes the runtime's own request-response race (cbt/raceClientRequestWithV4Interaction
// in the vendored source) rethrow that error instead of catching it, which
// most likely fails the tool call outright rather than politely declining
// to answer. No Telegram round-trip here since there's no reasonable way
// for an unattended bridge to actually answer a free-form question.
zcode.onServerRequest('interaction/requestUserInput', async () => ({
  action: 'decline',
  reason: 'auto-declined: unattended bridge session, no user available to answer',
}));

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
    if (!turn) return;
    const payload = msg.params.payload;

    if (payload?.kind === 'text_delta' && typeof payload.delta === 'string') {
      turn.textBuffer += payload.delta;
    } else if (typeof payload?.content === 'string') {
      // Authoritative final text for the turn -- prefer this over the
      // accumulated delta buffer if present.
      turn.finalText = payload.content;
    } else if (payload?.error) {
      turn.error = payload.error;
    }
    return;
  }

  if (msg.method === 'v4/telemetry/event' && msg.params.kind === 'turn.terminal') {
    void finalizeTurn(sessionId, msg.params);
  }
});

async function finalizeTurn(sessionId, terminalParams) {
  const turn = activeTurns.get(sessionId);
  activeTurns.delete(sessionId);
  busySessions.delete(sessionId);
  if (!turn) return;

  let text;
  if (terminalParams.status === 'success') {
    text = turn.finalText ?? turn.textBuffer ?? '(no text response)';
  } else {
    const err = turn.error;
    text = `⚠️ Turn failed: ${terminalParams.errorCode || 'unknown_error'}${err?.message ? `\n${err.message}` : ''}`;
  }
  text = truncate(text, 4000);

  try {
    await tg.editMessageText({ chatId: cfg.chatId, messageId: turn.placeholderMessageId, text });
  } catch (e) {
    console.error('[bridge] failed to edit final reply:', e.message);
  }
}

// Force-clears any turn that's been open longer than cfg.turnTimeoutMs with
// no turn.terminal ever seen -- without this, a single dropped/never-sent
// terminal event wedges that topic on the busy placeholder for the rest of
// the process's life, with no recovery except restarting the whole bridge
// (which resets every OTHER topic's state too). /stop below is the
// user-initiated version of this same cleanup, for when 20 minutes is too
// long to wait.
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, turn] of activeTurns) {
    if (now - turn.startedAt <= cfg.turnTimeoutMs) continue;
    console.error(`[bridge] turn on session ${sessionId} exceeded ${cfg.turnTimeoutMs}ms with no turn.terminal event -- force-clearing`);
    activeTurns.delete(sessionId);
    busySessions.delete(sessionId);
    tg
      .editMessageText({
        chatId: cfg.chatId,
        messageId: turn.placeholderMessageId,
        text: '⚠️ No response after a long time — giving up on waiting for this turn. Send another message to try again (or /stop next time to cancel earlier).',
      })
      .catch((e) => console.error('[bridge] failed to edit watchdog-timeout notice:', e.message));
  }
}, 60_000);

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
      await zcode.call('session/resume', { sessionId: entry.sessionId });
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
    try {
      await zcode.call('session/setModel', { sessionId, model: parseModelRef(cfg.defaultModel) });
      await zcode.call('session/setMode', { sessionId, mode: cfg.defaultSessionMode });
    } catch (e) {
      // Session exists server-side but we're about to throw before ever
      // recording it anywhere (store, sessionToTopic, subscribedSessions) --
      // best-effort close it rather than leak an abandoned, never-subscribed
      // session on every retry of what might be a persistent misconfiguration
      // (e.g. a typo'd model ref this account isn't entitled to).
      await zcode.call('session/close', { sessionId }).catch(() => {});
      throw e;
    }
    entry = { sessionId, model: cfg.defaultModel };
    store.setTopic(threadId, entry);
    console.log(`[bridge] topic ${threadId}: created session ${sessionId} (${cfg.defaultModel}, mode=${cfg.defaultSessionMode})`);
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

// --- Telegram message handling ---
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
    const cmd = message.text.trim().toLowerCase();
    if (cmd === '/stop' || cmd === '/cancel') {
      await zcode.call('session/stop', { sessionId }).catch((e) => console.error('[bridge] session/stop failed:', e.message));
      const turn = activeTurns.get(sessionId);
      busySessions.delete(sessionId);
      activeTurns.delete(sessionId);
      if (turn) {
        await tg.editMessageText({ chatId: cfg.chatId, messageId: turn.placeholderMessageId, text: '🛑 Cancelled.' }).catch((e) => console.error('[bridge] failed to edit cancelled placeholder:', e.message));
      } else {
        await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: '🛑 Cancelled.' });
      }
      return;
    }
    await tg.sendMessage({
      chatId: cfg.chatId,
      messageThreadId: threadId,
      text: '⏳ Still working on the previous message in this topic — try again once it finishes, or send /stop to cancel it.',
    });
    return;
  }

  const placeholder = await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: '⏳ …' });
  busySessions.add(sessionId);
  activeTurns.set(sessionId, { placeholderMessageId: placeholder.message_id, textBuffer: '', startedAt: Date.now() });

  try {
    await zcode.call('session/send', { sessionId, content: message.text });
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
      try {
        const fresh = await getOrCreateSession(threadId, { forceFresh: true });
        busySessions.add(fresh.sessionId);
        activeTurns.set(fresh.sessionId, { placeholderMessageId: placeholder.message_id, textBuffer: '', startedAt: Date.now() });
        await zcode.call('session/send', { sessionId: fresh.sessionId, content: message.text });
        return; // retry accepted -- the normal event-driven flow takes it from here
      } catch (retryErr) {
        busySessions.delete(sessionId);
        activeTurns.delete(sessionId);
        console.error(`[bridge] topic ${threadId}: retry with a fresh session also failed:`, retryErr);
        e = retryErr;
      }
    }

    await tg
      .editMessageText({ chatId: cfg.chatId, messageId: placeholder.message_id, text: `⚠️ Failed to send: ${e.message}` })
      .catch((editErr) => console.error('[bridge] failed to edit failure notice:', editErr.message));
  }
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
  await cleanupOrphanedPermissionRequests();
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
