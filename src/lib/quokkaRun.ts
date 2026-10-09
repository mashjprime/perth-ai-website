// Server side of the Quokka Run leaderboard (/quokka-run). See docs/quokka-run.md.
//
// One row per leaderboard name, holding that name's best score. Nothing else
// about the player is stored: no email, no phone, no IP address. The D1
// database is bound as QUOKKA_RUN_DB in wrangler.jsonc.

// @ts-ignore: typed only once `npm run cf-typegen` has been run, which this repo doesn't require.
import { env } from 'cloudflare:workers';

// Just the parts of Cloudflare's D1 types used here, so `npm run check`
// passes without generated Worker types.
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}

interface QuokkaRunEnv {
  QUOKKA_RUN_DB: { prepare(sql: string): D1Statement };
}

export const db = () => (env as unknown as QuokkaRunEnv).QUOKKA_RUN_DB;

// Creates the table the first time each worker instance touches the database,
// so there's no migration step to remember on deploy. A column added later
// needs its own ALTER TABLE here as well (CREATE TABLE IF NOT EXISTS won't add
// it to the live database); see ADDED_COLUMNS in src/lib/ddd2026.ts.
//
//   player      the name, lower-cased: one spot on the board per name
//   name        the name as the player last typed it
//   hidden      1 to keep a name off the board (set by hand, see the docs)
//   updated_at  when this score was set, in UTC. Ties go to whoever got there first
let ready: Promise<unknown> | undefined;
export function ensureSchema() {
  ready ??= db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS scores (
        player TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        rounds INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run()
    // Forget a failed attempt so the next request tries again rather than
    // failing forever on a stale rejection.
    .catch((err: unknown) => {
      ready = undefined;
      throw err;
    });
  return ready;
}

// API routes are served by the Worker, not as static assets, so the headers in
// public/_headers don't apply to them. Set the same ones here.
export const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'SAMEORIGIN',
    },
  });
