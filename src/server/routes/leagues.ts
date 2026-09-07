import { Hono } from "hono";
import { applySeasonCap, REGULAR_SEASON_EVENT_CAP } from "../../shared/scoring";
import {
  DEFAULT_PICK_SECONDS,
  DEFAULT_SCORING,
  MAX_PICK_SECONDS,
  MIN_PICK_SECONDS,
} from "../../shared/types";
import type { ScoringConfig } from "../../shared/types";
import type { AppContext } from "../lib/context";
import { requireAuth, requireVerifiedEmail } from "../lib/context";
import { seasonYear } from "../lib/env";
import { minimumSalaryCap, pricingYearForLeague } from "../lib/pricing";
import type { MinimumCapParams } from "../lib/pricing";
import { syncAndScoreLeague } from "../lib/scores";
import { DEFAULT_TEAM_PRICE } from "../lib/statbotics";
import { syncEventTeams } from "../lib/sync";
import { waitLabel } from "../lib/throttle";

/** Ambiguous characters (0/O, 1/I) left out so codes survive being read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const MIN_SCHEDULE_LEAD_MS = 60 * 1000;
const MAX_SCHEDULE_LEAD_MS = 180 * 24 * 60 * 60 * 1000;

type ScheduleValidation = { ok: true; value: number } | { ok: false; error: string };

/** Validates a proposed draft auto-start time. Not "in the past" but "at least a minute
 * out" — a time that's already arrived (or arrives before the request even completes)
 * would race the DO's alarm setup for no benefit over just starting manually. */
function validateScheduledDraftAt(value: unknown): ScheduleValidation {
  if (value === null || value === undefined) {
    return { ok: false, error: "scheduledDraftAt is required" };
  }
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms)) return { ok: false, error: "scheduledDraftAt must be a timestamp in milliseconds" };

  const now = Date.now();
  if (ms < now + MIN_SCHEDULE_LEAD_MS) {
    return { ok: false, error: "Scheduled draft time must be at least a minute from now" };
  }
  if (ms > now + MAX_SCHEDULE_LEAD_MS) {
    return { ok: false, error: "Scheduled draft time can't be more than 180 days out" };
  }
  return { ok: true, value: Math.trunc(ms) };
}

/** Point values are generous but bounded so a typo (or someone messing around) can't
 * produce nonsense standings; the multiplier gets its own, tighter range since it scales
 * everything else at a Championship event. */
const SCORING_FIELD_BOUNDS: Record<keyof ScoringConfig, [number, number]> = {
  qualWin: [0, 200],
  qualTie: [0, 200],
  rankingPoint: [0, 200],
  allianceCaptain: [0, 200],
  alliancePick1: [0, 200],
  alliancePick2: [0, 200],
  alliancePick3: [0, 200],
  playoffWin: [0, 200],
  eventWinner: [0, 500],
  eventFinalist: [0, 500],
  awardImpact: [0, 200],
  awardEngineeringInspiration: [0, 200],
  awardOther: [0, 200],
  championshipMultiplier: [0, 10],
};

type ScoringValidation = { ok: true; value: ScoringConfig } | { ok: false; error: string };

function validateScoringConfig(value: unknown): ScoringValidation {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "scoringConfig must be an object" };
  }
  const input = value as Record<string, unknown>;
  const result = {} as ScoringConfig;

  for (const key of Object.keys(SCORING_FIELD_BOUNDS) as (keyof ScoringConfig)[]) {
    const [min, max] = SCORING_FIELD_BOUNDS[key];
    const raw = input[key];
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      return { ok: false, error: `${key} must be a number between ${min} and ${max}` };
    }
    result[key] = parsed;
  }
  return { ok: true, value: result };
}

function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

/** Hard bounds on a league's salary cap. The usable floor is per-league and higher — see
 * `salaryCapObjection`. */
const MIN_SALARY_CAP = 50;
const MAX_SALARY_CAP = 500;

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
  last_score_sync_at: number | null;
  scheduled_draft_at: number | null;
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
    scheduledDraftAt: row.scheduled_draft_at,
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

