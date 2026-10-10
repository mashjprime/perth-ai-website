// Quokka Run's engine: a one-tap endless runner drawn on a canvas. Tap to jump
// over hallucination bugs, rate limits and GPU fires. Every so often a gate
// shows a statement: jump through it for FACT, run under for HALLUCINATION.
// It levels up every LEVEL_EVERY_S seconds and never stops getting faster
// (see difficulty.js).
//
// The same engine plays itself (autopilot) behind the start screen.
//
// Started life in the DDD Perth 2026 booth kiosk (public/ddd-2026/js/runner.js).
// This copy is the permanent one. If you change how points are earned, check
// the plausibility limits in scoring.js still hold.

import { sprites } from './sprites.js';
import { levelAt, LEVEL_EVERY_S, START_SPEED } from './difficulty.js';

// World units: the playfield is ~540 units tall on a landscape screen.
const PX = 4; // world units per sprite pixel
const QUOKKA = { x: 120, w: 20 * PX, h: 16 * PX };
// How much road every player sees, whatever their screen. Wider screens get
// more picture, but obstacles still appear at this distance and the road fades
// out beyond it, so nobody gets longer to react (it matters at speed).
const VIEW_W = 900;
const MIN_LABEL_PX = 11; // gate labels never smaller than this on screen, if the gate's wide enough
const GRAVITY = 2600;
const JUMP_V = 900; // ~155 units high, ~0.7s in the air
const BUFFER_S = 0.12; // a tap just before landing still jumps
const ACCEL = 8; // units/s gained per second, up to the current level's top speed
const DEMO_MAX_SPEED = 560; // autopilot stays watchable
// The world moves at most this far per physics step. At top speed on a slow
// device one frame can be over 100 units, enough to skip clean past an
// obstacle, so a long frame is split into smaller steps.
const MAX_STEP_UNITS = 30;
const FIRST_GATE_S = 12;
const GATE_EVERY_S = 22;
export const READ_S = 7; // time between a statement appearing and reaching its gate
const GATE = { w: 130, split: 92, top: 250 }; // split = height of the HALLUCINATION panel
export const GATE_POINTS = { 1: 150, 2: 250, 3: 400 }; // by statement difficulty
const TOKEN_POINTS = 20;
export const RESULT_MS = 4200; // how long a gate's verdict stays up

export const CAUSES = {
  bug: 'Tripped over a hallucination',
  gpu: 'Singed by a GPU fire',
  sign: 'Hit a 429 rate limit',
  drone: 'Jumped into a flying hallucination',
};

const COLORS = {
  ground: '#6c789d',
  road: 'rgb(5 10 23 / 0.88)',
  pebble: '#232f52',
  fact: '#00c2ff',
  hallu: '#ff6b8a',
  token: '#ffc785',
  tokenEdge: '#dc7700',
  sign: '#ff6b8a',
  signEdge: '#8c1d36',
  post: '#99a0b8',
};

// ---------- engine ----------

