// One pinned status message per topic (busy/idle · queue depth · usage):
// created once -- at topic creation, as the topic's first message -- then
// edited in place for the topic's lifetime. This module is that message's
// STATE MACHINE; what the line says and when updates are wanted stay in
// index.js (topicStatusText and its call sites).
//
// EVERY create/edit/pin for a topic is SERIALIZED behind a per-key promise
// chain, and that is load-bearing, not polish: a status write awaits
// Telegram (the first send most of all), and writes fire from independent
// paths that legitimately race -- the initial write at topic creation, the
// turn's busy/idle, the queue refresh after every queue mutation. Run
// concurrently they each read `st.messageId` before the in-flight send had
// resolved, saw null, and each posted AND pinned its own status message --
// measured live on a guest: pinned ids 1125 and 1126 in one thread (1115
// and 1116 the run before), a stale pin left standing in relay-owned
// groups. The chain makes later callers queue instead: exactly one message
// is ever created per topic, later updates edit it, the LAST state
// requested renders last, a failed link is caught and the next update still
// runs, and a recreate (the 48h too-old replace) goes through the same
// chain so it cannot double-post either.
export function createTopicStatusTracker({ tg, chatOf, threadOf, persist }) {
  const topics = new Map(); // key -> { messageId, pinned, gone }
  const chains = new Map(); // key -> tail promise of that topic's update chain

  async function tryPin(key, st) {
    if (!st?.messageId || st.pinned) return;
    try {
      await tg.pinChatMessage({ chatId: chatOf(key), messageId: st.messageId });
      st.pinned = true;
    } catch (e) {
      // Usually "not enough rights" -- the bot needs admin can_pin_messages.
      // Warn once, keep retrying on later state changes (pinChatMessage on an
      // already-pinned message is idempotent once it succeeds).
      if (!tryPin.warned) {
        tryPin.warned = true;
        console.error(`[bridge] pinChatMessage failed (${e.message}); will keep retrying -- grant the bot admin pin rights to pin the per-topic status`);
      }
    }
  }

  // One link per requested update. `.then(step, step)`: whether the previous
  // link resolved or failed, this one still runs -- one failed update must
  // not wedge every update queued behind it (the steps below also catch
  // their own recoverable failures; this is the second net).
  function enqueue(key, step) {
    const next = (chains.get(key) ?? Promise.resolve()).then(step, step);
    chains.set(key, next);
    const drop = () => {
      if (chains.get(key) === next) chains.delete(key);
    };
    next.then(drop, drop);
    return next;
  }

  // `render` runs when the update's turn in the chain comes, not when
  // update() is called -- a queued update renders at RUN time, so what the
  // message finally shows is the last state anybody asked for.
  function update(key, render) {
    return enqueue(key, async () => {
      const text = render();
      let st = topics.get(key);
      if (st?.gone) return;
      if (st?.messageId) {
        let keep = true;
        try {
          await tg.editMessageText({ chatId: chatOf(key), messageId: st.messageId, text });
        } catch (e) {
          const m = e.message || '';
          if (/message to edit not found|MESSAGE_ID_INVALID/i.test(m)) {
            st.gone = true; // deleted (most likely deliberately) -- let it go
            return;
          }
          if (/message is not modified/i.test(m)) {
            // Two consecutive writes with identical content (e.g. /model then
            // /mode while idle). Not an error -- but treating it as one (the old
            // behavior) logged noise on every no-op write AND skipped the pin
            // retry below. Fall through to tryPin like a success.
          } else if (/can't be edited|too old/i.test(m)) {
            // Aged past the 48h edit window: replace, keeping exactly one.
            // The recreate is INSIDE this serialized step, so updates arriving
            // while the replacement send is in flight queue behind it instead
            // of posting their own.
            await tg.deleteMessage({ chatId: chatOf(key), messageId: st.messageId }).catch(() => {});
            topics.delete(key);
            st = undefined;
            keep = false;
          } else {
            console.error('[bridge] failed to update topic status:', m);
            return;
          }
        }
        if (keep && st) {
          await tryPin(key, st);
          return;
        }
      }
      st = { messageId: null, pinned: false, gone: false };
      topics.set(key, st);
      try {
        const msg = await tg.sendMessage({ chatId: chatOf(key), messageThreadId: threadOf(key), text });
        st.messageId = msg.message_id;
        persist?.(key, msg.message_id);
        await tryPin(key, st);
      } catch (e) {
        topics.delete(key);
        console.error('[bridge] failed to post topic status:', e.message);
      }
    });
  }

  // Re-adopt a status message id persisted by a previous process (the map
  // above is in-memory) so a restart keeps editing the same message instead
  // of posting a second one.
  function adopt(key, messageId) {
    topics.set(key, { messageId, pinned: false, gone: false });
  }

  return { update, adopt };
}
