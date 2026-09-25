// Unit tests for the per-topic status-message state machine
// (bridge/topicStatus.js). The bug these guard against was measured live on
// a guest: two status writes whose first sendMessage was still in flight
// EACH saw messageId == null and posted + pinned their own status line --
// pinned ids 1125 and 1126 in one topic (1115 and 1116 the run before).
// The queue refresh and the turn's busy/idle fire close together by design,
// so the serialization under test here is the fix, not a nice-to-have.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopicStatusTracker } from '../bridge/topicStatus.js';

const CHAT = -100777;
const KEY = '77';

// A Telegram stand-in whose sendMessage resolves SLOWLY (the real one takes
// tens of ms to seconds -- the window the race lived in), with every call
// counted and a message-id -> text table so assertions can see what each
// message finally says.
function fakeTelegram({ sendDelayMs = 25, failSendCalls = [], editErrorFor = null } = {}) {
  const calls = { send: [], edit: [], pin: [], delete: [] };
  const messages = new Map(); // message_id -> current text
  let nextId = 1000;
  let sendCount = 0;
  const tg = {
    async sendMessage(p) {
      const call = { chatId: p.chatId, thread: p.messageThreadId, text: p.text };
      calls.send.push(call);
      if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
      if (failSendCalls.includes(++sendCount)) throw new Error('Bad Request: telegram hiccup');
      const id = nextId++;
      messages.set(id, p.text);
      call.messageId = id;
      return { message_id: id };
    },
    async editMessageText(p) {
      const err = editErrorFor?.(p);
      calls.edit.push({ messageId: p.messageId, text: p.text, failed: Boolean(err) });
      if (err) throw err;
      if (messages.has(p.messageId)) messages.set(p.messageId, p.text);
      return { message_id: p.messageId };
    },
    async pinChatMessage(p) {
      calls.pin.push(p);
      return {};
    },
    async deleteMessage(p) {
      calls.delete.push(p);
      messages.delete(p.messageId);
      return {};
    },
  };
  return { tg, calls, messages };
}

function makeTracker(tg, persisted = []) {
  return createTopicStatusTracker({
    tg,
    chatOf: () => CHAT,
    threadOf: (key) => Number(key),
    persist: (key, messageId) => persisted.push({ key, messageId }),
  });
}

const BUSY = '📌 busy · no queued';
const IDLE = '📌 idle · no queued';

test('concurrent updates create exactly one message, pin it once, and the last state wins', async () => {
  const { tg, calls, messages } = fakeTelegram();
  const persisted = [];
  const tracker = makeTracker(tg, persisted);

  // The measured collision, three arrivals deep: the turn goes busy, and the
  // queue refresh plus the idle write land while the first send is still out.
  const p1 = tracker.update(KEY, () => BUSY);
  const p2 = tracker.update(KEY, () => IDLE);
  const p3 = tracker.update(KEY, () => BUSY);
  await Promise.all([p1, p2, p3]);

  assert.equal(calls.send.length, 1, `exactly one sendMessage, got ${calls.send.length}`);
  assert.equal(calls.pin.length, 1, `exactly one pinChatMessage, got ${calls.pin.length}`);
  const id = calls.send[0].messageId;
  assert.ok(calls.edit.length >= 2, 'later updates EDIT the one message instead of posting their own');
  assert.ok(calls.edit.every((e) => e.messageId === id), 'every edit targets that one message');
  assert.equal(calls.send[0].thread, Number(KEY));
  assert.equal(calls.send[0].chatId, CHAT);
  assert.equal(messages.get(id), BUSY, 'the final text is the LAST requested state');
  assert.deepEqual(persisted, [{ key: KEY, messageId: id }], 'exactly one statusMessageId is persisted');
});

test('a failed send does not wedge the chain: the next update posts and pins normally', async () => {
  const { tg, calls, messages } = fakeTelegram({ failSendCalls: [1] });
  const persisted = [];
  const tracker = makeTracker(tg, persisted);

  // The first create fails; the caller's promise must still resolve (the
  // step catches its own recoverable failures, like the bridge's callers
  // all .catch(() => {}) expect), and nothing may pin or persist.
  await assert.doesNotReject(tracker.update(KEY, () => BUSY));
  assert.equal(calls.send.length, 1);
  assert.equal(calls.pin.length, 0, 'a failed send never pins');
  assert.deepEqual(persisted, [], 'a failed send never persists a statusMessageId');

  // The next update runs -- a fresh single message, sent and pinned once.
  await tracker.update(KEY, () => IDLE);
  assert.equal(calls.send.length, 2);
  assert.equal(calls.pin.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(messages.get(persisted[0].messageId), IDLE);
});

test('a recreate (48h too-old replace) serializes too: updates arriving during the replacement send cannot double-post', async () => {
  const { tg, calls, messages } = fakeTelegram();
  const tracker = makeTracker(tg);

  await tracker.update(KEY, () => IDLE); // first message created + pinned
  const oldId = calls.send[0].messageId;
  assert.equal(calls.pin.length, 1);

  // Age the message past Telegram's 48h bot-edit window: edits of it fail.
  const tooOld = (p) => (p.messageId === oldId ? new Error("Bad Request: message can't be edited") : null);
  tg.editMessageText = async (p) => {
    const err = tooOld(p);
    calls.edit.push({ messageId: p.messageId, text: p.text, failed: Boolean(err) });
    if (err) throw err;
    messages.set(p.messageId, p.text);
    return { message_id: p.messageId };
  };

  // Two updates while the replacement is being recreated: the second must
  // queue behind the recreate's slow send, not redo it.
  const p1 = tracker.update(KEY, () => BUSY);
  const p2 = tracker.update(KEY, () => BUSY);
  await Promise.all([p1, p2]);

  assert.equal(calls.delete.length, 1, 'the old message is deleted exactly once');
  assert.equal(calls.send.length, 2, 'initial + exactly one replacement');
  assert.equal(calls.pin.length, 2, 'each generation pinned once');
  const newId = calls.send[1].messageId;
  assert.notEqual(newId, oldId);
  assert.equal(messages.get(newId), BUSY, 'the replacement carries the newest state');
});

test('a status message deleted by someone is let go, not resurrected', async () => {
  const { tg, calls } = fakeTelegram({
    editErrorFor: (p) => (p.messageId === 1000 ? new Error('Bad Request: message to edit not found') : null),
  });
  const tracker = makeTracker(tg);

  await tracker.update(KEY, () => IDLE); // created (id 1000), pinned
  await tracker.update(KEY, () => BUSY); // edit -> "not found" -> stop tracking
  await tracker.update(KEY, () => IDLE); // gone: no more writes, ever

  assert.equal(calls.send.length, 1, 'a deleted status message is not reposted');
  assert.equal(calls.pin.length, 1);
  assert.equal(calls.edit.length, 1, 'once gone, no further edits are attempted');
});
