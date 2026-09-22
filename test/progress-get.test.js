// progress_get: the MCP liveness probe. A caller polling twice must be able
// to tell WORKING (step count / last-activity moved) from WEDGED (neither
// moved) from IDLE (explicit, never inferred) -- and must never be handed
// reply text. Tests drive bridge/progress.js's pure surface with synthetic
// turn entries, plus the gateway surface (schema validation, tool error).

import test from 'node:test';
import assert from 'node:assert/strict';
import { noteActivity, progressSnapshot, progressForTopic } from '../bridge/progress.js';
import { createMcpGateway } from '../bridge/mcp.js';

const T0 = 1789999999000;

function liveTurn() {
  return { startedAt: T0, textBuffer: '', toolNames: new Map() };
}

test('idle is explicit: active false, state idle, nulls and an empty list -- nothing to infer', () => {
  const out = progressSnapshot({ key: 'k1', turn: undefined, now: T0 + 5000 });
  assert.deepEqual(out, {
    key: 'k1',
    active: false,
    state: 'idle',
    startedAt: null,
    runningMs: null,
    activityCount: null,
    lastActivityAt: null,
    lastActivityAgeMs: null,
    recentActivity: [],
  });
  // state is machine-checkable on its own; a caller never has to guess
  // "idle" from an absent field.
  assert.equal(out.state, 'idle');
  assert.equal(out.active, false);
});

test('a live turn observed twice, 30s apart, with work between: count AND last-activity advanced', () => {
  const turn = liveTurn();
  noteActivity(turn, '🔧 Bash · ls -la', { toolCallId: 'c1', now: T0 + 1000 });
  noteActivity(turn, '🔧 Bash · ls -la', { toolCallId: 'c1', done: true, now: T0 + 4000 });
  const obs1 = progressSnapshot({ key: 'k1', turn, now: T0 + 5000 });

  // The model moved on: narration streamed, then a new tool started.
  noteActivity(turn, '💭 narration', { now: T0 + 31000 });
  noteActivity(turn, '🔧 Edit · bridge/index.js', { toolCallId: 'c2', now: T0 + 34000 });
  const obs2 = progressSnapshot({ key: 'k1', turn, now: T0 + 36000 });

  // THE CONTRACT: the caller can say "it is alive" from these two reads.
  assert.ok(obs2.activityCount > obs1.activityCount, 'step count advanced');
  assert.ok(obs2.lastActivityAt > obs1.lastActivityAt, 'last-activity time moved');
  assert.ok(obs2.activityCount > 2);
  assert.equal(obs2.state, 'active');
  assert.equal(obs2.active, true);
  assert.equal(obs2.runningMs, 36000);
  // Fresh activity, and the labels arrive in order with timestamps.
  assert.ok(obs2.lastActivityAgeMs < 5000);
  assert.deepEqual(obs2.recentActivity.map((x) => x.label), ['🔧 Bash · ls -la ✓', '💭 narration', '🔧 Edit · bridge/index.js']);
});

test('a wedged turn observed twice, 10 minutes apart, with nothing between: nothing moved, age grew', () => {
  const turn = liveTurn();
  noteActivity(turn, '🔧 Bash · make test', { toolCallId: 'c1', now: T0 + 1000 });
  const obs1 = progressSnapshot({ key: 'k1', turn, now: T0 + 5000 });
  const obs2 = progressSnapshot({ key: 'k1', turn, now: T0 + 605000 });

  assert.equal(obs2.activityCount, obs1.activityCount, 'count frozen');
  assert.equal(obs2.lastActivityAt, obs1.lastActivityAt, 'last activity frozen');
  assert.equal(obs2.lastActivityAgeMs, 604000, 'age grew past any sane threshold');
  assert.equal(obs2.state, 'active', 'still a turn in flight -- stuck is the caller\'s verdict from the evidence');
});

test('an unknown key is refused, a closed key is refused -- never a hollow idle', () => {
  const topics = new Map([['k-live', { sessionId: 's1' }], ['k-dead', { sessionId: 's1', closed: true }], ['k-idle', { sessionId: 's2' }]]);
  const turns = new Map([['s1', liveTurn()]]);
  assert.throws(
    () => progressForTopic({ getTopic: (k) => topics.get(k), activeTurns: turns, key: 'nope' }),
    /unknown session: nope/,
  );
  assert.throws(
    () => progressForTopic({ getTopic: (k) => topics.get(k), activeTurns: turns, key: 'k-dead' }),
    /session k-dead is closed/,
  );
  // A known, open key with no turn in flight IS idle -- that is real
  // information, not the refusal path.
  const idle = progressForTopic({ getTopic: (k) => topics.get(k), activeTurns: turns, key: 'k-idle' });
  assert.equal(idle.state, 'idle');
  const active = progressForTopic({ getTopic: (k) => topics.get(k), activeTurns: turns, key: 'k-live' });
  assert.equal(active.state, 'active');
});

