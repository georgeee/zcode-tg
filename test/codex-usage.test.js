// node --test test/ -- usage_get's codex path against FAKE `codex app-server`
// account/rateLimits/read responses (GetAccountRateLimitsResponse, from the
// generated app-server schema of codex-cli 0.153.4). Deliberately no live
// codex credential here: these tests pin the owner-decided mapping
// (percentage + resetsAt populated, used/cap/remaining null and NEVER
// invented) and the honest-failure policy (each failure names itself and
// says whether retrying helps; an answer with nothing populated THROWS).

import test from 'node:test';
import assert from 'node:assert/strict';
import { codexUsageSnapshotOrThrow, codexUsageFetchError, codexWindowLabel } from '../bridge/usage.js';

const CACHED_AT = 1789999999000; // epoch ms

// A fully-populated read: plan named, primary 5-hour window, secondary
// 7-day window (10080 mins), both with reset times. Timestamps are epoch
// SECONDS (codex's convention for its own epoch fields -- see
// usage.js's codexResetsAtIso); the ISO strings below pin that assumption,
// so a real account contradicting it fails loudly here, not silently.
const POPULATED = {
  accountId: 'acc_123',
  rateLimits: {
    planType: 'pro',
    primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1800000000 },
    secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1800518400 },
  },
};

test('populated primary+secondary: the z.ai snapshot shape, with nulls exactly where codex reports nothing', () => {
  const out = codexUsageSnapshotOrThrow(POPULATED, CACHED_AT);
  assert.equal(out.level, 'pro');
  assert.equal(out.cachedAt, new Date(CACHED_AT).toISOString());
  assert.deepEqual(out.windows, [
    {
      window: 'Primary (~5h)',
      used: null,
      cap: null,
      remaining: null,
      percentage: 23,
      resetsAt: '2027-01-15T08:00:00.000Z', // 1800000000 SECONDS -- pins the unit assumption
    },
    {
      window: 'Secondary (~168h)',
      used: null,
      cap: null,
      remaining: null,
      percentage: 7,
      resetsAt: '2027-01-21T08:00:00.000Z',
    },
  ]);
});

test('planType null and only primary: nulls tolerated, nothing invented', () => {
  const out = codexUsageSnapshotOrThrow(
    { rateLimits: { planType: null, primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null } } },
    CACHED_AT,
  );
  assert.equal(out.level, null);
  assert.deepEqual(out.windows, [
    {
      window: 'Primary', // no windowDurationMins -> bare name, not a guessed duration
      used: null,
      cap: null,
      remaining: null,
      percentage: 0, // 0% used is a REAL reading -- must survive, not read as absent
      resetsAt: null,
    },
  ]);
});

test('a response whose fields are all null THROWS -- never an empty-but-successful figure', () => {
  assert.throws(() => codexUsageSnapshotOrThrow({ rateLimits: { planType: null, primary: null, secondary: null } }, CACHED_AT), /no populated window/);
  assert.throws(() => codexUsageSnapshotOrThrow({ rateLimits: {} }, CACHED_AT), /no populated window/);
  assert.throws(() => codexUsageSnapshotOrThrow({}, CACHED_AT), /no populated window/);
  assert.throws(() => codexUsageSnapshotOrThrow(null, CACHED_AT), /returned no payload/);
});

test('an RPC rejection is classified: which failure, and whether retrying helps', () => {
  // -32601 method-not-found (codexClient preserves the JSON-RPC code):
  // unsupported by this codex build, retrying cannot help.
  assert.throws(
    () => { throw codexUsageFetchError(Object.assign(new Error('Method not found'), { code: -32601 })); },
    /does not support account\/rateLimits\/read.*Retrying will not help.*upgrading/s,
  );
  // Login-shaped server message (exact codex wording UNVERIFIED LIVE -- the
  // verbatim text is carried so a mismatch is visible): credential problem.
  assert.throws(
    () => { throw codexUsageFetchError(Object.assign(new Error('Not logged in'), { code: -32000 })); },
    /not logged in.*Retrying will not help until the credential under CODEX_HOME is fixed/s,
  );
  // Process death / timeout: genuinely may clear (the bridge restarts a dead
  // default backend), so the message must NOT claim retrying is useless.
  assert.throws(
    () => { throw codexUsageFetchError(new Error('codex app-server exited (code=101 signal=null) before responding')); },
    /may be transient.*retrying may help/s,
  );
  assert.throws(
    () => { throw codexUsageFetchError(new Error('codex call timed out: account/rateLimits/read (120000ms)')); },
    /may be transient.*retrying may help/s,
  );
});

test('window labels: minutes, whole and fractional hours, bare name without a duration', () => {
  assert.equal(codexWindowLabel('Primary', { windowDurationMins: 300 }), 'Primary (~5h)');
  assert.equal(codexWindowLabel('Primary', { windowDurationMins: 45 }), 'Primary (~45m)');
  assert.equal(codexWindowLabel('Primary', { windowDurationMins: 90 }), 'Primary (~1.5h)');
  assert.equal(codexWindowLabel('Primary', { windowDurationMins: 0 }), 'Primary');
  assert.equal(codexWindowLabel('Primary', {}), 'Primary');
});
