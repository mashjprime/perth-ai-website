# Quokka Run (`/quokka-run`)

The one-tap runner from our DDD Perth 2026 booth, kept on the site for good. Jump the
hallucinations, GPU fires and 429s; at each gate, jump through for FACT or run under for
HALLUCINATION. The homepage links to it from the "Perth AI arcade" card.

It's the site's one permanent server-side feature: a canvas game needs client JavaScript, and the
leaderboard needs an API and a database. Everything else on the site is still static.

## What's where

| To change… | Edit… |
| --- | --- |
| Gate statements | `src/data/quokkaRunStatements.json` |
| Speed, gates, scoring, difficulty, obstacles | Constants at the top of `src/scripts/quokka-run/engine.js` |
| Which scores are accepted | `src/scripts/quokka-run/scoring.js` (the API uses it too) |
| The page, its copy and every screen's markup | `src/pages/quokka-run.astro` |
| What happens on each screen | `src/scripts/quokka-run/game.js` |
| Pixel art | `src/scripts/quokka-run/sprites.js` |
| The homepage card and its quokka | `src/pages/index.astro`, `src/components/QuokkaSprite.astro` |
| Leaderboard API | `src/pages/api/quokka-run/scores.ts` |
| Database table | `src/lib/quokkaRun.ts` |

Some things to know before editing:

- **Statements:** each has a `topic`, a `level` (1 easy, 2 medium, 3 hard), the `text`, whether
  it's a `fact`, and a `why` shown after answering. Statements sharing a topic never appear in the
  same run, so a true/false pair can't give each other away. Check facts before adding them: the
  `why` is shown as the answer.
- **Scoring and the plausibility check go together.** `scoring.js` refuses a score the game
  couldn't have produced in the time the run took (about 60 points a second at most). Make points
  easier to earn in `engine.js` and you may need to raise that limit, or real scores get refused.
- **The kiosk has its own copy.** `public/ddd-2026/` still has the original game for the booth. The
  two don't share code, so a change here doesn't reach the kiosk, and the kiosk can be deleted
  without touching this.

## The leaderboard

- **One spot per name,** at its best score. Names are matched ignoring case, so "Sam" and "sam"
  share a spot. A lower score under a name changes nothing; a higher one replaces it.
- **Only the name is stored,** with the score, gates right and gates reached. No email, phone or IP
  address. That's deliberate: there's nothing personal to look after.
- **Anyone can post a score,** so the API guards against the obvious abuse: implausible scores are
  refused, a short list of rude words is blocked, and it stops accepting saves for a minute once 30
  have landed in the last minute. A determined faker can still post a believable score. If that
  happens, hide it (below).

The database is Cloudflare D1, `perth-ai-quokka-run`, bound as `QUOKKA_RUN_DB` in
`wrangler.jsonc`. Like the kiosk's database, Wrangler creates it on the first deploy, and the API
creates its table on first use. If that deploy fails on the D1 step, create it by hand and paste the
id it prints into `wrangler.jsonc` as `database_id`:

```bash
npx wrangler d1 create perth-ai-quokka-run
```

### Hiding a name

There's no admin page. Hide a name with Wrangler (the name in lower case):

```bash
npx wrangler d1 execute perth-ai-quokka-run --remote --command "UPDATE scores SET hidden = 1 WHERE player = 'the name'"
```

A hidden name stays hidden, even if it's saved again. To see the board, including hidden names:

```bash
npx wrangler d1 execute perth-ai-quokka-run --remote --command "SELECT * FROM scores ORDER BY score DESC LIMIT 50"
```

To clear the whole board (a new season, say), `DELETE FROM scores` the same way.

## Testing locally

```bash
npm run preview
```

Then open http://127.0.0.1:8787/quokka-run/. `npm run dev` serves the page and the game, but not
the database, so the leaderboard shows "back shortly" and saving fails. The local database lives in
`.wrangler/` and has nothing to do with the real one.
