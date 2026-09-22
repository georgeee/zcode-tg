// Usage figures for the Telegram /usage command and the MCP usage_get tool:
// one snapshot shape, one renderer, one failure wording, two backends. The
// z.ai leg below reads the coding-plan quota straight from the monitoring
// endpoint the
// account's own dashboard uses (GET /api/monitor/usage/quota/limit with the
// same API key the zcode session runs on). Field names are misleading and
// were confirmed against a live response, not guessed:
//   limits[].usage        = the CAP (2000 short-term / 10000 weekly credits)
//   limits[].currentValue = what's been USED
//   limits[].unit         = time unit (3 = hours, 6 = weeks), number = how many
//   limits[].nextResetTime = epoch ms
// Reads the key at call time from zcode's config rather than caching it or
// copying it anywhere -- point-of-use only, same rule the bridge applies to
// its own .env.

import { readFileSync } from 'node:fs';

const USAGE_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

export function readZaiApiKey(configPath) {
  return readZaiProvider(configPath).apiKey;
}

// The whole provider block, for the workspace-catalog warm-up (see
// index.js): a "user"-source registry push needs the kind/baseURL/apiKey
// that builtins resolve internally.
export function readZaiProvider(configPath) {
  // MISSING FILE counts exactly like a missing key block -- both mean "no
  // z.ai credential HERE", which is PERMANENT, not transient. The owner's
  // reported case was precisely this: a codex bridge's HOME has no
  // config.json, readFileSync threw ENOENT, and because only the key-block
  // check below was coded, the cache classified it transient -- 60s backoff,
  // retried forever, and usage_get said "usage could not be fetched: ENOENT"
  // instead of the honest no-credential sentence. So the read and parse are
  // inside the tag too: ANY failure from this function carries
  // ZAI_UNCONFIGURED, with the original message (and stack) untouched, so
  // every caller and classifier agrees.
  let zai;
  try {
    zai = JSON.parse(readFileSync(configPath, 'utf8'))?.provider?.zai;
  } catch (e) {
    e.code = 'ZAI_UNCONFIGURED';
    throw e;
  }
  const apiKey = zai?.options?.apiKey;
  if (!zai || !apiKey) {
    // CODED, not just worded: the usage cache classifies this failure as
    // PERMANENT (no credential here, now or later -- "expected on a
    // non-zcode-default deployment"), so it is remembered and never retried
    // rather than backed off like a 429. See createUsageCache.
    const e = new Error(`no provider.zai.options.apiKey in ${configPath}`);
    e.code = 'ZAI_UNCONFIGURED';
    throw e;
  }
  return { providerId: 'zai', kind: zai.kind, label: zai.name, baseURL: zai.options.baseURL, apiKey };
}

// BOUNDED, AND THAT IS NOT OPTIONAL. The monitoring endpoint is on the hot
// path of the topic status line -- an endpoint that hangs (TLS stall, dead
// upstream) would otherwise hold every status refresh for minutes with no
// error and no data. 10s is generous for a JSON quota check.
const USAGE_TIMEOUT_MS = 10_000;

export async function fetchUsage({ apiKey, url = USAGE_URL, fetchImpl = fetch }) {
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success || !Array.isArray(json.data?.limits)) {
    throw new Error(json?.msg || `HTTP ${res.status}`);
  }
  return json.data;
}

// unit 3 x number 5 -> "Short-term (~5h)"; unit 6 x 1 -> "Weekly". Any other
// combination degrades to a literal label rather than a wrong friendly one.
export function windowLabel(l) {
  if (l.unit === 3) return `Short-term (~${l.number}h)`;
  if (l.unit === 6 && l.number === 1) return 'Weekly';
  if (l.unit === 6) return `~${l.number}w`;
  return `unit ${l.unit} x ${l.number}`;
}

