/** Settings dialog: every field persists on change and takes effect immediately. */
import { state, on, APP_VERSION, CONTEXT_OPTIONS, sanitizeSettings } from './state.js';
import { MODES, MODE_ORDER, DIFFICULTIES, LENGTHS } from './study-generator.js';
import { getStorageUsage, isStorageAvailable } from './storage.js';
import { updateSettings, refreshConnection, exportChats, importChats, clearAllLocalData } from './chat.js';
import { applyTheme, toast, confirmDialog } from './ui.js';
import { h, debounce, downloadJson, formatBytes } from './utils.js';

const $ = (id) => document.getElementById(id);

function fillSelect(select, entries) {
  select.replaceChildren(...entries.map(([value, text]) => h('option', { value, text })));
}

export function initSettings() {
  const dlg = $('settings-dialog');
  fillSelect($('set-ctx'), CONTEXT_OPTIONS.map((n) => [String(n), `${n.toLocaleString()} tokens`]));
  fillSelect($('set-mode'), MODE_ORDER.map((id) => [id, MODES[id].label]));
  fillSelect($('set-difficulty'), Object.entries(DIFFICULTIES));
  fillSelect($('set-length'), Object.entries(LENGTHS));
  $('about-version').textContent = `v${APP_VERSION}`;

  dlg.addEventListener('smartstudy:open', open);
  $('settings-close').addEventListener('click', () => dlg.close());

  $('theme-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-option]');
    if (!btn) return;
    updateSettings({ theme: btn.dataset.themeOption });
    applyTheme();
    syncThemeButtons();
  });

  const recheck = debounce(() => refreshConnection(), 600);
  const bind = (id, key, read, { reconnect = false } = {}) => {
    $(id).addEventListener('change', () => {
      const clean = sanitizeSettings({ ...state.settings, [key]: read($(id)) });
      updateSettings({ [key]: clean[key] });
      fill();
      if (reconnect) recheck();
    });
  };
  bind('set-endpoint', 'endpoint', (el) => el.value, { reconnect: true });
  bind('set-model', 'model', (el) => el.value, { reconnect: true });
  bind('set-ctx', 'numCtx', (el) => Number(el.value));
  bind('set-timeout', 'timeoutSec', (el) => Number(el.value));
  bind('set-thinking', 'thinking', (el) => el.checked);
  bind('set-mode', 'defaultMode', (el) => el.value);
  bind('set-difficulty', 'difficulty', (el) => el.value);
  bind('set-length', 'length', (el) => el.value);
  bind('set-maxmb', 'maxFileMB', (el) => Number(el.value));
  bind('set-maxfiles', 'maxFiles', (el) => Number(el.value));
  $('set-temp').addEventListener('input', () => { $('set-temp-out').textContent = Number($('set-temp').value).toFixed(2); });
  bind('set-temp', 'temperature', (el) => Number(el.value));

  $('btn-test').addEventListener('click', testConnection);
  $('btn-export').addEventListener('click', () => {
    downloadJson(`smart-study-export-${new Date().toISOString().slice(0, 10)}.json`, exportChats());
    toast('Chats exported as JSON.', { type: 'success' });
  });
  $('btn-import').addEventListener('click', () => $('import-input').click());
  $('import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { added, skipped } = await importChats(file);
      toast(`Imported ${added} conversation${added === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped as duplicates or invalid)` : ''}.`, { type: 'success' });
      updateUsage();
    } catch (err) { toast(err.message, { type: 'error' }); }
  });
  $('btn-clear-all').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear all local data?',
      message: 'Every conversation, subject, saved progress and setting in this browser will be permanently deleted. Export your chats first if you want a copy.',
      confirmLabel: 'Clear everything', danger: true,
    });
    if (ok) { clearAllLocalData(); applyTheme(); fill(); updateUsage(); }
  });
  on('settings', fill);
}

function syncThemeButtons() {
  document.querySelectorAll('[data-theme-option]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeOption === state.settings.theme)));
}

function fill() {
  const s = state.settings;
  $('set-endpoint').value = s.endpoint;
  $('set-model').value = s.model;
  $('set-temp').value = s.temperature;
  $('set-temp-out').textContent = s.temperature.toFixed(2);
  if (!CONTEXT_OPTIONS.includes(s.numCtx)) $('set-ctx').append(h('option', { value: String(s.numCtx), text: `${s.numCtx.toLocaleString()} tokens` }));
  $('set-ctx').value = String(s.numCtx);
  $('set-timeout').value = s.timeoutSec;
  $('set-thinking').checked = s.thinking;
  $('set-mode').value = s.defaultMode;
  $('set-difficulty').value = s.difficulty;
  $('set-length').value = s.length;
  $('set-maxmb').value = s.maxFileMB;
  $('set-maxfiles').value = s.maxFiles;
  syncThemeButtons();
  $('model-list').replaceChildren(...state.ollama.models.map((m) => h('option', { value: m })));
}

function updateUsage() {
  const el = $('storage-usage');
  if (!isStorageAvailable()) { el.textContent = 'Browser storage is unavailable, so nothing is being saved.'; return; }
  const { bytes, quota } = getStorageUsage();
  el.textContent = `Using about ${formatBytes(bytes)} of the roughly ${formatBytes(quota)} this browser usually allows. Large files are the main cost.`;
}

function open() {
  fill();
  updateUsage();
  $('test-result').hidden = true;
  $('settings-dialog').showModal();
}

async function testConnection() {
  const btn = $('btn-test');
  const out = $('test-result');
  btn.disabled = true;
  out.hidden = false;
  out.dataset.state = '';
  out.replaceChildren(h('p', { text: 'Checking…' }));
  const r = await refreshConnection();
  btn.disabled = false;
  fill();
  if (r.ok && r.installed) {
    out.dataset.state = 'ok';
    out.replaceChildren(h('p', { text: `Connected${r.version ? ` to Ollama ${r.version}` : ''}. "${state.settings.model}" is installed (${r.models.length} model${r.models.length === 1 ? '' : 's'} available).` }));
  } else if (r.ok) {
    out.dataset.state = 'warn';
    out.replaceChildren(
      h('p', { text: `Ollama is running, but "${state.settings.model}" isn't installed.` }),
      h('p', {}, 'Install it with ', h('code', { text: `ollama pull ${state.settings.model}` }), r.models.length ? `, or choose one of: ${r.models.join(', ')}.` : '.'));
  } else {
    out.dataset.state = 'error';
    out.replaceChildren(h('p', { text: r.error.message }), r.error.hint ? h('p', { text: r.error.hint }) : null);
  }
}
