import { DEFAULT_TEAM_PRICE } from "./statbotics";

/** TBA event_type for Offseason events (e.g. Chezy Champs, IRI). */
const OFFSEASON_EVENT_TYPE = 99;

export interface LeaguePricingContext {
  league_type: string;
  event_key: string | null;
  season_year: number;
}

/**
 * Which cached EPA year a league should price its draft pool from.
 *
 * Normally that's the *previous* season's final EPA — the current season isn't over yet,
 * so its EPA is still incomplete and a poor stand-in for team strength. The one exception
 * is a single-event league tied to an Offseason event (Chezy Champs, IRI, etc.): those
 * happen after the season has fully concluded, so that season's own EPA is both final and
 * far more current than reaching back a year.
 */
export async function pricingYearForLeague(db: D1Database, league: LeaguePricingContext): Promise<number> {
  if (league.league_type === "single_event" && league.event_key) {
    const event = await db
      .prepare("SELECT event_type FROM events WHERE event_key = ?")
      .bind(league.event_key)
      .first<{ event_type: number | null }>();
    if (event?.event_type === OFFSEASON_EVENT_TYPE) return league.season_year;
  }
  return league.season_year - 1;
}

export interface RecommendedCapParams {
  league_type: string;
  event_key: string | null;
  season_year: number;
  roster_size: number;
  max_members: number;
}

export interface RecommendedCap {
  recommendedCap: number;
  averagePrice: number;
  sampleSize: number;
}

/**
 * A starting-point salary cap: the average price of a league's draftable pool, times how
 * many teams one owner drafts. That's a budget which lets an "average" roster be built at
 * roughly average prices, with room to spend more on stars and less on the rest.
 *
 * For a single-event league the pool is just every team at that event — small and bounded,
 * so a plain average is meaningful. A season-long league's pool is the *entire* season
 * (3000+ teams), most of which are far below what any real roster looks like, so a plain
 * average would recommend an unhelpfully tiny cap. Instead it estimates from the slice of
 * teams that could actually end up drafted — the top (maxMembers × rosterSize) priced
 * teams — since ownership is exclusive and a small league never drafts deep into the pool.
 */
export async function recommendedSalaryCap(
  db: D1Database,
  params: RecommendedCapParams,
): Promise<RecommendedCap | null> {
  const pricingYear = await pricingYearForLeague(db, params);

  if (params.league_type === "single_event" && params.event_key) {
    const row = await db
      .prepare(
        `SELECT AVG(COALESCE(p.price, ?)) AS avg_price, COUNT(*) AS n
         FROM event_teams et
         LEFT JOIN team_prices p ON p.team_key = et.team_key AND p.season_year = ?
         WHERE et.event_key = ?`,
      )
      .bind(DEFAULT_TEAM_PRICE, pricingYear, params.event_key)
      .first<{ avg_price: number | null; n: number }>();
    if (!row || row.n === 0) return null;
    return toRecommendation(row.avg_price ?? DEFAULT_TEAM_PRICE, row.n, params.roster_size);
  }

  const poolSize = Math.max(params.max_members * params.roster_size, 1);
  const row = await db
    .prepare(
      `SELECT AVG(price) AS avg_price, COUNT(*) AS n
       FROM (SELECT price FROM team_prices WHERE season_year = ? ORDER BY price DESC LIMIT ?)`,
    )
    .bind(pricingYear, poolSize)
    .first<{ avg_price: number | null; n: number }>();
  if (!row || row.n === 0) return null;
  return toRecommendation(row.avg_price ?? DEFAULT_TEAM_PRICE, row.n, params.roster_size);
}

function toRecommendation(averagePrice: number, sampleSize: number, rosterSize: number): RecommendedCap {
  return {
    averagePrice: Math.round(averagePrice * 10) / 10,
    recommendedCap: Math.round((averagePrice * rosterSize) / 5) * 5,
    sampleSize,
  };
}