test('no reply text leaks into the payload -- labels only', () => {
  const turn = liveTurn();
  turn.textBuffer = 'SECRET-REPLY-BODY the answer is 42 and the apiKey is sk-nothing';
  noteActivity(turn, '💭 narration', { now: T0 + 1000 });
  noteActivity(turn, '🔧 Read · bridge/usage.js', { toolCallId: 'c1', now: T0 + 2000 });
  const out = progressSnapshot({ key: 'k1', turn, now: T0 + 3000 });
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes('SECRET-REPLY-BODY'), 'no reply text');
  assert.ok(!flat.includes('42'), 'no reply content');
  assert.ok(!flat.includes('sk-nothing'), 'no credential-shaped text');
  assert.ok(!('textBuffer' in out), 'the buffer field itself is not exposed');
  // Labels carry tool names / fixed activity words only.
  for (const x of out.recentActivity) assert.match(x.label, /^(💭|🔧)/);
});

test('noteActivity: completion stamps ✓ on the matching call id; a repeat start just refreshes', () => {
  const turn = liveTurn();
  noteActivity(turn, '🔧 Bash · slow build', { toolCallId: 'c9', now: T0 + 1000 });
  noteActivity(turn, '🔧 Bash', { toolCallId: 'c9', now: T0 + 2000 }); // a second start event, NOT a completion
  let a = turn.activity;
  assert.equal(a.labels.find((x) => x.label.includes('slow build')).label, '🔧 Bash · slow build', 'no premature ✓');
  noteActivity(turn, '🔧 Bash', { toolCallId: 'c9', done: true, now: T0 + 9000 });
  a = turn.activity;
  assert.equal(a.labels.find((x) => x.label.includes('slow build')).label, '🔧 Bash · slow build ✓');
  assert.equal(a.count, 3, 'every event counted, even ones that only refreshed a label');
});

test('noteActivity: a continuing narration refreshes one label instead of spamming the list', () => {
  const turn = liveTurn();
  for (let i = 0; i < 50; i++) noteActivity(turn, '💭 narration', { now: T0 + i * 100 });
  assert.equal(turn.activity.count, 50, 'count is monotonic across coalesced events');
  assert.equal(turn.activity.labels.filter((x) => x.label === '💭 narration').length, 1);
  assert.equal(turn.activity.lastAt, T0 + 4900, 'last-activity advanced with every delta');
});

test('noteActivity: the label list is capped at the last few, the count is not', () => {
  const turn = liveTurn();
  for (let i = 0; i < 12; i++) noteActivity(turn, `🔧 Tool${i}`, { toolCallId: `c${i}`, now: T0 + i * 1000 });
  assert.equal(turn.activity.labels.length, 6);
  assert.equal(turn.activity.labels[0].label, '🔧 Tool6', 'kept the LAST few, in order');
  assert.equal(turn.activity.count, 12);
});

test('over the gateway: progress_get routes, validates its key, and surfaces refusal as a tool error', async (t) => {
  const gw = createMcpGateway({ port: 0, log: () => {} });
  const seen = [];
  // The stub mirrors the real handler's contract (index.js's
  // progressForTopic): unknown keys THROW, they never answer idle.
  gw.wire({
    progressGet: (key) => {
      seen.push(key);
      if (key === 'nope') throw new Error(`unknown session: ${key}`);
      return { key, active: false, state: 'idle' };
    },
  });
  await gw.ready;
  t.after(() => gw.close());
  const url = `http://127.0.0.1:${gw.address().port}/mcp`;
  const rpc = async (body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : JSON.parse(await res.text()) };
  };

  const ok = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'progress_get', arguments: { key: 'k1' } } });
  assert.equal(ok.body.result.isError, false);
  assert.deepEqual(JSON.parse(ok.body.result.content[0].text), { key: 'k1', active: false, state: 'idle' });
  assert.deepEqual(seen, ['k1']);

  const missing = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'progress_get', arguments: {} } });
  assert.equal(missing.body.result.isError, true, 'a missing key fails loudly, like every required argument');
  assert.match(missing.body.result.content[0].text, /progress_get.*key/);

  const refused = await rpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'progress_get', arguments: { key: 'nope' } },
  });
  assert.equal(refused.body.result.isError, true);
  assert.match(refused.body.result.content[0].text, /unknown session: nope/);
});
