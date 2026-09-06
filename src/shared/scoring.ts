import type { ScoringConfig } from "./types";

/** TBA award_type values the default scoring treats specially. */
const AWARD_IMPACT = 0;
const AWARD_WINNER = 1;
const AWARD_FINALIST = 2;
const AWARD_ENGINEERING_INSPIRATION = 9;

/** TBA event_type values for Championship divisions and Einstein. */
export const CHAMPIONSHIP_EVENT_TYPES = [3, 4];

/**
 * TBA event_type values exempt from the regular-season cap below: District Championship,
 * District Championship Division, Championship Division, Championship Finals (Einstein).
 * Regional (0) and District (1) events are the ones that get capped.
 */
export const CAP_EXEMPT_EVENT_TYPES = [2, 3, 4, 5];

/**
 * A season-long roster only counts a team's best N regular-season events toward its
 * total — the same shape as FRC's own district point system (best 2 regular events, plus
 * district/season championships in full) — so a team that happens to attend more events
 * doesn't automatically outscore one that attends fewer but performs just as well.
 */
export const REGULAR_SEASON_EVENT_CAP = 2;

/**
 * TBA event_type values a season-long league never earns points from: Offseason (99) and
 * Preseason (100) aren't part of the official season, so they're dropped entirely rather
 * than competing for a team's capped regular-season slots. A single-event league tied
 * explicitly to one of these (e.g. an offseason event) is unaffected — this only prunes
 * the season-long "every event a team attended" discovery.
 */
export const SEASON_EXCLUDED_EVENT_TYPES = [99, 100];

export interface CappableEventScore {
  eventKey: string;
  eventType: number | null;
  points: number;
}

/**
 * Marks which of a single team's event scores count toward its season total: every
 * cap-exempt event, plus its best `REGULAR_SEASON_EVENT_CAP` regular-season events.
 * Call once per team — the cap is per team, not per owner or per league.
 */
export function applySeasonCap<T extends CappableEventScore>(entries: T[]): (T & { counted: boolean })[] {
  const exempt = entries.filter((entry) => CAP_EXEMPT_EVENT_TYPES.includes(entry.eventType ?? -1));
  const capped = entries.filter((entry) => !CAP_EXEMPT_EVENT_TYPES.includes(entry.eventType ?? -1));
  const bestCapped = new Set(
    [...capped]
      .sort((a, b) => b.points - a.points)
      .slice(0, REGULAR_SEASON_EVENT_CAP)
      .map((entry) => entry.eventKey),
  );
  const exemptKeys = new Set(exempt.map((entry) => entry.eventKey));

  return entries.map((entry) => ({
    ...entry,
    counted: exemptKeys.has(entry.eventKey) || bestCapped.has(entry.eventKey),
  }));
}

export interface ScoringMatch {
  compLevel: string;
  redTeams: string[];
  blueTeams: string[];
  winningAlliance: string | null;
  redRp: number | null;
  blueRp: number | null;
}

export interface ScoringAward {
  awardType: number;
  teamKey: string;
}

export interface ScoringAlliancePick {
  pickIndex: number;
  teamKey: string;
}

export interface EventResults {
  matches: ScoringMatch[];
  awards: ScoringAward[];
  alliances: ScoringAlliancePick[];
  isChampionship: boolean;
}

export interface TeamEventScore {
  teamKey: string;
  points: number;
  breakdown: Record<string, number>;
}

function add(scores: Map<string, Record<string, number>>, teamKey: string, key: string, value: number) {
  if (value === 0) return;
  const entry = scores.get(teamKey) ?? {};
  entry[key] = (entry[key] ?? 0) + value;
  scores.set(teamKey, entry);
}

/**
 * Fantasy points every team earned at one event, from TBA results only.
 * Pure and deterministic, so re-running a sync just overwrites the same numbers.
 */
export function scoreEvent(results: EventResults, config: ScoringConfig): TeamEventScore[] {
  const breakdowns = new Map<string, Record<string, number>>();

  for (const match of results.matches) {
    const isQual = match.compLevel === "qm";
    const sides = [
      { teams: match.redTeams, won: match.winningAlliance === "red", rp: match.redRp },
      { teams: match.blueTeams, won: match.winningAlliance === "blue", rp: match.blueRp },
    ];
    const tie = !match.winningAlliance;

    for (const side of sides) {
      for (const teamKey of side.teams) {
        if (isQual) {
          if (side.won) add(breakdowns, teamKey, "qualWins", config.qualWin);
          else if (tie) add(breakdowns, teamKey, "qualTies", config.qualTie);
          add(breakdowns, teamKey, "rankingPoints", (side.rp ?? 0) * config.rankingPoint);
        } else if (side.won) {
          add(breakdowns, teamKey, "playoffWins", config.playoffWin);
        }
      }
    }
  }

  const pickValues = [
    config.allianceCaptain,
    config.alliancePick1,
    config.alliancePick2,
    config.alliancePick3,
  ];
  for (const pick of results.alliances) {
    add(breakdowns, pick.teamKey, "allianceSelection", pickValues[pick.pickIndex] ?? 0);
  }

  for (const award of results.awards) {
    if (award.awardType === AWARD_WINNER) {
      add(breakdowns, award.teamKey, "eventWinner", config.eventWinner);
    } else if (award.awardType === AWARD_FINALIST) {
      add(breakdowns, award.teamKey, "eventFinalist", config.eventFinalist);
    } else if (award.awardType === AWARD_IMPACT) {
      add(breakdowns, award.teamKey, "awards", config.awardImpact);
    } else if (award.awardType === AWARD_ENGINEERING_INSPIRATION) {
      add(breakdowns, award.teamKey, "awards", config.awardEngineeringInspiration);
    } else {
      add(breakdowns, award.teamKey, "awards", config.awardOther);
    }
  }

  const multiplier = results.isChampionship ? config.championshipMultiplier : 1;

  return [...breakdowns].map(([teamKey, breakdown]) => {
    const scaled = Object.fromEntries(
      Object.entries(breakdown).map(([key, value]) => [key, value * multiplier]),
    );
    return {
      teamKey,
      points: Object.values(scaled).reduce((total, value) => total + value, 0),
      breakdown: scaled,
    };
  });
}
