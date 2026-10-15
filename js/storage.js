/**
 * LocalStorage persistence with validation, quota recovery, export/import and a clean-up helper.
 * Nothing here talks to the DOM; problems are reported through a notifier callback.
 */
import { state, DEFAULT_SETTINGS, APP_VERSION, sanitizeSettings } from './state.js';
import { isPlainObject, uid } from './utils.js';

const PREFIX = 'smartstudy.';
const KEYS = {
  conversations: `${PREFIX}conversations.v1`,
  settings: `${PREFIX}settings.v1`,
  subjects: `${PREFIX}subjects.v1`,
  session: `${PREFIX}session.v1`,
};
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const APPROX_QUOTA_BYTES = 5 * 1024 * 1024; // typical per-origin limit; browsers differ

let notify = () => {};
let available = true;
let dirty = false;
let saveTimer = null;

/** Receives { type: 'unavailable' | 'compacted' | 'quota-full' | 'write-failed' | 'corrupt', ... } */
export const setStorageNotifier = (fn) => { notify = fn; };
export const isStorageAvailable = () => available;

function probe() {
  try {
    localStorage.setItem(`${PREFIX}probe`, '1');
    localStorage.removeItem(`${PREFIX}probe`);
    return true;
  } catch { return false; }
}

const isQuotaError = (e) =>
  Boolean(e) && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (error) {
    return { ok: false, quota: isQuotaError(error), error };
  }
}

/** Parse JSON from storage. A corrupt value is copied aside so a later save can't destroy it. */
function read(key, fallback) {
  let raw = null;
  try { raw = localStorage.getItem(key); } catch { return fallback; }
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch {
    try { localStorage.setItem(`${key}.corrupt`, raw); } catch { /* storage may be full */ }
    notify({ type: 'corrupt', key });
    return fallback;
  }
}

/* ───────── Normalisation (used by load and import) ───────── */
const str = (v, fallback = '', max = 200) => (typeof v === 'string' ? v.slice(0, max) : fallback);
const ts = (v, fallback) => (Number.isFinite(v) ? v : fallback);

function normalizeDoc(d) {
  if (!isPlainObject(d) || typeof d.name !== 'string') return null;
  return {
    name: d.name.slice(0, 200),
    ext: str(d.ext, '', 10),
    size: ts(d.size, 0),
    pages: ts(d.pages, 0),
    text: typeof d.text === 'string' ? d.text : '',
    textDropped: Boolean(d.textDropped),
    truncatedOnSave: Boolean(d.truncatedOnSave),
  };
}

function normalizeMessage(m) {
  if (!isPlainObject(m) || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') return null;
  return {
    id: str(m.id, '', 80) || uid('m'),
    role: m.role,
    content: m.content.slice(0, 400000),
    ts: ts(m.ts, Date.now()),
    mode: str(m.mode, 'chat', 20),
    options: isPlainObject(m.options) ? { subject: str(m.options.subject, '', 60), difficulty: str(m.options.difficulty, '', 20), length: str(m.options.length, '', 20) } : {},
    docs: Array.isArray(m.docs) ? m.docs.map(normalizeDoc).filter(Boolean) : [],
    incomplete: Boolean(m.incomplete),
    notice: str(m.notice, '', 400),
    model: str(m.model, '', 120),
  };
}

export function normalizeConversation(raw) {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.messages)) return null;
  const now = Date.now();
  return {
    id: raw.id.slice(0, 80),
    title: str(raw.title, 'New chat', 120) || 'New chat',
    titleAuto: raw.titleAuto !== false,
    createdAt: ts(raw.createdAt, now),
    updatedAt: ts(raw.updatedAt, now),
    pinned: Boolean(raw.pinned),
    subject: str(raw.subject, '', 80),
    messages: raw.messages.map(normalizeMessage).filter(Boolean),
    progress: isPlainObject(raw.progress) ? raw.progress : {},
  };
}

