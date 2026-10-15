/** Sidebar: new chat, debounced search, grouped history, subjects, inline rename and item menus. */
import { state, on } from './state.js';
import { h, debounce, dayGroup } from './utils.js';
import { iconNode } from './icons.js';
import { openMenu, confirmDialog, promptDialog, closeDrawer, isMobile } from './ui.js';
import * as chat from './chat.js';

const $ = (id) => document.getElementById(id);
let editingId = null;
let subjectsOpen = true;

export function initSidebar() {
  $('btn-new-chat').addEventListener('click', () => { chat.startNewChat(); if (isMobile()) closeDrawer(); document.getElementById('prompt').focus(); });
  $('btn-add-subject').addEventListener('click', async () => {
    const name = await promptDialog({ title: 'New subject', label: 'Subject name', confirmLabel: 'Create' });
    if (name) chat.addSubject(name);
  });
  $('subjects-toggle').addEventListener('click', () => {
    subjectsOpen = !subjectsOpen;
    $('subjects-toggle').setAttribute('aria-expanded', String(subjectsOpen));
    $('subject-list').hidden = !subjectsOpen;
  });
  const search = $('search-input');
  const applySearch = debounce(() => { state.search = search.value; render(); }, 200);
  search.addEventListener('input', applySearch);
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; applySearch(); } });

  $('chat-list').addEventListener('click', onListClick);
  $('chat-list').addEventListener('dblclick', (e) => {
    const item = e.target.closest('.chat-item');
    if (item && e.target.closest('.chat-link')) startRename(item.dataset.id);
  });
  $('subject-list').addEventListener('click', onSubjectClick);
  $('btn-settings').addEventListener('click', () => $('settings-dialog').dispatchEvent(new CustomEvent('smartstudy:open')));

  on('conversations', render);
  on('active', render);
  render();
}

export const focusSearch = () => { $('search-input').focus(); $('search-input').select(); };

function snippetFor(conv, q) {
  for (const m of conv.messages) {
    const at = m.content.toLowerCase().indexOf(q);
    if (at >= 0) {
      const start = Math.max(0, at - 24);
      return h('span', { class: 'chat-snippet' },
        (start ? '…' : '') + m.content.slice(start, at).replace(/\s+/g, ' '),
        h('mark', { text: m.content.slice(at, at + q.length) }),
        m.content.slice(at + q.length, at + q.length + 50).replace(/\s+/g, ' '));
    }
  }
  return null;
}

function render() {
  renderSubjects();
  const q = state.search.trim().toLowerCase();
  let list = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.subjectFilter) list = list.filter((c) => c.subject === state.subjectFilter);
  const snippets = new Map();
  if (q) {
    list = list.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      const s = snippetFor(c, q);
      if (s) snippets.set(c.id, s);
      return Boolean(s);
    });
  }

  const root = $('chat-list');
  const nodes = [];
  const subject = state.subjects.find((s) => s.id === state.subjectFilter);
  if (subject) {
    nodes.push(h('div', { class: 'filter-chip' }, `Subject: ${subject.name}`,
      h('button', { type: 'button', 'aria-label': 'Clear subject filter', dataset: { action: 'clear-filter' } }, iconNode('x', 12))));
  }
  if (!list.length) {
    nodes.push(h('p', { class: 'side-empty', text: q ? `No chats match "${state.search.trim()}".` : subject ? 'No chats in this subject yet.' : 'No conversations yet. Start a new chat and it will show up here.' }));
  }
  const groups = new Map();
  for (const c of list) {
    const key = c.pinned ? 'Pinned' : dayGroup(c.updatedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const key of ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older']) {
    if (!groups.has(key)) continue;
    nodes.push(h('div', { class: 'group-label', text: key }), ...groups.get(key).map((c) => buildItem(c, snippets.get(c.id))));
  }
  root.replaceChildren(...nodes);
  if (editingId) { const input = root.querySelector('.chat-rename'); input?.focus(); input?.select(); }
}

