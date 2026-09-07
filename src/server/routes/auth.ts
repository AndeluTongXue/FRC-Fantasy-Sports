import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppContext } from "../lib/context";
import { requireAuth } from "../lib/context";
import {
  SESSION_COOKIE,
  createAuthToken,
  createSession,
  destroySession,
  destroyUserSessions,
  hashPassword,
  redeemAuthToken,
  sessionCookie,
  verifyPassword,
} from "../lib/auth";
import type { TokenPurpose } from "../lib/auth";
import {
  EmailError,
  appUrl,
  canDeliverEmail,
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "../lib/email";
import type { Env } from "../lib/env";
import {
  HANDSHAKE_TTL_SECONDS,
  OAUTH_COOKIE,
  OAuthError,
  decodeHandshake,
  encodeHandshake,
  exchangeGoogleCode,
  googleConfigured,
  handshakeCookie,
  startGoogleAuth,
} from "../lib/oauth";
import {
  clearThrottle,
  emailSendThrottleKeys,
  loginThrottleKeys,
  recordThrottleHit,
  throttleRetryAfter,
  waitLabel,
} from "../lib/throttle";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export const authRoutes = new Hono<AppContext>();

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  is_admin: number;
  email_verified_at: number | null;
}

function toUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    emailVerified: row.email_verified_at !== null,
  };
}

/** Mints a link token and mails it. Throwing rather than swallowing, so a caller that can
 * usefully tell the user "that didn't send" gets the chance to. */
async function mailLink(
  env: Env,
  requestUrl: string,
  user: { id: string; email: string; displayName: string },
  purpose: TokenPurpose,
): Promise<void> {
  const { token } = await createAuthToken(env.DB, user.id, user.email, purpose);
  const path = purpose === "verify_email" ? "verify-email" : "reset-password";
  const link = `${appUrl(env, requestUrl)}/${path}?token=${encodeURIComponent(token)}`;

  await sendEmail(
    env,
    purpose === "verify_email"
      ? verificationEmail(user.email, user.displayName, link)
      : passwordResetEmail(user.email, user.displayName, link),
  );
}

authRoutes.post("/signup", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; displayName?: string }>();
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const displayName = body.displayName?.trim() ?? "";

  if (!EMAIL_PATTERN.test(email)) return c.json({ error: "Enter a valid email address" }, 400);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
  }
  if (displayName.length < 2) return c.json({ error: "Display name must be at least 2 characters" }, 400);

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return c.json({ error: "An account with that email already exists" }, 409);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, email, displayName, await hashPassword(password), Date.now())
    .run();

  // The account is real and signed in whether or not the mail goes out. A provider outage
  // shouldn't cost someone their signup when the banner's resend button can retry it.
  let emailSent = true;
  try {
    await mailLink(c.env, c.req.url, { id, email, displayName }, "verify_email");
  } catch (caught) {
    emailSent = false;
    console.error("Could not send the confirmation email", caught);
  }

  const { token, expiresAt } = await createSession(c.env.DB, id);
  c.header("Set-Cookie", sessionCookie(token, Math.floor((expiresAt - Date.now()) / 1000)));
  return c.json({ user: { id, email, displayName, isAdmin: false, emailVerified: false }, emailSent }, 201);
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  // Checked before the lookup and the (deliberately expensive) hash verify, so a locked-out
  // attacker can't keep burning CPU.
  const throttleKeys = loginThrottleKeys(c.req.header("CF-Connecting-IP"), email);
  const retryAfter = await throttleRetryAfter(c.env.DB, throttleKeys);
  if (retryAfter !== null) {
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: `Too many sign-in attempts. Try again in ${waitLabel(retryAfter)}.` }, 429);
  }

  const row = await c.env.DB.prepare(
    "SELECT id, email, display_name, is_admin, email_verified_at, password_hash FROM users WHERE email = ?",
  )
    .bind(email)
    .first<UserRow & { password_hash: string }>();

  if (!row || !(await verifyPassword(password, row.password_hash))) {
    await recordThrottleHit(c.env.DB, throttleKeys);
    return c.json({ error: "Incorrect email or password" }, 401);
  }

  await clearThrottle(c.env.DB, `email:${email}`);
  const { token, expiresAt } = await createSession(c.env.DB, row.id);
  c.header("Set-Cookie", sessionCookie(token, Math.floor((expiresAt - Date.now()) / 1000)));
  return c.json({ user: toUser(row) });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(c.env.DB, token);
  c.header("Set-Cookie", sessionCookie("", 0));
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

/** Confirms an address from the emailed link. Signing in isn't required — these get clicked
 * from a phone that was never signed in. */
