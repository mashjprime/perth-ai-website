// Rules for saving a Quokka Run score. The page checks them before sending and
// the API (src/pages/api/quokka-run/scores.ts) checks them again, so they live
// in one place.
//
// Anyone can post a score with curl, so these can't stop a determined faker.
// They stop the obvious ones: a score the game couldn't produce in the time
// the run took. The limits come from engine.js: at most ~23 points a second
// from distance, ~14 from tokens and ~19 from gates. If you change how points
// are earned there, check these still hold.
const POINTS_PER_SECOND = 60;
const MAX_SECONDS = 4 * 60 * 60;
const GATE_EVERY_S = 22;

export const NAME_MAX = 16;

// Deliberately short (Scunthorpe problem: "Cockburn" is a Perth suburb).
// Anything else gets hidden by hand; see docs/quokka-run.md.
const BLOCKED_WORDS = /fuck|shit|cunt|nigg|bitch|pussy|wank|twat|slut|whore|nazi|hitler/i;

// Returns { ok, errors, clean }. `errors` is { field: message }, with `_form`
// for anything that isn't the name.
export function validateScore(body) {
  const b = body || {};
  // Control characters out, runs of spaces squashed, so two names that look
  // the same are the same.
  const name = String(b.name || '')
    .replace(/\p{C}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  const [score, correct, rounds, seconds] = [b.score, b.correct, b.rounds, b.seconds].map((n) => Math.round(Number(n)));
  const errors = {};
  if (!name) errors.name = 'Pick a name for the leaderboard';
  else if (BLOCKED_WORDS.test(name.replace(/[^a-z]/gi, ''))) errors.name = 'Let’s keep it family friendly';
  const plausible =
    [score, correct, rounds, seconds].every((n) => Number.isFinite(n) && n >= 0) &&
    seconds <= MAX_SECONDS &&
    score <= POINTS_PER_SECOND * seconds + 100 &&
    rounds <= seconds / GATE_EVERY_S + 1 &&
    correct <= rounds;
  if (!plausible) errors._form = 'That score can’t be saved.';
  return { ok: Object.keys(errors).length === 0, errors, clean: { name, score, correct, rounds, seconds } };
}
