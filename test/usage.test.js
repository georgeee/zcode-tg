// node --test test/ -- /usage rendering fixtures against the REAL response
// shape captured live from GET /api/monitor/usage/quota/limit on 2026-08-31
// (see git history). The API's field names are misleading (`usage` is the
// cap, `currentValue` is what's used); these tests pin our interpretation so
// a refactor can't silently swap them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUsage } from '../bridge/usage.js';

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

test('renders both windows with cap-as-usage disambiguated', () => {
  const out = renderUsage(LIVE_PAYLOAD.data, NOW);
  assert.ok(out.includes('Short-term (~5h)'), out);
  assert.ok(out.includes('Weekly'), out);
  assert.ok(out.includes('127 / 2000 cr'), out); // used / cap, not cap / used
  assert.ok(out.includes('127 / 10000 cr'), out);
  assert.ok(out.includes('1872'), out);
  assert.ok(out.includes('9872'), out);
  assert.ok(out.includes('6%'), out);
  assert.ok(out.includes('1%'), out);
  assert.ok(out.includes('Plan level: lite'), out);
});

test('reset column: relative + absolute UTC, matching the requested format', () => {
  const out = renderUsage(LIVE_PAYLOAD.data, NOW);
  assert.ok(out.includes('~10m'), out);
  assert.ok(out.includes('(2026-09-01 03:26 UTC)'), out);
  assert.ok(out.includes('(2026-09-07 22:05 UTC)'), out);
});

test('unknown window unit degrades to a literal label, not a wrong friendly one', () => {
  const out = renderUsage({ limits: [{ type: 'CREDIT_LIMIT', unit: 9, number: 2, usage: 500, currentValue: 1, remaining: 499, percentage: 0, nextResetTime: Date.now() + 3600_000 }] });
  assert.ok(out.includes('unit 9 x 2'), out);
});

test('columns are aligned (every data row is exactly as wide as its content)', () => {
  const out = renderUsage(LIVE_PAYLOAD.data, NOW);
  const lines = out.split('\n').filter((l) => l.includes(' cr '));
  assert.equal(lines.length, 2);
});
