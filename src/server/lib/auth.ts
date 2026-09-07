import type { User } from "../../shared/types";

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "ffs_session";

/** Long enough to survive a slow mail queue or a spam folder found the next morning. */
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
/** Short on purpose: this one hands over the account, so a link sitting in a mailbox
 * (or a browser history, or a forwarded thread) should stop working quickly. */
const RESET_TTL_MS = 60 * 60 * 1000;

export type TokenPurpose = "verify_email" | "password_reset";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** An account that has only ever signed in with Google stores '' here — see 0006. */
export function hasPassword(stored: string | null): boolean {
  return Boolean(stored) && stored!.startsWith("pbkdf2$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!hasPassword(stored)) return false;
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const derived = await deriveBits(password, fromBase64(salt), Number.parseInt(iterations, 10));
  return constantTimeEqual(derived, fromBase64(hash));
}

/** The raw token goes in the cookie; only its digest is stored, so a DB leak can't mint sessions. */
async function digestToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export async function createSession(db: D1Database, userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await digestToken(token), userId, expiresAt, Date.now())
    .run();
  return { token, expiresAt };
}

export async function resolveSession(db: D1Database, token: string): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.is_admin, u.email_verified_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .bind(await digestToken(token))
    .first<{
      id: string;
      email: string;
      display_name: string;
      is_admin: number;
      email_verified_at: number | null;
      expires_at: number;
    }>();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await destroySession(db, token);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    emailVerified: row.email_verified_at !== null,
  };
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(await digestToken(token)).run();
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

/** Signs the account out everywhere. Used on password reset: whoever prompted the reset may
 * already have had a session, and leaving it alive would defeat the point of changing the
 * password at all. */
export async function destroyUserSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

/**
 * Mints a single-use link token. Only the digest is stored, so the raw value exists in the
 * emailed link and nowhere else. Any outstanding token for the same purpose is dropped
 * first: asking for a second reset link should retire the first one, not leave two live.
 */
export async function createAuthToken(
  db: D1Database,
  userId: string,
  email: string,
  purpose: TokenPurpose,
): Promise<{ token: string; expiresAt: number }> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Date.now() + (purpose === "verify_email" ? VERIFY_TTL_MS : RESET_TTL_MS);

  await db.batch([
    db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?").bind(userId, purpose),
    db
      .prepare(
        `INSERT INTO auth_tokens (id, user_id, purpose, email, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(await digestToken(token), userId, purpose, email, expiresAt, Date.now()),
  ]);

  return { token, expiresAt };
}

/**
 * Consumes a token, returning the account it belongs to. Everything that can be wrong —
 * unknown, wrong purpose, expired, already used, or issued to an address the account no
 * longer has — comes back as null, and the caller gives one undifferentiated error, so a
 * token can't be probed for which of those it is.
 */
export async function redeemAuthToken(
  db: D1Database,
  token: string,
  purpose: TokenPurpose,
): Promise<{ userId: string; email: string; displayName: string } | null> {
  if (!token) return null;

  const id = await digestToken(token);
  const row = await db
    .prepare(
      `SELECT t.user_id, t.email, t.expires_at, t.used_at, u.email AS current_email, u.display_name
       FROM auth_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.id = ? AND t.purpose = ?`,
    )
    .bind(id, purpose)
    .first<{
      user_id: string;
      email: string;
      expires_at: number;
      used_at: number | null;
      current_email: string;
      display_name: string;
    }>();

  if (!row) return null;
  if (row.used_at !== null || row.expires_at < Date.now()) return null;
  if (row.current_email !== row.email) return null;

  // Marking used is conditional on it still being unused, so two clicks racing each other
  // (a mail client prefetching the link, say) can't both redeem it.
  const claim = await db
    .prepare("UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(Date.now(), id)
    .run();
  if (claim.meta.changes !== 1) return null;

  return { userId: row.user_id, email: row.email, displayName: row.display_name };
}

export async function pruneAuthTokens(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM auth_tokens WHERE expires_at < ?").bind(Date.now()).run();
}
