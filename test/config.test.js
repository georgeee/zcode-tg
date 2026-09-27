// The three boot states of bridge/config.js: Telegram (token present -- the
// full trio required, byte for byte the old need() behavior), MCP-only
// (transport present, token absent -- the chat vars demoted), and neither
// (refused, naming both ways out). Pure env-in, cfg-out: no process exits in
// here, which is the whole reason this module exists (index.js exports
// nothing and cannot be imported without booting).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, ConfigError } from '../bridge/config.js';

// A self-contained env: ZCODE_TG_ENV points at a path that does NOT exist so
// the refusal text takes its "No config found" branch deterministically,
// regardless of what the machine running the tests has in ~/.config.
const BASE = {
  ZCODE_BIN: '/bin/zcode',
  ZCODE_WORKSPACE_DIR: '/tmp/ws',
  ZCODE_TG_ENV: '/nonexistent/zcode-tg-test.env',
  HOME: '/nonexistent-home',
};

// node's assert.throws verifies a throw but does not hand the error back, so
// capture it directly -- the tests below assert ON the message.
function configErrorOf(env) {
  try {
    buildConfig(env);
  } catch (e) {
    return e;
  }
  assert.fail('expected buildConfig to refuse this env');
}

test('a token present keeps the full trio required', () => {
  const cfg = buildConfig({
    ...BASE,
    TELEGRAM_BOT_TOKEN: 'tok',
    TELEGRAM_CHAT_ID: '-100777',
    TELEGRAM_ALLOWED_USER_ID: '42',
    MCP_UNIX_SOCKET: '/tmp/mcp.sock',
  });
  assert.equal(cfg.telegramToken, 'tok');
  assert.equal(cfg.chatId, -100777);
  assert.equal(cfg.allowedUserId, 42);
  assert.equal(cfg.mcpUnixSocket, '/tmp/mcp.sock');
});

test('a token present without TELEGRAM_CHAT_ID is refused exactly as before (no MCP-only demotion)', () => {
  const err = configErrorOf({ ...BASE, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_ALLOWED_USER_ID: '42' });
  assert.ok(err instanceof ConfigError);
  assert.match(err.message, /^missing required env var: TELEGRAM_CHAT_ID\n/);
  // today's pointer at the searched config path, still present (this env
  // points at a path that does not exist, so the no-config branch fires)...
  assert.match(err.message, /No config found\. Create \/nonexistent\/zcode-tg-test\.env/);
  // ...and no MCP-only sentence: a token means Telegram mode, no ways-out.
  assert.doesNotMatch(err.message, /MCP_UNIX_SOCKET/);
});

test('a token present without TELEGRAM_ALLOWED_USER_ID is refused exactly as before', () => {
  const err = configErrorOf({ ...BASE, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '-100777' });
  assert.ok(err instanceof ConfigError);
  assert.match(err.message, /^missing required env var: TELEGRAM_ALLOWED_USER_ID\n/);
});

test('MCP-only: unix socket set, token absent -- chat vars demoted, not required', () => {
  const cfg = buildConfig({ ...BASE, MCP_UNIX_SOCKET: '/tmp/state/zcode-tg/mcp.sock' });
  assert.equal(cfg.telegramToken, undefined);
  assert.equal(cfg.mcpUnixSocket, '/tmp/state/zcode-tg/mcp.sock');
  assert.equal(cfg.mcpHttpPort, null);
  // There is no chat to authorize, so these name nothing; they stay parseable.
  assert.equal(cfg.chatId, 0);
  assert.equal(cfg.allowedUserId, 0);
  // The rest of cfg survives unchanged for the MCP-only boot.
  assert.equal(cfg.zcodeBin, '/bin/zcode');
  assert.equal(cfg.defaultModel, 'zai/glm-5.3-flash');
});

test('MCP-only: an explicit TELEGRAM_CHAT_ID is still parsed when given', () => {
  const cfg = buildConfig({ ...BASE, MCP_HTTP_PORT: '8080', TELEGRAM_CHAT_ID: '-100777', TELEGRAM_ALLOWED_USER_ID: '42' });
  assert.equal(cfg.telegramToken, undefined);
  assert.equal(cfg.mcpHttpPort, 8080);
  assert.equal(cfg.chatId, -100777);
  assert.equal(cfg.allowedUserId, 42);
});

