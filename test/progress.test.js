// Unit coverage for bridge/progress.js's pure helpers: step-detail
// extraction (model descriptions preferred over raw commands) and the
// live/frozen message rendering (labels uncapped up to the 2000-char
// budget, newline structure preserved).
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepDetail, liveText, frozenText } from '../bridge/progress.js';

test('stepDetail prefers the model description over the raw command', () => {
  const d = stepDetail('Bash', { command: 'cd /srv/some/long/path && grep -rn needle . | head', description: 'Find where the needle is referenced' });
  assert.equal(d, 'Find where the needle is referenced');
});

test('stepDetail falls back to a cd-stripped first command line', () => {
  const d = stepDetail('Bash', { command: 'cd /srv/repo && git log --oneline -5\nnext line' });
  assert.equal(d, 'git log --oneline -5');
});

test('stepDetail keeps path-shaped details for file tools, caps long ones', () => {
  assert.equal(stepDetail('Edit', { file_path: '/srv/repo/bridge/index.js' }), 'bridge/index.js');
  const long = stepDetail('Bash', { description: 'x'.repeat(200) });
  assert.ok(long.length <= 81 && long.endsWith('…'));
});

test('labels keep their line structure instead of becoming one wall', () => {
  const m = { label: 'First line.\n\nSecond paragraph.\nThird.', steps: [], closed: false };
  const t = frozenText(m);
  assert.ok(t.includes('First line.\n\nSecond paragraph.\nThird.'));
});

test('frozen milestone shows checkmark + description-first steps with durations', () => {
  const m = {
    label: 'Verify the build',
    steps: [
      { tool: 'Bash', detail: 'Build both packages', durationMs: 65000, done: true },
      { tool: 'Read', detail: 'README.md', done: false },
    ],
  };
  const t = frozenText(m);
  assert.ok(t.startsWith('✅ Verify the build'));
  assert.ok(t.includes('▪ Bash · Build both packages (65s)'));
  assert.ok(t.includes('▪ Read · README.md'));
});