/**
 * Guards the one league setting that can make a draft unplayable rather than merely awkward.
 *
 * Below the minimum cap, the draft room's reserve rule refuses every team from the very
 * first pick — the manager must keep back enough to fill their remaining slots, and if the
 * cap can't cover the worst case there is no legal pick at all. The clock then expires,
 * autopick finds nothing, and the turn is skipped; repeat until the draft ends with empty
 * rosters. That is what the minimum has always been the number for; nothing enforced it.
 *
 * Returns an error message, or null when the cap is safe (or when there's no price data to
 * judge it against, in which case blocking would be worse than allowing).
 */
async function salaryCapObjection(
  db: D1Database,
  params: MinimumCapParams,
  salaryCap: number,
): Promise<string | null> {
  const minimum = await minimumSalaryCap(db, params);
  if (!minimum || salaryCap >= minimum.minimumCap) return null;

  const where = params.league_type === "single_event" ? "at this event" : "this season";
  const detail =
    `A $${salaryCap} cap can't fill a ${params.roster_size}-team roster ${where}: the ` +
    `${params.roster_size} most expensive teams a manager could be left with cost ` +
    `$${minimum.minimumCap}.`;

  // No cap can rescue this one — the ceiling is below what the roster needs.
  if (minimum.minimumCap > MAX_SALARY_CAP) {
    return `${detail} That's above the $${MAX_SALARY_CAP} maximum, so lower the roster size or the number of managers instead.`;
  }
  return `${detail} Raise the cap to at least $${minimum.minimumCap}, or lower the roster size.`;
}

leagueRoutes.post("/", requireVerifiedEmail, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<Record<string, unknown>>();
  const name = String(body.name ?? "").trim();
  const leagueType = body.leagueType === "season" ? "season" : "single_event";
  const eventKey = body.eventKey ? String(body.eventKey) : null;

  if (name.length < 3) return c.json({ error: "League name must be at least 3 characters" }, 400);
  if (leagueType === "single_event" && !eventKey) {
    return c.json({ error: "Pick an event for a single-event league" }, 400);
  }

  let scheduledDraftAt: number | null = null;
  if (body.scheduledDraftAt !== undefined && body.scheduledDraftAt !== null) {
    const validation = validateScheduledDraftAt(body.scheduledDraftAt);
    if (!validation.ok) return c.json({ error: validation.error }, 400);
    scheduledDraftAt = validation.value;
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

  const rosterSize = clamp(body.rosterSize, 3, 10, 6);
  const maxMembers = clamp(body.maxMembers, 2, 16, 8);
  const salaryCap = clamp(body.salaryCap, MIN_SALARY_CAP, MAX_SALARY_CAP, 200);

  const objection = await salaryCapObjection(
    c.env.DB,
    {
      league_type: leagueType,
      event_key: eventKey,
      season_year: seasonYear(c.env),
      roster_size: rosterSize,
      max_members: maxMembers,
    },
    salaryCap,
  );
  if (objection) return c.json({ error: objection }, 400);

  const id = crypto.randomUUID();
  const league = {
    id,
    name,
    league_type: leagueType,
    event_key: eventKey,
    season_year: seasonYear(c.env),
    invite_code: generateInviteCode(),
    commissioner_id: user.id,
    roster_size: rosterSize,
    salary_cap: salaryCap,
    max_members: maxMembers,
    pick_seconds: clamp(body.pickSeconds, MIN_PICK_SECONDS, MAX_PICK_SECONDS, DEFAULT_PICK_SECONDS),
    scoring_config: JSON.stringify(DEFAULT_SCORING),
    status: "setup",
    created_at: Date.now(),
    scheduled_draft_at: scheduledDraftAt,
  };

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO leagues (id, name, league_type, event_key, season_year, invite_code, commissioner_id,
                            roster_size, salary_cap, max_members, pick_seconds, scoring_config, status, created_at,
                            scheduled_draft_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      league.scheduled_draft_at,
    ),
    c.env.DB.prepare(
      "INSERT INTO league_members (league_id, user_id, roster_name, joined_at) VALUES (?, ?, ?, ?)",
    ).bind(id, user.id, `${user.displayName}'s team`, Date.now()),
  ]);

  if (scheduledDraftAt !== null) {
    const stub = c.env.DRAFT_ROOM.get(c.env.DRAFT_ROOM.idFromName(id));
    await stub.setSchedule(id, scheduledDraftAt);
  }

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

