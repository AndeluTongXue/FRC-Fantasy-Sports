import { Hono } from "hono";
import { applySeasonCap, REGULAR_SEASON_EVENT_CAP } from "../../shared/scoring";
import { DEFAULT_SCORING } from "../../shared/types";
import type { AppContext } from "../lib/context";
import { requireAuth } from "../lib/context";
import { seasonYear } from "../lib/env";
import { minimumSalaryCap, pricingYearForLeague } from "../lib/pricing";
import { syncAndScoreLeague } from "../lib/scores";
import { DEFAULT_TEAM_PRICE } from "../lib/statbotics";
import { syncEventTeams } from "../lib/sync";

/** Ambiguous characters (0/O, 1/I) left out so codes survive being read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

interface LeagueRow {
  id: string;
  name: string;
  league_type: string;
  event_key: string | null;
  season_year: number;
  invite_code: string;
  commissioner_id: string;
  roster_size: number;
  salary_cap: number;
  max_members: number;
  pick_seconds: number;
  scoring_config: string;
  status: string;
  created_at: number;
}

function toLeague(row: LeagueRow) {
  return {
    id: row.id,
    name: row.name,
    leagueType: row.league_type,
    eventKey: row.event_key,
    seasonYear: row.season_year,
    inviteCode: row.invite_code,
    commissionerId: row.commissioner_id,
    rosterSize: row.roster_size,
    salaryCap: row.salary_cap,
    maxMembers: row.max_members,
    pickSeconds: row.pick_seconds,
    scoringConfig: JSON.parse(row.scoring_config),
    status: row.status,
    createdAt: row.created_at,
  };
}

async function loadMembership(db: D1Database, leagueId: string, userId: string) {
  return db
    .prepare("SELECT user_id FROM league_members WHERE league_id = ? AND user_id = ?")
    .bind(leagueId, userId)
    .first<{ user_id: string }>();
}

export const leagueRoutes = new Hono<AppContext>();

leagueRoutes.use("*", requireAuth);

leagueRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<Record<string, unknown>>();
  const name = String(body.name ?? "").trim();
  const leagueType = body.leagueType === "season" ? "season" : "single_event";
  const eventKey = body.eventKey ? String(body.eventKey) : null;

  if (name.length < 3) return c.json({ error: "League name must be at least 3 characters" }, 400);
  if (leagueType === "single_event" && !eventKey) {
    return c.json({ error: "Pick an event for a single-event league" }, 400);
  }

  if (eventKey) {
    const event = await c.env.DB.prepare("SELECT event_key FROM events WHERE event_key = ?")
      .bind(eventKey)
      .first();
    if (!event) return c.json({ error: "Unknown event — sync events first" }, 400);

    const cached = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM event_teams WHERE event_key = ?",
    )
      .bind(eventKey)
      .first<{ count: number }>();
    if (!cached?.count) await syncEventTeams(c.env, eventKey);
  }

  const id = crypto.randomUUID();
  const league = {
    id,
    name,
    league_type: leagueType,
    event_key: eventKey,
    season_year: seasonYear(c.env),
    invite_code: generateInviteCode(),
    commissioner_id: user.id,
    roster_size: clamp(body.rosterSize, 3, 10, 6),
    salary_cap: clamp(body.salaryCap, 50, 500, 200),
    max_members: clamp(body.maxMembers, 2, 16, 8),
    pick_seconds: clamp(body.pickSeconds, 30, 300, 90),
    scoring_config: JSON.stringify(DEFAULT_SCORING),
    status: "setup",
    created_at: Date.now(),
  };

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO leagues (id, name, league_type, event_key, season_year, invite_code, commissioner_id,
                            roster_size, salary_cap, max_members, pick_seconds, scoring_config, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      league.id,
      league.name,
      league.league_type,
      league.event_key,
      league.season_year,
      league.invite_code,
      league.commissioner_id,
      league.roster_size,
      league.salary_cap,
      league.max_members,
      league.pick_seconds,
      league.scoring_config,
      league.status,
      league.created_at,
    ),
    c.env.DB.prepare(
      "INSERT INTO league_members (league_id, user_id, roster_name, joined_at) VALUES (?, ?, ?, ?)",
    ).bind(id, user.id, `${user.displayName}'s team`, Date.now()),
  ]);

  return c.json({ league: toLeague(league as LeagueRow) }, 201);
});

leagueRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT l.*, (SELECT COUNT(*) FROM league_members m2 WHERE m2.league_id = l.id) AS member_count
     FROM leagues l
     JOIN league_members m ON m.league_id = l.id AND m.user_id = ?
     ORDER BY l.created_at DESC`,
  )
    .bind(c.get("user").id)
    .all<LeagueRow & { member_count: number }>();

  return c.json({
    leagues: results.map((row) => ({ ...toLeague(row), memberCount: row.member_count })),
  });
});

leagueRoutes.post("/join", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ inviteCode?: string }>();
  const code = (body.inviteCode ?? "").trim().toUpperCase();

  const league = await c.env.DB.prepare("SELECT * FROM leagues WHERE invite_code = ?")
    .bind(code)
    .first<LeagueRow>();
  if (!league) return c.json({ error: "No league with that invite code" }, 404);

  if (await loadMembership(c.env.DB, league.id, user.id)) {
    return c.json({ league: toLeague(league) });
  }
  if (league.status !== "setup") return c.json({ error: "That league has already started drafting" }, 409);

  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM league_members WHERE league_id = ?")
    .bind(league.id)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= league.max_members) return c.json({ error: "That league is full" }, 409);

  await c.env.DB.prepare(
    "INSERT INTO league_members (league_id, user_id, roster_name, joined_at) VALUES (?, ?, ?, ?)",
  )
    .bind(league.id, user.id, `${user.displayName}'s team`, Date.now())
    .run();

  return c.json({ league: toLeague(league) });
});

/**
 * The smallest safe salary cap for the league-creation form (and the pre-draft budget
 * editor). Registered ahead of GET /:id so the literal path "minimum-cap" is never
 * swallowed by the :id param.
 */
