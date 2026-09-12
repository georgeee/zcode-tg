// node --test test/ -- the preferences the app-server asks the bridge for.
//
// The value that matters is nativeSearchEnhancementsEnabled: leaving this
// request unanswered makes the app-server fall back to enabling it, which is
// what writes the 0600 bash prelude every command then fails to source on any
// deployment whose shell runs as a different account than the agent. See
// bridge/runtimePrefs.js for the full trace.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimePreferences } from '../bridge/runtimePrefs.js';

test('native search enhancements are ON by default, as the app-server itself defaults them', () => {
  assert.equal(runtimePreferences({}).nativeSearchEnhancementsEnabled, true);
});

test('NATIVE_SEARCH_ENHANCEMENTS=false turns them off', () => {
  const prefs = runtimePreferences({ NATIVE_SEARCH_ENHANCEMENTS: 'false' });
  assert.equal(prefs.nativeSearchEnhancementsEnabled, false);
});

// EXACTLY "false", NOT ANY FALSEY-LOOKING STRING, matching this bridge's
// existing AUTO_APPROVE_PERMISSIONS convention. "0" reading as off here and
// as on there would be the kind of inconsistency nobody discovers until a
// deployment quietly has the wrong one.
test('only the literal "false" disables them', () => {
  for (const v of ['0', 'no', 'off', '', 'true', 'False']) {
    assert.equal(
      runtimePreferences({ NATIVE_SEARCH_ENHANCEMENTS: v }).nativeSearchEnhancementsEnabled,
      true,
      `NATIVE_SEARCH_ENHANCEMENTS=${JSON.stringify(v)} should not disable`,
    );
  }
});

// The response schema on the far side is .strict(): unknown keys are a
// validation error, and every other field it accepts carries a default that
// matches the app-server's own fallback. So answering with this one key
// reproduces the fallback exactly, except for the flag being chosen here.
test('the reply carries only the one key the schema needs from us', () => {
  assert.deepEqual(Object.keys(runtimePreferences({})), ['nativeSearchEnhancementsEnabled']);
});
