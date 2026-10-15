/**
 * Interactive study widgets built from parsed model output.
 * Both take saved progress and call onChange(progress) after every user action so the
 * caller can persist it. Card and question text is rendered via the sanitized inline renderer.
 */
import { h } from './utils.js';
import { iconNode } from './icons.js';
import { renderInline } from './markdown.js';

const rich = (tag, className, text) => {
  const el = h(tag, { class: className });
  el.innerHTML = renderInline(text); // sanitized: only a small tag allow-list survives
  return el;
};
const plain = (text) => String(text).replace(/[*_`~]/g, '');

/* ═════════ Flashcards ═════════ */
export function renderFlashcards(cards, saved, onChange) {
  const progress = { index: 0, view: 'all', status: {}, ...saved };
  progress.status = { ...progress.status };
  let flipped = false;

  const root = h('div', { class: 'widget', tabindex: '-1', role: 'group', 'aria-label': 'Flashcards' });
  const count = h('span', { class: 'widget-count', 'aria-live': 'polite' });
  const tabAll = h('button', { type: 'button', 'aria-pressed': 'true' });
  const tabRev = h('button', { type: 'button', 'aria-pressed': 'false' });
  const frontText = h('span', { class: 'fc-text' });
  const backText = h('span', { class: 'fc-text' });
  const card = h('button', { type: 'button', class: 'fc-card', 'aria-label': 'Flip card' },
    h('span', { class: 'fc-inner' },
      h('span', { class: 'fc-face fc-front' }, h('span', { class: 'fc-label', text: 'Question' }), frontText),
      h('span', { class: 'fc-face fc-back', 'aria-hidden': 'true' }, h('span', { class: 'fc-label', text: 'Answer' }), backText)));
  const empty = h('div', { class: 'widget-empty', hidden: true, text: 'No cards are marked for revision yet.' });
  const hint = h('p', { class: 'widget-hint', text: 'Click the card to flip it. Use the arrow keys to move between cards.' });
  const btnPrev = h('button', { type: 'button', class: 'btn' }, iconNode('arrow-left', 16), 'Previous');
  const btnRevise = h('button', { type: 'button', class: 'btn' }, 'Needs revision');
  const btnKnown = h('button', { type: 'button', class: 'btn btn-primary' }, iconNode('check', 16), 'Known');
  const btnNext = h('button', { type: 'button', class: 'btn' }, 'Next', iconNode('arrow-right', 16));
  const controls = h('div', { class: 'widget-controls' }, btnPrev, btnRevise, btnKnown, btnNext);
  const summary = h('div', { class: 'widget-summary' });

  root.append(
    h('div', { class: 'widget-head' },
      h('span', { class: 'widget-title' }, iconNode('cards', 18), 'Flashcards'),
      h('div', { class: 'widget-tabs' }, tabAll, tabRev),
      count),
    card, empty, hint, controls, summary);

  const deck = () => cards.map((_, i) => i).filter((i) => progress.view === 'all' || progress.status[i] === 'revise');
  const changed = () => onChange?.({ index: progress.index, view: progress.view, status: progress.status });

  function paint({ keepFlip = false } = {}) {
    const indices = deck();
    progress.index = Math.min(Math.max(progress.index, 0), Math.max(indices.length - 1, 0));
    const n = Object.values(progress.status).filter((s) => s === 'known').length;
    const r = Object.values(progress.status).filter((s) => s === 'revise').length;

    tabAll.textContent = `All cards (${cards.length})`;
    tabRev.textContent = `To revise (${r})`;
    tabAll.setAttribute('aria-pressed', String(progress.view === 'all'));
    tabRev.setAttribute('aria-pressed', String(progress.view === 'revise'));
    summary.replaceChildren(
      h('span', {}, 'Known ', h('b', { text: n })),
      h('span', {}, 'To revise ', h('b', { text: r })),
      h('span', {}, 'Not rated ', h('b', { text: cards.length - n - r })));

    const has = indices.length > 0;
    card.hidden = controls.hidden = hint.hidden = !has;
    empty.hidden = has;
    if (!has) { count.textContent = '0 cards'; return; }

    const cardIndex = indices[progress.index];
    const status = progress.status[cardIndex];
    count.textContent = `${progress.index + 1} / ${indices.length}`;
    frontText.innerHTML = renderInline(cards[cardIndex].q);
    card.classList.toggle('is-known', status === 'known');
    card.classList.toggle('is-revise', status === 'revise');
    btnPrev.disabled = progress.index === 0;
    btnNext.disabled = progress.index === indices.length - 1;
    btnKnown.setAttribute('aria-pressed', String(status === 'known'));
    btnRevise.setAttribute('aria-pressed', String(status === 'revise'));

    const setBack = () => { backText.innerHTML = renderInline(cards[cardIndex].a); };
    if (flipped && !keepFlip) {
      // Turn the card back first so the next answer is never visible mid-flip.
      flipped = false;
      card.classList.remove('is-flipped');
      card.querySelector('.fc-back').setAttribute('aria-hidden', 'true');
      setTimeout(setBack, 260);
    } else setBack();
  }

  function flip() {
    flipped = !flipped;
    card.classList.toggle('is-flipped', flipped);
    card.querySelector('.fc-back').setAttribute('aria-hidden', String(!flipped));
    card.setAttribute('aria-label', flipped ? 'Show question' : 'Show answer');
  }

  function rate(value) {
    const indices = deck();
    const cardIndex = indices[progress.index];
    progress.status[cardIndex] = progress.status[cardIndex] === value ? undefined : value;
    if (progress.status[cardIndex] === undefined) delete progress.status[cardIndex];
    changed();
    // Advance after rating, unless we're already on the last card of the deck.
    const stillInDeck = deck().includes(cardIndex);
    if (stillInDeck && progress.index < deck().length - 1) progress.index++;
    paint();
  }

  card.addEventListener('click', flip);
  btnPrev.addEventListener('click', () => { progress.index--; changed(); paint(); });
  btnNext.addEventListener('click', () => { progress.index++; changed(); paint(); });
  btnKnown.addEventListener('click', () => rate('known'));
  btnRevise.addEventListener('click', () => rate('revise'));
  const setView = (view) => { progress.view = view; progress.index = 0; changed(); paint(); };
  tabAll.addEventListener('click', () => setView('all'));
  tabRev.addEventListener('click', () => setView('revise'));
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft' && !btnPrev.disabled) { e.preventDefault(); btnPrev.click(); }
    if (e.key === 'ArrowRight' && !btnNext.disabled) { e.preventDefault(); btnNext.click(); }
  });

  paint();
  return root;
}

/* ═════════ Quiz ═════════ */
export function renderQuiz(questions, saved, onChange) {
  const progress = { current: 0, finished: false, answers: {}, ...saved };
  progress.answers = { ...progress.answers };
  progress.current = Math.min(Math.max(progress.current, 0), questions.length - 1);

  const root = h('div', { class: 'widget', tabindex: '-1', role: 'group', 'aria-label': 'Quiz' });
  const changed = () => onChange?.({ current: progress.current, finished: progress.finished, answers: progress.answers });
  const score = () => questions.filter((q, i) => progress.answers[i] === q.answer).length;

  function draw({ focus = false } = {}) {
    root.replaceChildren(progress.finished ? resultsView() : questionView());
    if (focus) root.querySelector('[data-focus]')?.focus({ preventScroll: true });
  }

  function questionView() {
    const i = progress.current;
    const q = questions[i];
    const chosen = progress.answers[i];
    const answered = chosen !== undefined;
    const last = i === questions.length - 1;

    const options = h('div', { class: 'q-options' }, q.options.map((o) => {
      const state = !answered ? '' : o.key === q.answer ? ' is-correct' : o.key === chosen ? ' is-wrong' : '';
      const btn = h('button', { type: 'button', class: `q-opt${state}`, disabled: answered, dataset: { key: o.key } },
        h('span', { class: 'q-key', text: o.key }), rich('span', '', o.text));
      if (answered && o.key === q.answer) btn.append(h('span', { class: 'sr-only', text: ' (correct answer)' }));
      if (answered && o.key === chosen && chosen !== q.answer) btn.append(h('span', { class: 'sr-only', text: ' (your answer, incorrect)' }));
      btn.addEventListener('click', () => { progress.answers[i] = o.key; changed(); draw({ focus: true }); });
      return btn;
    }));

    const feedback = answered && h('div', { class: `q-feedback ${chosen === q.answer ? 'is-correct' : 'is-wrong'}`, role: 'status' },
      h('strong', { text: chosen === q.answer ? 'Correct' : `Not quite. The answer is ${q.answer}.` }),
      q.explanation ? rich('span', '', q.explanation) : null);

    const prev = h('button', { type: 'button', class: 'btn', disabled: i === 0 }, iconNode('arrow-left', 16), 'Previous');
    const next = h('button', { type: 'button', class: 'btn btn-primary', disabled: !answered }, last ? 'See results' : 'Next', last ? null : iconNode('arrow-right', 16));
    prev.addEventListener('click', () => { progress.current--; changed(); draw({ focus: true }); });
    next.addEventListener('click', () => {
      if (last) {
        if (Object.keys(progress.answers).length < questions.length) return;
        progress.finished = true;
      } else progress.current++;
      changed();
      draw({ focus: true });
    });
    // "See results" needs every question answered; earlier skips are possible via Previous.
    if (last && Object.keys(progress.answers).length < questions.length) {
      next.disabled = true;
      next.title = 'Answer every question to see your score';
    }

    // Focus target so keyboard users keep their place after each step.
    const qText = rich('div', 'q-text', q.q);
    qText.tabIndex = -1;
    qText.dataset.focus = '1';

    return h('div', {},
      h('div', { class: 'widget-head' },
        h('span', { class: 'widget-title' }, iconNode('quiz', 18), 'Quiz'),
        h('span', { class: 'widget-count', text: `Question ${i + 1} of ${questions.length}` })),
      h('div', { class: 'q-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(questions.length), 'aria-valuenow': String(Object.keys(progress.answers).length), 'aria-label': 'Answered questions' },
        h('i', { style: `width:${(Object.keys(progress.answers).length / questions.length) * 100}%` })),
      qText,
      options, feedback, h('div', { class: 'q-nav' }, prev, next));
  }

  function resultsView() {
    const total = questions.length;
    const right = score();
    const pct = Math.round((right / total) * 100);
    const wrong = questions.map((q, i) => ({ q, i })).filter(({ q, i }) => progress.answers[i] !== q.answer);
    const message = pct === 100 ? 'Perfect score.' : pct >= 70 ? 'Solid. Review the misses below.' : pct >= 40 ? 'Getting there. Review the misses and try again.' : 'Worth another pass through your notes.';

    const retake = h('button', { type: 'button', class: 'btn btn-primary' }, iconNode('refresh', 16), 'Retake quiz');
    retake.addEventListener('click', () => { progress.answers = {}; progress.current = 0; progress.finished = false; changed(); draw({ focus: true }); });
    const back = h('button', { type: 'button', class: 'btn' }, iconNode('arrow-left', 16), 'Back to questions');
    back.addEventListener('click', () => { progress.finished = false; progress.current = 0; changed(); draw({ focus: true }); });

    const review = wrong.length
      ? h('div', { class: 'q-review' },
        h('strong', { text: `Review (${wrong.length} to revisit)` }),
        wrong.map(({ q, i }) => {
          const mine = q.options.find((o) => o.key === progress.answers[i]);
          const right_ = q.options.find((o) => o.key === q.answer);
          return h('div', { class: 'q-review-item' },
            h('div', { class: 'q', text: `${i + 1}. ${plain(q.q)}` }),
            h('div', { class: 'mine', text: `Your answer: ${progress.answers[i] ?? '—'}${mine ? `) ${plain(mine.text)}` : ''}` }),
            h('div', { class: 'right', text: `Correct: ${q.answer}) ${plain(right_?.text ?? '')}` }),
            q.explanation ? h('div', { class: 'why', text: plain(q.explanation) }) : null);
        }))
      : h('p', { class: 'widget-hint', text: 'You answered every question correctly.' });

    return h('div', {},
      h('div', { class: 'widget-head' }, h('span', { class: 'widget-title' }, iconNode('quiz', 18), 'Quiz results')),
      h('div', { class: 'q-score', tabindex: '-1', dataset: { focus: '1' } },
        h('div', { class: 'big', text: `${right} / ${total}` }),
        h('p', { text: `${pct}% correct. ${message}` })),
      h('div', { class: 'widget-controls' }, retake, back), review);
  }

  draw();
  return root;
}
