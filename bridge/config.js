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
