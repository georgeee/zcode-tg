// Default-target resolution for MCP session_create: when the caller does not
// name a chat, pick a group a new topic can actually live in.
//
// The Bot API has no "list the chats this bot is in" call, so the bridge
// REMEMBERS every group it has served (owner messages, topic creations, being
// added -- see noteKnownChat in index.js, persisted by store.js) and
// re-validates the candidates live at pick time: getChat says whether Topics
// are enabled right now, getChatMember whether the bot is an administrator.
//
// Ranking (owner request 2026-09-10, after a stale TELEGRAM_CHAT_ID made the
// old unconditional home-chat default fail with "the chat is not a forum"):
//   1. Topics must be enabled (a supergroup with is_forum) -- anything else
//      is disqualified, whatever the config says.
//   2. Among forums, chats where the bot is an administrator win: creating a
//      topic through the API needs admin rights, so a mere-member forum is a
//      target that only moves the failure to createForumTopic.
//   3. Ties break by most-recently-served first -- the chat the owner is
//      actually using is the one a new session belongs in.

export async function pickForumChat({ getChat, getChatMember, botId, candidates }) {
  const eligible = [];
  const rejected = [];
  for (const c of candidates) {
    let chat;
    try {
      chat = await getChat(c.chatId);
    } catch (e) {
      rejected.push(`${c.chatId}: unreachable (${e.message})`);
      continue;
    }
    if (!chat || chat.type !== 'supergroup' || !chat.is_forum) {
      rejected.push(`${c.chatId} (${chat?.title ?? chat?.type ?? 'unknown'}): topics not enabled`);
      continue;
    }
    let admin = false;
    try {
      admin = (await getChatMember(c.chatId, botId))?.status === 'administrator';
    } catch {
      // An unreadable membership is not disqualifying: if the bot really
      // lacks the rights, createForumTopic itself will say so, clearly.
    }
    eligible.push({ chatId: c.chatId, title: chat.title, admin, lastSeenAt: c.lastSeenAt ?? 0 });
  }
  if (!eligible.length) {
    const seen = rejected.length ? ` Checked: ${rejected.join('; ')}.` : ' No known group chats at all yet.';
    throw new Error(
      `no forum-enabled group found for the default session target.${seen} ` +
        'Pass an explicit chat_id, or enable Topics in a group the bot is a member of (with the bot as admin).',
    );
  }
  eligible.sort((a, b) => Number(b.admin) - Number(a.admin) || b.lastSeenAt - a.lastSeenAt);
  return eligible[0];
}
