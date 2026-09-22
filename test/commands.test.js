// The @-suffix predicate behind the bridge's command interception
// (bridge/commands.js). In a group with more than one bot, a command
// carrying @somename belongs to somename or nobody -- shared-group design
// section 1. The bug this pins: parseCommand used to match the suffix and
// DISCARD it, so /model@SomeOtherBot ran our handler. One predicate, five
// verdicts it must get right, each a test below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandText, commandIsOurs } from '../bridge/commands.js';

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
