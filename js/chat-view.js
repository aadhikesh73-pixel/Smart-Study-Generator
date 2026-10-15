/**
 * Renders the message thread. Full re-renders happen only when the conversation changes;
 * while streaming, just the live message body is patched (throttled).
 */
import { state, on, getActiveConversation } from './state.js';
import { renderMarkdown } from './markdown.js';
import { MODES, parseFlashcards, parseQuiz } from './study-generator.js';
import { renderFlashcards, renderQuiz } from './study-widgets.js';
import { h, formatTime, formatDateTime, formatBytes, copyText, stripThinking } from './utils.js';
import { iconNode } from './icons.js';
import { toast } from './ui.js';
import * as chat from './chat.js';

const $ = (id) => document.getElementById(id);
let scroller; let thread; let welcome; let jump;
let stick = true;
let patchTimer = null;
let lastPatch = 0;

export function initChatView() {
  scroller = $('scroller'); thread = $('thread'); welcome = $('welcome'); jump = $('btn-jump');

  scroller.addEventListener('scroll', () => {
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    updateJump();
  }, { passive: true });
  jump.addEventListener('click', () => scrollToBottom(true));
  thread.addEventListener('click', onThreadClick);

  on('active', (d) => renderAll(d));
  on('messages', (d) => renderAll(d));
  on('error', renderErrorBanner);
  on('generation', updateJump);
  on('stream', onStream);
  on('conversations', updateTitle);
  renderAll({ scroll: 'bottom' });
}

function updateTitle() {
  const conv = getActiveConversation();
  $('topbar-title').textContent = conv?.title ?? 'Smart Study';
  document.title = conv ? `${conv.title} · Smart Study` : 'Smart Study';
}

function updateJump() {
  jump.hidden = stick || !state.generating;
}

function scrollToBottom(force = false) {
  if (force || stick) scroller.scrollTop = scroller.scrollHeight;
  if (force) { stick = true; updateJump(); }
}

function renderAll(detail = {}) {
  const conv = getActiveConversation();
  const has = Boolean(conv?.messages.length);
  welcome.hidden = has;
  thread.hidden = !has;
  updateTitle();
  if (!has) {
    thread.replaceChildren();
    if (detail.scroll === 'bottom') scroller.scrollTop = 0;
    return;
  }
  const prevTop = scroller.scrollTop;
  thread.replaceChildren(...conv.messages.map((m) => buildMessage(m, conv)), ...[buildErrorBanner()].filter(Boolean));
  if (detail.scroll === 'bottom') scrollToBottom(true); else scroller.scrollTop = prevTop;
}

/* ───────── Message DOM ───────── */
function actionButton(action, icon, label) {
  return h('button', { type: 'button', class: 'icon-btn sm', dataset: { action }, title: label, 'aria-label': label }, iconNode(icon, 15));
}

function buildMessage(msg, conv) {
  const isUser = msg.role === 'user';
  const live = state.generating?.msgId === msg.id;
  const mode = MODES[msg.mode];

  const content = h('div', { class: 'msg-content prose' });
  fillContent(content, msg, live, conv);

  const actions = [actionButton('copy-message', 'copy', 'Copy message')];
  if (!isUser && !state.generating && conv.messages.at(-1) === msg) actions.push(actionButton('regenerate', 'refresh', 'Regenerate response'));
  actions.push(actionButton('delete-message', 'trash', 'Delete message'));

  const body = h('div', { class: 'msg-body' },
    h('div', { class: 'msg-meta' },
      h('span', { class: 'msg-role', text: isUser ? 'You' : 'Smart Study' }),
      mode && msg.mode !== 'chat' ? h('span', { class: 'badge', text: mode.label }) : null,
      h('time', { datetime: new Date(msg.ts).toISOString(), title: formatDateTime(msg.ts), text: formatTime(msg.ts) })),
    isUser && msg.docs.length
      ? h('div', { class: 'msg-files' }, msg.docs.map((d) => h('span', { class: 'file-chip', title: `${d.name} (${formatBytes(d.size)})` }, iconNode('file', 14), h('span', { text: d.name }))))
      : null,
    content,
    msg.notice ? h('div', { class: 'msg-note' }, iconNode('alert', 14), h('span', { text: msg.notice })) : null,
    live ? null : h('div', { class: 'msg-actions', role: 'group', 'aria-label': 'Message actions' }, ...actions));

  return h('article', { class: `msg ${isUser ? 'msg-user' : 'msg-ai'}${live ? ' is-live' : ''}`, dataset: { id: msg.id } },
    isUser ? null : h('div', { class: 'msg-avatar', 'aria-hidden': 'true' }, iconNode('logo', 18)),
    body);
}

