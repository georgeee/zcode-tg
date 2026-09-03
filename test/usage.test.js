// node --test test/ -- /usage rendering fixtures against the REAL response
// shape captured live from GET /api/monitor/usage/quota/limit on 2026-08-31
// (see git history). The API's field names are misleading (`usage` is the
// cap, `currentValue` is what's used); these tests pin our interpretation so
// a refactor can't silently swap them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUsage, usagePercentages } from '../bridge/usage.js';

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

test('renders both windows as Telegram HTML: used / cap disambiguated, grouped', () => {
  const out = renderUsage(LIVE_PAYLOAD.data, NOW);
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
  const out = renderUsage(LIVE_PAYLOAD.data, NOW);
  assert.ok(out.includes('1,872 cr left · resets in ~10m · 2026-09-01 03:26 UTC'), out);
  assert.ok(out.includes('9,872 cr left · resets in ~'), out);
  assert.ok(out.includes('2026-09-07 22:05 UTC'), out);
});

test('pressure dot and bar follow the percentage', () => {
  const out = renderUsage(LIVE_PAYLOAD.data, NOW);
  assert.ok(out.includes('🟢'), out); // 6% and 1% are green
  assert.ok(out.includes('<code>▰▱▱▱▱▱▱▱▱▱</code>'), out); // ~1/10 filled
  const hot = renderUsage({
    limits: [{ unit: 3, number: 5, usage: 100, currentValue: 92, percentage: 92, nextResetTime: NOW + 3600_000 }],
  }, NOW);
  assert.ok(hot.includes('🔴'), hot); // 92% is red
  assert.ok(hot.includes('<code>▰▰▰▰▰▰▰▰▰▱</code>'), hot);
});

test('unknown window unit degrades to a literal label, not a wrong friendly one', () => {
  const out = renderUsage({ limits: [{ type: 'CREDIT_LIMIT', unit: 9, number: 2, usage: 500, currentValue: 1, remaining: 499, percentage: 0, nextResetTime: Date.now() + 3600_000 }] });
  assert.ok(out.includes('unit 9 x 2'), out);
});

test('the level string is HTML-escaped, never trusted', () => {
  const out = renderUsage({ limits: LIVE_PAYLOAD.data.limits, level: '<b>pwn</b>' }, NOW);
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