leagueRoutes.get("/minimum-cap", async (c) => {
  const leagueType = c.req.query("leagueType") === "season" ? "season" : "single_event";
  const eventKey = c.req.query("eventKey")?.trim() || null;
  const rosterSize = clamp(c.req.query("rosterSize"), 3, 10, 6);
  const maxMembers = clamp(c.req.query("maxMembers"), 2, 16, 8);

  if (leagueType === "single_event" && !eventKey) {
    return c.json({ error: "eventKey is required for a single-event league" }, 400);
  }

  const minimum = await minimumSalaryCap(c.env.DB, {
    league_type: leagueType,
    event_key: eventKey,
    season_year: seasonYear(c.env),
    roster_size: rosterSize,
    max_members: maxMembers,
  });

  if (!minimum) {
    return c.json({ error: "No priced teams found for that pool yet" }, 404);
  }
  return c.json(minimum);
});

leagueRoutes.get("/:id", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");

  const league = await c.env.DB.prepare("SELECT * FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<LeagueRow>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (!(await loadMembership(c.env.DB, leagueId, user.id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }

  const [members, picks] = await Promise.all([
    c.env.DB.prepare(
      `SELECT m.user_id, m.roster_name, m.draft_position, m.joined_at, u.display_name
       FROM league_members m JOIN users u ON u.id = m.user_id
       WHERE m.league_id = ? ORDER BY m.joined_at`,
    )
      .bind(leagueId)
      .all<{
        user_id: string;
        roster_name: string;
        draft_position: number | null;
        joined_at: number;
        display_name: string;
      }>(),
    c.env.DB.prepare(
      `SELECT d.pick_number, d.user_id, d.team_key, d.price, d.drafted_at, t.nickname, t.team_number
       FROM draft_picks d LEFT JOIN teams t ON t.team_key = d.team_key
       WHERE d.league_id = ? ORDER BY d.pick_number`,
    )
      .bind(leagueId)
      .all<{
        pick_number: number;
        user_id: string;
        team_key: string;
        price: number;
        drafted_at: number;
        nickname: string | null;
        team_number: number | null;
      }>(),
  ]);

  return c.json({
    league: toLeague(league),
    members: members.results.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      rosterName: row.roster_name,
      draftPosition: row.draft_position,
      joinedAt: row.joined_at,
    })),
    picks: picks.results.map((row) => ({
      pickNumber: row.pick_number,
      userId: row.user_id,
      teamKey: row.team_key,
      teamNumber: row.team_number,
      nickname: row.nickname,
      price: row.price,
      draftedAt: row.drafted_at,
    })),
  });
});

