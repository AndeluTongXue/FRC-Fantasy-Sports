import type { Env } from "./env";

const STATBOTICS_BASE = "https://api.statbotics.io/v3";
const PAGE_SIZE = 1000;

/** Fallback for teams with no prior-season EPA (rookies, or a team that sat out). */
export const DEFAULT_TEAM_PRICE = 10;

interface StatboticsTeamYear {
  team: number;
  epa: {
    total_points: number | null;
    ranks?: { total?: { percentile?: number | null } | null } | null;
  } | null;
}

/**
 * Percentile → price. Steep at the top so the best teams cost a real share of the cap:
 * with the default $200 cap and 6 roster slots you can afford roughly one elite team
 * plus a solid core, not two superstars.
 */
function priceForPercentile(percentile: number): number {
  if (percentile >= 0.995) return 75;
  if (percentile >= 0.98) return 62;
  if (percentile >= 0.95) return 52;
  if (percentile >= 0.9) return 44;
  if (percentile >= 0.8) return 36;
  if (percentile >= 0.65) return 28;
  if (percentile >= 0.5) return 22;
  if (percentile >= 0.35) return 17;
  if (percentile >= 0.2) return 12;
  if (percentile >= 0.1) return 8;
  return 5;
}

/** Statbotics drops requests often enough that a single 503 shouldn't fail the whole job. */
async function fetchPage(year: number, offset: number): Promise<StatboticsTeamYear[]> {
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    try {
      const response = await fetch(
        `${STATBOTICS_BASE}/team_years?year=${year}&limit=${PAGE_SIZE}&offset=${offset}`,
        { headers: { Accept: "application/json" } },
      );
      if (response.ok) return await response.json<StatboticsTeamYear[]>();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "network error";
    }
  }
  throw new Error(`Statbotics unavailable (${lastError})`);
}

async function writePrices(env: Env, epaYear: number, page: StatboticsTeamYear[]): Promise<number> {
  const now = Date.now();
  const statements = page
    .filter((entry) => entry.epa?.ranks?.total?.percentile != null)
    .map((entry) =>
      env.DB.prepare(
        `INSERT INTO team_prices (season_year, team_key, price, epa, source, updated_at)
         VALUES (?, ?, ?, ?, 'statbotics', ?)
         ON CONFLICT(season_year, team_key) DO UPDATE SET
           price = excluded.price, epa = excluded.epa,
           source = excluded.source, updated_at = excluded.updated_at`,
      ).bind(
        epaYear,
        `frc${entry.team}`,
        priceForPercentile(entry.epa!.ranks!.total!.percentile!),
        entry.epa!.total_points,
        now,
      ),
    );

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  return statements.length;
}

/**
 * Caches final EPA from Statbotics for `epaYear`, one row per team keyed by that literal
 * year (not a "target season" derived from it) — so a league drafting from prior-season
 * EPA and a league drafting from the just-finished season's EPA can both have cached
 * prices at once without overwriting each other. See `pricingYearForLeague` for which
 * year applies to which league. Statbotics is only read here — never during a draft or
 * in-season scoring — and each page is written as it arrives, so a mid-run outage keeps
 * its progress and re-running just fills in the rest.
 */
export async function priceTeamsFromStatbotics(env: Env, epaYear: number): Promise<{ priced: number; epaYear: number }> {
  let priced = 0;

  for (let offset = 0; offset < 10_000; offset += PAGE_SIZE) {
    const page = await fetchPage(epaYear, offset);
    priced += await writePrices(env, epaYear, page);
    if (page.length < PAGE_SIZE) break;
  }

  return { priced, epaYear };
}
