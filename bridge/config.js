// Bridge configuration: parse the process environment into cfg, and decide
// the boot mode. Split out of index.js (which exports nothing and cannot be
// imported without booting) so the three boot states are unit-testable:
//
//   1. TELEGRAM_BOT_TOKEN set            -- a Telegram bridge. The full trio
//      (token + TELEGRAM_CHAT_ID + TELEGRAM_ALLOWED_USER_ID) is required, and
//      MCP_UNIX_SOCKET / MCP_HTTP_PORT may additionally expose the MCP
//      gateway. Byte for byte today's behavior.
//   2. token absent + MCP_UNIX_SOCKET (or MCP_HTTP_PORT) set -- MCP-only
//      mode: zcode/codex usable as MCPs with NO Telegram at all -- no bot,
//      no group, no polling. TELEGRAM_CHAT_ID / TELEGRAM_ALLOWED_USER_ID are
//      NOT required here (there is no chat to authorize; the security gate
//      does not loosen -- it is simply not in the path). The security gate
//      itself (the owner allowlist) stays exactly as strict whenever a
//      token IS present.
//   3. neither -- refused with a sentence naming both ways out.
//
// The refusal is a ConfigError, not a process.exit: the caller (index.js)
// prints it and exits, exactly as the inline need() this module replaces
// did -- need() itself exited, but the exit belongs to the program's entry
// point, not to a parser a test has to import.

import { existsSync } from 'node:fs';
import { resolveEnvPath } from './env.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// The message need() printed for a missing TELEGRAM_* var, preserved
// verbatim: the first var every fresh install trips on is TELEGRAM_BOT_TOKEN,
// and pointing at the config path actually being searched (honoring
// ZCODE_TG_ENV and any fallbacks) is what sent people digging through the
// README once and got fixed here.
function missingTelegramVar(key, env) {
  const cfgPath = resolveEnvPath({ override: env.ZCODE_TG_ENV || env.ZCODE_MOBILE_ENV, home: env.HOME });
  const have = existsSync(cfgPath);
  const lines = [
    `missing required env var: ${key}`,
    have
      ? `${cfgPath} exists but doesn't define ${key} -- fill it in (see .env.example in the repo).`
      : `No config found. Create ${cfgPath} (template: .env.example in the repo) with at least TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_ID.`,
    `To use a different location, set ZCODE_TG_ENV=/path/to/.env.`,
  ];
  return new ConfigError(lines.join('\n'));
}

// Appended to the refusal when there is no Telegram token AND no MCP
// transport: today's message alone reads as "Telegram or nothing", which
// stopped being true with MCP-only mode. Name both ways out.
function withWaysOut(err) {
  return new ConfigError(
    err.message +
      '\n' +
      'Run it one of two ways: set TELEGRAM_BOT_TOKEN (with TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_ID) ' +
      'for a Telegram bridge, or set MCP_UNIX_SOCKET (or MCP_HTTP_PORT) for an MCP-only bridge with no Telegram at all.',
  );
}

