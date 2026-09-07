import type { DraftRoom } from "../durable-objects/DraftRoom";

export interface Env {
  DB: D1Database;
  DRAFT_ROOM: DurableObjectNamespace<DraftRoom>;
  ASSETS: Fetcher;
  /** Season the app is currently serving, e.g. "2026". */
  SEASON_YEAR: string;
  /** Secret: set via `wrangler secret put TBA_API_KEY` (or .dev.vars locally). */
  TBA_API_KEY: string;
  /** Secret: set via `wrangler secret put RESEND_API_KEY`. Unset means account email is
   * captured in D1 instead of sent — fine locally, broken in production. */
  RESEND_API_KEY?: string;
  /** From address for account email, e.g. "FRC Fantasy <no-reply@yourdomain.com>". Must be
   * on a domain verified with Resend. */
  EMAIL_FROM?: string;
  /** Origin the emailed links point at. Set it in production; see `appUrl`. */
  APP_URL?: string;
  /** OAuth client from the Google Cloud console. The id is public (it ends up in the
   * redirect URL); the secret is a secret. Both unset means the Google button is hidden and
   * the routes 404, so the app still runs without them. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "1" exposes GET /api/auth/dev/outbox, which reads back the mail that would have been
   * sent. Local development only — never set this on a deploy. */
  EMAIL_DEV_OUTBOX?: string;
}

export function seasonYear(env: Env): number {
  const parsed = Number.parseInt(env.SEASON_YEAR, 10);
  return Number.isFinite(parsed) ? parsed : new Date().getUTCFullYear();
}