leagueRoutes.post("/join", requireVerifiedEmail, async (c) => {
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

  const banned = await c.env.DB.prepare("SELECT 1 FROM league_bans WHERE league_id = ? AND user_id = ?")
    .bind(league.id, user.id)
    .first();
  if (banned) return c.json({ error: "You've been banned from this league" }, 403);

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

  const isCommissioner = league.commissioner_id === user.id;

  const [members, picks, bans] = await Promise.all([
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
    // Only the commissioner needs to see who's banned.
    isCommissioner
      ? c.env.DB.prepare(
          `SELECT b.user_id, b.banned_at, u.display_name
           FROM league_bans b JOIN users u ON u.id = b.user_id
           WHERE b.league_id = ? ORDER BY b.banned_at DESC`,
        )
          .bind(leagueId)
          .all<{ user_id: string; banned_at: number; display_name: string }>()
      : Promise.resolve({ results: [] as { user_id: string; banned_at: number; display_name: string }[] }),
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
    bannedUsers: bans.results.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      bannedAt: row.banned_at,
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
/**
 * Pre-draft league settings the commissioner can still change: the salary cap and the pick
 * clock. Both are locked once the draft starts — the cap because rosters are already priced
 * against it, the clock because the draft room's alarm is already running on it.
 */
leagueRoutes.patch("/:id", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ salaryCap?: unknown; pickSeconds?: unknown }>();

  const league = await c.env.DB.prepare("SELECT * FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<LeagueRow>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (league.commissioner_id !== user.id) {
    return c.json({ error: "Only the commissioner can edit this league" }, 403);
  }
  if (league.status !== "setup") {
    return c.json({ error: "League settings can't change once the draft has started" }, 409);
  }

  const updates: { column: string; value: number }[] = [];

  if (body.salaryCap !== undefined) {
    const salaryCap = Number(body.salaryCap);
    if (
      !Number.isFinite(salaryCap) ||
      !Number.isInteger(salaryCap) ||
      salaryCap < MIN_SALARY_CAP ||
      salaryCap > MAX_SALARY_CAP
    ) {
      return c.json(
        { error: `Salary cap must be a whole number between $${MIN_SALARY_CAP} and $${MAX_SALARY_CAP}` },
        400,
      );
    }
    const objection = await salaryCapObjection(c.env.DB, league, salaryCap);
    if (objection) return c.json({ error: objection }, 400);
    updates.push({ column: "salary_cap", value: salaryCap });
  }

  if (body.pickSeconds !== undefined) {
    const pickSeconds = Number(body.pickSeconds);
    // Validated rather than clamped: silently turning a mistyped 5 into 30 leaves the
    // commissioner believing they set something they didn't.
    if (
      !Number.isFinite(pickSeconds) ||
      !Number.isInteger(pickSeconds) ||
      pickSeconds < MIN_PICK_SECONDS ||
      pickSeconds > MAX_PICK_SECONDS
    ) {
      return c.json(
        { error: `Pick clock must be a whole number of seconds between ${MIN_PICK_SECONDS} and ${MAX_PICK_SECONDS}` },
        400,
      );
    }
    updates.push({ column: "pick_seconds", value: pickSeconds });
  }

  if (updates.length === 0) return c.json({ league: toLeague(league) });

  await c.env.DB.prepare(
    `UPDATE leagues SET ${updates.map((entry) => `${entry.column} = ?`).join(", ")} WHERE id = ?`,
  )
    .bind(...updates.map((entry) => entry.value), leagueId)
    .run();

  const updated = { ...league };
  for (const entry of updates) (updated as unknown as Record<string, number>)[entry.column] = entry.value;
  return c.json({ league: toLeague(updated) });
});

/** A member renames their own team. Purely cosmetic, so unlike the salary cap this is
 * allowed any time — before, during, or after the draft. */
leagueRoutes.patch("/:id/roster-name", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ rosterName?: unknown }>();

  const league = await c.env.DB.prepare("SELECT id FROM leagues WHERE id = ?").bind(leagueId).first();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (!(await loadMembership(c.env.DB, leagueId, user.id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }

  const rosterName = typeof body.rosterName === "string" ? body.rosterName.trim() : "";
  if (!rosterName) return c.json({ error: "Team name can't be empty" }, 400);
  if (rosterName.length > 40) return c.json({ error: "Team name must be 40 characters or fewer" }, 400);

  await c.env.DB.prepare("UPDATE league_members SET roster_name = ? WHERE league_id = ? AND user_id = ?")
    .bind(rosterName, leagueId, user.id)
    .run();

  return c.json({ rosterName });
});

/**
 * Sets or reschedules the draft's auto-start time. Commissioner-only and pre-draft-only,
 * like the salary cap edit — once a draft is running (or done), a start time is moot.
 */
leagueRoutes.put("/:id/schedule", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ scheduledDraftAt?: unknown }>();

  const league = await c.env.DB.prepare("SELECT commissioner_id, status FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<{ commissioner_id: string; status: string }>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (league.commissioner_id !== user.id) {
    return c.json({ error: "Only the commissioner can schedule the draft" }, 403);
  }
  if (league.status !== "setup") {
    return c.json({ error: "The draft can't be scheduled once it has started" }, 409);
  }

  const validation = validateScheduledDraftAt(body.scheduledDraftAt);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  await c.env.DB.prepare("UPDATE leagues SET scheduled_draft_at = ? WHERE id = ?")
    .bind(validation.value, leagueId)
    .run();

  const stub = c.env.DRAFT_ROOM.get(c.env.DRAFT_ROOM.idFromName(leagueId));
  await stub.setSchedule(leagueId, validation.value);

  return c.json({ scheduledDraftAt: validation.value });
});

