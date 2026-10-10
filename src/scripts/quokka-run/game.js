// Runs Quokka Run on its page (src/pages/quokka-run.astro): the start screen,
// a run, pausing, the results, saving a score and the leaderboards. The markup
// is in the page; this only shows and hides it and fills in the numbers.
//
// One state at a time:
//   start     the game plays itself behind the Start button
//   playing   a run is on
//   paused    a run is on hold (the P key, the pause button, switching tabs,
//             leaving full screen, or scrolling the game off screen)
//   counting  3, 2, 1 before a paused run carries on
//   over      the results

import statements from '../../data/quokkaRunStatements.json';
import settings from '../../data/quokkaRun.json';
import { createEngine, CAUSES, GATE_POINTS, READ_S, RESULT_MS } from './engine.js';
import { pickRamp, LEVEL_NAMES } from './statements.js';
import { validateScore } from './scoring.js';
import { createFullscreen } from './fullscreen.js';
import * as sound from './sound.js';

const API = '/api/quokka-run/scores';
const BOARD_SIZE = 10;
const BOARD_REFRESH_MS = 60_000;
const TOAST_MS = 2400;
const NOTICE_MS = 2600;
const COUNT_MS = 450; // each step of the 3, 2, 1
// Results ignore Play again for a moment, so a player still tapping from the
// run doesn't throw away an unsaved score.
const RESULTS_SETTLE_MS = 500;

const NAME_KEY = 'quokka-run-name';
const BEST_KEY = 'quokka-run-best';

// A competition on and not yet closed (src/data/quokkaRun.json).
const competitionOpen = () =>
  settings.competition.active && Date.now() < Date.parse(settings.competition.closes);

const fmt = (n) => Number(n).toLocaleString('en-AU');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// localStorage can be missing or blocked (private windows, blocked site data).
// Everything kept there is a nicety, so a failure just means it's forgotten.
const store = {
  get(key) {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {}
  },
};

