// Unit tests for bridge/chatpick.js: the default-target picker for MCP
// session_create. Pure function over injected Telegram calls -- no bridge,
// no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickForumChat } from '../bridge/chatpick.js';

const BOT = 4242;

function harness({ chats = {}, members = {}, unreachable = new Set() } = {}) {
  const calls = { getChat: [], getChatMember: [] };
  const getChat = async (id) => {
    calls.getChat.push(id);
    if (unreachable.has(id)) throw new Error('telegram getChat failed: Bad Request: chat not found');
    return chats[id];
  };
  const getChatMember = async (id, userId) => {
    calls.getChatMember.push({ id, userId });
    if (!(id in members)) throw new Error('telegram getChatMember failed: Bad Request: user not found');
    return { status: members[id] };
  };
  return { getChat, getChatMember, calls };
}

const forum = (id, title = `forum ${id}`) => ({ id, type: 'supergroup', title, is_forum: true });
const group = (id, title = `group ${id}`) => ({ id, type: 'supergroup', title });

test('picks the only forum among non-forums and unreachable chats', async () => {
  const h = harness({
    chats: { [-1001]: forum(-1001), [-1002]: group(-1002), [-1003]: group(-1003) },
    members: { [-1001]: 'member' },
    unreachable: new Set([-1003]),
  });
  const winner = await pickForumChat({ ...h, botId: BOT, candidates: [
    { chatId: -1002, lastSeenAt: 90 },
    { chatId: -1001, lastSeenAt: 50 },
    { chatId: -1003, lastSeenAt: 80 },
  ] });
  assert.equal(winner.chatId, -1001);
  assert.equal(winner.admin, false);
  assert.equal(winner.title, 'forum -1001');
});

test('an admin forum beats a more recently used member forum', async () => {
  const h = harness({
    chats: { [-1001]: forum(-1001), [-1002]: forum(-1002) },
    members: { [-1001]: 'administrator', [-1002]: 'member' },
  });
  const winner = await pickForumChat({ ...h, botId: BOT, candidates: [
    { chatId: -1002, lastSeenAt: 200 }, // newer, but bot is a mere member
    { chatId: -1001, lastSeenAt: 100 },
  ] });
  assert.equal(winner.chatId, -1001);
  assert.equal(winner.admin, true);
});

test('within the same admin tier, most recently served wins', async () => {
  const h = harness({
    chats: { [-1001]: forum(-1001), [-1002]: forum(-1002), [-1003]: forum(-1003) },
    members: { [-1001]: 'administrator', [-1002]: 'administrator', [-1003]: 'member' },
  });
  const winner = await pickForumChat({ ...h, botId: BOT, candidates: [
    { chatId: -1001, lastSeenAt: 10 },
    { chatId: -1002, lastSeenAt: 20 },
    { chatId: -1003, lastSeenAt: 300 },
  ] });
  assert.equal(winner.chatId, -1002);
});

test('getChatMember asking about the bot itself, by id', async () => {
  const h = harness({ chats: { [-1001]: forum(-1001) }, members: { [-1001]: 'administrator' } });
  await pickForumChat({ ...h, botId: BOT, candidates: [{ chatId: -1001, lastSeenAt: 0 }] });
  assert.deepEqual(h.calls.getChatMember, [{ id: -1001, userId: BOT }]);
});

test('an unreadable membership is not disqualifying', async () => {
  const h = harness({ chats: { [-1001]: forum(-1001) } }); // members: empty -> getChatMember throws
  const winner = await pickForumChat({ ...h, botId: BOT, candidates: [{ chatId: -1001, lastSeenAt: 0 }] });
  assert.equal(winner.chatId, -1001);
  assert.equal(winner.admin, false);
});

test('no eligible chat: a descriptive error naming every rejected candidate', async () => {
  const h = harness({
    chats: { [-1002]: group(-1002, 'Stale Home') },
    unreachable: new Set([-1003]),
  });
  await assert.rejects(
    pickForumChat({ ...h, botId: BOT, candidates: [
      { chatId: -1002, lastSeenAt: 10 },
      { chatId: -1003, lastSeenAt: 20 },
    ] }),
    (e) => {
      assert.match(e.message, /no forum-enabled group/);
      assert.match(e.message, /Stale Home.*topics not enabled/);
      assert.match(e.message, /-1003.*unreachable/);
      assert.match(e.message, /explicit chat_id/);
      return true;
    },
  );
});

test('a private chat object (type private) is rejected, not crashed on', async () => {
  const h = harness({ chats: { [12345]: { id: 12345, type: 'private', first_name: 'Owner' } } });
  await assert.rejects(
    pickForumChat({ ...h, botId: BOT, candidates: [{ chatId: 12345, lastSeenAt: 1 }] }),
    /topics not enabled/,
  );
});