/** Cancels a scheduled draft start — the draft goes back to needing a manual start. */
leagueRoutes.delete("/:id/schedule", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");

  const league = await c.env.DB.prepare("SELECT commissioner_id, status FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<{ commissioner_id: string; status: string }>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (league.commissioner_id !== user.id) {
    return c.json({ error: "Only the commissioner can cancel the scheduled draft" }, 403);
  }
  if (league.status !== "setup") {
    return c.json({ error: "The draft schedule can't change once it has started" }, 409);
  }

  await c.env.DB.prepare("UPDATE leagues SET scheduled_draft_at = NULL WHERE id = ?").bind(leagueId).run();

  const stub = c.env.DRAFT_ROOM.get(c.env.DRAFT_ROOM.idFromName(leagueId));
  await stub.setSchedule(leagueId, null);

  return c.json({ ok: true });
});

/**
 * Retunes a league's scoring weights. Commissioner-only and pre-draft-only: once picks
 * exist, changing weights would retroactively rewrite points that owners already earned
 * (or, for a season league, are actively earning) under the old values.
 */
leagueRoutes.put("/:id/scoring", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ scoringConfig?: unknown }>();

  const league = await c.env.DB.prepare("SELECT commissioner_id, status FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<{ commissioner_id: string; status: string }>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (league.commissioner_id !== user.id) {
    return c.json({ error: "Only the commissioner can edit scoring weights" }, 403);
  }
  if (league.status !== "setup") {
    return c.json({ error: "Scoring weights can't change once the draft has started" }, 409);
  }

  const validation = validateScoringConfig(body.scoringConfig);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  await c.env.DB.prepare("UPDATE leagues SET scoring_config = ? WHERE id = ?")
    .bind(JSON.stringify(validation.value), leagueId)
    .run();

  return c.json({ scoringConfig: validation.value });
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
    c.env.DB.prepare("DELETE FROM league_bans WHERE league_id = ?").bind(leagueId),
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

/**
 * Commissioner kicks a member and blocks them from rejoining (via invite code) until
 * unbanned. Only allowed pre-draft, same reasoning as leaving: once picks exist, a roster
 * with no owner is a bigger mess than just not allowing this.
 */
