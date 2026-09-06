import { Hono } from "hono";
import type { AppContext } from "./lib/context";
import type { Env } from "./lib/env";
import { seasonYear } from "./lib/env";
import { recomputeLeagueScores } from "./lib/scores";
import { activeEventKeys, syncEventResults, syncEvents } from "./lib/sync";
import { TbaError } from "./lib/tba";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { eventRoutes } from "./routes/events";
import { leagueRoutes } from "./routes/leagues";
import { teamRoutes } from "./routes/teams";

export { DraftRoom } from "./durable-objects/DraftRoom";

const app = new Hono<AppContext>();

app.route("/api/auth", authRoutes);
app.route("/api/teams", teamRoutes);
app.route("/api/events", eventRoutes);
app.route("/api/leagues", leagueRoutes);
app.route("/api/admin", adminRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((error, c) => {
  if (error instanceof TbaError) {
    const message =
      error.status === 404 ? "The Blue Alliance has no data for that key" : "The Blue Alliance request failed";
    return c.json({ error: message }, error.status === 404 ? 404 : 502);
  }
  console.error("Unhandled error", error);
  return c.json({ error: "Something went wrong" }, 500);
});

const EVENTS_REFRESH_MS = 12 * 60 * 60 * 1000;

async function scheduled(_event: ScheduledController, env: Env): Promise<void> {
  const year = seasonYear(env);

  const freshness = await env.DB.prepare("SELECT MAX(updated_at) AS updated_at FROM events WHERE year = ?")
    .bind(year)
    .first<{ updated_at: number | null }>();

  if (!freshness?.updated_at || Date.now() - freshness.updated_at > EVENTS_REFRESH_MS) {
    await syncEvents(env, year);
  }

  for (const eventKey of await activeEventKeys(env, year)) {
    await syncEventResults(env, eventKey);
  }

  // Rescore from freshly cached results; no external calls needed here.
  const { results: leagues } = await env.DB.prepare(
    "SELECT id FROM leagues WHERE season_year = ? AND status IN ('active', 'complete')",
  )
    .bind(year)
    .all<{ id: string }>();

  for (const league of leagues) {
    await recomputeLeagueScores(env, league.id);
  }
}

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
