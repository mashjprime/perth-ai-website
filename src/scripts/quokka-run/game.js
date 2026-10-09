// Runs Quokka Run on its page (src/pages/quokka-run.astro): the start screen,
// a run, the results and saving a score. The markup is in the page; this only
// shows and hides it and fills in the numbers.

import statements from '../../data/quokkaRunStatements.json';
import { createEngine, CAUSES, GATE_POINTS, RESULT_MS } from './engine.js';
import { pickRamp, LEVEL_NAMES } from './statements.js';
import { validateScore } from './scoring.js';

const API = '/api/quokka-run/scores';
const NAME_KEY = 'quokka-run-name';
const TOAST_MS = 2400;

// localStorage can be missing or blocked (private windows, blocked site data).
// Remembering the name is a nicety, so a failure just means retyping it.
const remembered = {
  get: () => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  },
  set: (name) => {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {}
  },
};

export function startQuokkaRun(stage, boardEl) {
  const $ = (selector) => stage.querySelector(selector);
  const canvas = $('[data-canvas]');
  const startScreen = $('[data-start-screen]');
  const hud = $('[data-hud]');
  const gateCard = $('[data-gate-card]');
  const results = $('[data-results]');
  const form = $('[data-save]');
  const saved = $('[data-saved]');
  const nameInput = form.elements.namedItem('name');
  const stillDemo = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let engine = null;
  let run = null; // the current run's result, once it's over
  let hudRaf = 0;
  let gateTimer = 0;
  let toastTimer = 0;

  // ---------- the board ----------

  async function loadBoard(highlightRank) {
    try {
      const res = await fetch(`${API}?limit=10`);
      if (!res.ok) throw new Error(String(res.status));
      renderBoard(await res.json(), highlightRank);
    } catch {
      // A board that fails to refresh keeps what it had.
      if (!boardEl.dataset.loaded) boardEl.innerHTML = '<p class="text-ink-300">The leaderboard will be back shortly.</p>';
    }
  }

  function renderBoard(rows, highlightRank) {
    boardEl.dataset.loaded = 'yes';
    if (!rows.length) {
      boardEl.innerHTML = '<p class="text-ink-300">No scores yet. Be the first.</p>';
      return;
    }
    const list = document.createElement('ol');
    list.className = 'grid gap-1.5';
    rows.forEach((row, i) => {
      const me = i + 1 === highlightRank;
      const li = document.createElement('li');
      li.className = `grid grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-lg px-3 py-2 ${
        me ? 'bg-sunset-500 font-semibold text-ink-950' : 'bg-white/5'
      }`;
      const rank = document.createElement('span');
      rank.className = `font-display font-bold ${me ? '' : 'text-ink-300'}`;
      rank.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'truncate';
      name.textContent = row.name;
      const score = document.createElement('span');
      score.className = 'font-display font-bold tabular-nums';
      score.textContent = row.score.toLocaleString('en-AU');
      li.append(rank, name, score);
      if (me) li.setAttribute('aria-current', 'true');
      list.append(li);
    });
    boardEl.replaceChildren(list);
  }

  // ---------- screens ----------

  function stopEngine() {
    engine?.stop();
    engine = null;
    cancelAnimationFrame(hudRaf);
    clearTimeout(gateTimer);
    clearTimeout(toastTimer);
    stage.querySelector('[data-toast]')?.remove();
    gateCard.hidden = true;
  }

  // The start screen plays the game to itself behind the button. Standing
  // still, for anyone who'd rather nothing moved.
  function showStart() {
    stopEngine();
    engine = createEngine(canvas, { autopilot: true, gates: false, ...(stillDemo && { speedCap: 0 }) });
  }

  function play() {
    stopEngine();
    run = null;
    startScreen.hidden = true;
    results.hidden = true;
    hud.hidden = false;
    stage.classList.add('is-playing');
    // A phone can have the game half off screen; bring it all into view.
    const box = stage.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight) stage.scrollIntoView({ block: 'center' });
    stage.focus({ preventScroll: true });

    engine = createEngine(canvas, {
      questions: pickRamp(statements),
      onGate: showStatement,
      onGateResult: showVerdict,
      onLevel: showLevelUp,
      onOver: showResults,
    });

    const [level, tokens, gates, score] = ['level', 'tokens', 'gates', 'score'].map((k) => $(`[data-hud-${k}]`));
    const tick = () => {
      if (!engine) return;
      const stats = engine.stats();
      level.textContent = `Lv ${stats.level}`;
      tokens.textContent = `🪙 ${stats.tokens}`;
      gates.textContent = `🧠 ${stats.gatesRight}/${stats.gatesSeen}`;
      score.textContent = engine.score().toLocaleString('en-AU');
      hudRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function showStatement(q) {
    clearTimeout(gateTimer);
    gateCard.dataset.state = 'question';
    $('[data-gate-meta]').textContent = `${LEVEL_NAMES[q.level] ?? ''} · worth ${GATE_POINTS[q.level] ?? GATE_POINTS[2]}`;
    $('[data-gate-text]').textContent = q.text;
    gateCard.hidden = false;
  }

  function showVerdict(q, right) {
    gateCard.dataset.state = right ? 'right' : 'wrong';
    const points = GATE_POINTS[q.level] ?? GATE_POINTS[2];
    $('[data-gate-meta]').textContent = right ? `Right! +${points}` : 'Not quite';
    $('[data-gate-text]').textContent = `It’s ${q.fact ? 'a fact' : 'a hallucination'}. ${q.why}`;
    gateTimer = setTimeout(() => (gateCard.hidden = true), RESULT_MS);
  }

  function showLevelUp(level, note) {
    clearTimeout(toastTimer);
    stage.querySelector('[data-toast]')?.remove();
    const toast = document.createElement('div');
    toast.dataset.toast = '';
    toast.className = 'qr-toast';
    toast.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = `Level ${level}`;
    toast.append(title);
    if (note) {
      const detail = document.createElement('span');
      detail.textContent = note;
      toast.append(detail);
    }
    stage.append(toast);
    toastTimer = setTimeout(() => toast.remove(), TOAST_MS);
  }

  function showResults(result) {
    if (!engine) return;
    stopEngine();
    run = result;
    hud.hidden = true;
    stage.classList.remove('is-playing');
    $('[data-cause]').textContent = CAUSES[result.cause] ?? 'Game over';
    $('[data-final]').textContent = result.score.toLocaleString('en-AU');
    $('[data-summary]').textContent =
      `Level ${result.level} · ${result.metres} m · ${result.tokens} tokens · ${result.correct} of ${result.rounds} gates right`;
    form.hidden = false;
    saved.hidden = true;
    showErrors({});
    nameInput.value ||= remembered.get();
    results.hidden = false;
    // Focus the result rather than the name field, so a phone keyboard
    // doesn't jump up over the score.
    $('[data-results-heading]').focus();
  }

  // ---------- saving ----------

  function showErrors(errors) {
    const field = $('[data-error-name]');
    const general = $('[data-error-form]');
    field.textContent = errors.name ?? '';
    general.textContent = errors._form ?? '';
    nameInput.setAttribute('aria-invalid', String(Boolean(errors.name)));
    if (errors.name) nameInput.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!run) return;
    const body = { name: nameInput.value, score: run.score, correct: run.correct, rounds: run.rounds, seconds: run.seconds };
    // The API applies the same rules; checking here saves a round trip.
    const check = validateScore(body);
    if (!check.ok) return showErrors(check.errors);
    showErrors({});

    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showErrors(data.errors ?? { _form: 'That didn’t save. Try again in a minute.' });
      remembered.set(check.clean.name);
      showSaved(data, check.clean.name);
      loadBoard(data.rank ?? undefined);
    } catch {
      showErrors({ _form: 'Couldn’t reach the leaderboard. Check your connection and try again.' });
    } finally {
      button.disabled = false;
      button.textContent = 'Save my score';
    }
  });

  function showSaved({ rank, best, improved }, name) {
    const title = $('[data-saved-title]');
    const hint = $('[data-saved-hint]');
    if (rank == null) {
      title.textContent = `Saved, ${name}.`;
      hint.textContent = '';
    } else if (!improved && best > run.score) {
      title.textContent = `${name} is #${rank}.`;
      hint.textContent = `The best score under that name is still ${best.toLocaleString('en-AU')}. Play again to beat it.`;
    } else {
      title.textContent = rank === 1 ? `New high score, ${name}!` : `You’re #${rank}, ${name}.`;
      hint.textContent = rank <= 10 ? 'You’re on the board below.' : 'Play again to climb the board.';
    }
    form.hidden = true;
    saved.hidden = false;
    title.focus();
  }

  // ---------- controls ----------

  // While running, a tap or click anywhere on the game jumps, and so do Space
  // and the up arrow (which would otherwise scroll the page).
  stage.addEventListener('pointerdown', (e) => {
    if (!engine || !stage.classList.contains('is-playing')) return;
    e.preventDefault();
    engine.jump();
  });
  window.addEventListener('keydown', (e) => {
    if (!engine || !stage.classList.contains('is-playing')) return;
    if (e.code !== 'Space' && e.code !== 'ArrowUp') return;
    e.preventDefault();
    if (!e.repeat) engine.jump();
  });

  stage.querySelectorAll('[data-play]').forEach((button) => button.addEventListener('click', play));

  showStart();
  loadBoard();
}
