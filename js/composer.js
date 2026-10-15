/** The message composer: modes, options, file attachments with extraction status, send/stop. */
import { state, on, emit, getActiveConversation } from './state.js';
import { MODES, MODE_ORDER, DIFFICULTIES, LENGTHS } from './study-generator.js';
import { validateFile, extractFile, FileError } from './file-handler.js';
import { sendMessage, stopGeneration, setConversationSubject, addSubject } from './chat.js';
import { toast, promptDialog } from './ui.js';
import { h, uid, formatBytes, estimateTokens } from './utils.js';
import { iconNode } from './icons.js';

const $ = (id) => document.getElementById(id);
const files = new Map();            // attachment id -> { file, controller }
let queue = Promise.resolve();      // PDFs are read one at a time
let els;

export function initComposer() {
  els = {
    form: $('composer'), prompt: $('prompt'), send: $('btn-send'), tray: $('attachments'), input: $('file-input'),
    modes: $('mode-row'), options: $('options-row'), optBtn: $('btn-options'),
    subject: $('opt-subject'), difficulty: $('opt-difficulty'), length: $('opt-length'),
  };
  const c = state.composer;
  c.mode = state.settings.defaultMode;
  c.difficulty = state.settings.difficulty;
  c.length = state.settings.length;
  c.subject = getActiveConversation()?.subject ?? '';

  fillSelect(els.difficulty, Object.entries(DIFFICULTIES));
  fillSelect(els.length, Object.entries(LENGTHS));
  renderModes(); renderSubjects(); syncOptions(); updateSend(); autoresize();

  els.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  els.prompt.addEventListener('input', () => { autoresize(); updateSend(); });
  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  $('btn-attach').addEventListener('click', () => els.input.click());
  els.input.addEventListener('change', () => { addFiles(els.input.files); els.input.value = ''; });
  els.optBtn.addEventListener('click', () => {
    const open = els.options.hidden;
    els.options.hidden = !open;
    els.optBtn.setAttribute('aria-expanded', String(open));
  });
  els.modes.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-mode]');
    if (chip) setMode(chip.dataset.mode);
  });
  els.difficulty.addEventListener('change', () => { c.difficulty = els.difficulty.value; });
  els.length.addEventListener('change', () => { c.length = els.length.value; });
  els.subject.addEventListener('change', onSubjectChange);
  els.tray.addEventListener('click', onTrayClick);
  $('preview-close').addEventListener('click', () => $('preview-dialog').close());
  $('suggestions').addEventListener('click', (e) => {
    const card = e.target.closest('[data-mode]');
    if (card) applySuggestion(card.dataset.mode, card.dataset.prompt);
  });
  initDragDrop();

  on('generation', updateSend);
  on('composer', () => { renderSubjects(); });
  on('active', () => {
    const conv = getActiveConversation();
    if (conv) c.subject = conv.subject;
    renderSubjects();
  });
  on('settings', () => { renderModes(); });
}

const fillSelect = (select, entries) => select.replaceChildren(...entries.map(([v, t]) => h('option', { value: v, text: t })));

function syncOptions() {
  els.difficulty.value = state.composer.difficulty;
  els.length.value = state.composer.length;
}

/* ───────── Modes and options ───────── */
function renderModes() {
  els.modes.replaceChildren(...MODE_ORDER.map((id) => h('button', {
    type: 'button', class: 'chip', dataset: { mode: id }, 'aria-pressed': String(state.composer.mode === id),
  }, iconNode(MODES[id].icon, 14), MODES[id].label)));
  els.prompt.placeholder = MODES[state.composer.mode].placeholder;
}

export function setMode(mode) {
  if (!MODES[mode]) return;
  state.composer.mode = mode;
  renderModes();
}

