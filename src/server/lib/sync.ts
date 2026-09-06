import type { Env } from "./env";
import { TbaClient } from "./tba";

/** D1 caps statements per batch, so writes go out in chunks. */
async function runBatched(db: D1Database, statements: D1PreparedStatement[], chunkSize = 50): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}

export async function syncTeams(env: Env, year: number): Promise<number> {
  const tba = new TbaClient(env.TBA_API_KEY);
  const teams = await tba.allTeams(year);
  const now = Date.now();

  const statements = teams.map((team) =>
    env.DB.prepare(
      `INSERT INTO teams (team_key, team_number, nickname, name, city, state_prov, country, rookie_year, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_key) DO UPDATE SET
         team_number = excluded.team_number, nickname = excluded.nickname, name = excluded.name,
         city = excluded.city, state_prov = excluded.state_prov, country = excluded.country,
         rookie_year = excluded.rookie_year, updated_at = excluded.updated_at`,
    ).bind(
      team.key,
      team.team_number,
      team.nickname ?? null,
      team.name ?? null,
      team.city ?? null,
      team.state_prov ?? null,
      team.country ?? null,
      team.rookie_year ?? null,
      now,
    ),
  );

  await runBatched(env.DB, statements);
  return teams.length;
}

export async function syncEvents(env: Env, year: number): Promise<number> {
  const tba = new TbaClient(env.TBA_API_KEY);
  const events = await tba.events(year);
  const now = Date.now();

  const statements = events.map((event) =>
    env.DB.prepare(
      `INSERT INTO events (event_key, year, name, short_name, event_type, event_type_string, week,
                           start_date, end_date, city, state_prov, country, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO UPDATE SET
         year = excluded.year, name = excluded.name, short_name = excluded.short_name,
         event_type = excluded.event_type, event_type_string = excluded.event_type_string,
         week = excluded.week, start_date = excluded.start_date, end_date = excluded.end_date,
         city = excluded.city, state_prov = excluded.state_prov, country = excluded.country,
         updated_at = excluded.updated_at`,
    ).bind(
      event.key,
      event.year,
      event.name,
      event.short_name ?? null,
      event.event_type ?? null,
      event.event_type_string ?? null,
      event.week ?? null,
      event.start_date ?? null,
      event.end_date ?? null,
      event.city ?? null,
      event.state_prov ?? null,
      event.country ?? null,
      now,
    ),
  );

  await runBatched(env.DB, statements);
  return events.length;
}

export async function syncEventTeams(env: Env, eventKey: string): Promise<number> {
  const tba = new TbaClient(env.TBA_API_KEY);
  const teams = await tba.eventTeams(eventKey);
  const now = Date.now();

  const statements: D1PreparedStatement[] = [];
  for (const team of teams) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO teams (team_key, team_number, nickname, name, city, state_prov, country, rookie_year, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_key) DO UPDATE SET
           nickname = excluded.nickname, name = excluded.name, updated_at = excluded.updated_at`,
      ).bind(
        team.key,
        team.team_number,
        team.nickname ?? null,
        team.name ?? null,
        team.city ?? null,
        team.state_prov ?? null,
        team.country ?? null,
        team.rookie_year ?? null,
        now,
      ),
      env.DB.prepare("INSERT OR IGNORE INTO event_teams (event_key, team_key) VALUES (?, ?)").bind(
        eventKey,
        team.key,
      ),
    );
  }

  await runBatched(env.DB, statements);
  return teams.length;
}

/** Pulls the results an event's fantasy scoring depends on: matches, awards, alliance selections. */
export async function syncEventResults(env: Env, eventKey: string): Promise<{
  matches: number;
  awards: number;
  alliances: number;
}> {
  const tba = new TbaClient(env.TBA_API_KEY);
  const [matches, awards, alliances] = await Promise.all([
    tba.eventMatches(eventKey),
    tba.eventAwards(eventKey),
    tba.eventAlliances(eventKey),
  ]);
  const now = Date.now();

  const statements: D1PreparedStatement[] = matches.map((match) =>
    env.DB.prepare(
      `INSERT INTO matches (match_key, event_key, comp_level, set_number, match_number, red_teams, blue_teams,
                            red_score, blue_score, winning_alliance, score_breakdown, actual_time, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_key) DO UPDATE SET
         red_score = excluded.red_score, blue_score = excluded.blue_score,
         winning_alliance = excluded.winning_alliance, score_breakdown = excluded.score_breakdown,
         actual_time = excluded.actual_time, updated_at = excluded.updated_at`,
    ).bind(
      match.key,
      match.event_key,
      match.comp_level,
      match.set_number ?? null,
      match.match_number ?? null,
      JSON.stringify(match.alliances.red.team_keys),
      JSON.stringify(match.alliances.blue.team_keys),
      match.alliances.red.score,
      match.alliances.blue.score,
      match.winning_alliance ?? null,
      match.score_breakdown ? JSON.stringify(match.score_breakdown) : null,
      match.actual_time ?? null,
      now,
    ),
  );

  statements.push(env.DB.prepare("DELETE FROM awards WHERE event_key = ?").bind(eventKey));
  let awardRows = 0;
  for (const award of awards) {
    for (const recipient of award.recipient_list) {
      if (!recipient.team_key) continue;
      awardRows++;
      statements.push(
        env.DB.prepare(
          "INSERT OR REPLACE INTO awards (event_key, award_type, name, team_key) VALUES (?, ?, ?, ?)",
        ).bind(eventKey, award.award_type, award.name, recipient.team_key),
      );
    }
  }

  statements.push(env.DB.prepare("DELETE FROM alliances WHERE event_key = ?").bind(eventKey));
  let allianceRows = 0;
  (alliances ?? []).forEach((alliance, index) => {
    alliance.picks.forEach((teamKey, pickIndex) => {
      allianceRows++;
      statements.push(
        env.DB.prepare(
          "INSERT OR REPLACE INTO alliances (event_key, alliance_number, pick_index, team_key) VALUES (?, ?, ?, ?)",
        ).bind(eventKey, index + 1, pickIndex, teamKey),
      );
    });
  });

  await runBatched(env.DB, statements);
  return { matches: matches.length, awards: awardRows, alliances: allianceRows };
}

/** Events whose date window includes today — the ones worth polling frequently. */
export async function activeEventKeys(env: Env, year: number): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT event_key FROM events
     WHERE year = ? AND start_date <= ? AND date(end_date, '+1 day') >= ?`,
  )
    .bind(year, today, today)
    .all<{ event_key: string }>();
  return results.map((row) => row.event_key);
}
