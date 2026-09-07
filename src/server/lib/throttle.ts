/**
 * A shared fixed-window counter, keyed by an arbitrary string. Fixed window: the counter
 * resets WINDOW_MS after the first hit in a run.
 *
 * Two things ride on it — failed sign-ins (below) and outbound account email, which is
 * rate limited for a different reason: those routes make us send mail to an address the
 * caller typed, so an unlimited one is a way to use us to spam a stranger.
 *
 * Both live in the `login_attempts` table, which predates the second use — the key prefix
 * is what separates them.
 */
const WINDOW_MS = 15 * 60 * 1000;

/** Guards one account against password guessing. */
const MAX_FAILURES_PER_EMAIL = 10;

/** Guards the whole app against one host spraying many accounts. Deliberately looser —
 * a shared NAT can legitimately produce several bad passwords in a window. */
const MAX_FAILURES_PER_IP = 50;

/** Enough for "it didn't arrive, send it again" a few times over; not enough to bury
 * someone's inbox. */
const MAX_EMAILS_PER_ADDRESS = 5;
const MAX_EMAILS_PER_IP = 20;

export interface ThrottleKey {
  key: string;
  limit: number;
}

/**
 * Only `CF-Connecting-IP` is trusted: Cloudflare sets it at the edge and a client can't
 * forge it. `X-Forwarded-For` is client-supplied, so honouring it would let an attacker
 * rotate the header to sidestep the per-IP limit entirely. Absent locally (`wrangler dev`
 * doesn't set it), in which case only the per-email counter applies.
 */
export function loginThrottleKeys(clientIp: string | undefined, email: string): ThrottleKey[] {
  const keys: ThrottleKey[] = [{ key: `email:${email}`, limit: MAX_FAILURES_PER_EMAIL }];
  if (clientIp) keys.push({ key: `ip:${clientIp}`, limit: MAX_FAILURES_PER_IP });
  return keys;
}

/** Caps how often a confirmation or reset link can be mailed to one address, and how many
 * distinct addresses one host can aim them at. */
export function emailSendThrottleKeys(clientIp: string | undefined, email: string): ThrottleKey[] {
  const keys: ThrottleKey[] = [{ key: `mail:${email}`, limit: MAX_EMAILS_PER_ADDRESS }];
  if (clientIp) keys.push({ key: `mailip:${clientIp}`, limit: MAX_EMAILS_PER_IP });
  return keys;
}

/** Seconds the caller must wait, or null when the attempt may proceed. */
export async function throttleRetryAfter(db: D1Database, keys: ThrottleKey[]): Promise<number | null> {
  const now = Date.now();
  const { results } = await db
    .prepare(`SELECT key, failures, window_start FROM login_attempts WHERE key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys.map((entry) => entry.key))
    .all<{ key: string; failures: number; window_start: number }>();

  let retryAfter = 0;
  for (const row of results) {
    const limit = keys.find((entry) => entry.key === row.key)?.limit;
    if (limit === undefined) continue;
    if (now - row.window_start >= WINDOW_MS) continue; // stale window; the next failure resets it
    if (row.failures < limit) continue;
    retryAfter = Math.max(retryAfter, Math.ceil((row.window_start + WINDOW_MS - now) / 1000));
  }
  return retryAfter > 0 ? retryAfter : null;
}

export async function recordThrottleHit(db: D1Database, keys: ThrottleKey[]): Promise<void> {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  await db.batch(
    keys.map(({ key }) =>
      db
        .prepare(
          `INSERT INTO login_attempts (key, failures, window_start) VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET
             failures = CASE WHEN login_attempts.window_start < ? THEN 1 ELSE login_attempts.failures + 1 END,
             window_start = CASE WHEN login_attempts.window_start < ? THEN ? ELSE login_attempts.window_start END`,
        )
        .bind(key, now, cutoff, cutoff, now),
    ),
  );
}

/** Clearing needs the correct password for that address, so it can't be used to reset
 * someone else's counter. The per-IP counter is intentionally left alone. */
export async function clearThrottle(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

export async function pruneThrottleAttempts(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE window_start < ?").bind(Date.now() - WINDOW_MS).run();
}

export function waitLabel(seconds: number): string {
  return seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}
