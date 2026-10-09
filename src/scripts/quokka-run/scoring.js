// Rules for saving a Quokka Run score. The page checks them before sending and
// the API (src/pages/api/quokka-run/scores.ts) checks them again, so they live
// in one place.
//
// Anyone can post a score with curl, so these can't stop a determined faker.
// They stop the obvious ones: a score the game couldn't produce in the time
// the run took. The limits come from engine.js, and were checked by simulating
// runs of every length at 10 to 240 frames a second: at most 22.5 points a
// second from distance, ~10 from tokens and ~14 from gates, so ~46 in all. A
// gate comes round at most every ~29 seconds (22 between gates, plus 7 to read
// the statement). If you change how points are earned there, check these
// still hold.
const POINTS_PER_SECOND = 60;
const MAX_SECONDS = 4 * 60 * 60;
const GATE_CYCLE_S = 29;

export const NAME_MAX = 16;

// Deliberately short, and matched a word at a time so real names get through
// (the Scunthorpe problem: "Cockburn" is a Perth suburb, and Nazir, Wankowski
// and Shitara are surnames). A few words are blocked at the start of any word,
// the rest only as whole words or with a common ending. Anything that slips
// through gets hidden by hand; see docs/quokka-run.md.
const BLOCKED_START = /^(fuck|cunt|nigg)/i;
const BLOCKED_WORD = /^(shit|bitch|pussy|wank|twat|slut|whore|nazi|hitler)(s|es|er|ers|ing|ed|y|head|face|bag)?$/i;
const rude = (name) => name.split(/[^a-z]+/i).some((word) => BLOCKED_START.test(word) || BLOCKED_WORD.test(word));

// Returns { ok, errors, clean }. `errors` is { field: message }, with `_form`
// for anything that isn't the name.
export function validateScore(body) {
  const b = body || {};
  // Control characters out, runs of spaces squashed, so two names that look
  // the same are the same.
  const cleaned = String(b.name || '')
    .replace(/\p{C}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  // By character, not UTF-16 unit, so an emoji is never cut in half.
  const name = [...cleaned].slice(0, NAME_MAX).join('').trim();
  const [score, correct, rounds, seconds] = [b.score, b.correct, b.rounds, b.seconds].map((n) => Math.round(Number(n)));
  const errors = {};
  if (!name) errors.name = 'Pick a name for the leaderboard';
  else if (rude(name)) errors.name = 'Let’s keep it family friendly';
  const plausible =
    [score, correct, rounds, seconds].every((n) => Number.isFinite(n) && n >= 0) &&
    seconds <= MAX_SECONDS &&
    score <= POINTS_PER_SECOND * seconds + 100 &&
    rounds <= seconds / GATE_CYCLE_S + 1 &&
    correct <= rounds;
  if (!plausible) errors._form = 'That score can’t be saved.';
  return { ok: Object.keys(errors).length === 0, errors, clean: { name, score, correct, rounds, seconds } };
}
