import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppContext } from "../lib/context";
import { requireAuth } from "../lib/context";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  hashPassword,
  sessionCookie,
  verifyPassword,
} from "../lib/auth";
import {
  clearLoginFailures,
  loginRetryAfter,
  loginThrottleKeys,
  recordLoginFailure,
  waitLabel,
} from "../lib/throttle";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export const authRoutes = new Hono<AppContext>();

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

  const { token, expiresAt } = await createSession(c.env.DB, id);
  c.header("Set-Cookie", sessionCookie(token, Math.floor((expiresAt - Date.now()) / 1000)));
  return c.json({ user: { id, email, displayName, isAdmin: false } }, 201);
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  // Checked before the lookup and the (deliberately expensive) hash verify, so a locked-out
  // attacker can't keep burning CPU.
  const throttleKeys = loginThrottleKeys(c.req.header("CF-Connecting-IP"), email);
  const retryAfter = await loginRetryAfter(c.env.DB, throttleKeys);
  if (retryAfter !== null) {
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: `Too many sign-in attempts. Try again in ${waitLabel(retryAfter)}.` }, 429);
  }

  const row = await c.env.DB.prepare(
    "SELECT id, email, display_name, is_admin, password_hash FROM users WHERE email = ?",
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      display_name: string;
      is_admin: number;
      password_hash: string;
    }>();

  if (!row || !(await verifyPassword(password, row.password_hash))) {
    await recordLoginFailure(c.env.DB, throttleKeys);
    return c.json({ error: "Incorrect email or password" }, 401);
  }

  await clearLoginFailures(c.env.DB, `email:${email}`);
  const { token, expiresAt } = await createSession(c.env.DB, row.id);
  c.header("Set-Cookie", sessionCookie(token, Math.floor((expiresAt - Date.now()) / 1000)));
  return c.json({
    user: { id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin === 1 },
  });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(c.env.DB, token);
  c.header("Set-Cookie", sessionCookie("", 0));
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));
