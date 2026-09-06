// Unit coverage for bridge/progress.js's pure helpers: step-detail
// extraction (model descriptions preferred over raw commands) and the
// live/frozen message rendering (labels uncapped up to the 2000-char
// budget, newline structure preserved).
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepDetail, liveText, frozenText, ProgressReporter } from '../bridge/progress.js';

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

// The reporter is drivable without network with a resolving fake tg. The
// owner's run-on complaint is the POST-CAP fold: past MAX_MILESTONES,
// further narrations fold into the LAST message synchronously -- and each
// segment still gets its own timestamped line there. try/finally around
// r.stop() is load-bearing: an assertion thrown before stop() leaves the
// flush timer alive and hangs the test runner (found the hard way).
test('post-cap narrations fold into timestamped lines on the last message', () => {
  let id = 100;
  const tg = {
    sendMessage: async () => ({ message_id: ++id }),
    editMessageText: async () => {},
  };
  const r = new ProgressReporter({ tg, chatId: 1, threadId: 1, seedMessageId: 42, editIntervalMs: 10_000_000 });
  try {
    for (let i = 0; i < 12; i++) {
      r.toolCall({ toolName: 'Bash', input: { command: 'x', description: 'd' }, toolCallId: 'c' + i });
      r.narration('filler ' + i + '.'); // each opens a milestone until the cap
    }
    assert.equal(r.milestones.length, 10, 'cap held'); // seed + 9 opens: the guard opens while length < MAX
    // Everything past the cap folds into the last milestone synchronously:
    const label = r.current.label;
    const lines = label.split('\n');
    assert.ok(lines.length >= 3, `expected folded stamped lines, got: ${JSON.stringify(label)}`);
    for (const l of lines) assert.match(l, /^\d{2}:\d{2} /, `line not timestamped: ${JSON.stringify(l)}`);
    // Same-segment deltas share one line; a tool between narrations starts a new one.
    assert.ok(lines[lines.length - 1].includes('filler 11.'), lines[lines.length - 1]);
    assert.ok(!label.includes('filler 11.filler'), 'segments must not run together');
  } finally {
    r.stop();
  }
});