// Numeric env with a fallback, and WITHOUT Number()'s traps: '' -> fallback,
// garbage -> fallback, and a real 0 survives (AGY_IDLE_CLOSE_MIN=0 must stay
// 0 -- it means "disable the reaper" -- where `|| fallback` would erase it).
function numberEnv(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function buildConfig(env = process.env) {
  const mcpHttpPort = env.MCP_HTTP_PORT?.trim() ? Number(env.MCP_HTTP_PORT) : null;
  const mcpUnixSocket = env.MCP_UNIX_SOCKET || '';
  const hasMcpTransport = Boolean(mcpUnixSocket) || mcpHttpPort != null;
  const token = env.TELEGRAM_BOT_TOKEN || '';

  // THE BOOT MODE DECISION. A token always means Telegram mode -- MCP-only
  // is spelled "transport set AND token absent", never "transport set", so
  // a deployment that configures a bot can never silently lose it.
  if (!token && !hasMcpTransport) {
    throw withWaysOut(missingTelegramVar('TELEGRAM_BOT_TOKEN', env));
  }

  // The rest of the trio stays required exactly as before WHENEVER a token
  // is present -- MCP-only mode demotes nothing but the vars that name a
  // chat, and only when there is no chat to name.
  if (token && !env.TELEGRAM_CHAT_ID) throw missingTelegramVar('TELEGRAM_CHAT_ID', env);
  if (token && !env.TELEGRAM_ALLOWED_USER_ID) throw missingTelegramVar('TELEGRAM_ALLOWED_USER_ID', env);

  return {
    telegramToken: token || undefined,
    // Proxied mode (relay-owned-group design, section 4): the API root is a
    // unix: socket, so a relay is standing in for Telegram -- parsed here,
    // from the same env var bridge/telegram.js reads, so the proxied-mode
    // command refusals are testable without the client. Any http(s) root
    // (explicit or the absent default) is the direct world, not proxied.
    proxied: (env.TELEGRAM_API_ROOT || '').startsWith('unix:'),
    chatId: Number(env.TELEGRAM_CHAT_ID || 0),
    allowedUserId: Number(env.TELEGRAM_ALLOWED_USER_ID || 0),
    nodeBin: env.ZCODE_NODE_BIN || process.execPath,
    zcodeBin: env.ZCODE_BIN || raise(`missing required env var: ZCODE_BIN`),
    workspaceDir: env.ZCODE_WORKSPACE_DIR || raise(`missing required env var: ZCODE_WORKSPACE_DIR`),
    defaultModel: env.ZCODE_DEFAULT_MODEL || 'zai/glm-5.3-flash',
    codexBin: env.CODEX_BIN || 'codex',
    codexHome: env.CODEX_HOME || '',
    codexDefaultModel: env.CODEX_DEFAULT_MODEL || 'gpt-5.6-terra',
    codexDisallowAstra: /^(1|true|yes)$/i.test(env.CODEX_DISALLOW_ASTRA || ''),
    // The antigravity backend (Google Antigravity CLI, `agy`): opt-in and
    // lazily started exactly like codex -- a deployment that never sets
    // AGY_HOME (nor DEFAULT_BACKEND/EAGER_BACKENDS/MODEL_BACKENDS
    // 'antigravity') pays nothing for it. agyBin may be a bare 'agy' on PATH
    // or the nix store path; agyHome is the credential HOME (the CODEX_HOME
    // analogue: it holds .gemini/antigravity-cli/antigravity-oauth-token,
    // 0600, one login per bridge model account -- never a path under the
    // workspace); agyEffort is the reasoning-effort default for new sessions
    // (low|medium|high, per George's single-model decision 2026-09-24).
    agyBin: env.AGY_BIN || 'agy',
    agyHome: env.AGY_HOME || '',
    agyEffort: env.AGY_EFFORT || 'medium',
    agyConfigVerifier: env.AGY_CONFIG_VERIFIER || '',
    // agy's PRIVATE working directory -- never the workspace, which the
    // executor writes and agy would read project config from (see
    // antigravityClient.js). Made 0700 at spawn; empty = the backend's
    // default, <AGY_HOME's parent>/.local/state/agent-cage/agy-bridge/cwd
    // (defaultAgyBridgeCwd).
    agyBridgeCwd: env.AGY_BRIDGE_CWD || '',
    // THE AGY PROCESS GC (2026-09-24). agy's stream-json mode runs one
    // process per conversation with no multiplexing, and an idle child costs
    // 93-181 MB anon RSS -- before the GC, children of finished sessions were
    // never reaped and lived until the bridge died.
    //   AGY_IDLE_CLOSE_MIN -- close a session's child after this many idle
    //     minutes (clock: end of the last turn, or the spawn; a session
    //     mid-turn is never reaped). Default 20; 0 disables.
    //   AGY_MAX_PROCS -- live agy children per bridge. A new child at the cap
    //     evicts the least-recently-used IDLE child; if all are mid-turn the
    //     request is refused with the busy keys listed. Default 4.
    // Closing a child never loses a conversation: agy persists it under
    // AGY_HOME, and the next message respawn-resumes with --conversation.
    agyIdleCloseMin: numberEnv(env, 'AGY_IDLE_CLOSE_MIN', 20),
    agyMaxProcs: numberEnv(env, 'AGY_MAX_PROCS', 4),
    defaultBackend: env.DEFAULT_BACKEND || 'zcode',
    fleet: env.TELEGRAM_FLEET || '',
    eagerBackends: (env.EAGER_BACKENDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    modelBackendsEnv: (env.MODEL_BACKENDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    storePath: env.STORE_PATH || new URL('../data/sessions.json', import.meta.url).pathname,
    permissionTimeoutMs: Number(env.PERMISSION_TIMEOUT_MS || 10 * 60 * 1000), // 10 min
    // Empty string is "off"; a bare 0 means an ephemeral listen (what the e2e uses).
    mcpHttpPort,
    mcpUnixSocket,
    autoApprovePermissions: env.AUTO_APPROVE_PERMISSIONS !== 'false', // default: on
    defaultSessionMode: env.ZCODE_DEFAULT_MODE || 'yolo',
    streamEditIntervalMs: Number(env.STREAM_EDIT_INTERVAL_MS || 5000),
    streamProgress: env.STREAM_PROGRESS || 'messages',
    inputMergeMs: Number(env.INPUT_MERGE_MS ?? 800),
    taskBlockLimitMs: Number(env.TASK_BLOCK_LIMIT_MS ?? 15 * 60 * 1000),
    inputMergeMaxMs: Number(env.INPUT_MERGE_MAX_MS ?? 3000),
    streamHeartbeatMs: Number(env.STREAM_HEARTBEAT_MS ?? 60000),
    userInputTimeoutMs: Number(env.USER_INPUT_TIMEOUT_MS || 10 * 60 * 1000),
    maxFileBytes: Number(env.MAX_FILE_MB || 45) * 1024 * 1024,
    maxInboundFileBytes: Math.min(Number(env.MAX_INBOUND_FILE_MB ?? 20), 20) * 1024 * 1024,
    turnTimeoutMs: Number(env.TURN_TIMEOUT_MS || 0),
    zaiConfigPath: env.ZAI_CONFIG_PATH || `${env.HOME ?? process.env.HOME}/.zcode/cli/config.json`,
    maxQueuePerTopic: Number(env.MAX_QUEUE_PER_TOPIC || 20),
    shutdownDrainMs: Number(env.SHUTDOWN_DRAIN_MS ?? 25 * 60 * 1000), // 25 min
  };
}

function raise(message) {
  throw new Error(message);
}
