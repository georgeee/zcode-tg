// Unit tests for the cross-backend /model pure helpers (bridge/modelref.js):
// merging per-backend model lists into one stable listing, and resolving a
// user-typed ref to the {backend, ref} pair it names -- with the ambiguity
// rule (a bare ref offered by two backends is refused, naming both) and the
// qualified `backend:ref` override. PLAIN DATA IN, PLAIN DATA OUT: no bridge
// boot, no Telegram, no backend subprocesses -- the same {backend: [models]}
// maps handleModelCommand assembles from real listModels() calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeModelLists, resolveModelRef, qualifyModelRef } from '../bridge/modelref.js';

// Two backends whose refs overlap, plus mock's single model: the disjoint
// namespace today's deployments have is the EASY case, and these tests must
// not rely on it (a ref matching in more than one backend is exactly the
// shape the resolver exists to catch).
const LISTS = {
  zcode: [
    { ref: 'zai/glm-5.3-flash', label: 'GLM-5.3 Flash', contextWindow: 204800 },
    { ref: 'zai/glm-4.6', label: 'GLM-4.6' },
  ],
  codex: [
    { ref: 'gpt-5.6-terra', label: 'Terra' },
    { ref: 'shared-model', label: 'offered by both, on purpose' },
  ],
  mock: [{ ref: 'shared-model', label: 'mock echoes it too' }],
};

test('resolve picks the unique backend for a bare ref', () => {
  assert.deepEqual(resolveModelRef('gpt-5.6-terra', LISTS), { backend: 'codex', ref: 'gpt-5.6-terra' });
  assert.deepEqual(resolveModelRef('zai/glm-5.3-flash', LISTS), { backend: 'zcode', ref: 'zai/glm-5.3-flash' });
});

test('a ref offered by more than one backend is refused, naming every backend that has it', () => {
  let err = null;
  try {
    resolveModelRef('shared-model', LISTS);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'ambiguous ref must throw');
  assert.match(err.message, /shared-model/);
  assert.match(err.message, /codex/);
  assert.match(err.message, /mock/);
  assert.doesNotMatch(err.message, /zcode/); // only the backends that actually offer it
  assert.match(err.message, /backend:model|backend:ref/); // the reply must name the escape hatch
});

test('the qualified backend:ref form resolves the override exactly', () => {
  assert.deepEqual(resolveModelRef('mock:shared-model', LISTS), { backend: 'mock', ref: 'shared-model' });
  assert.deepEqual(resolveModelRef('codex:shared-model', LISTS), { backend: 'codex', ref: 'shared-model' });
  // A slash-carrying ref qualifies fine too (zcode refs always carry one).
  assert.deepEqual(resolveModelRef('zcode:zai/glm-4.6', LISTS), { backend: 'zcode', ref: 'zai/glm-4.6' });
});

test('qualified form names the problem precisely: unknown backend vs unknown model on a known one', () => {
  let err = null;
  try {
    resolveModelRef('nonsense:shared-model', LISTS);
  } catch (e) {
    err = e;
  }
  assert.ok(err?.message.includes('nonsense'), err?.message);
  assert.match(err.message, /known backend/i);

  err = null;
  try {
    resolveModelRef('codex:zai/glm-5.3-flash', LISTS);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'a ref the named backend does not offer must throw');
  assert.match(err.message, /zai\/glm-5.3-flash/);
  assert.match(err.message, /codex/);
});

test('a bare unknown ref is refused with the list hint', () => {
  let err = null;
  try {
    resolveModelRef('gpt-9-whimsy', LISTS);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'unknown ref must throw');
  assert.match(err.message, /gpt-9-whimsy/);
  assert.match(err.message, /\/model/); // points at the listing command
});

test('merge orders by the given backend order, then by each list order -- stable across calls', () => {
  const a = mergeModelLists(LISTS, ['codex', 'zcode', 'mock']);
  const b = mergeModelLists(LISTS, ['codex', 'zcode', 'mock']);
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.map((m) => `${m.backend}:${m.ref}`),
    [
      'codex:gpt-5.6-terra',
      'codex:shared-model',
      'zcode:zai/glm-5.3-flash',
      'zcode:zai/glm-4.6',
      'mock:shared-model',
    ],
  );
});

test('merge keeps every model field and tolerates a backend whose list failed (absent key)', () => {
  const merged = mergeModelLists({ zcode: [{ ref: 'zai/glm-5.3-flash', label: 'GLM-5.3 Flash', contextWindow: 204800 }] }, ['codex', 'zcode']);
  assert.deepEqual(merged, [{ backend: 'zcode', ref: 'zai/glm-5.3-flash', label: 'GLM-5.3 Flash', contextWindow: 204800 }]);
});

test('qualifyModelRef round-trips through resolveModelRef', () => {
  const pair = { backend: 'zcode', ref: 'zai/glm-5.3-flash' };
  assert.deepEqual(resolveModelRef(qualifyModelRef(pair.backend, pair.ref), LISTS), pair);
});
