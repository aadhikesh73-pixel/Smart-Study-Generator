/**
 * Small Markdown renderer. Strategy:
 *   1. Escape everything first, then add only the tags this file generates.
 *   2. Run the result through an allow-list sanitizer as a second line of defence.
 * Raw HTML in the source is therefore shown as text, never executed.
 */
import { escapeHtml } from './utils.js';

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FENCE_RE = /^\s*(```|~~~)\s*([\w+#.-]*)/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>/;

/* ───────── Inline ───────── */
export function inline(source) {
  const stash = [];
  const keep = (html) => `\u0001${stash.push(html) - 1}\u0001`;

  let s = String(source).replace(/[\u0000\u0001]/g, '');
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, label, url) =>
    keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`));
  s = escapeHtml(s);
  s = s.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(\S(?:[\s\S]*?\S)?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*(\S(?:[^*\n]*?\S)?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(>])_(\S(?:[^_\n]*?\S)?)_(?=[\s).,;:!?<]|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~(\S(?:[\s\S]*?\S)?)~~/g, '<del>$1</del>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => stash[Number(i)]);
}

/* ───────── Blocks ───────── */
function codeBlock(code, lang) {
  return `<div class="codeblock"><div class="codeblock-head"><span class="codeblock-lang">${escapeHtml(lang || 'text')}</span>`
    + `<button type="button" class="codeblock-copy" data-action="copy-code">Copy</button></div>`
    + `<pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function splitRow(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isBlockStart(lines, i) {
  const line = lines[i];
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line)
    || (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]));
}

function buildList(items) {
  let pos = 0;
  const level = (indent) => {
    const tag = items[pos].ordered ? 'ol' : 'ul';
    let html = `<${tag}>`;
    while (pos < items.length && items[pos].indent >= indent) {
      const item = items[pos++];
      let li = `<li>${inline(item.text)}`;
      if (pos < items.length && items[pos].indent > item.indent) li += level(items[pos].indent);
      html += `${li}</li>`;
    }
    return `${html}</${tag}>`;
  };
  return level(items[0].indent);
}

function readList(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST_RE);
    // A top-level item of the other kind (bullet vs numbered) starts a new list.
    const startsNewList = (match) => items.length > 0
      && match[1].replace(/\t/g, '    ').length <= items[0].indent
      && /\d/.test(match[2]) !== items[0].ordered;
    if (m) {
      if (startsNewList(m)) break;
      items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3] });
      i++;
    } else if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? lines[j].match(LIST_RE) : null;
      if (next && !startsNewList(next)) i = j; else break;
    } else if (/^\s{2,}\S/.test(line) && items.length && !isBlockStart(lines, i)) {
      items[items.length - 1].text += ` ${line.trim()}`; // wrapped continuation line
      i++;
    } else break;
  }
  return { html: buildList(items), next: i };
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = line.match(FENCE_RE);
    if (m) {
      const [, fence, lang] = m;
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++; // closing fence (may be missing while streaming)
      out.push(codeBlock(buf.join('\n'), lang));
      continue;
    }
    if ((m = line.match(HEADING_RE))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${blocks(buf)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST_RE.test(line)) { const res = readList(lines, i); out.push(res.html); i = res.next; continue; }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) buf.push(lines[i++]);
    out.push(`<p>${buf.map((l) => inline(l.trim())).join('<br>')}</p>`);
  }
  return out.join('\n');
}

/** Markdown to HTML without the sanitizer pass. Exported for tests. */
export const markdownToHtml = (src) => blocks(String(src).replace(/\r\n?/g, '\n').split('\n'));

/* ───────── Sanitizer ───────── */
const ALLOWED_TAGS = new Set(['A', 'P', 'BR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'DIV', 'SPAN', 'BUTTON']);
const ALLOWED_CLASSES = new Set(['codeblock', 'codeblock-head', 'codeblock-lang', 'codeblock-copy', 'table-wrap']);

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html'); // inert: nothing runs or loads
  const walk = (parent) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); continue; }
      if (!ALLOWED_TAGS.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent)); continue; }

      for (const attr of [...node.attributes]) {
        const ok = attr.name === 'class'
          || (node.tagName === 'A' && ['href', 'target', 'rel'].includes(attr.name))
          || (node.tagName === 'BUTTON' && ['type', 'data-action'].includes(attr.name));
        if (!ok) node.removeAttribute(attr.name);
      }
      if (node.hasAttribute('class')) {
        const kept = node.getAttribute('class').split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c));
        if (kept.length) node.setAttribute('class', kept.join(' ')); else node.removeAttribute('class');
      }
      if (node.tagName === 'A') {
        if (!/^(https?:|mailto:)/i.test(node.getAttribute('href') || '')) node.removeAttribute('href');
        node.setAttribute('rel', 'noopener noreferrer');
        node.setAttribute('target', '_blank');
      }
      if (node.tagName === 'BUTTON') {
        if (node.getAttribute('data-action') !== 'copy-code') node.removeAttribute('data-action');
        node.setAttribute('type', 'button');
      }
      walk(node);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export const renderMarkdown = (src) => sanitizeHtml(markdownToHtml(src));
export const renderInline = (src) => sanitizeHtml(inline(src));
