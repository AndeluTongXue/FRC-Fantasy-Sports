import { pickOwner } from "../../shared/types";
import { DEFAULT_TEAM_PRICE } from "./statbotics";

/** TBA event_type for Offseason events (e.g. Chezy Champs, IRI). */
const OFFSEASON_EVENT_TYPE = 99;

/** Hard bounds on a league's salary cap, enforced by the create and budget-edit endpoints.
 * The usable floor is per-league and higher — see `minimumSalaryCap`. The recommendation has
 * to land inside this range too, or "Use this" would hand back a value refused on save. */
export const MIN_SALARY_CAP = 50;
export const MAX_SALARY_CAP = 500;

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

export interface MinimumCapParams {
  league_type: string;
  event_key: string | null;
  season_year: number;
  roster_size: number;
  max_members: number;
}

export interface MinimumCap {
  minimumCap: number;
  /** The cap that makes for a good draft rather than a merely survivable one. Always at
   * least `minimumCap`, and inside [MIN_SALARY_CAP, MAX_SALARY_CAP] unless the minimum
   * itself is already above that ceiling. See `bestAvailableSnakeBill`. */
  recommendedCap: number;
  /** minimumCap / rosterSize, for a "per-team" figure to display alongside it. */
  worstCaseAveragePrice: number;
  /** How many cheaper teams the worst case assumes opponents hoard before this manager's
   * own picks land (≤ (maxMembers - 1) × rosterSize). */
  worstCaseOpponentPicks: number;
  /** Total teams in the relevant universe (event roster, or all cached teams for the year). */
  universeSize: number;
  /** True if there aren't even enough teams for every manager to fill a full roster —
   * no cap can fix that; roster size or manager count needs to come down instead. */
  insufficientPool: boolean;
}

/**
 * What the priciest draft slot ends up paying when everyone just takes the best team still
 * on the board — the basis for the recommended cap.
 *
 * Price tracks EPA, so "best available" and "priciest available" are the same pick, which
 * means the teams that actually get drafted are the top `maxMembers × rosterSize` of the
 * pool. Handing those out in the real snake order (the same `pickOwner` the draft room
 * advances turns with, so this can't drift from how a draft actually runs) gives each seat a
 * specific bundle; the snake evens the seats out but never perfectly, and one of them always
 * ends up with the biggest bill.
 *
 * A cap set there means no draft position is priced out of simply taking the best team
 * available — the default strategy stays open to everyone — while nobody can afford more
 * than roughly their fair share of the stars, so buying above average anywhere still forces
 * going below average somewhere else. That's the tradeoff a salary cap exists to create.
 * It lands a little above the plain market-clearing average (pool value ÷ managers) without
 * an arbitrary fudge factor, and stays well under the point where the cap stops binding at
 * all (the sum of the `rosterSize` priciest teams), since any one seat only ever lands one
 * of the very top teams.
 */
function bestAvailableSnakeBill(topPricesDesc: number[], maxMembers: number): number {
  const seats = Array.from({ length: maxMembers }, (_, index) => String(index));
  const bills = new Array<number>(maxMembers).fill(0);

  topPricesDesc.forEach((price, pickIndex) => {
    const seat = Number(pickOwner(seats, pickIndex));
    bills[seat] += price;
  });

  return Math.max(...bills);
}

/**
 * The smallest salary cap that's *guaranteed* safe: no matter how the draft unfolds, no
 * manager can be left unable to afford a full roster.
 *
 * Ownership is exclusive, so across the whole league at most (maxMembers × rosterSize)
 * teams ever get drafted. The adversarial case for any one manager isn't the globally
 * priciest teams — the other (maxMembers - 1) managers can only ever hoard away at most
 * (maxMembers - 1) × rosterSize teams between them, and a self-interested manager always
 * drafts the *cheapest* team still available on their turn. So the worst case is: opponents
 * grab the cheapest `otherCapacity` teams in the whole pool first, and this manager is left
 * to fill their roster from the cheapest `rosterSize` teams that remain *after* that — i.e.
 * the price-ascending slice starting right after `otherCapacity` teams, not the top
 * `rosterSize` most expensive teams overall (those can always be avoided whenever the pool
 * is bigger than what the league will ever actually draft). A cap at or above the sum of
 * that slice means that worst case is always affordable, which is exactly the guarantee the
 * live draft room's reserve-budget rule depends on to never strand a manager (see
 * DraftRoom's cheapestPrices/reserveCost check). Rounded *up* to the nearest $5 so rounding
 * can never eat into the safety margin.
 */
