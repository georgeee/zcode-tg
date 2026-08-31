// zcode <-> Telegram bridge.
//
// One Telegram forum topic == one zcode session. Sending a message in a
// topic sends it to that session; the final reply lands as an edited
// placeholder message in the same topic.
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

loadEnv(new URL('../.env', import.meta.url).pathname);

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

// --- in-memory routing state (rebuilt each process start; durable session
// identities live in `store`) ---
const subscribedSessions = new Set(); // sessionId we've called session/subscribe for, this process
const sessionToTopic = new Map(); // sessionId -> { threadId }
const busySessions = new Set(); // sessionId currently running a turn
const activeTurns = new Map(); // sessionId -> { placeholderMessageId, textBuffer, lastEditAt }
const pendingPermissions = new Map(); // requestId -> { resolve, tokenMap: Map(token->response), chatId, threadId }
const tokenToRequestId = new Map(); // callback_data token -> requestId

// --- permission relay: server asks, we answer (auto-approve by default) ---
zcode.onServerRequest('interaction/requestPermission', async (params) => {
  const topic = sessionToTopic.get(params.sessionId);

  if (cfg.autoApprovePermissions) {
    const response = pickAutoApproveOption(params.options);
    if (topic) {
      // Fire-and-forget audit notice -- never hold up the turn on this.
      tg.sendMessage({
        chatId: cfg.chatId,
        messageThreadId: topic.threadId,
        text: `🔓 auto-approved: ${params.toolName} (${params.riskLevel})${params.reason ? ` — ${params.reason}` : ''}`,
      }).catch((e) => console.error('[bridge] failed to post auto-approve notice:', e.message));
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

  const inputPreview = safePreview(params.input);
  const text = [
    `🔐 Permission requested`,
    `Tool: ${params.toolName}  ·  risk: ${params.riskLevel}`,
    params.reason ? `Reason: ${params.reason}` : null,
    inputPreview ? `Input: ${inputPreview}` : null,
  ].filter(Boolean).join('\n');

  const msg = await tg.sendMessage({
    chatId: cfg.chatId,
    messageThreadId: topic.threadId,
    text,
    replyMarkup: TG.inlineKeyboard(buttons),
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const denyOpt = params.options.find((o) => o.response?.decision === 'deny');
      finishPermission(params.requestId, denyOpt?.response ?? { decision: 'deny', reason: 'auto-denied: no response within timeout' }, '⏱ auto-denied (no response in time)');
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
  pending.resolve(response);
  tg.editMessageText({ chatId: pending.chatId, messageId: pending.messageId, text: resultLabel }).catch((e) =>
    console.error('[bridge] failed to edit permission message:', e.message),
  );
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

function safePreview(input) {
  try {
    const s = JSON.stringify(input);
    if (!s) return null;
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch {
    return null;
  }
}

// --- session event routing: zcode -> Telegram ---
zcode.on('event', (msg) => {
  const sessionId = msg.params?.sessionId;
  if (!sessionId) return;

  if (msg.method === 'session/event') {
    const payload = msg.params.payload;
    const turn = activeTurns.get(sessionId);
    if (!turn) return;

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
  if (text.length > 4000) text = text.slice(0, 4000) + '\n…(truncated)';

  try {
    await tg.editMessageText({ chatId: cfg.chatId, messageId: turn.placeholderMessageId, text });
  } catch (e) {
    console.error('[bridge] failed to edit final reply:', e.message);
  }
}

// --- get-or-create the zcode session for a Telegram topic ---
async function getOrCreateSession(threadId) {
  let entry = store.getTopic(threadId);
  if (!entry) {
    const created = await zcode.call('session/create', {
      workspace: { workspacePath: cfg.workspaceDir, workspaceKey: `tg-topic-${threadId}` },
    });
    const sessionId = created.session.sessionId;
    await zcode.call('session/setModel', {
      sessionId,
      model: parseModelRef(cfg.defaultModel),
    });
    await zcode.call('session/setMode', { sessionId, mode: cfg.defaultSessionMode });
    entry = { sessionId, model: cfg.defaultModel };
    store.setTopic(threadId, entry);
    console.log(`[bridge] topic ${threadId}: created session ${sessionId} (${cfg.defaultModel}, mode=${cfg.defaultSessionMode})`);
  }
  sessionToTopic.set(entry.sessionId, { threadId });
  if (!subscribedSessions.has(entry.sessionId)) {
    await zcode.call('session/subscribe', { sessionId: entry.sessionId, deliveryKind: 'web-remote-replayable' });
    subscribedSessions.add(entry.sessionId);
  }
  return entry.sessionId;
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

  const sessionId = await getOrCreateSession(threadId);

  if (busySessions.has(sessionId)) {
    await tg.sendMessage({
      chatId: cfg.chatId,
      messageThreadId: threadId,
      text: '⏳ Still working on the previous message in this topic — try again once it finishes.',
    });
    return;
  }

  const placeholder = await tg.sendMessage({ chatId: cfg.chatId, messageThreadId: threadId, text: '⏳ …' });
  busySessions.add(sessionId);
  activeTurns.set(sessionId, { placeholderMessageId: placeholder.message_id, textBuffer: '' });

  await zcode.call('session/send', { sessionId, content: message.text });
}

async function handleCallbackQuery(cq) {
  if (cq.from?.id !== cfg.allowedUserId) {
    await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'Not authorized.', showAlert: true });
    return;
  }
  const token = cq.data;
  const requestId = tokenToRequestId.get(token);
  const pending = requestId && pendingPermissions.get(requestId);
  if (!pending) {
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
      store.setOffset(offset);
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
