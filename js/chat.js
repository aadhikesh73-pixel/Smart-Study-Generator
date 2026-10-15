/**
 * Conversation domain logic: creating, renaming, pinning and deleting chats, sending messages,
 * streaming replies, cancelling and connection checks. It mutates state, persists, and emits
 * events; it never touches the DOM (views listen to the events).
 */
import { state, emit, getConversation, getActiveConversation, DEFAULT_SETTINGS } from './state.js';
import {
  saveConversationsSoon, saveConversationsNow, saveSession, saveSubjects, saveSettings,
  clearAllData, exportData, importData,
} from './storage.js';
import { streamChat, checkConnection, OllamaError } from './ollama.js';
import { buildChatMessages, titleFromMessage } from './study-generator.js';
import { uid, stripThinking } from './utils.js';
import { toast } from './ui.js';

const MAX_MESSAGE_CHARS = 20000;
const MAX_STORED_DOC_CHARS = 100000; // per file kept in LocalStorage; larger files are cut (see README)

/* ───────── Conversations ───────── */
function createConversation(subjectId = '') {
  const now = Date.now();
  const conv = { id: uid('c'), title: 'New chat', titleAuto: true, createdAt: now, updatedAt: now, pinned: false, subject: subjectId, messages: [], progress: {} };
  state.conversations.unshift(conv);
  return conv;
}

export function startNewChat() {
  state.activeId = null;
  state.lastError = null;
  saveSession();
  emit('active', { scroll: 'bottom' });
  emit('error');
}

export function openConversation(id) {
  if (!getConversation(id)) return;
  state.activeId = id;
  state.lastError = null;
  saveSession();
  emit('active', { scroll: 'bottom' });
  emit('error');
}

export function renameConversation(id, title) {
  const conv = getConversation(id);
  const clean = title.trim().slice(0, 120);
  if (!conv || !clean) return;
  conv.title = clean;
  conv.titleAuto = false; // a manual name is never overwritten
  saveConversationsSoon();
  emit('conversations');
}

export function togglePin(id) {
  const conv = getConversation(id);
  if (!conv) return;
  conv.pinned = !conv.pinned;
  saveConversationsSoon();
  emit('conversations');
}

export function setConversationSubject(id, subjectId) {
  const conv = getConversation(id);
  if (!conv) return;
  conv.subject = subjectId || '';
  saveConversationsSoon();
  emit('conversations');
}

export function deleteConversation(id) {
  if (state.generating?.convId === id) stopGeneration();
  const before = state.conversations.length;
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.conversations.length === before) return;
  const wasActive = state.activeId === id;
  if (wasActive) { state.activeId = null; state.lastError = null; }
  saveConversationsNow();
  saveSession();
  emit('conversations');
  if (wasActive) emit('active', { scroll: 'bottom' });
}