function buildItem(conv, snippet) {
  const active = conv.id === state.activeId;
  if (editingId === conv.id) {
    const input = h('input', { type: 'text', class: 'chat-rename', value: conv.title, maxlength: '120', 'aria-label': 'Conversation title' });
    const finish = (save) => {
      if (editingId !== conv.id) return;
      editingId = null;
      if (save && input.value.trim()) chat.renameConversation(conv.id, input.value); else render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    return h('div', { class: 'chat-item', dataset: { id: conv.id } }, input);
  }
  return h('div', { class: `chat-item${active ? ' is-active' : ''}`, dataset: { id: conv.id } },
    h('button', { type: 'button', class: 'chat-link', dataset: { action: 'open' }, 'aria-current': active ? 'page' : null },
      h('span', { class: 'chat-title' }, h('span', { text: conv.title }), conv.pinned ? h('span', { class: 'pin-mark', title: 'Pinned' }, iconNode('pin', 12)) : null),
      snippet ?? null),
    h('button', { type: 'button', class: 'icon-btn sm chat-more', dataset: { action: 'menu' }, 'aria-label': `Actions for ${conv.title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, iconNode('more', 16)));
}

function startRename(id) { editingId = id; render(); }

async function confirmDelete(conv) {
  const ok = await confirmDialog({
    title: 'Delete this conversation?',
    message: `"${conv.title}" and its messages will be permanently removed from this browser. This can't be undone.`,
    confirmLabel: 'Delete', danger: true,
  });
  if (ok) chat.deleteConversation(conv.id);
}

function onListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'clear-filter') { state.subjectFilter = ''; render(); return; }
  const id = btn.closest('.chat-item')?.dataset.id;
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  if (btn.dataset.action === 'open') { chat.openConversation(id); if (isMobile()) closeDrawer(); return; }

  openMenu(btn, [
    { label: 'Rename', icon: 'edit', onSelect: () => startRename(id) },
    { label: conv.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: () => chat.togglePin(id) },
    { divider: true },
    { heading: 'Move to subject' },
    { label: 'No subject', checked: !conv.subject, onSelect: () => chat.setConversationSubject(id, '') },
    ...state.subjects.map((s) => ({ label: s.name, checked: conv.subject === s.id, onSelect: () => chat.setConversationSubject(id, s.id) })),
    { divider: true },
    { label: 'Delete', icon: 'trash', danger: true, onSelect: () => confirmDelete(conv) },
  ]);
}

/* ───────── Subjects ───────── */
function renderSubjects() {
  const list = $('subject-list');
  if (!state.subjects.length) {
    list.replaceChildren(h('li', { class: 'side-empty', text: 'Group chats by course or topic. Add a subject to begin.' }));
    return;
  }
  list.replaceChildren(...state.subjects.map((s) => {
    const count = state.conversations.filter((c) => c.subject === s.id).length;
    return h('li', { class: `subject-item${state.subjectFilter === s.id ? ' is-active' : ''}`, dataset: { id: s.id } },
      h('button', { type: 'button', class: 'subject-btn', dataset: { action: 'filter' }, 'aria-pressed': String(state.subjectFilter === s.id) },
        iconNode('folder', 16), h('span', { class: 'name', text: s.name }), h('span', { class: 'count', text: String(count) })),
      h('span', { class: 'subject-actions' },
        h('button', { type: 'button', class: 'icon-btn sm', dataset: { action: 'rename' }, 'aria-label': `Rename ${s.name}`, title: 'Rename' }, iconNode('edit', 14)),
        h('button', { type: 'button', class: 'icon-btn sm', dataset: { action: 'delete' }, 'aria-label': `Delete ${s.name}`, title: 'Delete' }, iconNode('trash', 14))));
  }));
}

async function onSubjectClick(e) {
  const btn = e.target.closest('[data-action]');
  const id = btn?.closest('.subject-item')?.dataset.id;
  const subject = state.subjects.find((s) => s.id === id);
  if (!subject) return;
  if (btn.dataset.action === 'filter') {
    state.subjectFilter = state.subjectFilter === id ? '' : id;
    render();
  } else if (btn.dataset.action === 'rename') {
    const name = await promptDialog({ title: 'Rename subject', label: 'Subject name', value: subject.name });
    if (name) chat.renameSubject(id, name);
  } else if (btn.dataset.action === 'delete') {
    const ok = await confirmDialog({
      title: `Delete "${subject.name}"?`,
      message: 'The subject is removed. Its conversations are kept and become unassigned.',
      confirmLabel: 'Delete subject', danger: true,
    });
    if (ok) chat.deleteSubject(id);
  }
}
