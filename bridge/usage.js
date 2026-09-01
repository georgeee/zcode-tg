// /usage: Z.ai coding-plan quota, straight from the monitoring endpoint the
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
  const zai = JSON.parse(readFileSync(configPath, 'utf8'))?.provider?.zai;
  const apiKey = zai?.options?.apiKey;
  if (!zai || !apiKey) throw new Error(`no provider.zai.options.apiKey in ${configPath}`);
  return { providerId: 'zai', kind: zai.kind, label: zai.name, baseURL: zai.options.baseURL, apiKey };
}

export async function fetchUsage({ apiKey, url = USAGE_URL, fetchImpl = fetch }) {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' } });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success || !Array.isArray(json.data?.limits)) {
    throw new Error(json?.msg || `HTTP ${res.status}`);
  }
  return json.data;
}

// unit 3 x number 5 -> "Short-term (~5h)"; unit 6 x 1 -> "Weekly". Any other
// combination degrades to a literal label rather than a wrong friendly one.
function windowLabel(l) {
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

export function renderUsage(data, now = Date.now()) {
  const rows = data.limits.map((l) => ({
    window: windowLabel(l),
    used: `${l.currentValue} / ${l.usage} cr`,
    remaining: String(l.remaining ?? '—'),
    pct: `${l.percentage}%`,
    resets: `in ~${humanRemaining(l.nextResetTime - now)} (${utc(l.nextResetTime)})`,
  }));
  const head = ['Window', 'Used', 'Remaining', '% used', 'Resets'];
  const widths = head.map((_, i) => Math.max(head[i].length, ...rows.map((r) => r[Object.keys(r)[i]].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  // ASCII hyphens for the rule: an em-dash is ambiguous-width in several
  // monospace fonts and visibly breaks the column alignment it's measuring.
  const table = [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map((r) => line(Object.values(r)))].join('\n');
  const level = data.level ? `\n\nPlan level: ${data.level}` : '';
  return `📊 Z.ai usage\n\n${table}${level}`;
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

function utc(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