authRoutes.post("/verify-email", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
  const claim = await redeemAuthToken(c.env.DB, body.token ?? "", "verify_email");
  if (!claim) {
    return c.json({ error: "That confirmation link is invalid or has expired. Request a new one." }, 400);
  }

  await c.env.DB.prepare("UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL")
    .bind(Date.now(), claim.userId)
    .run();

  return c.json({ ok: true, email: claim.email });
});

authRoutes.post("/resend-verification", requireAuth, async (c) => {
  const user = c.get("user");
  if (user.emailVerified) return c.json({ ok: true, alreadyVerified: true });

  const keys = emailSendThrottleKeys(c.req.header("CF-Connecting-IP"), user.email);
  const retryAfter = await throttleRetryAfter(c.env.DB, keys);
  if (retryAfter !== null) {
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: `Too many emails requested. Try again in ${waitLabel(retryAfter)}.` }, 429);
  }
  await recordThrottleHit(c.env.DB, keys);

  try {
    await mailLink(c.env, c.req.url, user, "verify_email");
  } catch (caught) {
    console.error("Could not resend the confirmation email", caught);
    if (caught instanceof EmailError) {
      return c.json({ error: "We couldn't send that email just now. Try again in a few minutes." }, 502);
    }
    throw caught;
  }

  return c.json({ ok: true });
});

/**
 * Always answers the same way, whether or not the address has an account — anything else
 * turns this route into a way to test which addresses are registered.
 */
authRoutes.post("/forgot-password", async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = body.email?.trim().toLowerCase() ?? "";
  const ok = { ok: true, message: "If that address has an account, a reset link is on its way." };

  // No delivery path means no reset. Saying so is better than the generic success message,
  // which would be a promise this deploy can't keep.
  if (!canDeliverEmail(c.env)) {
    return c.json({ error: "Password reset is unavailable on this deployment. Sign in with Google instead." }, 503);
  }

  if (!EMAIL_PATTERN.test(email)) return c.json(ok);

  // Rate limited on the address the *caller typed*, which is the address we would mail — an
  // unlimited version is a way to make us bury a stranger's inbox.
  const keys = emailSendThrottleKeys(c.req.header("CF-Connecting-IP"), email);
  const retryAfter = await throttleRetryAfter(c.env.DB, keys);
  if (retryAfter !== null) {
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: `Too many reset emails requested. Try again in ${waitLabel(retryAfter)}.` }, 429);
  }
  await recordThrottleHit(c.env.DB, keys);

  const row = await c.env.DB.prepare("SELECT id, email, display_name FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string; display_name: string }>();

  if (row) {
    try {
      await mailLink(
        c.env,
        c.req.url,
        { id: row.id, email: row.email, displayName: row.display_name },
        "password_reset",
      );
    } catch (caught) {
      // Still answered as success: surfacing the failure would reveal that the address exists.
      console.error("Could not send the password reset email", caught);
    }
  }

  return c.json(ok);
});

authRoutes.post("/reset-password", async (c) => {
  const body = await c.req
    .json<{ token?: string; password?: string }>()
    .catch(() => ({}) as { token?: string; password?: string });
  const password = body.password ?? "";

  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
  }

  const claim = await redeemAuthToken(c.env.DB, body.token ?? "", "password_reset");
  if (!claim) {
    return c.json({ error: "That reset link is invalid or has expired. Request a new one." }, 400);
  }

  // Redeeming the link proves control of the mailbox, which is exactly what confirmation
  // proves — so a reset confirms the address too. That keeps "I never got the confirmation
  // email" from being a dead end.
  await c.env.DB.prepare(
    "UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?",
  )
    .bind(await hashPassword(password), Date.now(), claim.userId)
    .run();

  // Whoever prompted the reset may already be signed in somewhere; changing the password
  // means nothing if their session outlives it.
  await destroyUserSessions(c.env.DB, claim.userId);
  await clearThrottle(c.env.DB, `email:${claim.email}`);

  const row = await c.env.DB.prepare(
    "SELECT id, email, display_name, is_admin, email_verified_at FROM users WHERE id = ?",
  )
    .bind(claim.userId)
    .first<UserRow>();
  if (!row) return c.json({ error: "That account no longer exists" }, 400);

  const { token, expiresAt } = await createSession(c.env.DB, row.id);
  c.header("Set-Cookie", sessionCookie(token, Math.floor((expiresAt - Date.now()) / 1000)));
  return c.json({ user: toUser(row) });
});

/**
 * Reads back the mail that would have been sent, for local development and the smoke script.
 * Off unless `EMAIL_DEV_OUTBOX=1`, which belongs in .dev.vars and nowhere else — on a deploy
 * it would hand anyone a reset link for any address. `outbound_emails` is only written when
 * no provider is configured, so this returns nothing once RESEND_API_KEY is set.
 */