leagueRoutes.post("/:id/ban", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ userId?: string }>();
  const targetId = body.userId?.trim();

  const league = await c.env.DB.prepare("SELECT commissioner_id, status FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<{ commissioner_id: string; status: string }>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (league.commissioner_id !== user.id) {
    return c.json({ error: "Only the commissioner can ban members" }, 403);
  }
  if (!targetId) return c.json({ error: "userId is required" }, 400);
  if (targetId === user.id) return c.json({ error: "You can't ban yourself" }, 400);
  if (league.status !== "setup") {
    return c.json({ error: "Can't ban a member once the draft has started" }, 409);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM league_members WHERE league_id = ? AND user_id = ?").bind(leagueId, targetId),
    c.env.DB.prepare(
      `INSERT INTO league_bans (league_id, user_id, banned_at) VALUES (?, ?, ?)
       ON CONFLICT(league_id, user_id) DO UPDATE SET banned_at = excluded.banned_at`,
    ).bind(leagueId, targetId, Date.now()),
  ]);

  return c.json({ ok: true });
});

leagueRoutes.post("/:id/unban", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ userId?: string }>();
  const targetId = body.userId?.trim();

  const league = await c.env.DB.prepare("SELECT commissioner_id FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<{ commissioner_id: string }>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (league.commissioner_id !== user.id) {
    return c.json({ error: "Only the commissioner can unban members" }, 403);
  }
  if (!targetId) return c.json({ error: "userId is required" }, 400);

  await c.env.DB.prepare("DELETE FROM league_bans WHERE league_id = ? AND user_id = ?")
    .bind(leagueId, targetId)
    .run();

  return c.json({ ok: true });
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

/**
 * Manual rescore. This is the one member-triggerable path that reaches TBA (a season
 * league asks TBA for every rostered team's schedule), so it's on a cooldown — otherwise
 * any member could spam the button and burn through our TBA rate limit. The cron rescores
 * from cached data anyway, so the cooldown only delays a manual nudge.
 */
const SCORE_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

