// node --test test/ -- /usage rendering fixtures against the REAL response
// shape captured live from GET /api/monitor/usage/quota/limit on 2026-08-31
// (see git history). The API's field names are misleading (`usage` is the
// cap, `currentValue` is what's used); these tests pin our interpretation so
// a refactor can't silently swap them.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderUsage, usageTelegramText, usagePercentages, usageSnapshot, usageSnapshotOrThrow,
  codexUsageSnapshotOrThrow, codexUsageFetchError,
} from '../bridge/usage.js';

const LIVE_PAYLOAD = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 127, remaining: 1872, percentage: 6, nextResetTime: 1788233217027 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 127, remaining: 9872, percentage: 1, nextResetTime: 1788818739998 },
    ],
    level: 'lite',
  },
  success: true,
};

// 10 minutes before the short-term reset, so both durations are stable to assert
const NOW = 1788233217027 - 10 * 60 * 1000;

// The production z.ai pipeline, exactly as the /usage command now runs it:
// raw monitor payload -> usageSnapshotOrThrow (the object usageGetForMcp
// returns, shared with MCP) -> renderUsage. Every z.ai wording assertion
// below goes through it, so the TG surface is pinned against the SAME
// snapshot shape both surfaces consume, not against the raw API fields.
const renderZai = (data, now = NOW) => renderUsage(usageSnapshotOrThrow(data, now), { now });

test('renders both windows as Telegram HTML: used / cap disambiguated, grouped', () => {
  const out = renderZai(LIVE_PAYLOAD.data);
  assert.ok(out.includes('📊 <b>Z.ai usage</b> · plan <i>lite</i>'), out); // the headline keeps its long-standing wording
  assert.ok(out.includes('Short-term (~5h)'), out);
  assert.ok(out.includes('Weekly'), out);
  assert.ok(out.includes('127 / 2,000 cr'), out); // used / cap, not cap / used
  assert.ok(out.includes('127 / 10,000 cr'), out);
  assert.ok(out.includes('(6%)'), out);
  assert.ok(out.includes('(1%)'), out);
  assert.ok(out.includes('plan <i>lite</i>'), out);
  assert.ok(!out.includes('&lt;i&gt;'), out); // the level is rendered, not escaped into text
});

test('reset line: remaining, relative and absolute UTC', () => {
  const out = renderZai(LIVE_PAYLOAD.data);
  assert.ok(out.includes('1,872 cr left · resets in ~10m · 2026-09-01 03:26 UTC'), out);
  assert.ok(out.includes('9,872 cr left · resets in ~'), out);
  assert.ok(out.includes('2026-09-07 22:05 UTC'), out);
});

test('pressure dot and bar follow the percentage', () => {
  const out = renderZai(LIVE_PAYLOAD.data);
  assert.ok(out.includes('🟢'), out); // 6% and 1% are green
  assert.ok(out.includes('<code>▰▱▱▱▱▱▱▱▱▱</code>'), out); // ~1/10 filled
  const hot = renderZai({
    limits: [{ unit: 3, number: 5, usage: 100, currentValue: 92, percentage: 92, nextResetTime: NOW + 3600_000 }],
  });
  assert.ok(hot.includes('🔴'), hot); // 92% is red
  assert.ok(hot.includes('<code>▰▰▰▰▰▰▰▰▰▱</code>'), hot);
});

test('unknown window unit degrades to a literal label, not a wrong friendly one', () => {
  const out = renderZai({ limits: [{ type: 'CREDIT_LIMIT', unit: 9, number: 2, usage: 500, currentValue: 1, remaining: 499, percentage: 0, nextResetTime: Date.now() + 3600_000 }] });
  assert.ok(out.includes('unit 9 x 2'), out);
});

test('the level string is HTML-escaped, never trusted', () => {
  const out = renderZai({ limits: LIVE_PAYLOAD.data.limits, level: '<b>pwn</b>' });
  assert.ok(out.includes('&lt;b&gt;pwn&lt;/b&gt;'), out);
  assert.ok(!out.includes('<b>pwn</b>'), out);
});

// --- usagePercentages: the status line's percentages-only digest ---

test('usagePercentages maps short-term -> session, weekly -> week', () => {
  assert.deepEqual(usagePercentages(LIVE_PAYLOAD.data), { shortPct: 6, weekPct: 1 });
});

test('usagePercentages rounds, and tolerates missing windows / junk input', () => {
  assert.deepEqual(usagePercentages({ limits: [{ unit: 3, percentage: 11.4 }] }), { shortPct: 11, weekPct: null });
  assert.deepEqual(usagePercentages({ limits: [{ unit: 6, percentage: 5 }] }), { shortPct: null, weekPct: 5 });
  assert.deepEqual(usagePercentages({}), { shortPct: null, weekPct: null });
  assert.deepEqual(usagePercentages(null), { shortPct: null, weekPct: null });
});

