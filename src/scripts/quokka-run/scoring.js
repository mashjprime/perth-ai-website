// Rules for saving a Quokka Run score. The page checks them before sending and
// the API (src/pages/api/quokka-run/scores.ts) checks them again, so they live
// in one place.
//
// Anyone can post a score with curl, so these can't stop a determined faker.
// They stop the obvious ones: a score the game couldn't produce in the time
// the run took. A run's best possible score is:
//   distance  a point per 40 units, at most each level's top speed the whole
//             way (difficulty.js), plus a second for rounding
//   tokens    20 each, at most one every 1.4 seconds
//   gates     at most 400 for each one answered right, and a gate comes round
//             at most every ~29 seconds (22 between gates, plus 7 to read)
// If you change how points are earned in engine.js, check these still hold.

import { maxDistance } from './difficulty.js';

const MAX_SECONDS = 60 * 60; // at top speed the best simulated players last about 10 minutes
const GATE_CYCLE_S = 29;
const TOKEN_EVERY_S = 1.4;
const bestPossible = (seconds, correct) =>
  maxDistance(seconds + 1) / 40 + 20 * (seconds / TOKEN_EVERY_S + 2) + 400 * correct + 100;

export const NAME_MAX = 16;
export const EMAIL_MAX = 120;

// Good enough to catch a typo; the real test is whether the winner gets the email.
export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

// Deliberately short, and matched a word at a time so real names get through
// (the Scunthorpe problem: "Cockburn" is a Perth suburb, and Nazir, Wankowski
// and Shitara are surnames). A few words are blocked at the start of any word,
// the rest only as whole words or with a common ending. Anything that slips
// through gets hidden by hand; see docs/quokka-run.md.
const BLOCKED_START = /^(fuck|cunt|nigg)/i;
const BLOCKED_WORD = /^(shit|bitch|pussy|wank|twat|slut|whore|nazi|hitler)(s|es|er|ers|ing|ed|y|head|face|bag)?$/i;
const rude = (name) => name.split(/[^a-z]+/i).some((word) => BLOCKED_START.test(word) || BLOCKED_WORD.test(word));

// Returns { ok, errors, clean }. `errors` is { field: message }, with `_form`
// for anything that isn't a field. `email` is optional (it's only asked for
// while there's a competition on; the API decides whether to keep it).
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
  const email = String(b.email || '').trim();
  if (!name) errors.name = 'Pick a name for the leaderboard';
  else if (rude(name)) errors.name = 'Let’s keep it family friendly';
  if (email && (email.length > EMAIL_MAX || !isEmail(email))) errors.email = 'That email doesn’t look right';
  const plausible =
    [score, correct, rounds, seconds].every((n) => Number.isFinite(n) && n >= 0) &&
    seconds <= MAX_SECONDS &&
    score <= bestPossible(seconds, correct) &&
    rounds <= seconds / GATE_CYCLE_S + 1 &&
    correct <= rounds;
  if (!plausible) errors._form = 'That score can’t be saved.';
  return { ok: Object.keys(errors).length === 0, errors, clean: { name, email, score, correct, rounds, seconds } };
}