leagueRoutes.post("/:id/refresh-scores", async (c) => {
  const leagueId = c.req.param("id");
  if (!(await loadMembership(c.env.DB, leagueId, c.get("user").id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }

  const row = await c.env.DB.prepare("SELECT last_score_sync_at FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<{ last_score_sync_at: number | null }>();
  if (!row) return c.json({ error: "League not found" }, 404);

  const now = Date.now();
  const elapsed = now - (row.last_score_sync_at ?? 0);
  if (elapsed < SCORE_SYNC_COOLDOWN_MS) {
    const retryAfter = Math.ceil((SCORE_SYNC_COOLDOWN_MS - elapsed) / 1000);
    c.header("Retry-After", String(retryAfter));
    return c.json(
      { error: `Scores were just refreshed — try again in ${waitLabel(retryAfter)}.`, retryAfter },
      429,
    );
  }

  // Claim the window before the work starts, so two clicks racing can't both reach TBA.
  await c.env.DB.prepare("UPDATE leagues SET last_score_sync_at = ? WHERE id = ?").bind(now, leagueId).run();
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

/**
 * A manager's own draft queue: the teams to take, in order, when their pick clock expires.
 *
 * Always scoped to the signed-in user — a queue is private, and reading an opponent's would
 * be a large unearned advantage. Drafted teams are filtered out rather than returned with a
 * flag, so a queue read back is always a list of teams the manager can still actually get.
 */
async function readQueue(db: D1Database, league: LeagueRow, userId: string) {
  const pricingYear = await pricingYearForLeague(db, league);
  const bindings: unknown[] = [DEFAULT_TEAM_PRICE, pricingYear, league.id, userId, league.id];

  let poolClause = "1 = 1";
  if (league.league_type === "single_event" && league.event_key) {
    poolClause = "t.team_key IN (SELECT team_key FROM event_teams WHERE event_key = ?)";
    bindings.push(league.event_key);
  }

  const { results } = await db
    .prepare(
      `SELECT t.team_key, t.team_number, t.nickname, COALESCE(p.price, ?) AS price, p.epa
       FROM draft_queues q
       JOIN teams t ON t.team_key = q.team_key
       LEFT JOIN team_prices p ON p.team_key = q.team_key AND p.season_year = ?
       WHERE q.league_id = ? AND q.user_id = ?
         AND t.team_key NOT IN (SELECT team_key FROM draft_picks WHERE league_id = ?)
         AND ${poolClause}
       ORDER BY q.position ASC`,
    )
    .bind(...bindings)
    .all<{
      team_key: string;
      team_number: number;
      nickname: string | null;
      price: number;
      epa: number | null;
    }>();

  return results.map((row) => ({
    teamKey: row.team_key,
    teamNumber: row.team_number,
    nickname: row.nickname,
    price: row.price,
    epa: row.epa,
  }));
}

leagueRoutes.get("/:id/queue", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");

  const league = await c.env.DB.prepare("SELECT * FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<LeagueRow>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (!(await loadMembership(c.env.DB, leagueId, user.id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }

  return c.json({ teams: await readQueue(c.env.DB, league, user.id) });
});

/** How deep a queue is worth keeping. Beyond a manager's own roster size it's already
 * insurance against opponents taking their favourites; past this it's noise. */
const MAX_QUEUE_LENGTH = 50;

/**
 * Replaces the whole queue in one shot rather than patching positions. Reordering is the
 * common edit and doing it as a diff invites off-by-one bugs for no benefit — these lists
 * are tens of rows.
 *
 * Unknown, out-of-pool, and already-drafted teams are dropped silently rather than failing
 * the request: a team drafted by someone else a moment before the save shouldn't cost the
 * manager the rest of their reordering.
 */
leagueRoutes.put("/:id/queue", async (c) => {
  const leagueId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ teamKeys?: unknown }>().catch(() => ({}) as { teamKeys?: unknown });

  const league = await c.env.DB.prepare("SELECT * FROM leagues WHERE id = ?")
    .bind(leagueId)
    .first<LeagueRow>();
  if (!league) return c.json({ error: "League not found" }, 404);
  if (!(await loadMembership(c.env.DB, leagueId, user.id))) {
    return c.json({ error: "You're not in this league" }, 403);
  }
  if (league.status === "active" || league.status === "complete") {
    return c.json({ error: "The draft is over — queues no longer do anything" }, 409);
  }

  if (!Array.isArray(body.teamKeys)) return c.json({ error: "teamKeys must be an array" }, 400);

  const requested = [...new Set(body.teamKeys.filter((key): key is string => typeof key === "string"))].slice(
    0,
    MAX_QUEUE_LENGTH,
  );

  let valid: string[] = [];
  if (requested.length > 0) {
    const bindings: unknown[] = [leagueId, ...requested];
    let poolClause = "1 = 1";
    if (league.league_type === "single_event" && league.event_key) {
      poolClause = "t.team_key IN (SELECT team_key FROM event_teams WHERE event_key = ?)";
      bindings.push(league.event_key);
    }

    const { results } = await c.env.DB.prepare(
      `SELECT t.team_key FROM teams t
       WHERE t.team_key NOT IN (SELECT team_key FROM draft_picks WHERE league_id = ?)
         AND t.team_key IN (${requested.map(() => "?").join(",")})
         AND ${poolClause}`,
    )
      .bind(...bindings)
      .all<{ team_key: string }>();

    // Re-sorted into the caller's order: the SQL result order is not the queue order.
    const allowed = new Set(results.map((row) => row.team_key));
    valid = requested.filter((key) => allowed.has(key));
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM draft_queues WHERE league_id = ? AND user_id = ?").bind(leagueId, user.id),
    ...valid.map((teamKey, index) =>
      c.env.DB.prepare(
        "INSERT INTO draft_queues (league_id, user_id, position, team_key) VALUES (?, ?, ?, ?)",
      ).bind(leagueId, user.id, index, teamKey),
    ),
  ]);

  return c.json({ teams: await readQueue(c.env.DB, league, user.id) });
});
