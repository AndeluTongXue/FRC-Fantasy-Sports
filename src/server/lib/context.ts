import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { User } from "../../shared/types";
import type { Env } from "./env";
import { SESSION_COOKIE, resolveSession } from "./auth";
import { canDeliverEmail } from "./email";

export type AppContext = {
  Bindings: Env;
  Variables: { user: User };
};

/** Rejects the request unless a valid session cookie is present. */
export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await resolveSession(c.env.DB, token) : null;
  if (!user) return c.json({ error: "Not signed in" }, 401);
  c.set("user", user);
  await next();
};

/**
 * Rejects the request unless the session belongs to an admin. Must run after `requireAuth`.
 * Admin gates the sync jobs, which spend our TBA/Statbotics API quota — being signed in is
 * not enough to trigger those.
 */
export const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get("user").isAdmin) return c.json({ error: "Admins only" }, 403);
  await next();
};

/**
 * Rejects the request unless the account's email is confirmed. Must run after `requireAuth`.
 * Deliberately narrow: it guards creating and joining leagues — the actions that put an
 * address in front of other people and that later hang notifications off it — and nothing
 * else, so an unconfirmed account can still sign in and look around.
 */
export const requireVerifiedEmail: MiddlewareHandler<AppContext> = async (c, next) => {
  // The gate only stands where a confirmation link can actually be delivered; see
  // `canDeliverEmail`. Otherwise it degrades to the banner.
  if (!canDeliverEmail(c.env)) return next();

  if (!c.get("user").emailVerified) {
    return c.json({ error: "Confirm your email address first — check your inbox for the link." }, 403);
  }
  await next();
};

export function currentUser(c: Context<AppContext>): User {
  return c.get("user");
}
