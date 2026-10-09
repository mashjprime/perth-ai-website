// The Quokka Run leaderboard (/quokka-run). One spot per name, at its best score.
import type { APIRoute } from 'astro';
import { db, ensureSchema, json } from '../../../lib/quokkaRun';
// Plain JS shared with the page, so both apply the same rules.
import { validateScore } from '../../../scripts/quokka-run/scoring.js';

export const prerender = false;

// Anyone can post a score, so this stops a script filling the board with
// thousands of names. A community site gets nowhere near it; if real players
// ever do, raise it.
const MAX_SAVES_PER_MINUTE = 30;

const ORDER = 'ORDER BY score DESC, updated_at ASC, player ASC';

export const GET: APIRoute = async ({ url }) => {
  await ensureSchema();
  // Clamped both ways: SQLite reads a negative LIMIT as "no limit".
  const limit = Math.min(50, Math.max(1, Math.round(Number(url.searchParams.get('limit'))) || 10));
  const { results } = await db()
    .prepare(`SELECT name, score FROM scores WHERE hidden = 0 ${ORDER} LIMIT ?`)
    .bind(limit)
    .all();
  return json(results);
};

// Saves a run if it beats the best under that name, and says where the name stands.
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  const { ok, errors, clean } = validateScore(body);
  if (!ok) return json({ errors }, 400);
  const { name, score, correct, rounds } = clean;
  // Lower-cased here, not with SQLite's lower(), which only handles A to Z.
  const player = name.toLowerCase();

  await ensureSchema();

  const recent = await db()
    .prepare(`SELECT COUNT(*) AS n FROM scores WHERE updated_at > datetime('now', '-1 minute')`)
    .first<number>('n');
  if ((recent ?? 0) >= MAX_SAVES_PER_MINUTE) {
    return json({ errors: { _form: 'The leaderboard is busy. Try saving again in a minute.' } }, 503);
  }

  const saved = await db()
    .prepare(
      `INSERT INTO scores (player, name, score, correct, rounds) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (player) DO UPDATE SET
         name = excluded.name, score = excluded.score, correct = excluded.correct,
         rounds = excluded.rounds, updated_at = datetime('now')
       WHERE excluded.score > scores.score`
    )
    .bind(player, name, score, correct, rounds)
    .run();

  // Where the name stands now: its best (which may be an earlier run) and its
  // place on the board. No rank if the name has been hidden.
  const best = await db()
    .prepare('SELECT score, hidden, updated_at FROM scores WHERE player = ?')
    .bind(player)
    .first<{ score: number; hidden: number; updated_at: string }>();
  const rank =
    best && !best.hidden
      ? await db()
          .prepare(
            `SELECT COUNT(*) + 1 AS rank FROM scores WHERE hidden = 0
             AND (score > ? OR (score = ? AND (updated_at < ? OR (updated_at = ? AND player < ?))))`
          )
          .bind(best.score, best.score, best.updated_at, best.updated_at, player)
          .first<number>('rank')
      : null;

  return json({ ok: true, improved: saved.meta.changes > 0, best: best?.score ?? score, rank });
};
