// Tiny .env loader -- no dependency. Does not override vars already set in
// the real environment (systemd Environment=/EnvironmentFile= wins).
import { readFileSync, existsSync } from 'node:fs';

export function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// Where the bridge's config lives, in preference order: an explicit
// ZCODE_TG_ENV override, then ~/.config/zcode-tg/.env, then -- only when
// it's what actually exists on the machine -- a legacy
// ~/.config/zcode-mobile-bridge/.env, so existing installations keep
// working unchanged (ZCODE_MOBILE_ENV is accepted the same way).
export function resolveEnvPath({ override, home = process.env.HOME }) {
  if (override) return override;
  const fresh = `${home}/.config/zcode-tg/.env`;
  const legacy = `${home}/.config/zcode-mobile-bridge/.env`;
  return existsSync(legacy) && !existsSync(fresh) ? legacy : fresh;
}