authRoutes.get("/dev/outbox", async (c) => {
  if (c.env.EMAIL_DEV_OUTBOX !== "1") return c.json({ error: "Not found" }, 404);

  const email = c.req.query("email")?.trim().toLowerCase() ?? "";
  const row = await c.env.DB.prepare(
    // rowid breaks ties: two mails to one address inside the same millisecond (signup
    // immediately followed by a resend) would otherwise come back in either order.
    "SELECT subject, body, created_at FROM outbound_emails WHERE to_email = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  )
    .bind(email)
    .first<{ subject: string; body: string; created_at: number }>();

  if (!row) return c.json({ error: "No captured email for that address" }, 404);
  return c.json({ subject: row.subject, body: row.body, createdAt: row.created_at });
});

// ── Sign in with Google ─────────────────────────────────────────────────────────────────

/** Lets the sign-in pages hide what this deploy can't actually do: the Google button with no
 * OAuth client, and the password-reset link with no way to deliver the email. */
authRoutes.get("/providers", (c) =>
  c.json({ google: googleConfigured(c.env), passwordReset: canDeliverEmail(c.env) }),
);

authRoutes.get("/google/start", async (c) => {
  if (!googleConfigured(c.env)) return c.json({ error: "Google sign-in isn't configured" }, 404);

  const { url, handshake } = await startGoogleAuth(c.env, appUrl(c.env, c.req.url));
  c.header("Set-Cookie", handshakeCookie(encodeHandshake(handshake), HANDSHAKE_TTL_SECONDS));
  return c.redirect(url, 302);
});

/** Google sends the browser here. Failures redirect to the sign-in page with a message
 * rather than returning JSON — this is a top-level navigation, not a fetch. */
authRoutes.get("/google/callback", async (c) => {
  if (!googleConfigured(c.env)) return c.json({ error: "Google sign-in isn't configured" }, 404);

  const origin = appUrl(c.env, c.req.url);
  const fail = (reason: string) => {
    c.header("Set-Cookie", handshakeCookie("", 0));
    return c.redirect(`${origin}/login?oauthError=${encodeURIComponent(reason)}`, 302);
  };

  if (c.req.query("error")) return fail("Google sign-in was cancelled.");

  const handshake = decodeHandshake(getCookie(c, OAUTH_COOKIE));
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";

  // No cookie usually means the handshake expired or third-party cookies were cleared
  // mid-flow; a mismatch means the callback didn't originate from our own redirect.
  if (!handshake || !state || state !== handshake.state) {
    return fail("That sign-in link expired. Try again.");
  }
  if (!code) return fail("Google didn't return an authorization code.");

  let identity;
  try {
    identity = await exchangeGoogleCode(c.env, origin, code, handshake.verifier);
  } catch (caught) {
    console.error("Google sign-in failed", caught);
    return fail(
      caught instanceof OAuthError && caught.message.includes("isn't verified")
        ? "That Google account's email address isn't verified."
        : "Google sign-in failed. Try again.",
    );
  }

  const now = Date.now();
  let row = await c.env.DB.prepare(
    "SELECT id, email, display_name, is_admin, email_verified_at FROM users WHERE google_sub = ?",
  )
    .bind(identity.sub)
    .first<UserRow>();

  if (!row) {
    // Link to an existing password account on the address Google just vouched for. Only when
    // that account isn't already tied to a different Google account, which shouldn't be
    // possible but shouldn't silently overwrite if it were.
    const existing = await c.env.DB.prepare(
      "SELECT id, email, display_name, is_admin, email_verified_at, google_sub FROM users WHERE email = ?",
    )
      .bind(identity.email)
      .first<UserRow & { google_sub: string | null }>();

    if (existing && existing.google_sub && existing.google_sub !== identity.sub) {
      return fail("That email is already linked to a different Google account.");
    }

    if (existing) {
      await c.env.DB.prepare(
        "UPDATE users SET google_sub = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?",
      )
        .bind(identity.sub, now, existing.id)
        .run();
      row = { ...existing, email_verified_at: existing.email_verified_at ?? now };
    } else {
      // '' for password_hash: this account has no password and can't be signed into with one.
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, display_name, password_hash, google_sub, email_verified_at, created_at)
         VALUES (?, ?, ?, '', ?, ?, ?)`,
      )
        .bind(id, identity.email, identity.name, identity.sub, now, now)
        .run();
      row = {
        id,
        email: identity.email,
        display_name: identity.name,
        is_admin: 0,
        email_verified_at: now,
      };
    }
  }

  const { token, expiresAt } = await createSession(c.env.DB, row.id);
  c.header("Set-Cookie", handshakeCookie("", 0));
  c.header("Set-Cookie", sessionCookie(token, Math.floor((expiresAt - Date.now()) / 1000)), { append: true });
  return c.redirect(`${origin}/`, 302);
});