// `speedCap: 0` gives a still scene (the start screen, for anyone who prefers reduced motion).
export function createEngine(canvas, {
  autopilot = false,
  invincible = autopilot,
  speedCap = autopilot ? DEMO_MAX_SPEED : Infinity,
  gates = true,
  questions = [],
  onGate,
  onGateResult,
  onLevel,
  onOver,
  onSound, // 'jump', 'token' or 'crash', for sound effects
}) {
  const ctx = canvas.getContext('2d');
  const art = sprites();
  let W = 0;
  let H = 0;
  let G = 0; // ground line
  let raf = 0;
  let last = 0;
  let zoom = 1; // screen pixels per world unit
  let paused = false;
  let overTimer = 0;

  const s = {
    clock: 0,
    level: 0,
    speed: START_SPEED,
    dist: 0,
    score: 0,
    tokens: 0,
    gatesSeen: 0,
    gatesRight: 0,
    y: 0, // quokka height above the ground
    vy: 0,
    buffered: -1,
    obstacles: [],
    coins: [],
    gate: null,
    spawnIn: 600,
    coinIn: 900,
    nextGate: FIRST_GATE_S,
    queue: [...questions],
    over: false,
    cause: null,
  };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    // Zoom so every screen sees the same stretch of road ahead, in either
    // orientation. It used to be 620 wide in portrait, for bigger sprites on a
    // phone, but at high speed that left portrait players a fraction of a
    // second less to react, which isn't fair on a shared leaderboard.
    const portrait = h > w;
    let scale = w / VIEW_W;
    scale = Math.min(scale, h / 460); // keep world height >= 460 so the 250-tall gates still fit above the ground
    W = w / scale;
    H = h / scale;
    // Ground sits low in every orientation, road filling below it, so nothing
    // floats and there is no empty half in portrait.
    G = Math.round(H * (portrait ? 0.74 : 0.82));
    // Tell the CSS skyline where the ground is so the buildings stand on it
    // rather than at the bottom of the screen (which left them under the road).
    if (canvas.parentElement) {
      canvas.parentElement.style.setProperty('--ground-px', Math.max(0, Math.round(h - G * scale)) + 'px');
    }
    zoom = scale;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // Resizing clears the canvas, and a paused game isn't drawing frames.
    if (paused) draw();
  }
  // Re-fit on rotation and viewport changes (iOS Safari fires visualViewport,
  // not always resize). These are removed in stop() so they do not accumulate
  // across runs.
  const onViewport = () => resize();
  window.addEventListener('orientationchange', onViewport);
  window.visualViewport && window.visualViewport.addEventListener('resize', onViewport);
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const onGround = () => s.y <= 0;

  // Fixed-height jump: a quick tap on a touch screen should clear anything.
  function jump() {
    if (s.over) return;
    if (paused) return;
    if (onGround()) {
      s.vy = JUMP_V;
      onSound?.('jump');
    } else s.buffered = BUFFER_S;
  }

  // ----- spawning -----

  function spawnObstacle() {
    const { kinds, gap } = levelAt(s.level);
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const x = VIEW_W + 20;
    const bug = (i) => ({ kind: 'bug', x: x + i * 12 * PX, y: 0, w: 12 * PX, h: 10 * PX });
    if (kind === 'bug') s.obstacles.push(bug(0));
    if (kind === 'pair') s.obstacles.push(bug(0), bug(1));
    if (kind === 'triple') s.obstacles.push(bug(0), bug(1), bug(2));
    if (kind === 'gpu') s.obstacles.push({ kind, x, y: 0, w: 12 * PX, h: 12 * PX });
    if (kind === 'sign') s.obstacles.push({ kind, x, y: 0, w: 34, h: 70 });
    // Floats just above the quokka's head: run under it, don't jump.
    if (kind === 'drone') s.obstacles.push({ kind, x, y: 72, w: 12 * PX, h: 12 * PX });
    // Always leave room to land and jump again; more room at random.
    s.spawnIn = s.speed * (gap[0] + Math.random() * gap[1]) + 80;
  }

  function spawnCoin() {
    s.coins.push({ x: VIEW_W + 20, y: 70 + Math.random() * 80, r: 12 });
    s.coinIn = s.speed * (1.5 + Math.random() * 2.5);
  }

  function startGate() {
    const q = s.queue.shift();
    if (!q) return (s.nextGate = Infinity);
    s.gate = { q, x: QUOKKA.x + s.speed * READ_S, jumped: false, done: false };
    onGate?.(q);
  }

  // ----- update -----

  const hits = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  function quokkaBox() {
    // Forgiving hitbox: skip the ears, tail and toes.
    return { x: QUOKKA.x + 10, w: QUOKKA.w - 22, y: s.y + 4, h: QUOKKA.h - 18 };
  }

  function autopilotStep() {
    const centre = QUOKKA.x + QUOKKA.w / 2;
    const lead = s.speed * 0.34; // jump so the apex lands over the obstacle's middle
    if (!onGround()) return;
    const ground = s.obstacles.filter((o) => o.y === 0);
    const next = ground.find((o) => o.x + o.w > QUOKKA.x);
    if (next) {
      const run = ground.filter((o) => o.x >= next.x && o.x <= next.x + 12 * PX * 2);
      const end = Math.max(...run.map((o) => o.x + o.w));
      if ((next.x + end) / 2 - centre <= lead) return void (s.vy = JUMP_V);
    }
    const g = s.gate;
    if (g && !g.done && g.q.fact && g.x + GATE.w / 2 - centre <= lead) s.vy = JUMP_V;
  }

  function update(dt) {
    if (s.over) return;
    s.clock += dt;
    const level = Math.floor(s.clock / LEVEL_EVERY_S);
    if (level !== s.level) {
      s.level = level;
      onLevel?.(level + 1, levelAt(level).note);
    }
    if (!s.gate) s.speed = Math.min(speedCap, levelAt(level).speed, s.speed + ACCEL * dt);
    const dx = s.speed * dt;
    s.dist += dx;
    s.score += dx / 40;

    // quokka
    if (autopilot) autopilotStep();
    if (s.buffered > 0) {
      s.buffered -= dt;
      if (onGround()) {
        s.vy = JUMP_V;
        s.buffered = -1;
        onSound?.('jump');
      }
    }
    if (!onGround() || s.vy > 0) {
      s.vy -= GRAVITY * dt;
      s.y = Math.max(0, s.y + s.vy * dt);
      if (s.y === 0) s.vy = 0;
    }

    // world
    for (const o of s.obstacles) o.x -= dx;
    for (const c of s.coins) c.x -= dx;
    s.obstacles = s.obstacles.filter((o) => o.x + o.w > -20);
    s.coins = s.coins.filter((c) => c.x + c.r > -20 && !c.taken);

    const gateOpen = s.gate && !s.gate.done;
    if (!gateOpen) {
      s.spawnIn -= dx;
      s.coinIn -= dx;
      if (s.spawnIn <= 0) spawnObstacle();
      if (s.coinIn <= 0) spawnCoin();
      if (gates && !s.gate && s.clock >= s.nextGate) startGate();
    }

    // gate
    const g = s.gate;
    if (g) {
      g.x -= dx;
      const overlapping = g.x < QUOKKA.x + QUOKKA.w - 10 && g.x + GATE.w > QUOKKA.x + 10;
      if (overlapping && s.y > 20) g.jumped = true;
      if (!g.done && g.x + GATE.w < QUOKKA.x + 10) {
        g.done = true;
        const right = g.jumped === g.q.fact;
        s.gatesSeen += 1;
        if (right) {
          s.gatesRight += 1;
          s.score += GATE_POINTS[g.q.level] ?? GATE_POINTS[2];
        }
        s.spawnIn = s.speed * 0.9;
        s.nextGate = s.clock + GATE_EVERY_S;
        onGateResult?.(g.q, right, g.jumped);
      }
      if (g.done && g.x + GATE.w < -20) s.gate = null;
    }

    // collisions
    const me = quokkaBox();
    for (const c of s.coins) {
      if (hits(me, { x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 })) {
        c.taken = true;
        s.tokens += 1;
        s.score += TOKEN_POINTS;
        onSound?.('token');
      }
    }
    if (!invincible) {
      const hit = s.obstacles.find((o) => hits(me, { x: o.x + 4, y: o.y, w: o.w - 8, h: o.h - 4 }));
      if (hit) {
        s.over = true;
        s.cause = hit.kind;
        onSound?.('crash');
        overTimer = setTimeout(() => onOver?.(result()), 900);
      }
    }
  }

  // ----- draw -----

  const img = (sprite, x, yFromGround) =>
    ctx.drawImage(sprite, x, G - yFromGround - sprite.height * PX, sprite.width * PX, sprite.height * PX);

  function drawGround() {
    // Dark road under the runner so it reads clearly over the skyline.
    ctx.fillStyle = COLORS.road;
    ctx.fillRect(0, G, W, H - G);
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, G, W, 3);
    ctx.fillStyle = COLORS.pebble;
    const gap = 37;
    for (let k = Math.floor(s.dist / gap); k * gap - s.dist < W; k++) {
      const hash = (k * 2654435761) >>> 0;
      const x = k * gap - s.dist;
      ctx.fillRect(x, G + 10 + (hash % 4) * 9, 4 + (hash % 3) * 4, 3);
    }
  }

  function drawSign(o) {
    const top = G - o.h;
    ctx.fillStyle = COLORS.post;
    ctx.fillRect(o.x + o.w / 2 - 3, top + 24, 6, o.h - 24);
    ctx.fillStyle = COLORS.signEdge;
    ctx.fillRect(o.x - 6, top, o.w + 12, 30);
    ctx.fillStyle = COLORS.sign;
    ctx.fillRect(o.x - 3, top + 3, o.w + 6, 24);
    ctx.fillStyle = '#050a17'; // dark on coral: white would be 2.7:1
    ctx.font = '700 17px "Space Grotesk Variable", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('429', o.x + o.w / 2, top + 16);
  }

  function drawCoin(c) {
    const y = G - c.y;
    ctx.fillStyle = COLORS.tokenEdge;
    ctx.beginPath();
    ctx.arc(c.x, y, c.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.token;
    ctx.beginPath();
    ctx.arc(c.x, y, c.r - 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.tokenEdge;
    ctx.font = '700 13px "Space Grotesk Variable", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('T', c.x, y + 1);
  }

  function drawGate(g, front) {
    const x = g.x;
    const splitY = G - GATE.split;
    const topY = G - GATE.top;
    if (!front) {
      // posts
      ctx.fillStyle = '#e0e3eb';
      ctx.fillRect(x - 6, topY - 8, 6, GATE.top + 8);
      ctx.fillRect(x + GATE.w, topY - 8, 6, GATE.top + 8);
      ctx.fillRect(x - 6, topY - 8, GATE.w + 12, 6);
      ctx.fillRect(x - 6, splitY - 3, GATE.w + 12, 6);
      return;
    }
    const dim = g.done ? 0.12 : 0.3;
    ctx.globalAlpha = dim;
    ctx.fillStyle = COLORS.fact;
    ctx.fillRect(x, topY - 2, GATE.w, splitY - topY - 1);
    ctx.fillStyle = COLORS.hallu;
    ctx.fillRect(x, splitY + 3, GATE.w, GATE.split - 3);
    ctx.globalAlpha = g.done ? 0.4 : 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.fact;
    labels(x + GATE.w / 2, (topY + splitY) / 2, ['FACT', 22], ['↑ jump', 15]);
    ctx.fillStyle = COLORS.hallu;
    // On a zoomed-out phone HALLUCINATION won't fit the gate at a readable size, so it splits.
    const hallu = fits('HALLUCINATION', 13) ? [['HALLUCINATION', 13]] : [['HALLU-', 13], ['CINATION', 13]];
    labels(x + GATE.w / 2, splitY + GATE.split / 2, ...hallu, ['run under', 15]);
    ctx.globalAlpha = 1;
  }

  // Lines of gate label centred on (cx, cy). Each is its normal size, or
  // MIN_LABEL_PX on screen if that's bigger (a zoomed-out phone), but never
  // wider than the gate.
  const labelSize = (text, size) => {
    const px = Math.max(size, MIN_LABEL_PX / zoom);
    ctx.font = `700 ${px}px "Space Grotesk Variable", sans-serif`;
    return Math.min(px, (px * (GATE.w - 10)) / ctx.measureText(text).width);
  };
  const fits = (text, size) => labelSize(text, size) * zoom >= MIN_LABEL_PX - 0.5;

  function labels(cx, cy, ...lines) {
    const fonts = lines.map(([text, size]) => labelSize(text, size));
    const gap = 4;
    let y = cy - (fonts.reduce((a, b) => a + b, 0) + gap * (lines.length - 1)) / 2;
    lines.forEach(([text], i) => {
      ctx.font = `700 ${fonts[i]}px "Space Grotesk Variable", sans-serif`;
      ctx.fillText(text, cx, y + fonts[i] / 2);
      y += fonts[i] + gap;
    });
  }

  // Past VIEW_W the road fades to dark, so a wide screen shows more sky and
  // city but no more of what's coming.
  function drawFog() {
    if (W <= VIEW_W) return;
    // Starts at VIEW_W exactly, so everything a 16:9 screen sees is just as
    // clear here; obstacles appear at VIEW_W + 20, inside the dark.
    const fade = ctx.createLinearGradient(VIEW_W, 0, VIEW_W + 20, 0);
    fade.addColorStop(0, 'rgb(5 10 23 / 0)');
    fade.addColorStop(1, 'rgb(5 10 23 / 0.96)');
    ctx.fillStyle = fade;
    ctx.fillRect(VIEW_W, 0, 20, H);
    ctx.fillStyle = 'rgb(5 10 23 / 0.96)';
    ctx.fillRect(VIEW_W + 20, 0, W - VIEW_W - 20, H);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawGround();
    if (s.gate) drawGate(s.gate, false);
    for (const c of s.coins) drawCoin(c);
    const flicker = Math.floor(s.clock * 8) % 2;
    for (const o of s.obstacles) {
      if (o.kind === 'bug') img(art.bug, o.x, Math.abs(Math.sin(s.clock * 6 + o.x)) * 4);
      if (o.kind === 'gpu') img(art.gpu[flicker], o.x, 0);
      if (o.kind === 'drone') img(art.drone[flicker], o.x, o.y + Math.sin(s.clock * 5) * 3);
      if (o.kind === 'sign') drawSign(o);
    }
    const frame = !onGround() ? art.jump : Math.floor(s.dist / 60) % 2 ? art.run1 : art.run2;
    if (s.over) {
      ctx.save();
      ctx.translate(QUOKKA.x + QUOKKA.w / 2, G - s.y - QUOKKA.h / 2);
      ctx.rotate(-0.35);
      ctx.drawImage(frame, -QUOKKA.w / 2, -QUOKKA.h / 2, QUOKKA.w, QUOKKA.h);
      ctx.restore();
    } else {
      img(frame, QUOKKA.x, s.y);
    }
    if (s.gate) drawGate(s.gate, true);
    drawFog();
  }

  function loop(now) {
    // A frame longer than 0.1s (under 10 fps) plays as 0.1s, so a stall can't
    // teleport the world. Below that the game runs a little slow; above it,
    // the substeps keep a long frame accurate.
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    const steps = Math.max(1, Math.ceil((s.speed * dt) / MAX_STEP_UNITS));
    for (let i = 0; i < steps; i++) update(dt / steps);
    draw();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  const result = () => ({
    score: Math.round(s.score),
    correct: s.gatesRight,
    rounds: s.gatesSeen,
    tokens: s.tokens,
    level: s.level + 1,
    metres: Math.round(s.dist / 40),
    cause: s.cause,
    seconds: Math.round(s.clock),
  });

  return {
    jump,
    // Pausing stops the loop; resuming starts the clock again from that frame,
    // so no time passes while paused. A run that's already over can't pause.
    pause() {
      if (paused || s.over) return false;
      paused = true;
      cancelAnimationFrame(raf);
      return true;
    },
    resume() {
      if (!paused) return;
      paused = false;
      last = 0;
      raf = requestAnimationFrame(loop);
    },
    score: () => Math.round(s.score),
    stats: () => ({ tokens: s.tokens, gatesRight: s.gatesRight, gatesSeen: s.gatesSeen, level: s.level + 1 }),
    // Seconds until the quokka reaches the open gate, or null if there isn't one.
    // (Speed holds steady while a gate is open, so this counts down evenly.)
    gateEta: () =>
      s.gate && !s.gate.done ? Math.max(0, (s.gate.x - QUOKKA.x - QUOKKA.w) / Math.max(1, s.speed)) : null,
    stop() {
      cancelAnimationFrame(raf);
      clearTimeout(overTimer);
      ro.disconnect();
      window.removeEventListener('orientationchange', onViewport);
      window.visualViewport && window.visualViewport.removeEventListener('resize', onViewport);
    },
  };
}
