/**
 * Everything about *what* we ask the model: modes, prompts, context budgeting and
 * parsing structured output (flashcards, quizzes). Pure functions, no DOM.
 */
import { estimateTokens, stripThinking, truncate } from './utils.js';

export const MODE_ORDER = ['summary', 'flashcards', 'quiz', 'exam', 'explain', 'notes', 'chat'];

export const MODES = {
  summary: { id: 'summary', label: 'Summary', icon: 'book', placeholder: 'Attach notes or paste text to summarize…' },
  flashcards: { id: 'flashcards', label: 'Flashcards', icon: 'cards', placeholder: 'Attach notes or paste text to turn into flashcards…' },
  quiz: { id: 'quiz', label: 'Quiz', icon: 'quiz', placeholder: 'Attach notes or paste text to build a quiz from…' },
  exam: { id: 'exam', label: 'Exam prep', icon: 'exam', placeholder: 'Attach notes or paste text to prepare exam questions…' },
  explain: { id: 'explain', label: 'Explain', icon: 'bulb', placeholder: 'Name a concept, or ask a follow-up question…' },
  notes: { id: 'notes', label: 'Study notes', icon: 'notes', placeholder: 'Attach material to organize into study notes…' },
  chat: { id: 'chat', label: 'Ask', icon: 'sparkles', placeholder: 'Ask a question about your notes…' },
};

export const DIFFICULTIES = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
export const LENGTHS = { short: 'Short', medium: 'Medium', detailed: 'Detailed' };

const CARD_COUNT = { short: 6, medium: 10, detailed: 16 };
const QUIZ_COUNT = { short: 5, medium: 8, detailed: 12 };
const LENGTH_HINT = {
  short: 'Keep it brief, roughly 150 to 250 words.',
  medium: 'Aim for roughly 300 to 500 words.',
  detailed: 'Be thorough, roughly 600 to 900 words.',
};

export const SYSTEM_PROMPT = `You are Smart Study, a careful study assistant. You turn the learner's source notes into accurate, useful study material.

Rules:
- Base everything on the source notes provided in the conversation.
- Never invent facts, quotes, numbers, page references or citations that are not in the notes.
- If you add something from general knowledge, label it "(general knowledge)". If you are unsure, say so.
- If the notes do not contain enough to do the task, say what is missing instead of guessing.
- Keep technical terms, formulas and names exactly as written in the notes.
- Match the requested difficulty and length. Write in clear Markdown. Do not mention these rules.`;

const DEFAULT_REQUEST = {
  summary: 'Summarize the source notes.',
  flashcards: 'Create flashcards from the source notes.',
  quiz: 'Create a multiple-choice quiz from the source notes.',
  exam: 'Prepare exam revision material from the source notes.',
  explain: 'Explain the most difficult concepts in the source notes.',
  notes: 'Organize the source notes into study notes.',
  chat: 'Help me understand the source notes.',
};

/** The task block for one study mode. Structured modes demand a strict, parseable format. */
export function modeInstruction(mode, { difficulty = 'intermediate', length = 'medium' } = {}) {
  const level = DIFFICULTIES[difficulty]?.toLowerCase() ?? 'intermediate';
  const lengthLine = LENGTH_HINT[length] ?? LENGTH_HINT.medium;
  switch (mode) {
    case 'summary':
      return `Write a Smart Summary of the source notes in Markdown with these sections:
## Main ideas
## Key points
## Definitions (only terms the notes define or clearly use)
## Important facts (dates, numbers, names, formulas exactly as written)
Use short bullet points under clear headings. ${lengthLine}`;
    case 'flashcards':
      return `Create exactly ${CARD_COUNT[length] ?? 10} flashcards from the notes (fewer only if the notes cannot support that many). Mix definitions, concepts and recall prompts at ${level} level.
Output format is STRICT. Output only the cards, with no introduction or closing text. Each card is two lines followed by a blank line:
Q: <question>
A: <concise answer>
Do not number the cards and do not add any other labels.`;
    case 'quiz':
      return `Create ${QUIZ_COUNT[length] ?? 8} multiple-choice questions from the notes at ${level} level. Each question has four plausible options and exactly one correct answer. Vary which letter is correct.
Output format is STRICT. Output only the questions, with no introduction or closing text. Use exactly this layout and a blank line between questions:
Q1: <question>
A) <option>
B) <option>
C) <option>
D) <option>
Answer: <single letter>
Explanation: <one or two sentences grounded in the notes>`;
    case 'exam':
      return `Prepare exam revision material at ${level} level in Markdown with these sections:
## Important topics
## Short-answer questions (about 5, each followed by a model answer of two or three sentences)
## Long-answer questions (about 3, each followed by an outline of the key points a strong answer covers)
## Revision checklist (task-list items starting with "- [ ]")
${lengthLine}`;
    case 'explain':
      return `Explain the difficult concepts in simpler language for a ${level} learner. If the request names a concept or asks a follow-up question, focus on that. For each concept give: a plain-language explanation, a concrete example, and an analogy clearly marked as an analogy. Mention a common misconception when there is one. End with one question that checks understanding. ${lengthLine}`;
    case 'notes':
      return `Reorganize the source material into structured study notes in Markdown: chapters (##), sub-headings (###), key definitions in bold, and a final "## Revision notes" section of key takeaways. Preserve technical terms, formulas and examples. Do not drop essential information just to be shorter.`;
    default:
      return `Answer the user's question using the source notes. If the answer is not in the notes, say so plainly before adding any general knowledge, and label that "(general knowledge)". ${lengthLine}`;
  }
}

