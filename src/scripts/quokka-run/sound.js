// Quokka Run's sound effects, synthesised with the Web Audio API so there are
// no audio files to license or download. Quiet, short and chiptune-ish.
//
// Browsers only allow audio after the visitor has interacted with the page,
// so nothing is created until unlock() is called from a click or key press.
// The on/off choice is remembered on the device.

const KEY = 'quokka-run-sound';
const VOLUME = 0.12;

let ctx = null;
let master = null;
let on = read();

function read() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export const soundOn = () => on;

export function setSound(value) {
  on = value;
  try {
    localStorage.setItem(KEY, value ? 'on' : 'off');
  } catch {}
  if (on) unlock();
}

// Call from a user gesture (the Start button, a key press).
export function unlock() {
  if (!on) return;
  if (!window.AudioContext) return;
  if (!ctx) {
    ctx = new window.AudioContext();
    master = ctx.createGain();
    master.gain.value = VOLUME;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

// One square-ish note sliding from `from` to `to` Hz over `ms`, starting `delay` ms from now.
function tone({ from, to = from, ms = 90, type = 'square', delay = 0, gain = 1 }) {
  const start = ctx.currentTime + delay / 1000;
  const end = start + ms / 1000;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(to, end);
  amp.gain.setValueAtTime(gain, start);
  amp.gain.exponentialRampToValueAtTime(0.001, end);
  osc.connect(amp).connect(master);
  osc.start(start);
  osc.stop(end + 0.02);
}

function noise(ms, gain = 0.8) {
  const length = Math.floor((ctx.sampleRate * ms) / 1000);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const src = ctx.createBufferSource();
  const amp = ctx.createGain();
  amp.gain.value = gain;
  src.buffer = buffer;
  src.connect(amp).connect(master);
  src.start();
}

const EFFECTS = {
  jump: () => tone({ from: 300, to: 620, ms: 110, gain: 0.6 }),
  token: () => {
    tone({ from: 990, ms: 60, type: 'triangle' });
    tone({ from: 1320, ms: 110, type: 'triangle', delay: 55 });
  },
  right: () => [523, 659, 784].forEach((f, i) => tone({ from: f, ms: 110, type: 'triangle', delay: i * 80 })),
  wrong: () => tone({ from: 260, to: 110, ms: 320, type: 'sawtooth', gain: 0.5 }),
  level: () => [392, 523, 659, 784].forEach((f, i) => tone({ from: f, ms: 90, delay: i * 70, gain: 0.5 })),
  crash: () => {
    noise(260);
    tone({ from: 180, to: 50, ms: 380, type: 'sawtooth', gain: 0.6 });
  },
};

export function play(name) {
  if (!on || !ctx || ctx.state !== 'running') return;
  EFFECTS[name]?.();
}
