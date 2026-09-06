export interface Env {
  DB: D1Database;
  DRAFT_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Season the app is currently serving, e.g. "2026". */
  SEASON_YEAR: string;
  /** Secret: set via `wrangler secret put TBA_API_KEY` (or .dev.vars locally). */
  TBA_API_KEY: string;
}

export function seasonYear(env: Env): number {
  const parsed = Number.parseInt(env.SEASON_YEAR, 10);
  return Number.isFinite(parsed) ? parsed : new Date().getUTCFullYear();
}
