/** Entry point: load data, wire modules together, handle global events. */
import { state, on } from './state.js';
import { loadAll, setStorageNotifier, flushIfDirty, saveSession } from './storage.js';
import { hydrateIcons } from './icons.js';
import { initUi, applyTheme, applySidebar, closeDrawer, toast } from './ui.js';
import { initSidebar, focusSearch } from './sidebar.js';
import { initChatView } from './chat-view.js';
import { initComposer, focusComposer } from './composer.js';
import { initSettings } from './settings.js';
import { refreshConnection, startNewChat } from './chat.js';

let lastQuotaToast = 0;

function onStorageEvent(e) {
  switch (e.type) {
    case 'unavailable':
      toast('Browser storage is blocked or unavailable. You can keep using the app, but chats will be lost when you close this tab.', { type: 'warn', timeout: 9000 });
      break;
    case 'corrupt':
      toast('Some saved data could not be read. A copy was kept aside and the app started fresh for that item.', { type: 'warn', timeout: 9000 });
      break;
    case 'compacted':
      toast(`Browser storage was full. Stored text from ${e.removed} old attached file${e.removed === 1 ? '' : 's'} was removed to make room.`, { type: 'warn', timeout: 9000 });
      break;
    case 'quota-full':
    case 'write-failed':
      if (Date.now() - lastQuotaToast < 10000) break;
      lastQuotaToast = Date.now();
      toast('Your latest changes could not be saved because browser storage is full. Export your chats, then delete old conversations.', {
        type: 'error', timeout: 0,
        action: { label: 'Open settings', onClick: () => document.getElementById('settings-dialog').dispatchEvent(new CustomEvent('smartstudy:open')) },
      });
      break;
    default:
  }
}

function boot() {
  setStorageNotifier(onStorageEvent);
  loadAll();
  hydrateIcons();
  initUi();
  applyTheme();
  applySidebar();
  initSidebar();
  initChatView();
  initComposer();
  initSettings();

  on('settings', () => { applyTheme(); applySidebar(); });

  refreshConnection();

  // Persist anything still waiting on the debounce when the tab is hidden or closed.
  window.addEventListener('pagehide', () => { flushIfDirty(); saveSession(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushIfDirty(); });
  // Re-check Ollama when returning to the tab after a while.
  window.addEventListener('focus', () => {
    if (!state.generating && Date.now() - state.ollama.checkedAt > 30000) refreshConnection();
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); startNewChat(); focusComposer(); }
    else if (e.key === 'Escape') closeDrawer();
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    toast('Something unexpected went wrong. Your chats are safe; try the action again.', { type: 'error' });
  });
}

boot();