// --- usageSnapshot: the same data as plain fields, for the MCP usage_get
// tool, where the API's misleading names (`usage` is the cap, `currentValue`
// is what's used) must not leak through ---

test('usageSnapshot renames the confusing fields and keeps the level', () => {
  const out = usageSnapshot(LIVE_PAYLOAD.data);
  assert.equal(out.level, 'lite');
  assert.equal(out.windows.length, 2);
  const shortTerm = out.windows[0];
  assert.equal(shortTerm.window, 'Short-term (~5h)');
  assert.equal(shortTerm.used, 127); // was currentValue
  assert.equal(shortTerm.cap, 2000); // was usage
  assert.equal(shortTerm.remaining, 1872);
  assert.equal(shortTerm.percentage, 6);
  assert.equal(shortTerm.resetsAt, new Date(1788233217027).toISOString());
});

test('usageSnapshot falls back to cap-minus-used when remaining is absent', () => {
  const out = usageSnapshot({ limits: [{ unit: 3, number: 5, usage: 100, currentValue: 40, percentage: 40, nextResetTime: 0 }] });
  assert.equal(out.windows[0].remaining, 60);
});

test('usageSnapshot tolerates missing/junk input without throwing', () => {
  assert.deepEqual(usageSnapshot(null), { level: null, windows: [] });
  assert.deepEqual(usageSnapshot({}), { level: null, windows: [] });
  const out = usageSnapshot({ limits: [{ unit: 3 }] });
  assert.deepEqual(out.windows[0], {
    window: 'Short-term (~undefinedh)', // windowLabel's own degradation for a missing `number`, not usageSnapshot's concern
    used: null,
    cap: null,
    remaining: null,
    percentage: null,
    resetsAt: null,
  });
});

// --- usageSnapshotOrThrow: usage_get's own policy, an empty cache is an
// error rather than a silent "no usage" answer ---

test('usageSnapshotOrThrow returns the reshaped data plus when it was fetched', () => {
  const out = usageSnapshotOrThrow(LIVE_PAYLOAD.data, 1788233217027 - 10 * 60 * 1000);
  assert.equal(out.level, 'lite');
  assert.equal(out.windows.length, 2);
  assert.equal(out.cachedAt, new Date(1788233217027 - 10 * 60 * 1000).toISOString());
});

test('usageSnapshotOrThrow refuses to answer before anything has been fetched', () => {
  assert.throws(() => usageSnapshotOrThrow(null, 0), /has not been fetched yet/);
});

// A BRIDGE WITH NO Z.AI CREDENTIAL IS NOT A COLD CACHE, and until this test
// existed both answered the same sentence.
//
// usage is a Z.ai coding-plan figure: the tool takes no session argument and
// reads that account's monitoring endpoint with that account's key. A
// codex-default deployment has no such credential BY DESIGN -- index.js says
// so where it skips the fetch ("expected on a non-zcode-default deployment")
// -- so its cache is empty for ever, and "retry shortly" sends a caller round
// a loop with no exit. Reported from the field 2026-09-22: three calls minutes
// apart, identical sentence, against a zcode bridge that answered first time.
test('usageSnapshotOrThrow says nothing will arrive when no z.ai credential is configured', () => {
  assert.throws(() => usageSnapshotOrThrow(null, 0, { unconfigured: true }), /no usage to report/);
  assert.throws(() => usageSnapshotOrThrow(null, 0, { unconfigured: true }), /Retrying will not change this/);
  // AND IT MUST NOT SAY THE OTHER THING: the two causes want opposite advice,
  // so a message carrying both is no better than the one it replaced.
  assert.doesNotMatch(
    (() => { try { usageSnapshotOrThrow(null, 0, { unconfigured: true }); } catch (e) { return e.message; } })(),
    /retry shortly/);
});

test('usageSnapshotOrThrow still says "not yet" for a cold cache that WILL fill', () => {
  assert.throws(() => usageSnapshotOrThrow(null, 0, { unconfigured: false }), /has not been fetched yet/);
});

// --- the Telegram surface: usageTelegramText is the WHOLE /usage render ---
//
// The command takes the same source-selection path as MCP usage_get (index.js
// hands over usageGetForMcp itself; it cannot drift), so what is pinned here
// is the render half: a zcode snapshot renders UNCHANGED on TG, a codex
// snapshot renders percentage-led with the nulls respected, and every failure
// sentence MCP can throw comes out byte for byte behind the command's ⚠️.

test('a zcode snapshot on the TG surface renders exactly as renderUsage renders it', async () => {
  const snap = usageSnapshotOrThrow(LIVE_PAYLOAD.data, NOW);
  const text = await usageTelegramText(async () => snap, { now: NOW });
  assert.equal(text, renderUsage(snap, { now: NOW })); // default headline stays "Z.ai usage"
});

