-- Three hardening changes:
--   1. An explicit admin flag. `/api/admin/*` used to accept any signed-in account, which
--      let any user trigger unbounded TBA/Statbotics syncs against our API keys.
--   2. Failed sign-in counters, so password guessing can be rate limited.
--   3. A per-league timestamp backing the refresh-scores cooldown.

-- Set directly in D1 (see README) — deliberately not settable through the app, so there's
-- no "first account wins" race on a fresh deploy.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- One row per throttle key: 'email:<address>' or 'ip:<address>'. Rows are pruned by cron.
CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

ALTER TABLE leagues ADD COLUMN last_score_sync_at INTEGER;