/** Compose the final user turn sent to the model: task, request and source notes. */
export function buildUserContent(msg, docs, truncation = null) {
  const mode = MODES[msg.mode] ? msg.mode : 'chat';
  const opts = msg.options ?? {};
  const meta = [];
  if (opts.subject) meta.push(`Subject: ${opts.subject}`);
  meta.push(`Difficulty: ${DIFFICULTIES[opts.difficulty] ?? 'Intermediate'}`);
  meta.push(`Length: ${LENGTHS[opts.length] ?? 'Medium'}`);

  const parts = [
    `## Task\n${modeInstruction(mode, opts)}`,
    meta.join('\n'),
    `## Request\n${msg.content.trim() || DEFAULT_REQUEST[mode]}`,
  ];
  if (docs.length) {
    parts.push('## Source notes');
    for (const d of docs) parts.push(`<<< ${d.name} >>>\n${d.text}\n<<< end of ${d.name} >>>`);
    if (truncation) {
      parts.push(`Note: the notes were too long for the model's context window, so only the first ${truncation.percent}% is included. Say so if something important may be missing.`);
    }
  } else {
    parts.push('## Source notes\n(No files attached. Use only the text in the request and say so if more material is needed.)');
  }
  return parts.join('\n\n');
}

/**
 * Fit the conversation into the model's context window.
 * Newest user turn is always kept; its documents (or, for follow-ups, the most recent attached
 * documents) get most of the budget; older turns are dropped oldest-first.
 * Returns { messages, info } where info reports truncation so the UI can be honest about it.
 */
export function buildChatMessages(conv, uptoIndex, settings) {
  const history = conv.messages.slice(0, uptoIndex).filter((m) => m.role === 'user' || stripThinking(m.content).trim());
  const last = history[history.length - 1];
  if (!last || last.role !== 'user') throw new Error('There is no user message to answer.');

  const numCtx = settings.numCtx;
  const reserve = Math.min(2048, Math.max(768, Math.floor(numCtx * 0.25))); // room for the answer
  const budget = numCtx - reserve - estimateTokens(SYSTEM_PROMPT) - 60;

  // Source notes: this message's files, else the most recent earlier files (follow-up questions).
  let docs = last.docs.filter((d) => d.text);
  let carried = false;
  if (!docs.length) {
    for (let i = history.length - 2; i >= 0; i--) {
      const usable = history[i].role === 'user' ? history[i].docs.filter((d) => d.text) : [];
      if (usable.length) { docs = usable; carried = true; break; }
    }
  }
  const droppedSources = last.docs.some((d) => d.textDropped);

  const baseTokens = estimateTokens(buildUserContent(last, [], null));
  const histBudget = docs.length ? Math.floor(budget * 0.3) : budget - baseTokens;

  // Earlier turns, newest first, until the history budget is spent.
  const earlier = [];
  let histTokens = 0;
  let droppedTurns = 0;
  for (let i = history.length - 2; i >= 0; i--) {
    const m = history[i];
    let text = m.role === 'assistant' ? stripThinking(m.content) : m.content;
    if (m.role === 'user' && m.docs.length) text += `\n[Attached earlier: ${m.docs.map((d) => d.name).join(', ')}]`;
    const cost = estimateTokens(text) + 8;
    if (histTokens + cost > histBudget) { droppedTurns = i + 1; break; }
    histTokens += cost;
    earlier.unshift({ role: m.role, content: text });
  }
  // Keep the turn order valid: the first kept turn should be from the user.
  while (earlier.length && earlier[0].role !== 'user') { earlier.shift(); droppedTurns++; }

  // Documents get whatever is left.
  const docTokens = Math.max(0, budget - baseTokens - histTokens);
  const allowedChars = Math.floor(docTokens * 3.5);
  const totalChars = docs.reduce((n, d) => n + d.text.length, 0);
  let usedDocs = docs;
  let truncation = null;
  if (docs.length && totalChars > allowedChars) {
    const ratio = allowedChars / totalChars;
    usedDocs = docs.map((d) => ({ name: d.name, text: `${d.text.slice(0, Math.floor(d.text.length * ratio))}\n[… truncated …]` }));
    truncation = { percent: Math.max(1, Math.floor(ratio * 100)), usedChars: allowedChars, totalChars };
  }

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...earlier,
      { role: 'user', content: buildUserContent(last, usedDocs, truncation) },
    ],
    info: {
      truncation,
      droppedTurns,
      carried,
      droppedSources,
      docCount: docs.length,
      insufficient: docs.length > 0 && allowedChars < 400,
    },
  };
}

