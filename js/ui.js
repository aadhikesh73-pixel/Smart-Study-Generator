/** Cross-cutting UI helpers: theme, drawer, toasts, dialogs, popup menus and status pills. */
import { state, on } from './state.js';
import { saveSettings } from './storage.js';
import { h } from './utils.js';
import { iconNode } from './icons.js';

const $ = (id) => document.getElementById(id);
const mobileQuery = window.matchMedia('(max-width: 900px)');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export const isMobile = () => mobileQuery.matches;

/* ───────── Theme ───────── */
export const resolveTheme = (pref) => (pref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : pref);

export function applyTheme(pref = state.settings.theme) {
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  const btn = $('btn-theme');
  if (btn) {
    btn.replaceChildren(iconNode(theme === 'dark' ? 'sun' : 'moon'));
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = btn.getAttribute('aria-label');
  }
}

/* ───────── Sidebar / drawer ───────── */
export function applySidebar() {
  const collapsed = state.settings.sidebarCollapsed;
  $('app').dataset.sidebar = collapsed ? 'collapsed' : 'open';
  $('sidebar').toggleAttribute('inert', collapsed && !isMobile());
}

export function openDrawer() {
  $('app').dataset.drawer = 'open';
  $('backdrop').hidden = false;
}

export function closeDrawer() {
  delete $('app').dataset.drawer;
  $('backdrop').hidden = true;
}

export function toggleSidebar() {
  if (isMobile()) {
    if ($('app').dataset.drawer === 'open') closeDrawer(); else openDrawer();
    return;
  }
  state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
  saveSettings();
  applySidebar();
}

/* ───────── Toasts ───────── */
export function toast(message, { type = 'info', timeout = 5200, action = null } = {}) {
  const root = $('toasts');
  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  };
  const iconName = { error: 'alert', warn: 'alert', success: 'check', info: 'info' }[type] ?? 'info';
  const node = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    iconNode(iconName, 16),
    h('span', { class: 'toast-text', text: message }),
    action ? h('button', { type: 'button', class: 'btn-link', text: action.label, onClick: () => { dismiss(); action.onClick(); } }) : null,
    h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Dismiss notification', onClick: dismiss }, iconNode('x', 14)));
  root.append(node);
  while (root.children.length > 4) root.firstElementChild.remove();
  if (timeout) setTimeout(dismiss, timeout);
  return dismiss;
}

/* ───────── Dialogs ───────── */
/** Resolves true only when the user presses the confirm button. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  const dlg = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  const ok = $('confirm-ok');
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'btn-danger is-solid' : 'btn-primary'}`;
  dlg.returnValue = '';
  dlg.showModal();
  $('confirm-cancel').focus(); // the safe choice has focus by default
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true });
  });
}

/** Resolves the entered text, or null when cancelled. */
export function promptDialog({ title, label, value = '', confirmLabel = 'Save' }) {
  const dlg = $('prompt-dialog');
  const input = $('prompt-input');
  $('prompt-title').textContent = title;
  $('prompt-label').textContent = label;
  $('prompt-ok').textContent = confirmLabel;
  input.value = value;
  dlg.returnValue = '';
  dlg.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      const text = input.value.trim();
      resolve(dlg.returnValue === 'ok' && text ? text : null);
    }, { once: true });
  });
}

/* ───────── Popup menu ───────── */
let openMenuState = null;

export function closeMenu() {
  if (!openMenuState) return;
  const { menu, cleanup, anchor } = openMenuState;
  openMenuState = null;
  cleanup();
  menu.remove();
  anchor.setAttribute('aria-expanded', 'false');
}

/** items: [{ label, icon, onSelect, danger, checked } | { divider: true } | { heading: 'text' }] */
export function openMenu(anchor, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item.divider) { menu.append(h('div', { class: 'menu-divider', role: 'separator' })); continue; }
    if (item.heading) { menu.append(h('div', { class: 'menu-heading', text: item.heading })); continue; }
    const btn = h('button', { type: 'button', role: 'menuitem', class: `menu-item${item.danger ? ' is-danger' : ''}${item.checked ? ' is-checked' : ''}` },
      item.icon ? iconNode(item.icon, 16) : h('span', { class: 'menu-spacer' }),
      h('span', { text: item.label }),
      item.checked ? iconNode('check', 14) : null);
    btn.addEventListener('click', () => { closeMenu(); item.onSelect?.(); });
    menu.append(btn);
  }
  $('menu-root').append(menu);
  anchor.setAttribute('aria-expanded', 'true');

  const rect = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8);
  let top = rect.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const entries = () => [...menu.querySelectorAll('.menu-item')];
  const onPointer = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = entries();
    const at = list.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
    list[next]?.focus();
  };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
  openMenuState = {
    menu, anchor,
    cleanup() {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    },
  };
  entries()[0]?.focus();
}

/* ───────── Ollama status pills ───────── */
const STATUS_TEXT = { unknown: 'Ollama not checked', checking: 'Checking Ollama…', offline: 'Ollama offline', 'model-missing': 'Model not installed' };

export function renderStatus() {
  const { status, message } = state.ollama;
  const text = status === 'connected' ? `${state.settings.model} ready` : STATUS_TEXT[status] ?? STATUS_TEXT.unknown;
  for (const id of ['topbar-status', 'composer-status', 'settings-status']) {
    const el = $(id);
    if (!el) continue;
    el.dataset.state = status;
    el.querySelector('.status-text').textContent = text;
    el.title = message || '';
  }
}

/* ───────── Init ───────── */
export function initUi() {
  // Dialogs: Escape and backdrop clicks close them; buttons set the return value.
  document.querySelectorAll('dialog.dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
  });
  $('confirm-ok').addEventListener('click', () => $('confirm-dialog').close('confirm'));
  $('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close('cancel'));
  $('prompt-cancel').addEventListener('click', () => $('prompt-dialog').close('cancel'));
  $('prompt-form').addEventListener('submit', () => { $('prompt-dialog').returnValue = 'ok'; });

  darkQuery.addEventListener('change', () => { if (state.settings.theme === 'system') applyTheme(); });
  mobileQuery.addEventListener('change', () => { closeDrawer(); applySidebar(); });
  $('backdrop').addEventListener('click', closeDrawer);
  $('btn-collapse').addEventListener('click', toggleSidebar);
  $('btn-open-sidebar').addEventListener('click', toggleSidebar);
  $('btn-theme').addEventListener('click', () => {
    state.settings.theme = resolveTheme(state.settings.theme) === 'dark' ? 'light' : 'dark';
    saveSettings();
    applyTheme();
    document.dispatchEvent(new CustomEvent('smartstudy:theme-changed'));
  });
  on('ollama', renderStatus);
  on('settings', renderStatus);
  renderStatus();
}