function buildThinking() {
  const label = state.generating?.phase === 'reasoning' ? 'Reasoning through your notes' : 'Thinking';
  return h('div', { class: 'thinking', role: 'status' },
    h('div', { class: 'thinking-row' }, h('span', { class: 'orb', 'aria-hidden': 'true' }), h('span', { text: label }),
      h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))),
    h('div', { class: 'skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
}

/** Fill a message body. Text from the user or model only ever reaches the DOM via textContent or the sanitized renderer. */
function fillContent(el, msg, live, conv) {
  if (msg.role === 'user') {
    if (msg.content) el.textContent = msg.content;
    else { el.textContent = `Using ${msg.docs.length === 1 ? 'the attached file' : 'the attached files'}`; el.classList.add('is-placeholder'); }
    return;
  }
  const text = stripThinking(msg.content);
  if (live && !text) { el.replaceChildren(buildThinking()); return; }
  const widget = live ? null : buildWidget(msg, text, conv);
  if (widget) {
    const raw = h('details', { class: 'raw-toggle' }, h('summary', { text: 'View as text' }), h('div', { class: 'prose' }));
    raw.querySelector('.prose').innerHTML = renderMarkdown(text);
    el.replaceChildren(widget, raw);
  } else {
    el.innerHTML = renderMarkdown(text);
  }
}

/** Flashcard / quiz output becomes interactive once it parses; otherwise it stays readable text. */
function buildWidget(msg, text, conv) {
  const save = (data) => chat.saveProgress(conv.id, msg.id, data);
  if (msg.mode === 'flashcards') {
    const cards = parseFlashcards(text);
    if (cards.length) return renderFlashcards(cards, conv.progress[msg.id], save);
  }
  if (msg.mode === 'quiz') {
    const questions = parseQuiz(text);
    if (questions.length) return renderQuiz(questions, conv.progress[msg.id], save);
  }
  return null;
}

/* ───────── Errors ───────── */
function buildErrorBanner() {
  const err = state.lastError;
  if (!err || err.convId !== state.activeId) return null;
  return h('div', { class: 'banner banner-error', role: 'alert', dataset: { banner: '1' } },
    iconNode('alert', 18),
    h('div', { class: 'banner-text' },
      h('strong', { text: err.message }),
      err.hint ? h('p', { text: err.hint }) : null,
      h('div', { class: 'banner-actions' },
        err.retryable ? h('button', { type: 'button', class: 'btn btn-sm', dataset: { action: 'retry' }, text: 'Try again' }) : null,
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { action: 'dismiss-error' }, text: 'Dismiss' }))));
}

function renderErrorBanner() {
  thread?.querySelector('[data-banner]')?.remove();
  const banner = buildErrorBanner();
  if (banner && !thread.hidden) { thread.append(banner); scrollToBottom(true); }
}

/* ───────── Streaming ───────── */
function liveNode(msgId) {
  return thread.querySelector(`[data-id="${CSS.escape(msgId)}"]`);
}

function patchLive() {
  const g = state.generating;
  if (!g || g.convId !== state.activeId) return;
  const conv = getActiveConversation();
  const msg = conv?.messages.find((m) => m.id === g.msgId);
  const body = liveNode(g.msgId)?.querySelector('.msg-content');
  if (!msg || !body) return;
  fillContent(body, msg, true, conv);
  scrollToBottom(false);
}

function onStream(e) {
  if (e.convId !== state.activeId) return;
  if (e.type === 'token' || e.type === 'phase') {
    if (patchTimer) return;
    patchTimer = setTimeout(() => {
      patchTimer = null;
      lastPatch = performance.now();
      requestAnimationFrame(patchLive);
    }, Math.max(0, 60 - (performance.now() - lastPatch)));
  } else if (e.type === 'end') {
    clearTimeout(patchTimer);
    patchTimer = null;
    const conv = getActiveConversation();
    const msg = conv?.messages.find((m) => m.id === e.msgId);
    const node = liveNode(e.msgId);
    if (node && msg) node.replaceWith(buildMessage(msg, conv)); // swap in the final version with actions and widgets
    else if (node) node.remove();
    scrollToBottom(false);
    updateJump();
  }
}

/* ───────── Actions (event delegation) ───────── */
async function onThreadClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.closest('.msg')?.dataset.id;
  const conv = getActiveConversation();

  if (action === 'copy-code') {
    const ok = await copyText(btn.closest('.codeblock')?.querySelector('code')?.textContent ?? '');
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  } else if (action === 'copy-message') {
    const msg = conv?.messages.find((m) => m.id === id);
    const ok = await copyText(msg ? stripThinking(msg.content) : '');
    toast(ok ? 'Copied to clipboard.' : 'Couldn\'t copy. Select the text and copy it manually.', { type: ok ? 'success' : 'error', timeout: 2200 });
  } else if (action === 'regenerate' || action === 'retry') chat.regenerateLast();
  else if (action === 'delete-message' && id) chat.deleteMessage(id);
  else if (action === 'dismiss-error') chat.dismissError();
}
