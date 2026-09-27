// The @-suffix predicate behind the bridge's command interception
// (bridge/commands.js). In a group with more than one bot, a command
// carrying @somename belongs to somename or nobody -- shared-group design
// section 1. The bug this pins: parseCommand used to match the suffix and
// DISCARD it, so /model@SomeOtherBot ran our handler. One predicate, five
// verdicts it must get right, each a test below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandText, commandIsOurs, proxiedBackendSwitchRefusal } from '../bridge/commands.js';

test('parseCommandText: plain command, command with suffix, non-commands', () => {
  assert.deepEqual(parseCommandText('/usage'), { name: 'usage', suffix: null });
  assert.deepEqual(parseCommandText('/model gpt-6-astra'), { name: 'model', suffix: null });
  assert.deepEqual(parseCommandText('/usage@SomeBot'), { name: 'usage', suffix: 'SomeBot' });
  assert.deepEqual(parseCommandText('/usage@SomeBot now'), { name: 'usage', suffix: 'SomeBot' });
  assert.deepEqual(parseCommandText('/stop@Other_Bot '), { name: 'stop', suffix: 'Other_Bot' });
  assert.equal(parseCommandText('hello'), null);
  assert.equal(parseCommandText('/'), null);
  assert.deepEqual(parseCommandText('/init extra'), { name: 'init', suffix: null }); // the model's, not ours -- but parsed
  assert.equal(parseCommandText(''), null);
  assert.equal(parseCommandText(undefined), null);
  // command name is case-insensitive as before; the suffix travels verbatim
  assert.deepEqual(parseCommandText('/STOP'), { name: 'stop', suffix: null });
});

test('no suffix: ours -- the whole pre-shared-group world, unchanged', () => {
  assert.equal(commandIsOurs(null, 'ourbot'), true);
  assert.equal(commandIsOurs(null, null), true); // even with our own name unknown
});

test('our suffix: ours', () => {
  assert.equal(commandIsOurs('ourbot', 'ourbot'), true);
});

test('our suffix in different case: ours -- Telegram usernames are case-insensitive', () => {
  assert.equal(commandIsOurs('OurBot', 'ourbot'), true);
  assert.equal(commandIsOurs('OURBOT', 'OurBot'), true);
});

test('foreign suffix: not ours', () => {
  assert.equal(commandIsOurs('otherbot', 'ourbot'), false);
  assert.equal(commandIsOurs('ourbot2', 'ourbot'), false); // a prefix is not a match
});

test('unknown own username (getMe unanswered): a suffixed command is NOT ours -- never assumed', () => {
  assert.equal(commandIsOurs('ourbot', null), false);
  assert.equal(commandIsOurs('ourbot', undefined), false);
  assert.equal(commandIsOurs('ourbot', ''), false);
  // and the case-insensitivity must not rescue it
  assert.equal(commandIsOurs('OurBot', null), false);
});

// The proxied-mode refusal (relay-owned-group design, section 4): a unix:
// TELEGRAM_API_ROOT means a relay stands in for Telegram, a topic's provider
// is fixed by its fleet/model binding, and BOTH switch surfaces (/backend's
// argument, /model's resolveModelRef answer) must refuse a cross-backend
// move with the one shared sentence. The truth table over
// (proxied, topicBackend, otherBackend) -> refusal | null:
test('proxied + cross-backend: refused with THE sentence, naming the other backend', () => {
  assert.equal(
    proxiedBackendSwitchRefusal(true, 'zcode', 'codex'),
    "⚠️ this topic's provider is fixed by its fleet/model binding; create a topic for codex instead",
  );
  assert.equal(
    proxiedBackendSwitchRefusal(true, 'codex', 'zcode'),
    "⚠️ this topic's provider is fixed by its fleet/model binding; create a topic for zcode instead",
  );
});

test('not proxied: allow, cross-backend included -- today\'s behavior byte for byte', () => {
  assert.equal(proxiedBackendSwitchRefusal(false, 'zcode', 'codex'), null);
  assert.equal(proxiedBackendSwitchRefusal(false, 'codex', 'zcode'), null);
});

test('proxied + same backend: allow -- within-backend switches stay legal and invisible to the relay', () => {
  assert.equal(proxiedBackendSwitchRefusal(true, 'zcode', 'zcode'), null);
  assert.equal(proxiedBackendSwitchRefusal(true, 'codex', 'codex'), null);
  assert.equal(proxiedBackendSwitchRefusal(false, 'zcode', 'zcode'), null);
});

test('both surfaces (/backend arg, /model resolution) produce the identical refusal string', () => {
  // /backend hands the handler its argument; /model hands it the backend
  // resolveModelRef found the ref in. Same predicate, same triple shape --
  // so the two surfaces cannot drift, asserted here as one string.
  const viaBackendArg = proxiedBackendSwitchRefusal(true, 'zcode', 'codex');
  const viaModelResolution = proxiedBackendSwitchRefusal(true, 'zcode', 'codex');
  assert.equal(viaBackendArg, viaModelResolution);
  assert.match(
    viaBackendArg,
    /^⚠️ this topic's provider is fixed by its fleet\/model binding; create a topic for codex instead$/,
  );
});