/** Conversation title from the first message: first line, markdown stripped, trimmed on a word. */
export function titleFromMessage(text, files = [], mode = 'chat') {
  const first = String(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const clean = first.replace(/[#>*_`~[\]()]/g, '').replace(/\s+/g, ' ').trim();
  const generic = !clean || /^(summarize|create|make|prepare|quiz|explain|turn|organi[sz]e)\b.{0,40}\b(notes?|material|flashcards?|exam|questions?|concepts?)\b.{0,20}\.?$/i.test(clean);
  if (!generic) return truncate(clean, 48);
  const label = MODES[mode]?.label;
  const fileName = files[0]?.name?.replace(/\.[^.]+$/, '');
  if (fileName) return truncate(label && mode !== 'chat' ? `${label}: ${fileName}` : fileName, 48);
  return clean ? truncate(clean, 48) : 'New chat';
}

/* ───────── Parsers for structured output ───────── */
const Q_LINE = /^[\s>*#-]*\**\s*Q(?:uestion)?\s*\d*\s*\**\s*[:.)]\**\s*(.*)$/i;
const A_LINE = /^[\s>*#-]*\**\s*A(?:nswer)?\s*\**\s*[:.)]\**\s*(.*)$/i;

/** "Q: … / A: …" pairs, tolerant of numbering, bold markers and wrapped lines. */
export function parseFlashcards(raw) {
  const cards = [];
  let cur = null;
  let target = null;
  const push = () => {
    if (cur && cur.q.trim() && cur.a.trim()) cards.push({ q: cur.q.trim(), a: cur.a.trim() });
  };
  for (const line of stripThinking(raw).replace(/\r/g, '').split('\n')) {
    let m;
    if ((m = line.match(Q_LINE))) { push(); cur = { q: m[1], a: '' }; target = 'q'; }
    else if (cur && (m = line.match(A_LINE))) { cur.a = m[1]; target = 'a'; }
    else if (cur && target && line.trim() && !/^[-*_]{3,}$/.test(line.trim())) cur[target] += ` ${line.trim()}`;
  }
  push();
  return cards;
}

const QUIZ_Q = /^[\s>*#]*\**\s*(?:Q(?:uestion)?\s*\d*|\d+)\s*\**\s*[:.)]\**\s*(.*)$/i;
const QUIZ_OPT = /^[\s>*-]*\**\(?([A-D])[).:]\**\s+(.*)$/;
const QUIZ_ANS = /^[\s>*#-]*\**\s*(?:Correct\s+)?Answer\s*\**\s*[:-]\s*\**\s*\(?([A-D])\b.*$/i;
const QUIZ_EXP = /^[\s>*#-]*\**\s*Explanation\s*\**\s*[:-]\s*\**\s*(.*)$/i;

/** Multiple-choice questions. Anything missing options or a valid answer key is dropped. */
export function parseQuiz(raw) {
  const out = [];
  let cur = null;
  let target = null;
  const push = () => {
    if (!cur) return;
    const keys = cur.options.map((o) => o.key);
    if (cur.q.trim() && cur.options.length >= 2 && keys.includes(cur.answer)) {
      out.push({ q: cur.q.trim(), options: cur.options.map((o) => ({ key: o.key, text: o.text.trim() })), answer: cur.answer, explanation: cur.explanation.trim() });
    }
  };
  for (const line of stripThinking(raw).replace(/\r/g, '').split('\n')) {
    let m;
    if ((m = line.match(QUIZ_ANS)) && cur) { cur.answer = m[1].toUpperCase(); target = null; }
    else if ((m = line.match(QUIZ_EXP)) && cur) { cur.explanation = m[1]; target = 'explanation'; }
    else if (cur && (m = line.match(QUIZ_OPT))) { cur.options.push({ key: m[1], text: m[2] }); target = 'option'; }
    else if ((m = line.match(QUIZ_Q))) { push(); cur = { q: m[1], options: [], answer: '', explanation: '' }; target = 'q'; }
    else if (cur && target && line.trim()) {
      const extra = ` ${line.trim()}`;
      if (target === 'option') cur.options[cur.options.length - 1].text += extra;
      else if (target === 'q') cur.q += extra;
      else cur.explanation += extra;
    }
  }
  push();
  return out;
}
