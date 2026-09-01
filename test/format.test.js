// node --test test/ -- renderer fixtures for the markdown -> Telegram HTML
// path. Each fixture pins what the model's output actually looks like after
// rendering, so a regex change can't silently degrade the chat experience.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReply, toPlainText } from '../bridge/format.js';

function firstChunk(md) {
  return renderReply(md)[0];
}

test('plain text passes through, entities escaped', () => {
  assert.equal(firstChunk('hello world'), 'hello world');
  assert.equal(firstChunk('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

test('bold, italic, strikethrough', () => {
  assert.equal(firstChunk('**bold**'), '<b>bold</b>');
  assert.equal(firstChunk('*italic*'), '<i>italic</i>');
  assert.equal(firstChunk('~~gone~~'), '<s>gone</s>');
  assert.equal(firstChunk('**a** and *b* and ~~c~~'), '<b>a</b> and <i>b</i> and <s>c</s>');
});

test('stray asterisks are not emphasized', () => {
  assert.equal(firstChunk('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24');
  assert.equal(firstChunk('a ** b'), 'a ** b');
});

test('inline code wins over emphasis inside it', () => {
  assert.equal(firstChunk('run `x **not bold** y` now'), 'run <code>x **not bold** y</code> now');
});

test('fenced code block: content untouched, language kept, markdown inside literal', () => {
  const out = firstChunk('before\n```js\nconst a = **b** < c;\n```\nafter');
  assert.ok(out.includes('before'));
  assert.ok(out.includes('<pre><code class="language-js">const a = **b** &lt; c;</code></pre>'), out);
  assert.ok(out.includes('after'));
});

test('unclosed fence still renders as a block', () => {
  const out = firstChunk('text\n```\ncode that got truncated');
  assert.ok(out.includes('<pre><code>code that got truncated</code></pre>'), out);
});

test('links become anchors, non-http schemes do not', () => {
  assert.equal(firstChunk('see [docs](https://example.com/a?b=1)'), 'see <a href="https://example.com/a?b=1">docs</a>');
  assert.equal(firstChunk('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
});

test('headings, bullets, numbered lists, rules, quotes', () => {
  assert.equal(firstChunk('## Title'), '<b>Title</b>');
  assert.equal(firstChunk('- item'), '• item');
  assert.equal(firstChunk('3. step'), '3. step');
  assert.equal(firstChunk('---'), '────────────');
  const q = firstChunk('> quoted\n> more');
  assert.equal(q, '<blockquote>quoted\nmore</blockquote>');
});

test('emphasis never crosses a newline', () => {
  // single-line regexes: a ** opened on one line and closed on the next
  // stays literal rather than swallowing the paragraph between
  assert.equal(firstChunk('**bold\nnot**'), '**bold\nnot**');
});

test('long plain text splits at newline boundaries, chunks respect the cap', () => {
  const para = 'word '.repeat(60).trim(); // ~300 chars
  const md = Array.from({ length: 20 }, (_, i) => `${i} ${para}`).join('\n\n'); // ~6000
  const chunks = renderReply(md);
  assert.ok(chunks.length > 1, `expected split, got ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 3900, `chunk too long: ${c.length}`);
  // nothing lost
  const rejoined = chunks.join('\n');
  assert.ok(rejoined.includes('0 word word'), rejoined.slice(0, 50));
  assert.ok(rejoined.includes('19 word word'));
  // no chunk starts or ends inside a tag
  for (const c of chunks) assert.ok(!/<a[^>]*$/.test(c) && !/^[^<>]*>/.test(c.replace(/<\/?(b|i|s|code|pre|blockquote)>/g, '')));
});

test('a very long code block splits into reopened pre chunks', () => {
  const code = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  const chunks = renderReply('```\n' + code + '\n```');
  assert.ok(chunks.length > 1);
  assert.ok(chunks[0].startsWith('<pre><code>'));
  assert.ok(chunks[0].endsWith('</code></pre>'));
  for (const c of chunks) {
    assert.ok(c.length <= 3900);
    assert.equal((c.match(/<pre>/g) || []).length, (c.match(/<\/pre>/g) || []).length, 'unbalanced pre in chunk');
  }
  // all content survives across chunks
  const text = chunks.map(toPlainText).join('\n');
  assert.ok(text.includes('line 0 '));
  assert.ok(text.includes('line 199 '));
});

test('toPlainText undoes the rendering', () => {
  const html = firstChunk('**b** `c` < & [l](https://x.y/z)');
  const plain = toPlainText(html);
  assert.equal(plain, 'b c < & l');
});
