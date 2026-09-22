// node --test test/ -- the usage cache POLICY (createUsageCache, usage.js):
// explicit ask vs status-line heartbeat, the failure backoff, and the
// stale-fallback -- against a counting fetch and an injected clock, since
// index.js (which wires the two real instances) exports nothing and its
// fetches are real network. Letters (a)-(e) are the owner's half-2 test
// list; each is mutation-proved (see the report ledger).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageCache, fetchUsage, readZaiApiKey, unconfiguredUsageError, usageTelegramText } from '../bridge/usage.js';

// A clock that only moves when the test moves it: every rule here is
// time-based, so real Date.now() would make them unpinnable.
function makeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// A fetch that records when it was called and whose next result the test
// scripts (a value to resolve with, or an error to throw).
function fakeFetch(clock) {
  const calls = [];
  let next = () => 'v1';
  const fn = async () => { calls.push(clock.now()); return next(); };
  fn.calls = calls;
  fn.respondWith = (v) => { next = () => v; };
  fn.rejectWith = (e) => { next = () => { throw e; }; };
  return fn;
}

// Fire-and-forget fetches settle on their own microtask chain; one macrotask
// turn is enough for them to land before the assertions look.
const flush = () => new Promise((r) => setImmediate(r));

function makeCache(clock, fetch, overrides = {}) {
  return createUsageCache({ fetch, now: clock.now, ...overrides });
}

test('(a) an explicit ask older than the floor AWAITS its refresh and returns the NEW value', async () => {
  const clock = makeClock();
  const f = fakeFetch(clock);
  f.respondWith('v1');
  const c = makeCache(clock, f, { failBackoffMs: 60_000 });
  assert.equal((await c.explicitAsk(30_000)).data, 'v1'); // cold: fetches (1 call)
  f.respondWith('v2');
  clock.advance(60_000); // well past the 30s floor
  const r = await c.explicitAsk(30_000);
  assert.equal(r.data, 'v2'); // the NEW value -- not the stale one, not behind the answer
  assert.equal(r.stale, undefined);
  assert.equal(f.calls.length, 2);
});

test('(b) an explicit ask within the floor answers the cache and does not fetch', async () => {
  const clock = makeClock();
  const f = fakeFetch(clock);
  f.respondWith('v1');
  const c = makeCache(clock, f);
  await c.explicitAsk(30_000); // seed (1 call)
  clock.advance(5_000); // 5s old -- inside the 30s floor
  const r = await c.explicitAsk(30_000);
  assert.equal(r.data, 'v1');
  assert.equal(r.stale, undefined);
  assert.equal(f.calls.length, 1); // COUNTED: no second fetch
});

test('(c) a failed refresh with a cached value serves the cache + stale {ageMs, reason}', async () => {
  const clock = makeClock();
  const f = fakeFetch(clock);
  f.respondWith('v1');
  const c = makeCache(clock, f, { failBackoffMs: 60_000 });
  await c.explicitAsk(30_000); // seed
  clock.advance(60_000);
  f.rejectWith(new Error('HTTP 429'));
  const r = await c.explicitAsk(30_000);
  assert.equal(r.data, 'v1'); // the CACHED value, not an error
  assert.deepEqual(r.stale, { ageMs: 60_000, reason: 'HTTP 429' });
  // ...and the cache really did record the failure, not just this answer:
  assert.equal(c.data, 'v1');
});

test('(d) within the failure backoff no second fetch is attempted; after it, one is', async () => {
  const clock = makeClock();
  const f = fakeFetch(clock);
  f.respondWith('v1');
  const c = makeCache(clock, f, { failBackoffMs: 60_000 });
  await c.explicitAsk(30_000); // call 1: seed
  clock.advance(60_000);
  f.rejectWith(new Error('HTTP 429'));
  await c.explicitAsk(30_000); // call 2: the failed refresh
  assert.equal(f.calls.length, 2);
  clock.advance(45_000); // 45s into the 60s backoff -- past the 30s ask floor, INSIDE the backoff
  const r = await c.explicitAsk(30_000);
  assert.equal(f.calls.length, 2); // COUNTED: no re-hit while cooling down
  assert.equal(r.stale.ageMs, 105_000); // and the age kept growing
  clock.advance(20_000); // backoff has lapsed (65s > 60s)
  f.respondWith('v3');
  const r2 = await c.explicitAsk(30_000);
  assert.equal(f.calls.length, 3); // allowed again
  assert.equal(r2.data, 'v3');
  assert.equal(r2.stale, undefined);
});