const normalizeSubjects = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((s) => isPlainObject(s) && typeof s.id === 'string' && typeof s.name === 'string' && s.name.trim())
    .map((s) => ({ id: s.id.slice(0, 80), name: s.name.trim().slice(0, 60) }));

/* ───────── Load ───────── */
export function loadAll() {
  available = probe();
  if (!available) {
    notify({ type: 'unavailable' });
    return;
  }
  const settings = read(KEYS.settings, {});
  state.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...(isPlainObject(settings) ? settings : {}) });
  state.subjects = normalizeSubjects(read(KEYS.subjects, []));

  const rawConvs = read(KEYS.conversations, []);
  state.conversations = (Array.isArray(rawConvs) ? rawConvs : []).map(normalizeConversation).filter(Boolean);

  // A reload mid-generation leaves the last answer flagged as incomplete; keep it flagged.
  const session = read(KEYS.session, {});
  const activeId = isPlainObject(session) ? session.activeId : null;
  state.activeId = state.conversations.some((c) => c.id === activeId) ? activeId : null;
}

/* ───────── Save ───────── */
export function saveConversationsSoon() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConversationsNow, 600);
}

export function saveConversationsNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!available) return false;
  const res = write(KEYS.conversations, state.conversations);
  if (res.ok) { dirty = false; return true; }
  if (res.quota) return recoverFromQuota();
  notify({ type: 'write-failed', error: res.error });
  return false;
}

export const flushIfDirty = () => { if (dirty) saveConversationsNow(); };

/** Storage is full: drop stored document text from the oldest chats first, retrying as we go. */
function recoverFromQuota() {
  const docs = [];
  const oldestFirst = [...state.conversations].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const conv of oldestFirst) {
    for (const msg of conv.messages) for (const doc of msg.docs) if (doc.text) docs.push(doc);
  }
  let removed = 0;
  while (docs.length) {
    for (const doc of docs.splice(0, 3)) { doc.text = ''; doc.textDropped = true; removed++; }
    if (write(KEYS.conversations, state.conversations).ok) {
      dirty = false;
      notify({ type: 'compacted', removed });
      return true;
    }
  }
  notify({ type: 'quota-full' });
  return false;
}

export const saveSettings = () => available && write(KEYS.settings, state.settings).ok;
export const saveSubjects = () => available && write(KEYS.subjects, state.subjects).ok;
export const saveSession = () => available && write(KEYS.session, { activeId: state.activeId }).ok;

/* ───────── Usage, export, import, wipe ───────── */
export function getStorageUsage() {
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) bytes += (key.length + (localStorage.getItem(key)?.length ?? 0)) * 2; // UTF-16
    }
  } catch { /* ignored */ }
  return { bytes, quota: APPROX_QUOTA_BYTES };
}

export function exportData() {
  return {
    app: 'smart-study',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    conversations: state.conversations,
    subjects: state.subjects,
    settings: state.settings,
  };
}

/** Merge an export into the current data. Conversations whose id already exists are skipped. */
export function importData(json, rawByteLength = 0) {
  if (rawByteLength > MAX_IMPORT_BYTES) throw new Error('That file is larger than 25 MB.');
  if (!isPlainObject(json) || json.app !== 'smart-study' || !Array.isArray(json.conversations)) {
    throw new Error('This file is not a Smart Study export.');
  }
  const known = new Set(state.conversations.map((c) => c.id));
  let added = 0;
  let skipped = 0;
  for (const raw of json.conversations) {
    const conv = normalizeConversation(raw);
    if (!conv || known.has(conv.id)) { skipped++; continue; }
    state.conversations.push(conv);
    known.add(conv.id);
    added++;
  }
  const knownSubjects = new Set(state.subjects.map((s) => s.id));
  for (const subject of normalizeSubjects(json.subjects)) {
    if (!knownSubjects.has(subject.id)) state.subjects.push(subject);
  }
  saveConversationsNow();
  saveSubjects();
  return { added, skipped };
}

export function clearAllData() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
  } catch { /* ignored */ }
  dirty = false;
}
