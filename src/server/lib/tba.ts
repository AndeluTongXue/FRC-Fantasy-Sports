const TBA_BASE = "https://www.thebluealliance.com/api/v3";

export class TbaError extends Error {
  constructor(
    public status: number,
    public path: string,
  ) {
    super(`TBA ${status} for ${path}`);
  }
}

export interface TbaTeam {
  key: string;
  team_number: number;
  nickname?: string | null;
  name?: string | null;
  city?: string | null;
  state_prov?: string | null;
  country?: string | null;
  rookie_year?: number | null;
}

export interface TbaEvent {
  key: string;
  year: number;
  name: string;
  short_name?: string | null;
  event_type?: number | null;
  event_type_string?: string | null;
  week?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  city?: string | null;
  state_prov?: string | null;
  country?: string | null;
}

export interface TbaMatch {
  key: string;
  event_key: string;
  comp_level: string;
  set_number?: number | null;
  match_number?: number | null;
  winning_alliance?: string | null;
  actual_time?: number | null;
  alliances: {
    red: { team_keys: string[]; score: number | null };
    blue: { team_keys: string[]; score: number | null };
  };
  score_breakdown?: Record<string, Record<string, unknown>> | null;
}

export interface TbaAward {
  event_key: string;
  award_type: number;
  name: string;
  recipient_list: { team_key?: string | null; awardee?: string | null }[];
}

export interface TbaAlliance {
  name?: string | null;
  picks: string[];
}

export class TbaClient {
  constructor(private readonly apiKey: string) {}

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${TBA_BASE}${path}`, {
      headers: { "X-TBA-Auth-Key": this.apiKey, Accept: "application/json" },
    });
    if (!response.ok) throw new TbaError(response.status, path);
    return response.json<T>();
  }

  /** TBA pages teams 500 at a time; walk until a page comes back empty. */
  async allTeams(year: number): Promise<TbaTeam[]> {
    const teams: TbaTeam[] = [];
    for (let page = 0; page < 25; page++) {
      const batch = await this.get<TbaTeam[]>(`/teams/${year}/${page}/simple`);
      if (batch.length === 0) break;
      teams.push(...batch);
    }
    return teams;
  }

  events(year: number) {
    return this.get<TbaEvent[]>(`/events/${year}`);
  }

  eventTeams(eventKey: string) {
    return this.get<TbaTeam[]>(`/event/${eventKey}/teams/simple`);
  }

  eventMatches(eventKey: string) {
    return this.get<TbaMatch[]>(`/event/${eventKey}/matches`);
  }

  eventAwards(eventKey: string) {
    return this.get<TbaAward[]>(`/event/${eventKey}/awards`);
  }

  eventAlliances(eventKey: string) {
    return this.get<TbaAlliance[] | null>(`/event/${eventKey}/alliances`);
  }

  teamEvents(teamKey: string, year: number) {
    return this.get<TbaEvent[]>(`/team/${teamKey}/events/${year}`);
  }
}