export function startQuokkaRun(stage) {
  // The page was built while the competition was open; it may have closed since.
  if (!competitionOpen()) document.querySelectorAll('[data-competition]').forEach((node) => node.remove());

  const $ = (selector) => stage.querySelector(selector);
  const el = {
    canvas: $('[data-canvas]'),
    hud: $('[data-hud]'),
    gateCard: $('[data-gate-card]'),
    countdown: $('[data-countdown]'),
    start: $('[data-start-screen]'),
    startBest: $('[data-start-best]'),
    paused: $('[data-pause-screen]'),
    results: $('[data-results]'),
    form: $('[data-save]'),
    saved: $('[data-saved]'),
    notice: $('[data-notice]'),
    live: $('[data-live]'),
    pauseButton: $('[data-pause]'),
    soundButton: $('[data-sound]'),
    fullscreenButton: $('[data-fullscreen]'),
  };
  const boards = document.querySelectorAll('[data-board-list]');
  const nameInput = el.form.elements.namedItem('name');
  const emailInput = el.form.elements.namedItem('email'); // only while a competition is on
  const stillDemo = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Phones and tablets: a run starts in full screen, which is the only way
  // it's comfortable to play there.
  const touchFirst = matchMedia('(pointer: coarse)').matches;

  let state = 'start';
  let engine = null;
  let run = null; // the finished run's result
  let onScreen = true;
  let declinedFullscreen = false; // they left full screen, so don't put them back in
  let hudRaf = 0;
  let gateTimer = 0;
  let toastTimer = 0;
  let countTimer = 0;
  let noticeTimer = 0;
  let resultsAt = 0;
  let boardRequest = 0; // so an older leaderboard response can't overwrite a newer one
  const boardsInView = new Set(); // refresh only while someone could be looking at one

  const fullscreen = createFullscreen(stage, {
    onChange(on) {
      el.fullscreenButton.setAttribute('aria-pressed', String(on));
      // The name stays "Full screen"; pressed or not says which way it is.
      el.fullscreenButton.title = on ? 'Exit full screen (F)' : 'Full screen (F)';
      if (!on) {
        declinedFullscreen = true;
        pause();
      }
    },
  });

  // ---------- screens ----------

  function show(next) {
    state = next;
    const running = next === 'playing' || next === 'counting';
    el.start.hidden = next !== 'start';
    el.paused.hidden = next !== 'paused';
    el.results.hidden = next !== 'over';
    el.countdown.hidden = next !== 'counting';
    el.hud.hidden = !(running || next === 'paused');
    el.pauseButton.hidden = next !== 'playing';
    stage.classList.toggle('is-playing', running);
  }

  function stopEngine() {
    engine?.stop();
    engine = null;
    cancelAnimationFrame(hudRaf);
    clearTimeout(gateTimer);
    clearTimeout(toastTimer);
    clearInterval(countTimer);
    stage.querySelector('[data-toast]')?.remove();
    el.gateCard.hidden = true;
  }

  // The start screen plays the game to itself behind the button, standing
  // still for anyone who'd rather nothing moved.
  function showStart() {
    stopEngine();
    show('start');
    const best = Number(store.get(BEST_KEY));
    el.startBest.hidden = !best;
    el.startBest.textContent = best ? `Your best on this device: ${fmt(best)}` : '';
    engine = createEngine(el.canvas, { autopilot: true, gates: false, ...(stillDemo && { speedCap: 0 }) });
    syncDemo();
  }

  // The demo only runs while someone could be watching it.
  function syncDemo() {
    if (state !== 'start' || !engine) return;
    if (onScreen && !document.hidden) engine.resume();
    else engine.pause();
  }

  function play() {
    sound.unlock();
    stopEngine();
    run = null;
    show('playing');
    if (touchFirst && !declinedFullscreen && !fullscreen.isOn()) {
      fullscreen.enter();
    } else if (!fullscreen.isOn()) {
      // Bring the whole game into view, clear of the sticky header (which
      // would otherwise sit over the score and the statement card).
      const box = stage.getBoundingClientRect();
      const header = document.querySelector('body > header')?.getBoundingClientRect().bottom ?? 0;
      if (box.top < header || box.bottom > innerHeight) stage.scrollIntoView({ block: 'end', behavior: 'instant' });
    }
    stage.focus({ preventScroll: true });

    engine = createEngine(el.canvas, {
      questions: pickRamp(statements),
      onGate: showStatement,
      onGateResult: showVerdict,
      onLevel: showLevelUp,
      onOver: showResults,
      onSound: sound.play,
    });

    const [level, tokens, gates, score] = ['level', 'tokens', 'gates', 'score'].map((k) => $(`[data-hud-${k}]`));
    const eta = $('[data-gate-eta]');
    const tick = () => {
      if (!engine) return;
      const stats = engine.stats();
      level.textContent = `Lv ${stats.level}`;
      tokens.textContent = `🪙 ${stats.tokens}`;
      gates.textContent = `🧠 ${stats.gatesRight}/${stats.gatesSeen}`;
      score.textContent = fmt(engine.score());
      // The bar under the statement empties as the gate arrives, which matters
      // at speed, when the gate itself is only on screen for a moment.
      const left = engine.gateEta();
      eta.style.transform = `scaleX(${left == null ? 0 : Math.min(1, left / READ_S)})`;
      hudRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function pause() {
    if (state === 'counting') {
      clearInterval(countTimer);
    } else if (state !== 'playing' || !engine?.pause()) {
      // Nothing running, or the run has just ended (the results are on their way).
      return;
    }
    show('paused');
    stage.querySelector('[data-toast]')?.remove();
    // The verdict's explanation stays up until the run carries on.
    clearTimeout(gateTimer);
    $('[data-resume]').focus({ preventScroll: true });
  }

  // A 3, 2, 1 so a run never carries on before the player's ready.
  function resume() {
    if (state !== 'paused') return;
    // iOS can leave audio suspended after switching apps; this is a gesture, so wake it.
    sound.unlock();
    show('counting');
    stage.focus({ preventScroll: true });
    let n = 3;
    const step = () => {
      el.countdown.textContent = String(n);
      // Restart the pop animation for each number.
      el.countdown.style.animation = 'none';
      void el.countdown.offsetWidth;
      el.countdown.style.animation = '';
    };
    step();
    countTimer = setInterval(() => {
      n -= 1;
      if (n > 0) return step();
      clearInterval(countTimer);
      show('playing');
      engine?.resume();
      if (!el.gateCard.hidden && el.gateCard.dataset.state !== 'question') {
        gateTimer = setTimeout(() => (el.gateCard.hidden = true), RESULT_MS);
      }
    }, COUNT_MS);
  }

  // ---------- during a run ----------

  function showStatement(q) {
    clearTimeout(gateTimer);
    el.gateCard.dataset.state = 'question';
    const meta = `${LEVEL_NAMES[q.level] ?? ''} · worth ${GATE_POINTS[q.level] ?? GATE_POINTS[2]}`;
    $('[data-gate-meta]').textContent = meta;
    $('[data-gate-text]').textContent = q.text;
    el.gateCard.hidden = false;
    say(`${meta}. ${q.text} Jump through for fact, run under for hallucination.`);
  }

  function showVerdict(q, right) {
    sound.play(right ? 'right' : 'wrong');
    el.gateCard.dataset.state = right ? 'right' : 'wrong';
    const points = GATE_POINTS[q.level] ?? GATE_POINTS[2];
    const meta = right ? `Right! +${points}` : 'Not quite';
    const text = `It’s ${q.fact ? 'a fact' : 'a hallucination'}. ${q.why}`;
    $('[data-gate-meta]').textContent = meta;
    $('[data-gate-text]').textContent = text;
    say(`${meta}. ${text}`);
    gateTimer = setTimeout(() => (el.gateCard.hidden = true), RESULT_MS);
  }

  // Screen readers hear statements and verdicts from a region that's always in
  // the page; text written into the card while it's hidden often isn't read.
  function say(text) {
    el.live.textContent = text;
  }

  function showLevelUp(level, note) {
    sound.play('level');
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

  // ---------- results ----------

  function showResults(result) {
    if (state !== 'playing') return;
    stopEngine();
    run = result;
    resultsAt = performance.now();
    show('over');
    $('[data-cause]').textContent = CAUSES[result.cause] ?? 'Game over';
    $('[data-final]').textContent = fmt(result.score);
    $('[data-summary]').textContent =
      `Level ${result.level} · ${fmt(result.metres)} m · ${plural(result.tokens, 'token')} · ${result.correct} of ${plural(result.rounds, 'gate')} right`;

    const previous = Number(store.get(BEST_KEY)) || 0;
    if (result.score > previous) store.set(BEST_KEY, result.score);
    $('[data-best]').textContent =
      previous && result.score > previous
        ? `New best on this device. Your last was ${fmt(previous)}.`
        : previous
          ? `Your best on this device: ${fmt(previous)}`
          : '';

    el.form.hidden = false;
    el.saved.hidden = true;
    showErrors({});
    nameInput.value ||= store.get(NAME_KEY);
    loadBoards();
    // Focus the result rather than the name field, so a phone keyboard
    // doesn't jump up over the score.
    $('[data-results-heading]').focus({ preventScroll: true });
  }

  function showErrors(errors) {
    $('[data-error-name]').textContent = errors.name ?? '';
    $('[data-error-form]').textContent = errors._form ?? '';
    nameInput.setAttribute('aria-invalid', String(Boolean(errors.name)));
    if (emailInput) {
      $('[data-error-email]').textContent = errors.email ?? '';
      emailInput.setAttribute('aria-invalid', String(Boolean(errors.email)));
    }
    if (errors.name) nameInput.focus();
    else if (errors.email) emailInput?.focus();
  }

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!run) return;
    const saving = run;
    const email = emailInput && competitionOpen() ? emailInput.value : '';
    const body = { name: nameInput.value, email, score: run.score, correct: run.correct, rounds: run.rounds, seconds: run.seconds };
    // The API applies the same rules; checking here saves a round trip.
    const check = validateScore(body);
    if (!check.ok) return showErrors(check.errors);
    showErrors({});

    const button = el.form.querySelector('[type=submit]');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      // They've started another run since; this answer is about the old one.
      if (run !== saving) return;
      if (!res.ok) return showErrors(data.errors ?? { _form: 'That didn’t save. Try again in a minute.' });
      store.set(NAME_KEY, check.clean.name);
      showSaved(data, check.clean.name);
      loadBoards();
    } catch {
      if (run !== saving) return;
      showErrors({ _form: 'Couldn’t reach the leaderboard. Check your connection and try again.' });
    } finally {
      button.disabled = false;
      button.textContent = 'Save my score';
      // Disabling the button dropped focus; put it back if nothing else took it.
      if (!el.form.hidden && document.activeElement === document.body) button.focus();
    }
  });

  // `entry` is the best score entered with their email (null if not an
  // entry); `closed` means they gave an email after the competition closed.
  function showSaved({ rank, best, improved, entry, closed }, name) {
    const title = $('[data-saved-title]');
    const hint = $('[data-saved-hint]');
    if (rank == null) {
      title.textContent = `Saved, ${name}.`;
      hint.textContent = '';
    } else if (!improved && best > run.score) {
      title.textContent = `${name} is #${rank}.`;
      hint.textContent = `The best under that name is still ${fmt(best)}. Play again to beat it.`;
    } else {
      title.textContent = rank === 1 ? `New high score, ${name}!` : `You’re #${rank}, ${name}.`;
      hint.textContent = rank <= BOARD_SIZE ? 'You’re on the leaderboard.' : 'Play again to climb the board.';
    }
    const competition =
      entry != null
        ? entry > run.score
          ? `Your best competition entry is still ${fmt(entry)}.`
          : 'You’re in the competition.'
        : closed
          ? 'The competition has closed, so this one isn’t an entry.'
          : '';
    hint.textContent = `${hint.textContent} ${competition}`.trim();
    el.form.hidden = true;
    el.saved.hidden = false;
    title.focus({ preventScroll: true });
  }

  async function share() {
    if (!run) return;
    const url = new URL('/quokka-run', location.origin).href;
    const text = `I scored ${fmt(run.score)} on Quokka Run. Can you beat it?`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Quokka Run', text, url });
      } catch {} // closed the share sheet
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      notify('Copied. Paste it anywhere.');
    } catch {
      notify(`Couldn’t copy that. The link is ${url}`);
    }
  }

  function notify(message) {
    clearTimeout(noticeTimer);
    el.notice.textContent = message;
    el.notice.dataset.show = '';
    noticeTimer = setTimeout(() => {
      delete el.notice.dataset.show;
      el.notice.textContent = '';
    }, NOTICE_MS);
  }

  // ---------- leaderboards ----------
  // Two lists: one beside the results (seen in full screen) and one on the
  // page. Both show the top 10, plus the remembered name's place if it's lower.

  async function loadBoards() {
    const mine = ++boardRequest;
    const query = new URLSearchParams({ limit: String(BOARD_SIZE) });
    const name = store.get(NAME_KEY);
    if (name) query.set('player', name);
    try {
      const res = await fetch(`${API}?${query}`);
      if (!res.ok) throw new Error(String(res.status));
      const { top, me } = await res.json();
      if (mine !== boardRequest) return;
      boards.forEach((board) => renderBoard(board, top, me));
    } catch {
      // A board that fails to refresh keeps what it had.
      boards.forEach((board) => {
        if (!board.dataset.loaded) board.innerHTML = '<p class="text-ink-300">The leaderboard will be back shortly.</p>';
      });
    }
  }

  // `compact` is the board inside the game, which has to fit beside the result.
  function boardRow(rank, name, score, mine, compact) {
    const li = document.createElement('li');
    li.className = `grid grid-cols-[2.25rem_1fr_auto] items-center gap-3 rounded-lg px-3 ${compact ? 'py-1 text-sm' : 'py-2'} ${
      mine ? 'bg-sunset-500 font-semibold text-ink-950' : 'bg-white/5 text-ink-100'
    }`;
    li.value = rank;
    const place = document.createElement('span');
    place.setAttribute('aria-hidden', 'true');
    place.className = `font-display font-bold tabular-nums ${mine ? '' : 'text-ink-300'}`;
    place.textContent = String(rank);
    const who = document.createElement('span');
    who.className = 'truncate';
    who.textContent = name;
    if (mine) {
      const you = document.createElement('span');
      you.className = 'sr-only';
      you.textContent = ' (you)';
      who.append(you);
    }
    const points = document.createElement('span');
    points.className = 'font-display font-bold tabular-nums';
    points.textContent = fmt(score);
    li.append(place, who, points);
    return li;
  }

  function renderBoard(board, top, me) {
    board.dataset.loaded = 'yes';
    if (!top.length) {
      board.innerHTML = '<p class="text-ink-300">No scores yet. Be the first.</p>';
      return;
    }
    const list = document.createElement('ol');
    const compact = 'compact' in board.dataset;
    list.className = compact ? 'grid gap-1' : 'grid gap-1.5';
    // Preflight's list-style: none makes Safari drop list semantics without this.
    list.setAttribute('role', 'list');
    top.forEach((row, i) => list.append(boardRow(i + 1, row.name, row.score, me?.rank === i + 1, compact)));
    if (me && me.rank > top.length) {
      const gap = document.createElement('li');
      gap.className = 'px-3 text-center text-ink-400';
      gap.setAttribute('aria-hidden', 'true');
      gap.textContent = '⋯';
      list.append(gap, boardRow(me.rank, me.name, me.score, true, compact));
    }
    board.replaceChildren(list);
  }

  // ---------- controls ----------

  function toggleSound() {
    sound.setSound(!sound.soundOn());
    el.soundButton.setAttribute('aria-pressed', String(sound.soundOn()));
    notify(sound.soundOn() ? 'Sound on' : 'Sound off');
  }

  function toggleFullscreen() {
    if (!fullscreen.isOn()) declinedFullscreen = false;
    fullscreen.toggle();
  }

  // While running, a tap or click anywhere on the game jumps (except on the
  // buttons in the corner).
  stage.addEventListener('pointerdown', (e) => {
    if (state !== 'playing' || e.button > 0 || e.target.closest('[data-controls]')) return;
    e.preventDefault();
    engine?.jump();
  });

  // A tap anywhere on the start screen starts, as the hint says.
  el.start.addEventListener('click', (e) => {
    if (!e.target.closest('button')) play();
  });

  // The game's keys only work while a run is on, or while the player is in
  // the game (full screen, or focus inside it with it on screen). Elsewhere on
  // the page Space scrolls and F and M are just letters.
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const running = state === 'playing' || state === 'counting';
    const inGame = fullscreen.isOn() || (onScreen && stage.contains(document.activeElement));
    if (!running && !inGame) return;
    // A focused button gets Space for itself, as the browser intends
    // (except Carry on, which is what Space does anyway).
    const focusedButton = document.activeElement?.closest?.('button, a');
    const jumpKey = e.code === 'Space' || e.code === 'ArrowUp';
    const act = (fn) => {
      e.preventDefault();
      fn();
    };

    if (jumpKey) {
      if (focusedButton && !focusedButton.matches('[data-resume]')) return;
      if (state === 'playing') return act(() => !e.repeat && engine?.jump());
      if (state === 'counting') return act(() => {});
      if (state === 'paused') return act(resume);
      if (state === 'start') return act(play);
      return;
    }
    // Holding a toggle key down shouldn't flick it back and forth.
    if (e.repeat) return;
    if (e.code === 'KeyP') {
      if (running) return act(pause);
      if (state === 'paused') return act(resume);
    }
    if (e.code === 'Escape') {
      if (running) return act(pause);
      if (fullscreen.isOn()) return act(() => fullscreen.exit());
    }
    if (e.code === 'KeyF') return act(toggleFullscreen);
    if (e.code === 'KeyM') return act(toggleSound);
  });

  // A mouse or touch press on a corner button hands focus back to the game,
  // so the next Space jumps rather than pressing that button again. (A
  // keyboard press, detail 0, leaves focus where the player put it.)
  const corner = (fn) => (e) => {
    fn();
    if (e.detail > 0 && state !== 'paused') stage.focus({ preventScroll: true });
  };
  el.pauseButton.addEventListener('click', corner(pause));
  el.soundButton.addEventListener('click', corner(toggleSound));
  el.fullscreenButton.addEventListener('click', corner(toggleFullscreen));
  $('[data-resume]').addEventListener('click', resume);
  stage.querySelectorAll('[data-share]').forEach((button) => button.addEventListener('click', share));
  stage.querySelectorAll('[data-play]').forEach((button) =>
    button.addEventListener('click', () => {
      if (state === 'over' && performance.now() - resultsAt < RESULTS_SETTLE_MS) return;
      play();
    })
  );

  // Hold the run when the player can't be watching it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    syncDemo();
  });
  addEventListener('blur', pause);
  new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.intersectionRatio >= 0.5;
      if (!onScreen && !fullscreen.isOn()) pause();
      syncDemo();
    },
    { threshold: [0, 0.5, 1] }
  ).observe(stage);

  el.soundButton.setAttribute('aria-pressed', String(sound.soundOn()));
  showStart();
  loadBoards();
  const boardWatcher = new IntersectionObserver((entries) =>
    entries.forEach((entry) => (entry.isIntersecting ? boardsInView.add(entry.target) : boardsInView.delete(entry.target)))
  );
  boards.forEach((board) => boardWatcher.observe(board));
  setInterval(() => {
    if (!document.hidden && boardsInView.size && state !== 'playing' && state !== 'counting') loadBoards();
  }, BOARD_REFRESH_MS);
}