function humanRemaining(ms) {
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Telegram messages render in a proportional font: an ASCII column table
// collapses into ragged text the moment any cell changes width. So /usage
// speaks Telegram HTML instead -- one block per window, a status dot by
// pressure, and a 10-cell bar that is decoration only (the numbers carry the
// data, so nothing depends on glyph alignment).
function bar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function dot(pct) {
  if (pct >= 85) return '🔴';
  if (pct >= 60) return '🟡';
  return '🟢';
}

// Grouping by hand rather than toLocaleString: the result must be identical
// whatever ICU build the runtime node carries.
function grouped(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Ages are short (a cached figure served after a failed refresh is minutes
// old, not hours): seconds under a minute, minutes under an hour, then
// hours+minutes. Grouping by hand like `grouped` above -- no ICU dependence.
function humanAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

// renderUsage consumes the COMMON usage snapshot -- the exact {level,
// windows[{window, used, cap, remaining, percentage, resetsAt}], cachedAt}
// shape usageSnapshotOrThrow and codexUsageSnapshotOrThrow return -- not
// either upstream API's raw fields. ONE renderer for both backends: neither
// API's misleading names (`usage` is a cap) can leak into the wording, and a
// caller cannot get two different sentences for the same question. Windows
// where codex reports no absolutes (used/cap/remaining null -- "the nulls
// are the interface") render percentage-led, never as a fabricated "0/0" or
// "0 cr left"; a z.ai window keeps its long-standing wording byte for byte.
// `label` names the account in the headline (z.ai keeps its long-standing
// "Z.ai usage"; the codex command passes "codex usage"). cachedAt is part of
// the shape but stays unrendered: a figure inside the normal cache window
// does not announce its age -- staleness is only NEWS when a refresh FAILED
// and the cached figure is served anyway, and that case arrives marked as
// `stale: {ageMs, reason}`, rendered as the ⚠️ trailing line below.
export function renderUsage(snapshot, { label = 'Z.ai usage', now = Date.now() } = {}) {
  const head = `📊 <b>${label}</b>${snapshot.level ? ` · plan <i>${esc(snapshot.level)}</i>` : ''}`;
  const blocks = (Array.isArray(snapshot.windows) ? snapshot.windows : []).map((w) => {
    const pct = Number.isFinite(w.percentage) ? Math.round(w.percentage) : 0;
    // Absolute credits are a z.ai capability, not a default: printed only
    // when BOTH endpoints are real numbers, so a codex window (used/cap
    // null) falls to the percentage alone rather than to invented zeros.
    const measure = Number.isFinite(w.used) && Number.isFinite(w.cap)
      ? `${grouped(w.used)} / ${grouped(w.cap)} cr (${pct}%)`
      : `${pct}% used`;
    const remaining = Number.isFinite(w.remaining) ? `${grouped(w.remaining)} cr left · ` : '';
    const resetsAtMs = typeof w.resetsAt === 'number' ? w.resetsAt : Date.parse(w.resetsAt);
    const reset = Number.isFinite(resetsAtMs)
      ? `resets in ~${humanRemaining(resetsAtMs - now)} · ${utc(resetsAtMs)}`
      : 'reset time unknown';
    return [
      `${dot(pct)} <b>${w.window}</b> — ${measure}`,
      `<code>${bar(pct)}</code>`,
      `${remaining}${reset}`,
    ].join('\n');
  });
  const lines = [head, '', ...blocks];
  if (snapshot.stale) {
    // Half-2 policy (owner decision, 2026-09-22): an explicit ask whose
    // refresh FAILED is answered from the cache -- but a stale figure that
    // looks fresh is a lie, so the age and the reason travel with it. The
    // reason is upstream text: escaped like everything else.
    lines.push(`⚠️ figures ${humanAge(snapshot.stale.ageMs)} old · refresh failed: ${esc(snapshot.stale.reason)}`);
  }
  return lines.join('\n\n');
}

// usageTelegramText is the Telegram /usage command's WHOLE render, and exists
// to enforce the two halves of "one wording, both surfaces" by construction:
// the command's source selection is the SAME call usage_get makes (index.js
// hands over usageGetForMcp itself as a thunk -- no re-branch on
// cfg.defaultBackend here to drift out of sync), and a failure renders the
// SAME sentence usage_get throws, behind the command's own ⚠️ prefix. Pulled
// out as a pure function (a snapshot thunk in, Telegram text out) for the
// usual reason: index.js exports nothing, so this is the only testable seam.
// The prefix is the command surface's failure affordance, predating
// backend-awareness; everything after it is the shared sentence, byte for byte.
export async function usageTelegramText(getSnapshot, opts = {}) {
  try {
    return renderUsage(await getSnapshot(), opts);
  } catch (e) {
    return `⚠️ /usage failed: ${e.message}`;
  }
}

// Percentages-only digest for the per-topic status line ("11% session /
// 5% week" -- owner format, 2026-09-01): short-term window (unit 3) is the
// "session" figure, weekly (unit 6) the "week" one. Either is null when the
// response doesn't carry that window; callers render only what exists.
export function usagePercentages(data) {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const short = limits.find((l) => l.unit === 3);
  const week = limits.find((l) => l.unit === 6);
  const pct = (l) => (l && Number.isFinite(l.percentage) ? Math.round(l.percentage) : null);
  return { shortPct: pct(short), weekPct: pct(week) };
}

// usageSnapshot: the same figures renderUsage turns into Telegram HTML, as
// plain data rather than markup -- for the MCP usage_get tool, where the
// field names ARE the interface. The API's own names are misleading (`usage`
// is the CAP, `currentValue` is what's USED, exactly backwards from what a
// reader guesses), and that confusion must not leak through a tool a model
// is meant to reason over: every field below is named for what it holds.
export function usageSnapshot(data) {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  return {
    level: data?.level ?? null,
    windows: limits.map((l) => ({
      window: windowLabel(l),
      used: Number.isFinite(l.currentValue) ? l.currentValue : null,
      cap: Number.isFinite(l.usage) ? l.usage : null,
      // Prefer the API's own `remaining` (matches what a human sees in
      // renderUsage); fall back to the arithmetic only when it is absent,
      // rather than trusting a subtraction over a field the account itself
      // computed and may round or floor differently.
      remaining: Number.isFinite(l.remaining)
        ? l.remaining
        : Number.isFinite(l.usage) && Number.isFinite(l.currentValue)
          ? l.usage - l.currentValue
          : null,
      percentage: Number.isFinite(l.percentage) ? Math.round(l.percentage) : null,
      resetsAt: Number.isFinite(l.nextResetTime) ? new Date(l.nextResetTime).toISOString() : null,
    })),
  };
}

// usageSnapshotOrThrow is what the MCP usage_get tool actually calls:
// usageSnapshot plus the one policy decision that belongs beside it rather
// than in index.js's orchestration -- an EMPTY cache must be an ERROR, not a
// degradation. The status line has a blank to fall back to; a tool call has
// no such fallback, and answering `{windows: []}` to "how much usage is
// left" reads as "unlimited" rather than as "not fetched yet". Pulled out
// as its own pure function (data + a timestamp in, an object or a throw
// out) so this policy is unit-testable the same way every other rule in
// this file is, rather than living unreachably inside index.js, which
// exports nothing.
// The unconfigured sentence, its own function so BOTH surfaces throw the
// same object: usageSnapshotOrThrow (direct callers, tested below) and
// index.js's usageGetForMcp, whose explicit-ask path discovers
// unconfigured-ness through the cache rather than through a null data
// argument.
export function unconfiguredUsageError() {
  return new Error(
    'no usage to report: this is a Z.ai coding-plan figure and this bridge has no z.ai ' +
    'credential configured, which is expected on a codex- or mock-default deployment. ' +
    'Retrying will not change this.');
}

export function usageSnapshotOrThrow(data, cachedAt, opts = {}) {
  if (!data) {
    // AN EMPTY CACHE HAS TWO CAUSES AND THEY WANT OPPOSITE ADVICE.
    //
    // "retry shortly" is true of a cold or a failed fetch and FALSE of a
    // bridge that has no z.ai credential at all -- which is the normal state
    // of a codex- or mock-default deployment, and is described as such where
    // the fetch is skipped ("expected on a non-zcode-default deployment").
    // On such a bridge nothing will ever arrive, and telling a caller to
    // retry sends it round a loop with no exit: reported from the field on
    // 2026-09-22 after three calls minutes apart returned the identical
    // sentence, against a zcode bridge that answered on the first call.
    //
    // Usage here is a Z.AI CODING-PLAN FIGURE SPECIFICALLY -- this function
    // is only reached on a zcode-default bridge (a codex-default one is
    // routed to codexUsageSnapshotOrThrow below, before this runs), it takes
    // no session argument, and it is read from that account's monitoring
    // endpoint with that account's key. So the honest answer is that this
    // bridge has no such plan to report, not that the number is late.
    if (opts.unconfigured) throw unconfiguredUsageError();
    throw new Error('usage has not been fetched yet; retry shortly');
  }
  return { ...usageSnapshot(data), cachedAt: new Date(cachedAt).toISOString() };
}

function utc(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// --- Codex: usage_get's answer on a codex-default bridge ---
//
// Owner decision (2026-09-22): usage_get reports the quota of the bridge's
// OWN default backend. On a codex-default bridge that is the codex account's
// rate limits, read over the `codex app-server` connection the bridge
// already holds (RPC `account/rateLimits/read`), mapped onto the SAME shape
// usageSnapshot produces for z.ai -- a caller should not have to know which
// bridge it is talking to. Response shape is the generated app-server
// schema's GetAccountRateLimitsResponse (codex-cli 0.153.4,
// `codex app-server generate-json-schema --experimental`):
//   rateLimits: RateLimitSnapshot { planType?, credits?, primary?, secondary? }
//   RateLimitWindow { usedPercent (required), windowDurationMins?, resetsAt? }
//
// THE TWO UPSTREAM APIs DISAGREE ABOUT WHAT THEY REPORT, and the mapping
// does not paper over that: z.ai gives absolute credits (used/cap/remaining
// all real numbers), codex gives only a used PERCENTAGE and a reset time.
// So the codex windows carry used/cap/remaining as null -- never a cap
// back-computed from a percentage. A number upstream never reported would
// read downstream as a measurement, which is the exact failure this effort
// exists to prevent; the nulls are the interface.
export function codexUsageSnapshot(data) {
  const snap = data?.rateLimits;
  const windows = [];
  for (const [name, w] of [['Primary', snap?.primary], ['Secondary', snap?.secondary]]) {
    if (!w || !Number.isFinite(w.usedPercent)) continue;
    windows.push({
      window: codexWindowLabel(name, w),
      used: null,
      cap: null,
      remaining: null,
      percentage: Math.round(w.usedPercent),
      resetsAt: codexResetsAtIso(w.resetsAt),
    });
  }
  return { level: snap?.planType ?? null, windows };
}

// windowDurationMins -> "Primary (~5h)" / "Secondary (~45m)"; absent or
// nonsense -> the bare window name, never a guessed duration.
export function codexWindowLabel(name, w) {
  const mins = w?.windowDurationMins;
  if (!Number.isFinite(mins) || mins <= 0) return name;
  if (mins < 60) return `${name} (~${mins}m)`;
  const hours = mins / 60;
  return Number.isInteger(hours) ? `${name} (~${hours}h)` : `${name} (~${hours.toFixed(1)}h)`;
}

// The schema types resetsAt as a bare int64 with no unit. Codex's own epoch
// fields in the SAME generated dump are documented "Unix timestamp in
// seconds" (RateLimitResetCredit.grantedAt/expiresAt), so seconds it is.
// FLAG (unverified live -- this host has no codex credential): if a real
// account shows reset times a multiple of 1000 off, this one `* 1000` is
// the whole fix.
export function codexResetsAtIso(resetsAt) {
  if (!Number.isFinite(resetsAt)) return null;
  return new Date(resetsAt * 1000).toISOString();
}

// codexUsageSnapshotOrThrow is the codex side of usage_get, enforcing the
// same policy usageSnapshotOrThrow enforces for z.ai: an answer that cannot
// actually answer is an ERROR, never `{windows: []}` -- an empty success
// reads as "unlimited" to a caller deciding whether to spend.
export function codexUsageSnapshotOrThrow(data, cachedAt) {
  if (!data || typeof data !== 'object') {
    throw new Error('usage could not be fetched: codex account/rateLimits/read returned no payload');
  }
  const snap = codexUsageSnapshot(data);
  if (!snap.windows.length) {
    // The RPC succeeded and said nothing usable. Not "unlimited", not
    // "retry shortly" on a loop: say what happened and that retrying is
    // unlikely to change it.
    throw new Error(
      'usage could not be fetched: codex account/rateLimits/read answered but reported no populated window ' +
      '(no primary or secondary usedPercent). Retrying will not help unless the account state just changed.');
  }
  return { ...snap, cachedAt: new Date(cachedAt).toISOString() };
}

// codexUsageFetchError turns a REJECTED account/rateLimits/read into the
// error usage_get surfaces: WHICH failure it was, and whether retrying can
// help -- the same discipline as usageSnapshotOrThrow's
// unconfigured-vs-not-yet split. Pure (error in, error out) so it is
// unit-testable without a codex credential.
//
// What the classifier can actually distinguish: codexClient preserves the
// JSON-RPC error code on the rejected Error (codexClient.js's _onMessage
// response path), so "this build lacks the RPC" is precise (-32601); login
// state, by contrast, arrives as a server-authored MESSAGE with no
// reserved code, and the exact wording is UNVERIFIED LIVE (no credential on
// this host) -- hence the pattern match plus the verbatim server text in
// every message, so a mismatch on a real account is visible, not hidden.
export function codexUsageFetchError(e) {
  const detail = e?.message || String(e);
  if (e?.code === -32601 || /method not found/i.test(detail)) {
    return new Error(
      `usage could not be fetched: this codex version does not support account/rateLimits/read (codex said: ${detail}). ` +
      'Retrying will not help; the codex CLI needs upgrading.');
  }
  if (/not logged in|not authenticated|unauthorized|login required|no credentials|api key/i.test(detail)) {
    return new Error(
      `usage could not be fetched: the codex account on this bridge is not logged in (codex said: ${detail}). ` +
      'Retrying will not help until the credential under CODEX_HOME is fixed.');
  }
  // Process death, spawn failure, timeout: the bridge restarts a dead
  // default backend automatically, so these genuinely can clear.
  return new Error(
    `usage could not be fetched: codex account/rateLimits/read failed (codex said: ${detail}). ` +
    'This may be transient; retrying may help.');
}

// --- the cache policy both backends' usage figures are served under ---
//
// ONE POLICY, TWO INSTANCES (owner decision 2026-09-22, "half 2"). An
// EXPLICIT ask (MCP usage_get, TG /usage) and the background status line
// have opposite shapes, and the old single-TTL cache served both badly: the
// status line wants a slow cache and must never stall a turn, while a person
// or model ASKING wants movement -- twice a minute apart must show two
// different numbers when the account is moving, and a failed refresh must
// degrade to the cached figure WITH ITS AGE rather than to an error.
//
//   - heartbeat(): the status line's path. Fire-and-forget on the 5-minute
//     TTL, never awaited, exactly the old getUsageData contract.
//   - explicitAsk(floorMs): the ask path. Fresh-enough cache answers at
//     once; a staler one AWAITED its own refresh (the old warm path returned
//     stale and refreshed behind the answer -- that was the bug); a failed
//     refresh with a cached figure returns {data, stale:{ageMs, reason}},
//     and with nothing cached throws as before.
//   - failUntil: after ANY failed refresh, explicit asks for the next
//     failBackoffMs serve the cache instead of re-hitting upstream. Does not
//     touch the heartbeat, whose 5-minute TTL already governs it (60s < 5min,
//     so the backoff can only ever be the shorter suppression).
//
// The machinery lives here and not in index.js for the standing reason:
// index.js exports nothing, and a time-based policy is exactly the thing
// that must be pinned against an injected clock and a counting fetch.
export function createUsageCache({
  fetch, // async () => raw upstream payload; throws on failure
  failBackoffMs = 60_000,
  ttlMs = 5 * 60_000, // the status line's 5-minute cache
  now = Date.now, // injectable clock
  isUnconfigured = () => false, // a PERMANENT failure (no credential): remembered, never retried, never backed off
  onUnconfigured = () => {}, // called once, on first discovery
  onFailure = () => {}, // called once per failure streak (resets on success)
}) {
  let at = 0; // last refresh ATTEMPT, set eagerly -- the stampede guard; drives ttlMs
  let dataAt = 0; // when `data` was actually fetched; drives cachedAt and stale.ageMs
  let data = null; // last successful fetch
  let pending = null; // in-flight refresh; a second caller JOINS it, never stampedes
  let failUntil = 0; // explicit asks before this instant must not touch upstream
  let failure = null; // the last failure (stale.reason; the cold-cache throw)
  let unconfigured = false;
  let unconfiguredReported = false;
  let failureReported = false;

  function startFetch() {
    at = now(); // eager: concurrent callers join rather than stampede
    const p = Promise.resolve()
      .then(fetch)
      .then((fresh) => {
        data = fresh;
        dataAt = now();
        pending = null;
        failure = null;
        failureReported = false;
        return fresh;
      })
      .catch((e) => {
        pending = null;
        failure = e;
        if (isUnconfigured(e)) {
          // Permanent: remembered and reported once. No backoff -- backoff
          // is for rate limits, and this needs no retry at all. The eager
          // `at` still keeps the heartbeat quiet for a TTL, as before.
          unconfigured = true;
          if (!unconfiguredReported) {
            unconfiguredReported = true;
            onUnconfigured(e);
          }
        } else {
          failUntil = now() + failBackoffMs;
          if (!failureReported) {
            failureReported = true;
            onFailure(e);
          }
        }
        throw e;
      });
    pending = p;
    return p;
  }

  // ensure(maxAgeMs): the shared refresh decision, parameterised per
  // decision 1 (default: the 5-minute heartbeat TTL). Returns the in-flight
  // promise when a refresh is being or about to be fetched -- JOIN it; null
  // when nothing should happen: cache fresh enough for this caller's bar,
  // inside the failure backoff, or permanently unconfigured.
  function ensure(maxAgeMs = ttlMs) {
    if (unconfigured) return null;
    if (now() - at < maxAgeMs) return pending;
    if (now() < failUntil) return null;
    if (pending) return pending;
    return startFetch();
  }

  // heartbeat: the status line's path. Fire-and-forget BY CONTRACT -- the
  // caller is never made to wait on upstream; whatever is cached RIGHT NOW
  // comes back, and a due refresh happens in the background.
  function heartbeat() {
    const p = ensure();
    if (p) p.catch(() => {}); // rejection is handled (and reported) inside startFetch
    return data;
  }

  // explicitAsk: the usage_get / /usage path. Returns {data} for a fresh
  // answer, {data, stale:{ageMs, reason}} when a failed refresh (or the
  // backoff behind one) forced the cached figure, and throws when there is
  // nothing cached to fall back to.
  async function explicitAsk(floorMs) {
    if (unconfigured) throw failure;
    if (data != null && now() - dataAt < floorMs) return { data }; // fresh enough: answer at once, no fetch
    if (now() < failUntil) {
      if (data != null) return { data, stale: { ageMs: now() - dataAt, reason: failure.message } };
      throw failure; // cold and cooling down: the same verdict as the call that failed, no fetch
    }
    try {
      await (ensure(floorMs) ?? 0); // AWAITED: the answer waits for its own refresh
      return { data };
    } catch (e) {
      if (data != null) return { data, stale: { ageMs: now() - dataAt, reason: e.message } };
      throw e; // nothing cached: throw as before
    }
  }

  return {
    ensure,
    heartbeat,
    explicitAsk,
    get data() { return data; },
    get dataAt() { return dataAt; },
    get unconfigured() { return unconfigured; },
  };
}