/* ───────── Subjects ───────── */
export function addSubject(name) {
  const clean = name.trim().slice(0, 60);
  if (!clean) return null;
  const existing = state.subjects.find((s) => s.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const subject = { id: uid('s'), name: clean };
  state.subjects.push(subject);
  saveSubjects();
  emit('conversations');
  emit('composer');
  return subject;
}

export function renameSubject(id, name) {
  const subject = state.subjects.find((s) => s.id === id);
  const clean = name.trim().slice(0, 60);
  if (!subject || !clean) return;
  subject.name = clean;
  saveSubjects();
  emit('conversations');
  emit('composer');
}

export function deleteSubject(id) {
  state.subjects = state.subjects.filter((s) => s.id !== id);
  for (const conv of state.conversations) if (conv.subject === id) conv.subject = '';
  if (state.subjectFilter === id) state.subjectFilter = '';
  if (state.composer.subject === id) state.composer.subject = '';
  saveSubjects();
  saveConversationsSoon();
  emit('conversations');
  emit('composer');
}

/* ───────── Messages ───────── */
const toStoredDoc = (att) => ({
  name: att.name, ext: att.ext, size: att.size, pages: att.pages || 0,
  text: att.text.slice(0, MAX_STORED_DOC_CHARS),
  textDropped: false,
  truncatedOnSave: att.text.length > MAX_STORED_DOC_CHARS,
});

/**
 * Add the user's message and start generating. Returns { accepted, reason? } immediately;
 * the reply streams in afterwards. A second call while generating is rejected.
 */
export function sendMessage({ text, attachments }) {
  if (state.generating) return { accepted: false, reason: 'A response is still being generated. Stop it first, or wait for it to finish.' };
  const clean = text.trim();
  const ready = attachments.filter((a) => a.status === 'ready');
  if (!clean && !ready.length) return { accepted: false };
  if (clean.length > MAX_MESSAGE_CHARS) return { accepted: false, reason: `Messages are limited to ${MAX_MESSAGE_CHARS.toLocaleString()} characters. Attach a file for longer notes.` };

  let conv = getActiveConversation();
  if (!conv) {
    conv = createConversation(state.composer.subject);
    state.activeId = conv.id;
    saveSession();
  }
  const { mode, difficulty, length } = state.composer;
  const subjectName = state.subjects.find((s) => s.id === conv.subject)?.name ?? '';
  const docs = ready.map(toStoredDoc);

  const userMsg = {
    id: uid('m'), role: 'user', content: clean, ts: Date.now(), mode,
    options: { subject: subjectName, difficulty, length }, docs, incomplete: false, notice: '', model: '',
  };
  if (docs.some((d) => d.truncatedOnSave)) userMsg.notice = 'A very long file was cut to its first 100,000 characters when saved.';
  conv.messages.push(userMsg);
  conv.updatedAt = Date.now();
  if (conv.titleAuto && conv.messages.length === 1) conv.title = titleFromMessage(clean, ready, mode);

  state.lastError = null;
  saveConversationsNow();
  emit('conversations');
  emit('error');
  emit('active', { scroll: 'bottom' });
  generateReply(conv);
  return { accepted: true };
}

function setError(conv, err) {
  state.lastError = {
    convId: conv.id,
    code: err.code ?? 'unknown',
    message: err.message || 'Something went wrong.',
    hint: err.hint ?? '',
    retryable: err.code !== 'config' && err.code !== 'context',
  };
  emit('error');
}

async function generateReply(conv) {
  const settings = state.settings;
  const userMsg = [...conv.messages].reverse().find((m) => m.role === 'user');

  let context;
  try {
    context = buildChatMessages(conv, conv.messages.length, settings);
  } catch (err) {
    setError(conv, new OllamaError('context', err.message));
    return;
  }
  if (context.info.insufficient) {
    setError(conv, new OllamaError('context', 'Your notes are too large for the current context length, so there is no room to read them.',
      'Raise the context length in Settings (needs more memory), or attach a smaller file.'));
    return;
  }

  const ai = { id: uid('m'), role: 'assistant', content: '', ts: Date.now(), mode: userMsg?.mode ?? 'chat', options: {}, docs: [], incomplete: true, notice: '', model: settings.model };
  conv.messages.push(ai);
  const controller = new AbortController();
  state.generating = { convId: conv.id, msgId: ai.id, controller, phase: 'waiting' };
  state.lastError = null;
  emit('error');
  emit('generation');
  emit('messages', { scroll: 'bottom' });

  const notes = [];
  const { info } = context;
  if (info.truncation) notes.push(`Your notes were longer than the model's context window, so only the first ${info.truncation.percent}% was used. Raise the context length in Settings to include more.`);
  if (info.droppedSources) notes.push('Some earlier file text was removed to save space, so it could not be used.');
  if (info.droppedTurns) notes.push('Earlier messages were left out to fit the context window.');

  try {
    const result = await streamChat({
      endpoint: settings.endpoint,
      model: settings.model,
      messages: context.messages,
      options: { temperature: settings.temperature, num_ctx: settings.numCtx },
      think: settings.thinking,
      signal: controller.signal,
      timeoutMs: settings.timeoutSec * 1000,
      onThinking: () => {
        if (state.generating?.phase === 'waiting') { state.generating.phase = 'reasoning'; emit('stream', { type: 'phase', convId: conv.id, msgId: ai.id }); }
      },
      onToken: (chunk) => {
        ai.content += chunk;
        if (state.generating && state.generating.phase !== 'writing') state.generating.phase = 'writing';
        saveConversationsSoon();
        emit('stream', { type: 'token', convId: conv.id, msgId: ai.id });
      },
    });
    if (!stripThinking(ai.content).trim()) throw new OllamaError('empty', 'The model returned no text.', 'Try again, or turn off "reason before answering" in Settings.');
    ai.incomplete = result.doneReason === 'length' || result.doneReason === 'incomplete';
    if (result.doneReason === 'length') notes.push('The model hit its length limit, so this answer may be cut off.');
    else if (result.doneReason === 'incomplete') notes.push('The connection closed before the model finished, so this answer may be incomplete.');
    setConnection('connected');
  } catch (err) {
    ai.incomplete = true;
    if (err.code === 'aborted') {
      notes.push('Generation stopped.');
    } else {
      const known = err instanceof OllamaError ? err : new OllamaError('http', `Unexpected error: ${err.message}`);
      setError(conv, known);
      if (known.code === 'unreachable') setConnection('offline', `${known.message} ${known.hint}`.trim());
      if (known.code === 'model-missing') setConnection('model-missing', known.message);
    }
  } finally {
    if (ai.incomplete && !notes.length) notes.push('This response was interrupted and may be incomplete.');
    ai.notice = notes.join(' ');
    if (!stripThinking(ai.content).trim()) {
      conv.messages = conv.messages.filter((m) => m.id !== ai.id); // never keep an empty answer
    }
    conv.updatedAt = Date.now();
    state.generating = null;
    saveConversationsNow();
    emit('generation');
    emit('stream', { type: 'end', convId: conv.id, msgId: ai.id });
    emit('conversations');
  }
}

export function stopGeneration() {
  state.generating?.controller.abort();
}

/** Re-run the last answer. Also serves as "Try again" after an error. */
export function regenerateLast() {
  if (state.generating) return;
  const conv = getActiveConversation();
  if (!conv) return;
  const last = conv.messages.at(-1);
  if (last?.role === 'assistant') {
    conv.messages.pop();
    delete conv.progress[last.id];
  }
  if (conv.messages.at(-1)?.role !== 'user') return;
  state.lastError = null;
  emit('error');
  emit('messages', { scroll: 'keep' });
  generateReply(conv);
}

export function dismissError() {
  state.lastError = null;
  emit('error');
}

export function deleteMessage(id) {
  if (state.generating?.msgId === id) return;
  const conv = getActiveConversation();
  if (!conv) return;
  conv.messages = conv.messages.filter((m) => m.id !== id);
  delete conv.progress[id];
  if (!conv.messages.length) { deleteConversation(conv.id); return; }
  conv.updatedAt = Date.now();
  saveConversationsNow();
  emit('conversations');
  emit('messages', { scroll: 'keep' });
}

/** Persist flashcard / quiz progress for one assistant message. */
export function saveProgress(convId, msgId, data) {
  const conv = getConversation(convId);
  if (!conv) return;
  conv.progress[msgId] = data;
  saveConversationsSoon();
}

/* ───────── Connection ───────── */
export function setConnection(status, message = '') {
  state.ollama = { ...state.ollama, status, message, checkedAt: Date.now() };
  emit('ollama');
}

export async function refreshConnection() {
  const { endpoint, model } = state.settings;
  state.ollama.status = 'checking';
  emit('ollama');
  try {
    const r = await checkConnection({ endpoint, model });
    state.ollama = {
      status: r.installed ? 'connected' : 'model-missing',
      message: r.installed ? `Ollama${r.version ? ` ${r.version}` : ''} is running.` : `Ollama is running, but "${model}" isn't installed. Run: ollama pull ${model}`,
      models: r.models, version: r.version, checkedAt: Date.now(),
    };
    emit('ollama');
    return { ok: true, ...r };
  } catch (err) {
    const error = err instanceof OllamaError ? err : new OllamaError('unreachable', String(err.message || err));
    state.ollama = { status: 'offline', message: `${error.message} ${error.hint}`.trim(), models: [], version: '', checkedAt: Date.now() };
    emit('ollama');
    return { ok: false, error };
  }
}

/* ───────── Data management ───────── */
export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  saveSettings();
  emit('settings');
}

export async function importChats(file) {
  const raw = await file.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error('That file is not valid JSON.'); }
  const result = importData(json, file.size);
  emit('conversations');
  return result;
}

export const exportChats = () => exportData();

export function clearAllLocalData() {
  stopGeneration();
  clearAllData();
  state.conversations = [];
  state.subjects = [];
  state.activeId = null;
  state.lastError = null;
  state.subjectFilter = '';
  state.search = '';
  state.composer.subject = '';
  state.settings = { ...DEFAULT_SETTINGS };
  emit('settings');
  emit('conversations');
  emit('composer');
  emit('active', { scroll: 'bottom' });
  emit('error');
  toast('All local data was removed and settings are back to their defaults.', { type: 'success' });
}
