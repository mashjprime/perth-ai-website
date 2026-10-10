// How Quokka Run gets harder. Shared by the engine (engine.js) and by the
// score check (scoring.js), which needs to know how fast a run can go.
//
// A new level every LEVEL_EVERY_S seconds. The first seven add obstacles; after
// that every level is faster than the last, up to MAX_SPEED. The faster it
// goes, the less time there is to see what's coming, so even a great run ends
// in minutes. (At DDD the speed stopped rising at two minutes, and people
// played for an hour.)

export const LEVEL_EVERY_S = 20;
export const START_SPEED = 380;
const SPEED_STEP = 100; // added each level after the table runs out
export const MAX_SPEED = 3200;

// speed: top speed. gap: seconds of travel between obstacles, [minimum, random extra].
// Obstacle kinds accumulate: each level adds to the ones before it.
const TABLE = [
  { speed: 440, gap: [0.95, 0.9], adds: ['bug', 'gpu'] },
  { speed: 520, gap: [0.9, 0.8], adds: ['sign'], note: '429 rate limits ahead' },
  { speed: 600, gap: [0.9, 0.7], adds: ['pair'], note: 'Hallucinations come in pairs now' },
  { speed: 680, gap: [0.85, 0.6], adds: ['drone'], note: 'Flying hallucinations. Stay low.' },
  { speed: 760, gap: [0.85, 0.5], adds: ['triple'], note: 'Hallucinations in threes now' },
  { speed: 840, gap: [0.8, 0.45], adds: [], note: 'Faster' },
  { speed: 900, gap: [0.8, 0.4], adds: [], note: 'Faster' },
].map((level, i, all) => ({ ...level, kinds: all.slice(0, i + 1).flatMap((l) => l.adds) }));

const last = TABLE[TABLE.length - 1];

// Level `i` (0 is level 1), for any i.
export function levelAt(i) {
  if (i < TABLE.length) return TABLE[i];
  const speed = Math.min(MAX_SPEED, last.speed + SPEED_STEP * (i - TABLE.length + 1));
  const before = Math.min(MAX_SPEED, last.speed + SPEED_STEP * (i - TABLE.length));
  const note = speed < MAX_SPEED ? 'Faster' : before < MAX_SPEED ? 'Top speed. Good luck.' : undefined;
  return { ...last, speed, note };
}

// The furthest a run can travel in `seconds`, in world units: as if it ran at
// each level's top speed the whole time. (It never does; speed builds up.)
export function maxDistance(seconds) {
  let distance = 0;
  for (let i = 0; i * LEVEL_EVERY_S < seconds; i++) {
    const span = Math.min(LEVEL_EVERY_S, seconds - i * LEVEL_EVERY_S);
    distance += levelAt(i).speed * span;
  }
  return distance;
}
