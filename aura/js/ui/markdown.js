/**
 * AURA :: Minimal Markdown Renderer
 * ---------------------------------
 * Zero-dependency, XSS-safe: everything is HTML-escaped FIRST, then a small
 * set of inline/block rules is applied. No `innerHTML` of raw user content.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ESC[c]); }

function inline(text) {
  // Code spans are extracted FIRST and replaced with placeholders, so emphasis
  // rules can never run inside code (and vice-versa).
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  s = s
    // Bold: allow a lone '*' inside (e.g. "**47 * 89 = 4183**"), which a
    // [^*]+ class rejected — that left literal asterisks on screen.
    .replace(/\*\*(?!\s)((?:[^*]|\*(?!\*))+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?!\s)([^_]+?)(?<!\s)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_(?!\s)([^_\n]+?)(?<!\s)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  return s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

/**
 * @param {string} md
 * @returns {string} sanitized HTML
 */
export function renderMarkdown(md) {
  const src = escapeHtml(String(md ?? ''));
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  let inCode = false, codeLang = '', codeBuf = [];
  let listType = null, listBuf = [];
  let tableBuf = [];
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const flushList = () => {
    if (listBuf.length) {
      const tag = listType === 'ol' ? 'ol' : 'ul';
      out.push(`<${tag}>${listBuf.map(x => `<li>${inline(x)}</li>`).join('')}</${tag}>`);
      listBuf = []; listType = null;
    }
  };
  const flushTable = () => {
    if (tableBuf.length < 2) { tableBuf.forEach(r => para.push(r)); tableBuf = []; return; }
    const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const head = cells(tableBuf[0]);
    const body = tableBuf.slice(2).map(cells);
    out.push(
      `<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    );
    tableBuf = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');

    // fenced code
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        out.push(`<pre><code class="lang-${codeLang}">${codeBuf.join('\n')}</code></pre>`);
        inCode = false; codeBuf = []; codeLang = '';
      } else {
        flushAll();
        inCode = true; codeLang = fence[1] || '';
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    // table
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); tableBuf.push(line); continue; }
    else if (tableBuf.length) flushTable();

    // blank
    if (!line.trim()) { flushAll(); continue; }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushAll(); const lv = Math.min(6, h[1].length + 2); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }

    // hr
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

    // blockquote
    if (/^\s*&gt;\s?/.test(line)) { flushPara(); flushList(); out.push(`<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ''))}</blockquote>`); continue; }

    // lists
    const ul = /^\s*[-*+•]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ul) { flushPara(); if (listType === 'ol') flushList(); listType = 'ul'; listBuf.push(ul[1]); continue; }
    if (ol) { flushPara(); if (listType === 'ul') flushList(); listType = 'ol'; listBuf.push(ol[2]); continue; }
    if (listBuf.length) flushList();

    para.push(line.trim());
  }

  if (inCode) out.push(`<pre><code class="lang-${codeLang}">${codeBuf.join('\n')}</code></pre>`);
  flushAll();
  return out.join('');
}

export default renderMarkdown;
