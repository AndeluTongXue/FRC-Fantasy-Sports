import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { User } from "../../shared/types";
import type { Env } from "./env";
import { SESSION_COOKIE, resolveSession } from "./auth";

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

export function currentUser(c: Context<AppContext>): User {
  return c.get("user");
}