/** Only the salary cap is editable, and only before the draft starts — once picks exist,
 * changing the cap would retroactively make some already-drafted picks illegal. */
leagueRoutes.patch("/:id", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ salaryCap?: unknown }>();

  const league = await c.env.DB.prepare("SELECT * FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<LeagueRow>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (league.commissioner_id !== user.id) {
    return c.json({ error: "Only the commissioner can edit this league" }, 403);
  }
  if (league.status !== "setup") {
    return c.json({ error: "The budget can't change once the draft has started" }, 409);
  }

  if (body.salaryCap === undefined) return c.json({ league: toLeague(league) });

  const salaryCap = Number(body.salaryCap);
  if (!Number.isFinite(salaryCap) || !Number.isInteger(salaryCap) || salaryCap < 50 || salaryCap > 500) {
    return c.json({ error: "Salary cap must be a whole number between $50 and $500" }, 400);
  }

  await c.env.DB.prepare("UPDATE leagues SET salary_cap = ? WHERE id = ?").bind(salaryCap, leagueId).run();
  return c.json({ league: toLeague({ ...league, salary_cap: salaryCap }) });
});

leagueRoutes.delete("/:id", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");

  const league = await c.env.DB.prepare("SELECT commissioner_id FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<{ commissioner_id: string }>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (league.commissioner_id !== user.id) {
    return c.json({ error: "Only the commissioner can delete this league" }, 403);
  }

  // Explicit deletes rather than relying on D1's foreign-key cascade, so this is correct
  // regardless of whether FK enforcement is on for this connection.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM fantasy_scores WHERE league_id = ?").bind(leagueId),
    c.env.DB.prepare("DELETE FROM draft_picks WHERE league_id = ?").bind(leagueId),
    c.env.DB.prepare("DELETE FROM league_members WHERE league_id = ?").bind(leagueId),
    c.env.DB.prepare("DELETE FROM leagues WHERE id = ?").bind(leagueId),
  ]);

  // Best-effort: clear the draft room's Durable Object state so a stale alarm never
  // fires against a league that no longer exists.
  try {
    const stub = c.env.DRAFT_ROOM.get(c.env.DRAFT_ROOM.idFromName(leagueId));
    await stub.resetForDeletion();
  } catch (error) {
    console.error("Failed to reset draft room after league deletion", error);
  }

  return c.json({ ok: true });
});

/**
 * A member leaves their own league. Only allowed pre-draft — once picks exist, a roster
 * with no owner is a bigger mess than just not allowing this. If the commissioner leaves
 * and others remain, ownership passes to whoever joined earliest after them; if they're
 * the only member, they're pointed at delete instead (an empty, ownerless league helps
 * no one).
 */