export async function minimumSalaryCap(db: D1Database, params: MinimumCapParams): Promise<MinimumCap | null> {
  const pricingYear = await pricingYearForLeague(db, params);
  const totalNeeded = Math.max(params.max_members * params.roster_size, 1);
  const otherCapacity = Math.max(totalNeeded - params.roster_size, 0);

  let universeSize: number;
  let worstCasePrices: number[];
  /** The teams that actually get drafted, priciest first — at most one per pick. */
  let draftedPrices: number[];

  if (params.league_type === "single_event" && params.event_key) {
    const countRow = await db
      .prepare("SELECT COUNT(*) AS n FROM event_teams WHERE event_key = ?")
      .bind(params.event_key)
      .first<{ n: number }>();
    universeSize = countRow?.n ?? 0;
    if (universeSize === 0) return null;

    const offset = Math.max(0, Math.min(otherCapacity, universeSize - params.roster_size));
    const { results } = await db
      .prepare(
        `SELECT COALESCE(p.price, ?) AS price
         FROM event_teams et
         LEFT JOIN team_prices p ON p.team_key = et.team_key AND p.season_year = ?
         WHERE et.event_key = ?
         ORDER BY price ASC
         LIMIT ? OFFSET ?`,
      )
      .bind(DEFAULT_TEAM_PRICE, pricingYear, params.event_key, params.roster_size, offset)
      .all<{ price: number }>();
    worstCasePrices = results.map((row) => row.price);

    const top = await db
      .prepare(
        `SELECT COALESCE(p.price, ?) AS price
         FROM event_teams et
         LEFT JOIN team_prices p ON p.team_key = et.team_key AND p.season_year = ?
         WHERE et.event_key = ?
         ORDER BY price DESC
         LIMIT ?`,
      )
      .bind(DEFAULT_TEAM_PRICE, pricingYear, params.event_key, Math.min(totalNeeded, universeSize))
      .all<{ price: number }>();
    draftedPrices = top.results.map((row) => row.price);
  } else {
    const countRow = await db
      .prepare("SELECT COUNT(*) AS n FROM team_prices WHERE season_year = ?")
      .bind(pricingYear)
      .first<{ n: number }>();
    universeSize = countRow?.n ?? 0;
    if (universeSize === 0) return null;

    const offset = Math.max(0, Math.min(otherCapacity, universeSize - params.roster_size));
    const { results } = await db
      .prepare("SELECT price FROM team_prices WHERE season_year = ? ORDER BY price ASC LIMIT ? OFFSET ?")
      .bind(pricingYear, params.roster_size, offset)
      .all<{ price: number }>();
    worstCasePrices = results.map((row) => row.price);

    const top = await db
      .prepare("SELECT price FROM team_prices WHERE season_year = ? ORDER BY price DESC LIMIT ?")
      .bind(pricingYear, Math.min(totalNeeded, universeSize))
      .all<{ price: number }>();
    draftedPrices = top.results.map((row) => row.price);
  }

  if (worstCasePrices.length === 0) return null;

  const rawMinimum = worstCasePrices.reduce((sum, price) => sum + price, 0);
  const minimumCap = Math.ceil(rawMinimum / 5) * 5;

  // Clamped into the range the save endpoints accept, then floored at the minimum — a
  // recommendation below the minimum would be refused on save, and a pool expensive enough
  // to push the minimum past the ceiling has no valid cap to recommend anyway.
  const rawRecommended = Math.ceil(bestAvailableSnakeBill(draftedPrices, params.max_members) / 5) * 5;
  const recommendedCap = Math.max(
    Math.min(Math.max(rawRecommended, MIN_SALARY_CAP), MAX_SALARY_CAP),
    minimumCap,
  );

  return {
    minimumCap,
    recommendedCap,
    worstCaseAveragePrice: Math.round((minimumCap / params.roster_size) * 10) / 10,
    worstCaseOpponentPicks: Math.min(otherCapacity, Math.max(universeSize - params.roster_size, 0)),
    universeSize,
    insufficientPool: universeSize < totalNeeded,
  };
}
