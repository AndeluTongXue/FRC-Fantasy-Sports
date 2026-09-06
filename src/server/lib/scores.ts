import { CHAMPIONSHIP_EVENT_TYPES, SEASON_EXCLUDED_EVENT_TYPES, scoreEvent } from "../../shared/scoring";
import type { EventResults } from "../../shared/scoring";
import type { ScoringConfig } from "../../shared/types";
import type { Env } from "./env";
import { syncEventResults, syncEventTeams } from "./sync";
import { TbaClient } from "./tba";

interface LeagueScoringRow {
  id: string;
  league_type: string;
  event_key: string | null;
  season_year: number;
  scoring_config: string;
}

async function loadEventResults(env: Env, eventKey: string): Promise<EventResults> {
  const [event, matches, awards, alliances] = await Promise.all([
    env.DB.prepare("SELECT event_type FROM events WHERE event_key = ?")
      .bind(eventKey)
      .first<{ event_type: number | null }>(),
    env.DB.prepare(
      `SELECT comp_level, red_teams, blue_teams, winning_alliance, score_breakdown
       FROM matches WHERE event_key = ?`,
    )
      .bind(eventKey)
      .all<{
        comp_level: string;
        red_teams: string;
        blue_teams: string;
        winning_alliance: string | null;
        score_breakdown: string | null;
      }>(),
    env.DB.prepare("SELECT award_type, team_key FROM awards WHERE event_key = ?")
      .bind(eventKey)
      .all<{ award_type: number; team_key: string }>(),
    env.DB.prepare("SELECT pick_index, team_key FROM alliances WHERE event_key = ?")
      .bind(eventKey)
      .all<{ pick_index: number; team_key: string }>(),
  ]);

  return {
    matches: matches.results.map((row) => {
      const breakdown = row.score_breakdown
        ? (JSON.parse(row.score_breakdown) as { red?: { rp?: number }; blue?: { rp?: number } })
        : null;
      return {
        compLevel: row.comp_level,
        redTeams: JSON.parse(row.red_teams) as string[],
        blueTeams: JSON.parse(row.blue_teams) as string[],
        winningAlliance: row.winning_alliance || null,
        redRp: breakdown?.red?.rp ?? null,
        blueRp: breakdown?.blue?.rp ?? null,
      };
    }),
    awards: awards.results.map((row) => ({ awardType: row.award_type, teamKey: row.team_key })),
    alliances: alliances.results.map((row) => ({ pickIndex: row.pick_index, teamKey: row.team_key })),
    isChampionship: CHAMPIONSHIP_EVENT_TYPES.includes(event?.event_type ?? -1),
  };
}

/**
 * Which events can earn a league points: the one it's tied to (whatever type it is —
 * that's an explicit choice), or — for a season league — every cached in-season event a
 * rostered team attended. Reads only local data so scoring never depends on an external
 * API being up.
 */
async function relevantEvents(env: Env, league: LeagueScoringRow, teamKeys: string[]): Promise<string[]> {
  if (league.league_type === "single_event") return league.event_key ? [league.event_key] : [];
  if (teamKeys.length === 0) return [];

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT et.event_key
     FROM event_teams et JOIN events e ON e.event_key = et.event_key
     WHERE e.year = ? AND et.team_key IN (${teamKeys.map(() => "?").join(",")})
       AND e.event_type NOT IN (${SEASON_EXCLUDED_EVENT_TYPES.map(() => "?").join(",")})`,
  )
    .bind(league.season_year, ...teamKeys, ...SEASON_EXCLUDED_EVENT_TYPES)
    .all<{ event_key: string }>();
  return results.map((row) => row.event_key);
}

/**
 * Recomputes every rostered team's points for a league and rewrites `fantasy_scores`.
 * Season leagues simply accumulate across every event their teams attend, which is why
 * teams competing on different weekends need no special scheduling handling.
 */
export async function recomputeLeagueScores(env: Env, leagueId: string): Promise<number> {
  const league = await env.DB.prepare(
    "SELECT id, league_type, event_key, season_year, scoring_config FROM leagues WHERE id = ?",
  )
    .bind(leagueId)
    .first<LeagueScoringRow>();
  if (!league) return 0;

  const config = JSON.parse(league.scoring_config) as ScoringConfig;
  const { results: roster } = await env.DB.prepare(
    "SELECT team_key, user_id FROM draft_picks WHERE league_id = ?",
  )
    .bind(leagueId)
    .all<{ team_key: string; user_id: string }>();
  if (roster.length === 0) return 0;

  const ownerOf = new Map(roster.map((pick) => [pick.team_key, pick.user_id]));
  const eventKeys = await relevantEvents(env, league, [...ownerOf.keys()]);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM fantasy_scores WHERE league_id = ?").bind(leagueId),
  ];

  for (const eventKey of eventKeys) {
    const scores = scoreEvent(await loadEventResults(env, eventKey), config);
    for (const score of scores) {
      const userId = ownerOf.get(score.teamKey);
      if (!userId) continue;
      statements.push(
        env.DB.prepare(
          `INSERT INTO fantasy_scores (league_id, team_key, event_key, user_id, points, breakdown, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          leagueId,
          score.teamKey,
          eventKey,
          userId,
          score.points,
          JSON.stringify(score.breakdown),
          now,
        ),
      );
    }
  }

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  return statements.length - 1;
}

/**
 * Backfill: asks TBA which events this league's teams attended, caches those events'
 * rosters and results, then rescores. This is the only path that hits TBA for discovery —
 * the routine cron recompute works purely off cached data.
 */
export async function syncAndScoreLeague(env: Env, leagueId: string): Promise<number> {
  const league = await env.DB.prepare(
    "SELECT id, league_type, event_key, season_year, scoring_config FROM leagues WHERE id = ?",
  )
    .bind(leagueId)
    .first<LeagueScoringRow>();
  if (!league) return 0;

  const { results: roster } = await env.DB.prepare(
    "SELECT DISTINCT team_key FROM draft_picks WHERE league_id = ?",
  )
    .bind(leagueId)
    .all<{ team_key: string }>();

  const eventKeys = new Set<string>();
  if (league.league_type === "single_event" && league.event_key) {
    eventKeys.add(league.event_key);
  } else {
    const tba = new TbaClient(env.TBA_API_KEY);
    for (const row of roster) {
      for (const event of await tba.teamEvents(row.team_key, league.season_year)) {
        if (SEASON_EXCLUDED_EVENT_TYPES.includes(event.event_type ?? -1)) continue;
        eventKeys.add(event.key);
      }
    }
  }

  for (const eventKey of eventKeys) {
    await syncEventTeams(env, eventKey);
    await syncEventResults(env, eventKey);
  }
  return recomputeLeagueScores(env, leagueId);
}
