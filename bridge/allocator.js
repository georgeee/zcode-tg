// Synthetic thread/key allocator for MCP-only bridge sessions:
// Allocates unique numeric thread IDs across restarts (starting above max(persisted keys),
// and never returning any key that has an existing record, open or closed).

import { Store } from './store.js';

export class KeyAllocator {
  constructor(storeOrPath, { base = 9000, keyForFn = null } = {}) {
    this.store = typeof storeOrPath === 'string' ? new Store(storeOrPath) : storeOrPath;
    this.base = base;
    this.keyForFn = keyForFn;
    const max = this.maxPersistedKey();
    this.nextThreadId = Math.max(this.base, max >= this.base ? max + 1 : this.base);
  }

  maxPersistedKey() {
    return this.store?.maxPersistedKey ? this.store.maxPersistedKey() : 0;
  }

  isRecorded(threadId, chatId = null) {
    if (!this.store) return false;
    const sId = String(threadId);
    const key = this.keyForFn && chatId != null ? this.keyForFn(chatId, threadId) : sId;
    return this.store.isKeyRecorded(key, threadId);
  }

  allocate(chatId = null) {
    while (this.isRecorded(this.nextThreadId, chatId)) {
      this.nextThreadId++;
    }
    return this.nextThreadId++;
  }
}

// THE MCP-ONLY TELEGRAM STAND-IN. Same method surface as TelegramClient
// (everything index.js calls), returning benign shapes instead of touching
// the network: getChat claims a forum so session_create's default-target
// pick succeeds, createForumTopic hands out synthetic thread ids starting
// above max(persisted keys) and skipping any recorded keys, sends return
// synthetic message ids. One quiet log line at construction -- the stub
// itself stays silent, mirrors and replies are deliberately no-ops.
export function makeNullTelegram(store, defaultChatId = -100) {
  let nextMessageId = 1;
  const keyForFn = (chatId, threadId) => {
    if (defaultChatId != null && Number(chatId) === Number(defaultChatId)) {
      return threadId ? String(threadId) : `c${chatId}`;
    }
    return `c${chatId}` + (threadId ? `:t${threadId}` : '');
  };
  const allocator = new KeyAllocator(store, { base: 9000, keyForFn });
  console.log('[bridge] MCP-only mode: no TELEGRAM_BOT_TOKEN -- Telegram calls are no-ops, MCP serves everything');
  const forumChat = (chatId) => ({ id: Number(chatId), type: 'supergroup', is_forum: true, title: 'mcp-only' });
  return {
    allocator,
    getUpdates: async () => [],
    sendMessage: async () => ({ message_id: nextMessageId++ }),
    editMessageText: async () => ({ message_id: nextMessageId++ }),
    createForumTopic: async (p) => ({
      message_thread_id: allocator.allocate(p.chatId),
      chat_id: p.chatId,
      name: p.name,
    }),
    closeForumTopic: async () => ({}),
    getMe: async () => ({ id: 0, is_bot: true, username: 'mcp-only' }),
    getChat: async ({ chatId }) => forumChat(chatId),
    getChatMember: async () => ({ status: 'administrator' }),
    leaveChat: async () => ({}),
    pinChatMessage: async () => ({}),
    deleteMessage: async () => ({}),
    setMyCommands: async () => ({}),
    sendDocument: async () => ({ message_id: nextMessageId++ }),
    getFile: async () => ({ file_path: '' }),
    downloadFile: async () => Buffer.alloc(0),
    answerCallbackQuery: async () => ({}),
  };
}
