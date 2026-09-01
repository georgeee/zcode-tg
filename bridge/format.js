// Model replies arrive as markdown-ish text; Telegram renders them as raw
// backticks and asterisks unless the message is sent with a parse_mode. This
// renders the practical subset the model actually emits (fenced + inline
// code, bold/italic/strike, links, headings, lists, quotes, rules) into
// Telegram HTML, escaping everything else -- and splits the result into
// chunks under Telegram's 4096-char message cap, never breaking inside a
// code block's *content* without reopening the tags in the next chunk.
//
// Deliberately not a full CommonMark parser: the model's output is for a chat
// window, and a wrong-but-contained rendering beats a parse error that bounces
// the whole reply. Anything unrecognized passes through as escaped plain text.

const CHUNK_LIMIT = 3900; // headroom under Telegram's 4096 for the chunk joins

// chunkLimit is overridden by the streaming preview (bridge/streamer.js),
// which needs extra headroom in the same message for its ⌛ prefix and
// status lines.
export function renderReply(text, chunkLimit = CHUNK_LIMIT) {
  return splitHtml(mdToHtml(text ?? ''), chunkLimit);
}

// Fallback for Telegram rejecting our HTML outright ("can't parse entities"):
// strip the tags we generate and undo the entity escaping so the text still
// gets delivered, just unformatted. Better than losing the reply.
export function toPlainText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Control-character placeholders: can't collide with real content (they're
// stripped by Telegram anyway, but we always restore them before sending) and
// survive the escapeHtml pass untouched, so code content can hold its literal
// ** and ` until reinsertion.
const FENCED = (i) => `\x00${i}\x00`;
const INLINE = (i) => `\x01${i}\x01`;

function mdToHtml(md) {
  const fenced = [];
  const inlines = [];

  // 1. Fenced code blocks first, so nothing else reformats their contents.
  //    An unclosed ``` fence (truncated long reply) still renders as a block.
  let src = md.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
    fenced.push({ lang: lang.trim(), code });
    return FENCED(fenced.length - 1);
  });

  // 2. Inline code spans out of the way of bold/italic replacement.
  src = src.replace(/`([^`\n]+)`/g, (m, code) => {
    inlines.push(code);
    return INLINE(inlines.length - 1);
  });

  // 3. Escape everything that HTML would eat. From here on, only text we
  //    generate ourselves (tags, placeholders) contains markup.
  src = escapeHtml(src);

  // 4. Links: [text](https://...) -- only http(s), so a markdown-ish
  //    [x](javascript:...) degrades to plain text rather than an href.
  src = src.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, txt, url) => {
    return `<a href="${url.replace(/"/g, '&quot;')}">${txt}</a>`;
  });

  // 5. Inline emphasis, most specific first. Single-line only -- a stray **
  //    at one end of a paragraph and * at the other must not swallow the
  //    text between (and Telegram tags don't need to span lines anyway).
  src = src.replace(/~~(\S(?:[^~\n]*?\S)?)~~/g, '<s>$1</s>');
  src = src.replace(/\*\*(\S(?:[^*\n]*?\S)??)\*\*/g, '<b>$1</b>');
  src = src.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '<i>$1</i>');

  // 6. Line-level shapes. Headings and rules become bold lines / a rule so
  //    they read as structure without markdown's # --- showing through.
  const QUOTE = (s) => `\x02${s}\x02`;
  src = src
    .split('\n')
    .map((line) => {
      const h = line.match(/^ {0,3}#{1,6}\s+(.*)$/);
      if (h) return `<b>${h[1].trim()}</b>`;
      if (/^ {0,3}([-*_]\s*){3,}$/.test(line)) return '────────────';
      const li = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (li) return `${li[1]}• ${li[2]}`;
      const nli = line.match(/^(\s*\d+)[.)]\s+(.*)$/);
      if (nli) return `${nli[1]}. ${nli[2]}`;
      const bq = line.match(/^ {0,3}&gt;\s?(.*)$/);
      if (bq) return QUOTE(bq[1]);
      return line;
    })
    .join('\n');

  // Group consecutive quoted lines into one <blockquote> (Telegram renders it
  // as the collapsible quoted block).
  src = src.replace(/(^\x02.*\x02\n?)+/gm, (block) => {
    const inner = block
      .trimEnd()
      .split('\n')
      .map((l) => l.replace(/^\x02/, '').replace(/\x02$/, ''))
      .join('\n');
    return `<blockquote>${inner}</blockquote>`;
  });

  // 7./8. Restore the code held aside, escaped, as real tags.
  src = src.replace(/\x01(\d+)\x01/g, (m, i) => `<code>${escapeHtml(inlines[+i])}</code>`);
  src = src.replace(/\x00(\d+)\x00/g, (m, i) => {
    const { lang, code } = fenced[+i];
    const cls = lang ? ` class="language-${lang.replace(/[^a-z0-9+#_-]/gi, '')}"` : '';
    return `<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
  });

  return src;
}

// Split under `max`, preferring newline boundaries, never mid-entity where
// avoidable, and reopening an interrupted <pre><code> in the continuation
// chunk so a very long code block becomes several visually-contiguous code
// messages instead of one broken one. The reopening suffix/prefix have to
// come out of the budget, not on top of it -- the first version of this
// measured the cut before adding '\n</code></pre>' and every pre chunk came
// out 13 chars over the cap.
function splitHtml(html, max) {
  const chunks = [];
  let start = 0;
  while (start < html.length) {
    if (html.length - start <= max) {
      chunks.push(html.slice(start));
      break;
    }
    const PRE_SUFFIX = '\n</code></pre>';
    const inPre = countPres(html.slice(0, start + max)) > 0;
    const suffix = inPre ? PRE_SUFFIX : '';
    let end = Math.min(start + max - suffix.length, html.length);
    let brokeAtNewline = false;
    if (end < html.length) {
      // Preference order: newline (always safe), space (safe unless inside
      // an <a href> with a very long URL), then a hard cut. A hard cut can
      // land mid-tag or mid-entity; that chunk then fails Telegram's parser
      // and sendChunkFallback in index.js delivers it as plain text -- rare
      // and contained, which is the right trade here.
      const brk = html.lastIndexOf('\n', end);
      const sp = html.lastIndexOf(' ', end);
      if (brk > start) {
        end = brk;
        brokeAtNewline = true;
      } else if (sp > start) {
        end = sp;
      }
    }
    chunks.push(html.slice(start, end) + suffix);
    start = brokeAtNewline ? end + 1 : end;
    if (inPre && start < html.length) {
      html = `<pre><code>${html.slice(start)}`;
      start = 0;
    }
  }
  return chunks.filter((c) => c.length);
}

function countPres(s) {
  let n = 0;
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i] !== '<') continue;
    if (s.startsWith('<pre>', i)) n++;
    else if (s.startsWith('</pre>', i)) n--;
  }
  return n; // > 0 means the string ends inside an unclosed <pre>
}
