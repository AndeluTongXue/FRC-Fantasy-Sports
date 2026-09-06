import { Hono } from "hono";
import type { AppContext } from "../lib/context";
import { seasonYear } from "../lib/env";

interface EventRow {
  event_key: string;
  year: number;
  name: string;
  short_name: string | null;
  event_type: number | null;
  event_type_string: string | null;
  week: number | null;
  start_date: string | null;
  end_date: string | null;
  city: string | null;
  state_prov: string | null;
  country: string | null;
}

function toEvent(row: EventRow) {
  return {
    eventKey: row.event_key,
    year: row.year,
    name: row.name,
    shortName: row.short_name,
    eventType: row.event_type,
    eventTypeString: row.event_type_string,
    week: row.week,
    startDate: row.start_date,
    endDate: row.end_date,
    city: row.city,
    stateProv: row.state_prov,
    country: row.country,
  };
}

export const eventRoutes = new Hono<AppContext>();

eventRoutes.get("/", async (c) => {
  const year = Number.parseInt(c.req.query("year") ?? "", 10) || seasonYear(c.env);
  const search = c.req.query("search")?.trim().toLowerCase() ?? "";

  const { results } = await c.env.DB.prepare(
    `SELECT event_key, year, name, short_name, event_type, event_type_string, week,
            start_date, end_date, city, state_prov, country
     FROM events
     WHERE year = ? AND (? = '' OR lower(name) LIKE ? OR lower(event_key) LIKE ?)
     ORDER BY start_date, name`,
  )
    .bind(year, search, `%${search}%`, `%${search}%`)
    .all<EventRow>();

  return c.json({ events: results.map(toEvent) });
});

eventRoutes.get("/:eventKey", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT event_key, year, name, short_name, event_type, event_type_string, week,
            start_date, end_date, city, state_prov, country
     FROM events WHERE event_key = ?`,
  )
    .bind(c.req.param("eventKey"))
    .first<EventRow>();

  if (!row) return c.json({ error: "Event not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT COUNT(*) AS team_count FROM event_teams WHERE event_key = ?",
  )
    .bind(c.req.param("eventKey"))
    .all<{ team_count: number }>();

  return c.json({ event: toEvent(row), teamCount: results[0]?.team_count ?? 0 });
});
