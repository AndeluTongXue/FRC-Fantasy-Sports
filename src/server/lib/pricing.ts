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
