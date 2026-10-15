/**
 * Validation and text extraction for uploaded study files.
 * A file only counts as usable once extractFile() has returned text for it.
 */
import { formatBytes } from './utils.js';

export const SUPPORTED_EXTENSIONS = ['txt', 'md', 'pdf', 'csv', 'json'];
const MAX_CHARS = 1_000_000;   // hard cap on extracted text per file
const MAX_CSV_ROWS = 5000;

/** PDF.js is loaded lazily. Put a local copy in assets/vendor/pdfjs/ to work fully offline. */
const PDFJS_VERSION = '3.11.174';
const PDFJS_SOURCES = [
  { script: 'assets/vendor/pdfjs/pdf.min.js', worker: 'assets/vendor/pdfjs/pdf.worker.min.js' },
  {
    script: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`,
    worker: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`,
  },
];

export class FileError extends Error {}

export const getExt = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
export const fingerprint = (file) => `${file.name}|${file.size}|${file.lastModified}`;

export function validateFile(file, { maxBytes, existing = [] }) {
  const ext = getExt(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return { ok: false, ext, error: `${ext ? `.${ext}` : 'This'} files aren't supported. Use ${SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(', ')}.` };
  }
  if (file.size === 0) return { ok: false, ext, error: 'This file is empty.' };
  if (file.size > maxBytes) return { ok: false, ext, error: `Larger than the ${formatBytes(maxBytes)} limit (${formatBytes(file.size)}).` };
  const fp = fingerprint(file);
  if (existing.some((a) => a.fingerprint === fp)) return { ok: false, ext, duplicate: true, error: `"${file.name}" is already attached.` };
  return { ok: true, ext, fingerprint: fp };
}

/** Returns { text, pages?, warning? } or throws FileError with a user-facing message. */
export async function extractFile(file, ext, { onProgress, signal } = {}) {
  switch (ext) {
    case 'txt':
    case 'md': return extractPlain(file);
    case 'csv': return extractCsv(file);
    case 'json': return extractJson(file);
    case 'pdf': return extractPdf(file, { onProgress, signal });
    default: throw new FileError('Unsupported file type.');
  }
}

async function readText(file) {
  let text;
  try { text = await file.text(); } catch { throw new FileError('The browser could not read this file.'); }
  text = text.replace(/^\uFEFF/, '');
  if (text.includes('\u0000')) throw new FileError('This looks like a binary file, not text.');
  if (!text.trim()) throw new FileError('This file has no readable text.');
  return text;
}

function capText(text) {
  if (text.length <= MAX_CHARS) return { text };
  return { text: text.slice(0, MAX_CHARS), warning: `Only the first ${MAX_CHARS.toLocaleString()} characters were read.` };
}

async function extractPlain(file) {
  return capText(await readText(file));
}

async function extractJson(file) {
  const raw = await readText(file);
  let value;
  try { value = JSON.parse(raw); } catch (err) { throw new FileError(`Invalid JSON: ${String(err.message).slice(0, 120)}`); }
  return capText(JSON.stringify(value, null, 2));
}

/** RFC 4180-style parser: quoted fields, doubled quotes, CRLF, custom delimiter. */
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const endRow = () => { row.push(field); field = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); if (rows.length > MAX_CSV_ROWS) break; }
    else field += ch;
  }
  if (quoted) throw new Error('unclosed quote');
  endRow();
  return rows;
}

async function extractCsv(file) {
  const raw = await readText(file);
  const firstLine = raw.split(/\r?\n/, 1)[0];
  const delimiter = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  let rows;
  try { rows = parseCsv(raw, delimiter); } catch { throw new FileError('This CSV has an unclosed quote, so it can\'t be parsed.'); }
  if (!rows.length) throw new FileError('This CSV has no data rows.');
  const clipped = rows.length > MAX_CSV_ROWS;
  const text = rows.slice(0, MAX_CSV_ROWS).map((r) => r.map((c) => c.trim().replace(/\s+/g, ' ')).join(' | ')).join('\n');
  const result = capText(text);
  if (clipped) result.warning = `Only the first ${MAX_CSV_ROWS.toLocaleString()} rows were read.`;
  return result;
}

/* ───────── PDF ───────── */
let pdfLoader = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => { el.remove(); reject(new Error(`Could not load ${src}`)); };
    document.head.append(el);
  });
}

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfLoader) {
    pdfLoader = (async () => {
      for (const source of PDFJS_SOURCES) {
        try {
          await loadScript(source.script);
          if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(source.worker, document.baseURI).href;
            return window.pdfjsLib;
          }
        } catch { /* try the next source */ }
      }
      throw new Error('pdfjs-unavailable');
    })().catch((err) => { pdfLoader = null; throw err; });
  }
  return pdfLoader;
}

async function extractPdf(file, { onProgress, signal }) {
  let pdfjs;
  try { pdfjs = await loadPdfJs(); } catch {
    throw new FileError('PDF support could not be loaded. Connect to the internet once, or place PDF.js in assets/vendor/pdfjs/ (see README).');
  }
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try { doc = await pdfjs.getDocument({ data }).promise; } catch (err) {
    if (err?.name === 'PasswordException') throw new FileError('This PDF is password-protected. Remove the password and try again.');
    throw new FileError('This PDF looks corrupted or is not a valid PDF.');
  }

  const pages = [];
  let total = 0;
  let clipped = false;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      let lastY = null;
      let lastEnd = 0;
      for (const item of content.items) {
        if (typeof item.str !== 'string' || (!item.str && !item.hasEOL)) continue;
        const [, , , , x, y] = item.transform;
        // Rebuild spacing from glyph positions: new line on a y jump, space on an x gap.
        if (lastY !== null) {
          if (Math.abs(y - lastY) > 2) text += '\n';
          else if (x - lastEnd > 0.5 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' ';
        }
        text += item.str;
        lastY = y;
        lastEnd = x + (item.width || 0);
        if (item.hasEOL) { text += '\n'; lastY = null; }
      }
      text = text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text) pages.push(`--- Page ${n} ---\n${text}`);
      total += text.length;
      page.cleanup();
      onProgress?.(n / doc.numPages);
      if (total > MAX_CHARS) { clipped = true; break; }
    }
  } finally {
    doc.destroy?.();
  }

  if (total < 20 * Math.min(doc.numPages, 5)) {
    throw new FileError('No selectable text found. This is probably a scanned PDF. OCR is not included in this version.');
  }
  const result = capText(pages.join('\n\n'));
  result.pages = doc.numPages;
  if (clipped && !result.warning) result.warning = 'Only the first part of this PDF was read because it is very large.';
  return result;
}