leagueRoutes.post("/:id/leave", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");

  const league = await c.env.DB.prepare("SELECT commissioner_id, status FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<{ commissioner_id: string; status: string }>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (!(await loadMembership(c.env.DB, leagueId, user.id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }
  if (league.status !== "setup") {
    return c.json({ error: "Can't leave a league once the draft has started" }, 409);
  }

  if (league.commissioner_id !== user.id) {
    await c.env.DB.prepare("DELETE FROM league_members WHERE league_id = ? AND user_id = ?")
      .bind(leagueId, user.id)
      .run();
    return c.json({ ok: true });
  }

  const successor = await c.env.DB.prepare(
    "SELECT user_id FROM league_members WHERE league_id = ? AND user_id != ? ORDER BY joined_at ASC LIMIT 1",
  )
    .bind(leagueId, user.id)
    .first<{ user_id: string }>();

  if (!successor) {
    return c.json(
      { error: "You're the only member — delete the league instead if you want to remove it" },
      400,
    );
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE leagues SET commissioner_id = ? WHERE id = ?").bind(successor.user_id, leagueId),
    c.env.DB.prepare("DELETE FROM league_members WHERE league_id = ? AND user_id = ?").bind(leagueId, user.id),
  ]);

  return c.json({ ok: true, newCommissionerId: successor.user_id });
});