function renderSubjects() {
  const sel = els.subject;
  sel.replaceChildren(
    h('option', { value: '', text: 'No subject' }),
    ...state.subjects.map((s) => h('option', { value: s.id, text: s.name })),
    h('option', { value: '__new', text: 'New subject…' }));
  sel.value = state.subjects.some((s) => s.id === state.composer.subject) ? state.composer.subject : '';
}

async function onSubjectChange() {
  let value = els.subject.value;
  if (value === '__new') {
    const name = await promptDialog({ title: 'New subject', label: 'Subject name', confirmLabel: 'Create' });
    value = name ? addSubject(name)?.id ?? '' : state.composer.subject;
  }
  state.composer.subject = value;
  renderSubjects();
  const conv = getActiveConversation();
  if (conv) setConversationSubject(conv.id, value);
}

function applySuggestion(mode, prompt) {
  setMode(mode);
  els.prompt.value = prompt;
  autoresize(); updateSend();
  els.prompt.focus();
  if (!state.composer.attachments.length) toast('Attach your notes with the paperclip or paste them here, then press Enter.', { timeout: 4500 });
}

/* ───────── Textarea and send button ───────── */
function autoresize() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 220)}px`;
}

function updateSend() {
  const generating = Boolean(state.generating);
  const atts = state.composer.attachments;
  const busy = atts.some((a) => a.status === 'queued' || a.status === 'processing');
  const hasInput = els.prompt.value.trim().length > 0 || atts.some((a) => a.status === 'ready');
  const btn = els.send;
  btn.classList.toggle('is-stop', generating);
  btn.replaceChildren(iconNode(generating ? 'stop' : 'send', 18));
  btn.disabled = generating ? false : !hasInput || busy;
  const label = generating ? 'Stop generating' : busy ? 'Reading files…' : 'Send message';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  els.form.setAttribute('aria-busy', String(generating));
}

function submit() {
  if (state.generating) { stopGeneration(); return; }
  const atts = state.composer.attachments;
  if (atts.some((a) => a.status === 'queued' || a.status === 'processing')) {
    toast('Files are still being read. Try again in a moment.');
    return;
  }
  const result = sendMessage({ text: els.prompt.value, attachments: atts });
  if (!result.accepted) { if (result.reason) toast(result.reason, { type: 'warn' }); return; }
  els.prompt.value = '';
  state.composer.attachments = [];
  files.clear();
  autoresize(); renderTray(); updateSend();
}

/* ───────── Attachments ───────── */
function addFiles(list) {
  const { maxFiles, maxFileMB } = state.settings;
  for (const file of [...list]) {
    const atts = state.composer.attachments;
    if (atts.length >= maxFiles) { toast(`You can attach up to ${maxFiles} files per message.`, { type: 'warn' }); break; }
    const check = validateFile(file, { maxBytes: maxFileMB * 1048576, existing: atts });
    if (check.duplicate) { toast(check.error, { type: 'info' }); continue; }
    const att = { id: uid('f'), name: file.name, ext: check.ext, size: file.size, status: check.ok ? 'queued' : 'error', progress: 0, text: '', error: check.ok ? '' : check.error, warning: '', pages: 0, fingerprint: check.fingerprint };
    atts.push(att);
    if (check.ok) {
      files.set(att.id, { file, controller: new AbortController() });
      queue = queue.then(() => extract(att));
    }
  }
  renderTray(); updateSend();
}

async function extract(att) {
  const entry = files.get(att.id);
  if (!entry || !state.composer.attachments.includes(att)) return; // removed while queued
  att.status = 'processing';
  refreshCard(att);
  try {
    const res = await extractFile(entry.file, att.ext, {
      signal: entry.controller.signal,
      onProgress: (p) => { att.progress = p; refreshCard(att); },
    });
    att.text = res.text; att.pages = res.pages ?? 0; att.warning = res.warning ?? '';
    const tokens = estimateTokens(att.text);
    if (tokens > state.settings.numCtx * 0.7) {
      att.warning = `${att.warning} About ${tokens.toLocaleString()} tokens is more than fits in the ${state.settings.numCtx.toLocaleString()}-token context. Only the start will be used unless you raise the context length in Settings.`.trim();
    }
    att.status = 'ready'; att.progress = 1;
  } catch (err) {
    if (err.name === 'AbortError') return;
    att.status = 'error';
    att.error = err instanceof FileError ? err.message : 'This file could not be read. It may be corrupted.';
  }
  files.delete(att.id);
  refreshCard(att); updateSend();
}

function buildCard(att) {
  const meta = {
    queued: 'Waiting…',
    processing: `Reading… ${Math.round(att.progress * 100)}%`,
    ready: `${att.ext.toUpperCase()} · ${formatBytes(att.size)} · ${att.text.length.toLocaleString()} characters${att.pages ? ` · ${att.pages} pages` : ''}`,
    error: att.error,
  }[att.status];
  return h('div', { class: `attachment${att.status === 'error' ? ' is-error' : ''}`, dataset: { id: att.id } },
    h('div', { class: 'attachment-icon' }, att.status === 'processing' || att.status === 'queued' ? h('div', { class: 'spinner' }) : iconNode(att.status === 'error' ? 'alert' : 'file', 16)),
    h('div', { class: 'attachment-main' },
      h('span', { class: 'attachment-name', title: att.name, text: att.name }),
      h('span', { class: 'attachment-meta', text: meta }),
      att.warning ? h('span', { class: 'attachment-warn', text: att.warning }) : null),
    h('div', { class: 'attachment-actions' },
      att.status === 'ready' ? h('button', { type: 'button', class: 'icon-btn sm', dataset: { action: 'preview' }, title: 'Preview extracted text', 'aria-label': `Preview ${att.name}` }, iconNode('eye', 15)) : null,
      h('button', { type: 'button', class: 'icon-btn sm', dataset: { action: 'remove' }, title: 'Remove file', 'aria-label': `Remove ${att.name}` }, iconNode('x', 15))),
    att.status === 'processing' ? h('div', { class: 'progress', style: `width:${Math.round(att.progress * 100)}%` }) : null);
}

function refreshCard(att) {
  const node = els.tray.querySelector(`[data-id="${CSS.escape(att.id)}"]`);
  if (node) node.replaceWith(buildCard(att)); else renderTray();
}

function renderTray() {
  const atts = state.composer.attachments;
  els.tray.hidden = !atts.length;
  els.tray.replaceChildren(...atts.map(buildCard));
}

function onTrayClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const att = state.composer.attachments.find((a) => a.id === btn.closest('.attachment').dataset.id);
  if (!att) return;
  if (btn.dataset.action === 'remove') {
    files.get(att.id)?.controller.abort();
    files.delete(att.id);
    state.composer.attachments = state.composer.attachments.filter((a) => a !== att);
    renderTray(); updateSend();
  } else openPreview(att);
}

function openPreview(att) {
  const LIMIT = 15000;
  $('preview-title').textContent = att.name;
  $('preview-meta').textContent = `${att.text.length.toLocaleString()} characters, about ${estimateTokens(att.text).toLocaleString()} tokens. This is exactly the text the model will read.`;
  const warn = $('preview-warning');
  warn.hidden = !att.warning;
  warn.textContent = att.warning;
  $('preview-text').textContent = att.text.length > LIMIT ? `${att.text.slice(0, LIMIT)}\n\n[… ${(att.text.length - LIMIT).toLocaleString()} more characters not shown in this preview …]` : att.text;
  $('preview-dialog').showModal();
}

/* ───────── Drag and drop ───────── */
function initDragDrop() {
  const zone = $('dropzone');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; zone.hidden = false; } });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; zone.hidden = true; } });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; zone.hidden = true;
    addFiles(e.dataTransfer.files);
    els.prompt.focus();
  });
}

export const focusComposer = () => els.prompt.focus();