test("MCP-only is spelled 'transport AND token absent': MCP_HTTP_PORT=0 counts (ephemeral listen)", () => {
  const cfg = buildConfig({ ...BASE, MCP_HTTP_PORT: '0' });
  assert.equal(cfg.mcpHttpPort, 0);
});

test('neither set: refused, and the sentence names both ways out', () => {
  const err = configErrorOf({ ...BASE });
  // Today's refusal, kept verbatim...
  assert.ok(err instanceof ConfigError);
  assert.match(err.message, /^missing required env var: TELEGRAM_BOT_TOKEN\n/);
  assert.match(err.message, /No config found\. Create \/nonexistent\/zcode-tg-test\.env/);
  assert.match(err.message, /To use a different location, set ZCODE_TG_ENV=\/path\/to\/\.env\./);
  // ...plus both ways out, named.
  assert.match(err.message, /set TELEGRAM_BOT_TOKEN \(with TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_ID\)/);
  assert.match(err.message, /set MCP_UNIX_SOCKET \(or MCP_HTTP_PORT\) for an MCP-only bridge with no Telegram at all/);
});

test('neither set with an empty MCP_UNIX_SOCKET is still a refusal', () => {
  // An empty-string socket must not count as a transport (the same trim /
  // empty rule the MCP_HTTP_PORT parse applies), so this is still a refusal.
  const err = configErrorOf({ ...BASE, MCP_UNIX_SOCKET: '' });
  assert.ok(err instanceof ConfigError);
  assert.match(err.message, /missing required env var: TELEGRAM_BOT_TOKEN/);
});

test('non-Telegram required vars still throw plain Errors (as the old need() did)', () => {
  const { ZCODE_BIN: _omitBin, ...noBin } = BASE;
  const { ZCODE_WORKSPACE_DIR: _omitWs, ...noWs } = BASE;
  const binErr = configErrorOf({ ...noBin, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1', TELEGRAM_ALLOWED_USER_ID: '1' });
  assert.match(binErr.message, /missing required env var: ZCODE_BIN/);
  assert.doesNotMatch(binErr.message, /Run it one of two ways/);
  // MCP-only boot, workspace forgotten: a plain Error, not a ConfigError --
  // it is a bug-shaped misconfiguration, not an operator-facing mode choice.
  const wsErr = configErrorOf({ ...noWs, MCP_UNIX_SOCKET: '/tmp/mcp.sock' });
  assert.ok(!(wsErr instanceof ConfigError));
  assert.match(wsErr.message, /missing required env var: ZCODE_WORKSPACE_DIR/);
});

// Proxied mode (relay-owned-group design, section 4): cfg.proxied is the
// bridge's local test for "a relay stands in for Telegram", decided from the
// same env var bridge/telegram.js parses -- a unix: root, and only that form.
test('cfg.proxied: a unix: TELEGRAM_API_ROOT is proxied mode', () => {
  const cfg = buildConfig({
    ...BASE,
    TELEGRAM_BOT_TOKEN: 'tok',
    TELEGRAM_CHAT_ID: '-100777',
    TELEGRAM_ALLOWED_USER_ID: '42',
    TELEGRAM_API_ROOT: 'unix:/tmp/state/zcode-tg/relay.sock',
  });
  assert.equal(cfg.proxied, true);
});

test('cfg.proxied: http(s) roots -- explicit or the absent default -- are NOT proxied', () => {
  const telegramTrio = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '-100777', TELEGRAM_ALLOWED_USER_ID: '42' };
  // absent: the default https root bridge/telegram.js falls back to
  assert.equal(buildConfig({ ...BASE, ...telegramTrio }).proxied, false);
  assert.equal(buildConfig({ ...BASE, ...telegramTrio, TELEGRAM_API_ROOT: 'https://api.telegram.org' }).proxied, false);
  // any http(s) root counts, not just Telegram's own host
  assert.equal(buildConfig({ ...BASE, ...telegramTrio, TELEGRAM_API_ROOT: 'http://localhost:8081' }).proxied, false);
});