/** Draftable teams for a league, cheapest information the draft board needs. */
leagueRoutes.get("/:id/pool", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");
  const search = c.req.query("search")?.trim() ?? "";
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "60", 10) || 60, 200);

  const league = await c.env.DB.prepare("SELECT * FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<LeagueRow>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (!(await loadMembership(c.env.DB, leagueId, user.id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }

  const pricingYear = await pricingYearForLeague(c.env.DB, league);
  const bindings: unknown[] = [DEFAULT_TEAM_PRICE, pricingYear, leagueId];
  let poolClause = "1 = 1";
  if (league.league_type === "single_event" && league.event_key) {
    poolClause = "t.team_key IN (SELECT team_key FROM event_teams WHERE event_key = ?)";
    bindings.push(league.event_key);
  }

  let searchClause = "1 = 1";
  if (search) {
    searchClause = "(CAST(t.team_number AS TEXT) LIKE ? OR lower(t.nickname) LIKE ?)";
    bindings.push(`${search}%`, `%${search.toLowerCase()}%`);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT t.team_key, t.team_number, t.nickname, COALESCE(p.price, ?) AS price, p.epa
     FROM teams t
     LEFT JOIN team_prices p ON p.team_key = t.team_key AND p.season_year = ?
     WHERE t.team_key NOT IN (SELECT team_key FROM draft_picks WHERE league_id = ?)
       AND ${poolClause} AND ${searchClause}
     ORDER BY COALESCE(p.epa, -1e9) DESC, t.team_number
     LIMIT ?`,
  )
    .bind(...bindings, limit)
    .all<{
      team_key: string;
      team_number: number;
      nickname: string | null;
      price: number;
      epa: number | null;
    }>();

  return c.json({
    teams: results.map((row) => ({
      teamKey: row.team_key,
      teamNumber: row.team_number,
      nickname: row.nickname,
      price: row.price,
      epa: row.epa,
    })),
  });
});

/** Standings: total fantasy points per owner, with the per-team detail behind them. */
leagueRoutes.get("/:id/standings", async (c) => {
  const leagueId = c.req.param("id");
  if (!(await loadMembership(c.env.DB, leagueId, c.get("user").id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT s.user_id, s.team_key, s.event_key, s.points, s.breakdown,
            u.display_name, m.roster_name, t.team_number, t.nickname,
            e.name AS event_name, e.week, e.event_type
     FROM fantasy_scores s
     JOIN users u ON u.id = s.user_id
     JOIN league_members m ON m.league_id = s.league_id AND m.user_id = s.user_id
     LEFT JOIN teams t ON t.team_key = s.team_key
     LEFT JOIN events e ON e.event_key = s.event_key
     WHERE s.league_id = ?
     ORDER BY s.points DESC`,
  )
    .bind(leagueId)
    .all<{
      user_id: string;
      team_key: string;
      event_key: string;
      points: number;
      breakdown: string;
      display_name: string;
      roster_name: string;
      team_number: number | null;
      nickname: string | null;
      event_name: string | null;
      week: number | null;
      event_type: number | null;
    }>();

  interface StandingEntry {
    teamKey: string;
    teamNumber: number | null;
    nickname: string | null;
    eventKey: string;
    eventName: string | null;
    week: number | null;
    eventType: number | null;
    points: number;
    breakdown: Record<string, number>;
  }

  const owners = new Map<
    string,
    { userId: string; displayName: string; rosterName: string; points: number; entries: StandingEntry[] }
  >();

  for (const row of results) {
    const owner = owners.get(row.user_id) ?? {
      userId: row.user_id,
      displayName: row.display_name,
      rosterName: row.roster_name,
      points: 0,
      entries: [],
    };
    owner.entries.push({
      teamKey: row.team_key,
      teamNumber: row.team_number,
      nickname: row.nickname,
      eventKey: row.event_key,
      eventName: row.event_name,
      week: row.week,
      eventType: row.event_type,
      points: row.points,
      breakdown: JSON.parse(row.breakdown) as Record<string, number>,
    });
    owners.set(row.user_id, owner);
  }

  const members = await c.env.DB.prepare(
    `SELECT m.user_id, m.roster_name, u.display_name
     FROM league_members m JOIN users u ON u.id = m.user_id WHERE m.league_id = ?`,
  )
    .bind(leagueId)
    .all<{ user_id: string; roster_name: string; display_name: string }>();

  for (const member of members.results) {
    if (!owners.has(member.user_id)) {
      owners.set(member.user_id, {
        userId: member.user_id,
        displayName: member.display_name,
        rosterName: member.roster_name,
        points: 0,
        entries: [],
      });
    }
  }

  // Cap each team at its best REGULAR_SEASON_EVENT_CAP regular-season events (plus every
  // district/season championship in full) — the same shape as FRC's own district points —
  // so attending more events isn't by itself an advantage.
  for (const owner of owners.values()) {
    const byTeam = new Map<string, StandingEntry[]>();
    for (const entry of owner.entries) {
      const list = byTeam.get(entry.teamKey) ?? [];
      list.push(entry);
      byTeam.set(entry.teamKey, list);
    }

    let total = 0;
    const counted = new Set<string>(); // `${teamKey}|${eventKey}` — eventKey alone can repeat across teams
    for (const [teamKey, teamEntries] of byTeam) {
      for (const entry of applySeasonCap(teamEntries)) {
        if (entry.counted) {
          total += entry.points;
          counted.add(`${teamKey}|${entry.eventKey}`);
        }
      }
    }

    owner.points = total;
    owner.entries = owner.entries
      .map((entry) => ({ ...entry, counted: counted.has(`${entry.teamKey}|${entry.eventKey}`) }))
      .sort((a, b) => b.points - a.points);
  }

  return c.json({
    standings: [...owners.values()].sort((a, b) => b.points - a.points),
    regularSeasonEventCap: REGULAR_SEASON_EVENT_CAP,
  });
});

leagueRoutes.post("/:id/refresh-scores", async (c) => {
  const leagueId = c.req.param("id");
  if (!(await loadMembership(c.env.DB, leagueId, c.get("user").id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }
  return c.json({ scored: await syncAndScoreLeague(c.env, leagueId) });
});

leagueRoutes.get("/:id/draft/ws", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");

  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "Expected a WebSocket upgrade" }, 426);
  }
  if (!(await loadMembership(c.env.DB, leagueId, user.id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }

  const headers = new Headers(c.req.raw.headers);
  headers.set("X-League-Id", leagueId);
  headers.set("X-User-Id", user.id);

  const stub = c.env.DRAFT_ROOM.get(c.env.DRAFT_ROOM.idFromName(leagueId));
  return stub.fetch(new Request(c.req.url, { method: "GET", headers }));
});
