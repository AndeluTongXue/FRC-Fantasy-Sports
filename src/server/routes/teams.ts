import { Hono } from "hono";
import type { AppContext } from "../lib/context";
import { seasonYear } from "../lib/env";
import { pricingYearForLeague } from "../lib/pricing";

interface TeamRow {
  team_key: string;
  team_number: number;
  nickname: string | null;
  name: string | null;
  city: string | null;
  state_prov: string | null;
  country: string | null;
  rookie_year: number | null;
  price: number | null;
  epa: number | null;
}

function toTeam(row: TeamRow) {
  return {
    teamKey: row.team_key,
    teamNumber: row.team_number,
    nickname: row.nickname,
    name: row.name,
    city: row.city,
    stateProv: row.state_prov,
    country: row.country,
    rookieYear: row.rookie_year,
    price: row.price,
    epa: row.epa,
  };
}

export const teamRoutes = new Hono<AppContext>();

teamRoutes.get("/", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  const eventKey = c.req.query("eventKey")?.trim() ?? "";
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const year = seasonYear(c.env);
  // Browsing one event's teams uses that event's pricing year (current year if it's an
  // Offseason event, since that season's EPA is final by then); otherwise last year's.
  const pricingYear = eventKey
    ? await pricingYearForLeague(c.env.DB, { league_type: "single_event", event_key: eventKey, season_year: year })
    : year - 1;

  const conditions: string[] = [];
  const bindings: unknown[] = [pricingYear];

  if (eventKey) {
    conditions.push("t.team_key IN (SELECT team_key FROM event_teams WHERE event_key = ?)");
    bindings.push(eventKey);
  }
  if (search) {
    conditions.push("(CAST(t.team_number AS TEXT) LIKE ? OR lower(t.nickname) LIKE ?)");
    bindings.push(`${search}%`, `%${search.toLowerCase()}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { results } = await c.env.DB.prepare(
    `SELECT t.team_key, t.team_number, t.nickname, t.name, t.city, t.state_prov, t.country, t.rookie_year,
            p.price, p.epa
     FROM teams t
     LEFT JOIN team_prices p ON p.team_key = t.team_key AND p.season_year = ?
     ${where}
     ORDER BY t.team_number
     LIMIT ? OFFSET ?`,
  )
    .bind(...bindings, limit, offset)
    .all<TeamRow>();

  return c.json({ teams: results.map(toTeam), limit, offset });
});

teamRoutes.get("/:teamKey", async (c) => {
  const pricingYear = seasonYear(c.env) - 1;
  const row = await c.env.DB.prepare(
    `SELECT t.team_key, t.team_number, t.nickname, t.name, t.city, t.state_prov, t.country, t.rookie_year,
            p.price, p.epa
     FROM teams t
     LEFT JOIN team_prices p ON p.team_key = t.team_key AND p.season_year = ?
     WHERE t.team_key = ?`,
  )
    .bind(pricingYear, c.req.param("teamKey"))
    .first<TeamRow>();

  if (!row) return c.json({ error: "Team not found" }, 404);
  return c.json({ team: toTeam(row) });
});