test('(e) the heartbeat is fire-and-forget on the 5-minute TTL', async () => {
  const clock = makeClock();
  const f = fakeFetch(clock);
  f.respondWith('v1');
  const c = makeCache(clock, f, { ttlMs: 5 * 60_000 });
  assert.equal(c.heartbeat(), null); // cold: nothing cached yet, refresh starts behind the call
  await flush();
  assert.equal(c.data, 'v1');
  assert.equal(f.calls.length, 1);
  c.heartbeat(); // fresh cache: quiet
  c.heartbeat();
  await flush();
  assert.equal(f.calls.length, 1); // UNCHANGED call count on the 5-min TTL
  clock.advance(6 * 60_000); // stale for the heartbeat now
  f.respondWith('v2');
  const served = c.heartbeat(); // MUST return before the fetch settles
  assert.equal(served, 'v1'); // the OLD cache, synchronously -- never awaited
  await flush();
  assert.equal(f.calls.length, 2); // the refresh happened, in the background
  assert.equal(c.data, 'v2');
});

test('an explicit ask (floor 0, the codex case) refreshes on every ask, joining in flight', async () => {
  const clock = makeClock();
  const f = fakeFetch(clock);
  f.respondWith('v1');
  const c = makeCache(clock, f);
  assert.equal((await c.explicitAsk(0)).data, 'v1');
  f.respondWith('v2');
  const r = await c.explicitAsk(0); // no floor: refreshes even though the cache is 0ms old
  assert.equal(r.data, 'v2');
  assert.equal(f.calls.length, 2);
});

test('an unconfigured cache (no z.ai credential) is permanent: remembered, never refetched', async () => {
  const clock = makeClock();
  const f = fakeFetch(clock);
  f.rejectWith(Object.assign(new Error('no provider.zai.options.apiKey in /x'), { code: 'ZAI_UNCONFIGURED' }));
  let unconfiguredReports = 0;
  const c = makeCache(clock, f, { isUnconfigured: (e) => e?.code === 'ZAI_UNCONFIGURED', onUnconfigured: () => { unconfiguredReports++; } });
  await assert.rejects(() => c.explicitAsk(30_000), /no provider\.zai\.options\.apiKey/);
  assert.equal(unconfiguredReports, 1); // reported once
  clock.advance(10 * 60_000);
  await assert.rejects(() => c.explicitAsk(30_000), /no provider\.zai\.options\.apiKey/);
  assert.equal(f.calls.length, 1); // never re-hit upstream -- retrying cannot change this
  assert.equal(unconfiguredReports, 1);
  assert.equal(c.unconfigured, true);
  c.heartbeat(); // quiet too
  await flush();
  assert.equal(f.calls.length, 1);
});

test('a heartbeat-side failure also backs explicit asks off, and reports once per streak', async () => {
  const clock = makeClock();
  const f = fakeFetch(clock);
  f.respondWith('v1');
  const failures = [];
  const c = makeCache(clock, f, { failBackoffMs: 60_000, onFailure: (e) => failures.push(e.message) });
  c.heartbeat(); // seed via the status-line path
  await flush();
  assert.equal(c.data, 'v1');
  clock.advance(6 * 60_000); // heartbeat goes stale
  f.rejectWith(new Error('HTTP 429'));
  c.heartbeat(); // background refresh fails
  await flush();
  assert.deepEqual(failures, ['HTTP 429']); // once per streak, not per caller
  const r = await c.explicitAsk(30_000); // seconds later: an explicit ask must not re-hit
  assert.equal(f.calls.length, 2);
  assert.equal(r.stale.reason, 'HTTP 429');
});

test('a MISSING config file is unconfigured, not transient: ENOENT through the real readZaiApiKey', async () => {
  // The owner's reported case, at the factory level: a codex bridge's HOME
  // has no config.json, so the production fetch wrapper dies inside
  // readZaiApiKey with ENOENT. That is "no credential HERE" -- permanent --
  // and must reach the same honest sentence a missing key block gets, on
  // both surfaces, with the endpoint (and the filesystem) never re-hit.
  const clock = makeClock();
  let fetchAttempts = 0;
  const fetch = () => {
    fetchAttempts++;
    return fetchUsage({ apiKey: readZaiApiKey('/nonexistent/zcode-cli/config.json') });
  };
  const c = makeCache(clock, fetch, { isUnconfigured: (e) => e?.code === 'ZAI_UNCONFIGURED' });
  await assert.rejects(() => c.explicitAsk(30_000), /ENOENT/); // first ask: throws
  assert.equal(c.unconfigured, true); // ...as PERMANENT, not a 60s-transient
  await assert.rejects(() => c.explicitAsk(30_000), /ENOENT/); // second ask: same verdict
  assert.equal(fetchAttempts, 1); // COUNTED: no re-read -- retrying cannot change this
  // The TG surface, through usageGetForMcp's catch shape (index.js):
  const text = await usageTelegramText(async () => {
    try {
      await c.explicitAsk(30_000);
    } catch (e) {
      if (c.unconfigured) throw unconfiguredUsageError();
      throw e;
    }
  });
  assert.equal(text, `⚠️ /usage failed: ${unconfiguredUsageError().message}`);
});
