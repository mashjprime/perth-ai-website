// The Quokka Run leaderboard (/quokka-run). One spot per name, at its best score.
import type { APIRoute } from 'astro';
import { competitionOpen, db, ensureSchema, json } from '../../../lib/quokkaRun';
// Plain JS shared with the page, so both apply the same rules.
import { validateScore } from '../../../scripts/quokka-run/scoring.js';

export const prerender = false;

// Anyone can post a score, so this stops a script filling the board with
// thousands of names. A community site gets nowhere near it; if real players
// ever do, raise it.
const MAX_SAVES_PER_MINUTE = 30;

const ORDER = 'ORDER BY score DESC, updated_at ASC, player ASC';

// Where a name stands: its best score (which may be an earlier run) and its
// place on the board, matching ORDER. No row if it isn't on the board (never
// saved, or hidden).
const STANDING = `
  SELECT s.name, s.score, (
    SELECT COUNT(*) + 1 FROM scores o WHERE o.hidden = 0 AND (
      o.score > s.score OR (o.score = s.score AND (
        o.updated_at < s.updated_at OR (o.updated_at = s.updated_at AND o.player < s.player)
      ))
    )
  ) AS rank
  FROM scores s WHERE s.player = ? AND s.hidden = 0`;

type Standing = { name: string; score: number; rank: number };

// The top of the board, plus where `player` (a name the device remembers)
// stands, so someone outside the top 10 can still see their place.
export const GET: APIRoute = async ({ url }) => {
  await ensureSchema();
  // Clamped both ways: SQLite reads a negative LIMIT as "no limit".
  const limit = Math.min(50, Math.max(1, Math.round(Number(url.searchParams.get('limit'))) || 10));
  const player = validateScore({ name: (url.searchParams.get('player') ?? '').slice(0, 64) }).clean.name.toLowerCase();
  const [top, me] = await db().batch([
    db().prepare(`SELECT name, score FROM scores WHERE hidden = 0 ${ORDER} LIMIT ?`).bind(limit),
    db().prepare(STANDING).bind(player),
  ]);
  return json({ top: top.results, me: (player && (me.results[0] as Standing)) || null });
};

// Saves a run if it beats the best under that name, and says where the name
// stands. With an email while a competition is open, it's also an entry.
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  const { ok, errors, clean } = validateScore(body);
  if (!ok) return json({ errors }, 400);
  const { name, score, correct, rounds } = clean;
  // Lower-cased here, not with SQLite's lower(), which only handles A to Z.
  const player = name.toLowerCase();
  const email = clean.email.toLowerCase();
  const entering = Boolean(email) && competitionOpen();

  await ensureSchema();

  const recent = await db()
    .prepare(`SELECT COUNT(*) AS n FROM scores WHERE updated_at > datetime('now', '-1 minute')`)
    .first<number>('n');
  if ((recent ?? 0) >= MAX_SAVES_PER_MINUTE) {
    return json({ errors: { _form: 'The leaderboard is busy. Try saving again in a minute.' } }, 503);
  }

  // One round trip. D1 runs a batch in order, in one transaction, so the
  // reads see the writes before them.
  const statements = [
    db()
      .prepare(
        `INSERT INTO scores (player, name, score, correct, rounds) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (player) DO UPDATE SET
           name = excluded.name, score = excluded.score, correct = excluded.correct,
           rounds = excluded.rounds, updated_at = datetime('now')
         WHERE excluded.score > scores.score`
      )
      .bind(player, name, score, correct, rounds),
    db().prepare(STANDING).bind(player),
  ];
  // A competition entry is per email, at the best score saved with it (under
  // whatever name), so nobody can take over someone else's entry by using the
  // same name.
  if (entering) {
    statements.push(
      db()
        .prepare(
          `INSERT INTO competition_entries (email, player, name, score) VALUES (?, ?, ?, ?)
           ON CONFLICT (email) DO UPDATE SET
             player = excluded.player, name = excluded.name, score = excluded.score, updated_at = datetime('now')
           WHERE excluded.score > competition_entries.score`
        )
        .bind(email, player, name, score),
      db().prepare('SELECT score FROM competition_entries WHERE email = ?').bind(email)
    );
  }
  const [saved, standing, , entry] = await db().batch(statements);
  const me = standing.results[0] as Standing | undefined;

  return json({
    ok: true,
    improved: saved.meta.changes > 0,
    best: me?.score ?? score,
    rank: me?.rank ?? null,
    // The best score entered with this email, or null if it isn't an entry.
    entry: entering ? ((entry?.results[0] as { score: number } | undefined)?.score ?? null) : null,
    // An email came in, but the competition isn't taking entries.
    closed: Boolean(email) && !entering,
  });
};
