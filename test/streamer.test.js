// Regression coverage for the heartbeat added 2026-09-01: without it, a
// turn stuck inside one long tool call (no update() calls in between) shows
// a placeholder whose "elapsed" number never advances -- indistinguishable,
// from the chat, from a genuinely dead turn. Real timers (small intervals)
// rather than node:test's mock timers, since ReplyStreamer schedules with
// plain setTimeout/setInterval and this repo has no fake-timer dependency.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyStreamer } from '../bridge/streamer.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeTg() {
  const edits = [];
  return {
    edits,
    editMessageText: async ({ text }) => {
      edits.push(text);
      return {};
    },
  };
}

test('heartbeat keeps editing (and advancing elapsed) with no update() calls', async () => {
  const tg = fakeTg();
  // _render()'s elapsed is whole SECONDS, and _flush() dedupes identical
  // text -- so a heartbeat tick that lands within the same elapsed second
  // as the last edit is correctly suppressed. The test window has to
  // actually straddle a couple of one-second boundaries for that reason,
  // not just fire the timer a lot in a few hundred ms.
  const streamer = new ReplyStreamer({ tg, chatId: 1, messageId: 42, threadId: 1, minEditIntervalMs: 100, heartbeatMs: 150 });
  // Nudge once so there's a placeholder edit to diff against, then go quiet
  // -- exactly the "one long tool call, no new protocol events" scenario.
  streamer.update({ text: '', status: '🔧 Bash' });
  await sleep(2100);
  streamer.stop();
  assert.ok(tg.edits.length >= 2, `expected at least one heartbeat-driven edit past the first second, got ${tg.edits.length}`);
  // Each landed edit's rendered elapsed-time suffix differs from the last --
  // proof the counter is actually moving, not stale text re-sent (which
  // _flush's lastText dedupe would have suppressed before it ever reached
  // this fake tg).
  assert.ok(new Set(tg.edits).size === tg.edits.length, 'edits should be distinct as elapsed advances');
});

test('stop() silences the heartbeat -- no edits after it returns', async () => {
  const tg = fakeTg();
  const streamer = new ReplyStreamer({ tg, chatId: 1, messageId: 42, threadId: 1, minEditIntervalMs: 15, heartbeatMs: 20 });
  streamer.update({ text: 'hi', status: null });
  await sleep(60);
  streamer.stop();
  const countAtStop = tg.edits.length;
  await sleep(120);
  assert.equal(tg.edits.length, countAtStop, 'no further edits should land after stop()');
});

test('heartbeatMs: 0 disables the pulse -- silence produces no edits at all', async () => {
  const tg = fakeTg();
  const streamer = new ReplyStreamer({ tg, chatId: 1, messageId: 42, threadId: 1, minEditIntervalMs: 15, heartbeatMs: 0 });
  streamer.update({ text: 'hi', status: null });
  await sleep(15); // let the one real update flush
  const countAfterRealUpdate = tg.edits.length;
  await sleep(100); // pure silence -- would have produced heartbeats above
  streamer.stop();
  assert.equal(tg.edits.length, countAfterRealUpdate, 'no edits should appear from silence alone when heartbeatMs is 0');
});

test('a dead (deleted-placeholder) streamer never sends a heartbeat edit', async () => {
  const tg = {
    edits: [],
    editMessageText: async () => {
      throw new Error('Bad Request: message to edit not found');
    },
  };
  const streamer = new ReplyStreamer({ tg, chatId: 1, messageId: 42, threadId: 1, minEditIntervalMs: 15, heartbeatMs: 15 });
  streamer.update({ text: 'hi', status: null });
  await sleep(30); // the real update's flush fails and marks the streamer dead
  assert.equal(streamer.dead, true);
  await sleep(60); // heartbeats keep firing internally but must no-op on dead
  streamer.stop();
});

// The terminal-edit invariant (relay-owned-group design D1: "no edit for a
// message follows its terminal render"): finalizeTurn stops the streamer
// while a flush is commonly STILL IN FLIGHT, and if that held edit then
// fails transiently, the old catch/re-armor path re-edited the message with
// a stale preview AFTER the final render -- the failure the relay's
// latest-text-wins coalescer cannot absorb. stop() must seal the streamer
// against every later edit, including retries of edits issued before it.
test('stop() while a flush is in flight seals it: a failed held edit is never retried after stop', async () => {
  const edits = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const tg = {
    editMessageText: async ({ text }) => {
      edits.push(text); // recorded at ISSUE time
      await gate; // hold the edit "on the wire" while the turn finalizes
      throw new Error('telegram editMessageText failed: Internal Server Error: transient'); // transient -- not "not modified"/"not found"
    },
  };
  const streamer = new ReplyStreamer({ tg, chatId: 1, messageId: 42, threadId: 1, minEditIntervalMs: 20, heartbeatMs: 0 });
  streamer.update({ text: 'hi', status: null });
  await sleep(50); // the flush is now in flight, held by the gate
  streamer.stop(); // finalizeTurn's stop() -- the final render follows on the real path
  // Release AFTER a full second has passed since the held flush rendered:
  // the failure-path retry re-renders (the elapsed "Ns" suffix ticks over),
  // which is exactly when the unfixed catch/re-arm path actually ISSUES the
  // stale post-stop edit -- identical text would be swallowed by _flush's
  // lastText dedupe instead.
  await sleep(1150);
  release();
  await sleep(150); // the retry interval, several times over
  assert.equal(edits.length, 1, `exactly the pre-stop edit may exist; got ${edits.length}: ${JSON.stringify(edits)}`);
});
