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

// The top of the board, plus where `player` (a name the device remembers)
// stands, so someone outside the top 10 can still see their place.
export const GET: APIRoute = async ({ url }) => {
  await ensureSchema();
  // Clamped both ways: SQLite reads a negative LIMIT as "no limit".
  const limit = Math.min(50, Math.max(1, Math.round(Number(url.searchParams.get('limit'))) || 10));
  const { results: top } = await db()
    .prepare(`SELECT name, score FROM scores WHERE hidden = 0 ${ORDER} LIMIT ?`)
    .bind(limit)
    .all();
  const name = (url.searchParams.get('player') ?? '').slice(0, 64);
  const me = name ? await standing(validateScore({ name }).clean.name.toLowerCase()) : null;
  return json({ top, me });
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

  const me = await standing(player);
  return json({ ok: true, improved: saved.meta.changes > 0, best: me?.score ?? score, rank: me?.rank ?? null });
};

// Where a name stands: its best score (which may be an earlier run) and its
// place on the board, matching ORDER. Null if it isn't on the board (never
// saved, or hidden).
async function standing(player: string) {
  if (!player) return null;
  const row = await db()
    .prepare('SELECT name, score, updated_at FROM scores WHERE player = ? AND hidden = 0')
    .bind(player)
    .first<{ name: string; score: number; updated_at: string }>();
  if (!row) return null;
  const rank = await db()
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM scores WHERE hidden = 0
       AND (score > ? OR (score = ? AND (updated_at < ? OR (updated_at = ? AND player < ?))))`
    )
    .bind(row.score, row.score, row.updated_at, row.updated_at, player)
    .first<number>('rank');
  return { name: row.name, score: row.score, rank: rank ?? null };
}
