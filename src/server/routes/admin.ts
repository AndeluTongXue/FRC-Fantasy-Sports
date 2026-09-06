import { Hono } from "hono";
import type { AppContext } from "../lib/context";
import { requireAuth } from "../lib/context";
import { seasonYear } from "../lib/env";
import { priceTeamsFromStatbotics } from "../lib/statbotics";
import { syncEventResults, syncEventTeams, syncEvents, syncTeams } from "../lib/sync";

export const adminRoutes = new Hono<AppContext>();

adminRoutes.use("*", requireAuth);

adminRoutes.post("/sync/teams", async (c) => {
  const year = Number.parseInt(c.req.query("year") ?? "", 10) || seasonYear(c.env);
  return c.json({ year, teams: await syncTeams(c.env, year) });
});

adminRoutes.post("/sync/events", async (c) => {
  const year = Number.parseInt(c.req.query("year") ?? "", 10) || seasonYear(c.env);
  return c.json({ year, events: await syncEvents(c.env, year) });
});

/**
 * `year` here is the literal Statbotics EPA year to cache, not a "target season" — it
 * defaults to last year (the normal preseason-pricing case for in-season leagues). Pass
 * `?year=<current season>` once that season has concluded, to price offseason-event
 * leagues (Chezy Champs, IRI, etc.) from that season's own final EPA instead.
 */
adminRoutes.post("/price-teams", async (c) => {
  const year = Number.parseInt(c.req.query("year") ?? "", 10) || seasonYear(c.env) - 1;
  return c.json(await priceTeamsFromStatbotics(c.env, year));
});

adminRoutes.post("/sync/event/:eventKey", async (c) => {
  const eventKey = c.req.param("eventKey");
  const teams = await syncEventTeams(c.env, eventKey);
  const results = await syncEventResults(c.env, eventKey);
  return c.json({ eventKey, teams, ...results });
});
