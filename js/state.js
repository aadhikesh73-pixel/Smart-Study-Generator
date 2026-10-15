/**
 * Single source of truth plus a tiny topic-based event bus.
 * Modules mutate `state` through domain functions (chat.js, storage.js) and announce changes with emit().
 *
 * Topics: conversations, active, messages, stream, generation, error, settings, ollama, composer
 */
import { clamp } from './utils.js';

export const APP_VERSION = '1.0.0';

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',                // dark | light | system
  endpoint: 'http://localhost:11434/api/chat',
  model: 'gemma3:1b',
  temperature: 0.4,
  numCtx: 8192,
  thinking: false,
  timeoutSec: 120,
  defaultMode: 'summary',
  difficulty: 'intermediate',
  length: 'medium',
  maxFileMB: 10,
  maxFiles: 10,
  sidebarCollapsed: false,
});

export const CONTEXT_OPTIONS = [2048, 4096, 8192, 16384, 32768];
const THEMES = ['dark', 'light', 'system'];
const MODE_IDS = ['chat', 'summary', 'flashcards', 'quiz', 'exam', 'explain', 'notes'];
const DIFFICULTY_IDS = ['beginner', 'intermediate', 'advanced'];
const LENGTH_IDS = ['short', 'medium', 'detailed'];

const num = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
};
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const text = (v, fallback, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback);

/** Validate and clamp settings from storage, imports or form fields. */
export function sanitizeSettings(raw = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    theme: pick(raw.theme, THEMES, d.theme),
    endpoint: text(raw.endpoint, d.endpoint),
    model: text(raw.model, d.model, 120),
    temperature: num(raw.temperature, d.temperature, 0, 1.5),
    numCtx: num(raw.numCtx, d.numCtx, 1024, 131072),
    thinking: Boolean(raw.thinking),
    timeoutSec: num(raw.timeoutSec, d.timeoutSec, 15, 900),
    defaultMode: pick(raw.defaultMode, MODE_IDS, d.defaultMode),
    difficulty: pick(raw.difficulty, DIFFICULTY_IDS, d.difficulty),
    length: pick(raw.length, LENGTH_IDS, d.length),
    maxFileMB: Math.round(num(raw.maxFileMB, d.maxFileMB, 1, 50)),
    maxFiles: Math.round(num(raw.maxFiles, d.maxFiles, 1, 20)),
    sidebarCollapsed: Boolean(raw.sidebarCollapsed),
  };
}

export const state = {
  conversations: [],
  activeId: null,           // null means "new chat" draft: no conversation exists until the first message
  subjects: [],             // [{ id, name }]
  settings: { ...DEFAULT_SETTINGS },
  search: '',
  subjectFilter: '',
  generating: null,         // { convId, msgId, controller, phase }
  lastError: null,          // { convId, code, message, hint, retryable }
  ollama: { status: 'unknown', message: '', models: [], version: '', checkedAt: 0 },
  composer: {
    mode: DEFAULT_SETTINGS.defaultMode,
    difficulty: DEFAULT_SETTINGS.difficulty,
    length: DEFAULT_SETTINGS.length,
    subject: '',
    attachments: [],
  },
};

const listeners = new Map();

export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic)?.delete(fn);
}

export function emit(topic, detail) {
  for (const fn of listeners.get(topic) ?? []) {
    try { fn(detail); } catch (err) { console.error(`Listener for "${topic}" failed`, err); }
  }
}

export const getConversation = (id) => state.conversations.find((c) => c.id === id) ?? null;
export const getActiveConversation = () => (state.activeId ? getConversation(state.activeId) : null);
export const getSubject = (id) => state.subjects.find((s) => s.id === id) ?? null;