// Owner's example shape (2026-09-22): "codex (plus): 35% used on the ~5h
// primary window (resets 17:03 UTC); 6% on the weekly window". Codex reports
// only usedPercent + resetsAt, so used/cap/remaining arrive null ("the nulls
// are the interface") and must render as their ABSENCE -- a percentage-led
// line -- never as fabricated "0/0" or "0 cr left".
const CODEX_RATE_LIMITS = {
  rateLimits: {
    planType: 'plus',
    primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: Date.parse('2026-09-22T17:03:00Z') / 1000 },
    secondary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: Date.parse('2026-09-26T17:03:00Z') / 1000 },
  },
};
const TG_NOW = Date.parse('2026-09-22T15:33:00Z'); // 90 min before the primary reset

test('a codex snapshot on the TG surface: percentages and resets, no invented absolutes', async () => {
  const text = await usageTelegramText(
    async () => codexUsageSnapshotOrThrow(CODEX_RATE_LIMITS, 1789999999000),
    { label: 'codex usage', now: TG_NOW },
  );
  assert.ok(text.includes('📊 <b>codex usage</b> · plan <i>plus</i>'), text);
  assert.ok(text.includes('<b>Primary (~5h)</b> — 35% used'), text);
  assert.ok(text.includes('<b>Secondary (~168h)</b> — 6% used'), text);
  assert.ok(text.includes('resets in ~1h30m · 2026-09-22 17:03 UTC'), text);
  assert.ok(text.includes('resets in ~4d1h · 2026-09-26 17:03 UTC'), text); // day-plus format drops minutes, as it always has
  assert.ok(text.includes('<code>▰▰▰▰▱▱▱▱▱▱</code>'), text); // the bar follows 35%
  // THE NULL RULE, from the negative side: nothing absolute may leak in.
  assert.ok(!text.includes('cr ('), text);
  assert.ok(!text.includes('cr left'), text);
  assert.ok(!text.includes('0 / 0'), text);
  assert.ok(!text.includes('null'), text);
  assert.ok(!text.includes('undefined'), text);
  assert.ok(!text.includes('NaN'), text);
});

test('every usage_get failure sentence renders on TG byte for byte as MCP throws it', async () => {
  // Sentences GENERATED by the same pure policy functions the usage_get
  // handler calls, then rendered by the TG wrapper: no rewording, no
  // truncation, no friendly generic swallowed over the honest one.
  const mcpSentence = (throwing) => {
    try { throwing(); } catch (e) { return e.message; }
  };
  const sentences = [
    mcpSentence(() => usageSnapshotOrThrow(null, 0, { unconfigured: true })), // z.ai: no credential on this bridge
    mcpSentence(() => usageSnapshotOrThrow(null, 0)), // z.ai: nothing fetched yet
    mcpSentence(() => codexUsageSnapshotOrThrow(null, 0)), // codex: RPC returned no payload
    mcpSentence(() => codexUsageSnapshotOrThrow({ rateLimits: {} }, 0)), // codex: no populated window
    mcpSentence(() => { throw codexUsageFetchError(Object.assign(new Error('Method not found'), { code: -32601 })); }), // codex: unsupported RPC
    mcpSentence(() => { throw codexUsageFetchError(Object.assign(new Error('Not logged in'), { code: -32000 })); }), // codex: not logged in
    mcpSentence(() => { throw codexUsageFetchError(new Error('codex call timed out: account/rateLimits/read (120000ms)')); }), // codex: transient
    'usage could not be fetched: HTTP 429', // z.ai fetch failure, the wrapper sentence usageGetForMcp throws
  ];
  for (const sentence of sentences) {
    const text = await usageTelegramText(async () => { throw new Error(sentence); }, { label: 'codex usage' });
    assert.equal(text, `⚠️ /usage failed: ${sentence}`);
  }
});

// --- half 2: a cached figure served after a FAILED refresh carries its age ---

test('a stale snapshot renders the ⚠️ age line with the reason; a fresh one does not', () => {
  const stale = usageSnapshotOrThrow(LIVE_PAYLOAD.data, NOW);
  stale.stale = { ageMs: 190_000, reason: 'HTTP 429' };
  const out = renderUsage(stale, { now: NOW });
  assert.ok(out.includes('⚠️ figures 3m old · refresh failed: HTTP 429'), out);
  // the last thing in the message, after the window blocks:
  assert.ok(out.trimEnd().endsWith('refresh failed: HTTP 429'), out);
  const fresh = usageSnapshotOrThrow(LIVE_PAYLOAD.data, NOW);
  assert.ok(!renderUsage(fresh, { now: NOW }).includes('⚠️'), renderUsage(fresh, { now: NOW }));
});

test('the stale reason is upstream text: escaped, never trusted', () => {
  const snap = usageSnapshotOrThrow(LIVE_PAYLOAD.data, NOW);
  snap.stale = { ageMs: 45_000, reason: '<b>gateway</b> error' };
  const out = renderUsage(snap, { now: NOW });
  assert.ok(out.includes('⚠️ figures 45s old · refresh failed: &lt;b&gt;gateway&lt;/b&gt; error'), out);
  assert.ok(!out.includes('<b>gateway</b> error'), out);
});
