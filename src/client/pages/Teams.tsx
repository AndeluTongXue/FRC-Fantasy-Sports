import { useEffect, useState } from "react";
import type { PricedTeam } from "../../shared/types";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export function Teams() {
  const { user } = useAuth();
  const [teams, setTeams] = useState<PricedTeam[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pricing, setPricing] = useState(false);
  const [priceMessage, setPriceMessage] = useState("");
  const [priceYear, setPriceYear] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .get<{ teams: PricedTeam[] }>(`/teams?limit=100&search=${encodeURIComponent(search)}`)
        .then((data) => setTeams(data.teams))
        .catch((caught) => setError(caught instanceof Error ? caught.message : "Failed to load teams"))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  async function syncTeams() {
    setSyncing(true);
    setError("");
    try {
      await api.post("/admin/sync/teams");
      const data = await api.get<{ teams: PricedTeam[] }>("/teams?limit=100");
      setTeams(data.teams);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  /** Re-runs the Statbotics pricing job. Takes a while — it pages through the whole
   * season's EPA — so this can run long enough to be worth a distinct "in progress"
   * message rather than just reusing the team-sync spinner.
   *
   * Defaults to last year's final EPA (the normal case). Leagues tied to an Offseason
   * event (Chezy Champs, IRI, etc.) price from the *current* season's EPA instead — once
   * that season has concluded, override the year field with it to (re)price those pools. */
  async function priceTeams() {
    setPricing(true);
    setError("");
    setPriceMessage("");
    try {
      const path = priceYear.trim() ? `/admin/price-teams?year=${encodeURIComponent(priceYear.trim())}` : "/admin/price-teams";
      const result = await api.post<{ priced: number; epaYear: number }>(path);
      const data = await api.get<{ teams: PricedTeam[] }>(`/teams?limit=100&search=${encodeURIComponent(search)}`);
      setTeams(data.teams);
      setPriceMessage(`Priced ${result.priced} teams from ${result.epaYear} Statbotics EPA.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Pricing failed");
    } finally {
      setPricing(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Teams</h1>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by number or nickname…"
          className="flex-1 rounded-md border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-sky-500 sm:max-w-xs"
        />
        {user?.isAdmin && (
          <>
            <button
              type="button"
              onClick={syncTeams}
              disabled={syncing}
              className="rounded-md border border-edge bg-surface px-3 py-2 text-sm hover:border-sky-600 hover:bg-cream disabled:opacity-50"
            >
              {syncing ? "Syncing…" : "Sync from TBA"}
            </button>
            <input
              type="number"
              value={priceYear}
              onChange={(event) => setPriceYear(event.target.value)}
              placeholder="EPA year"
              title="Defaults to last season. Override with the current season year to price leagues tied to an Offseason event (Chezy Champs, IRI, etc.) once that season has concluded."
              className="w-24 rounded-md border border-edge bg-surface px-2 py-2 text-sm outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={priceTeams}
              disabled={pricing}
              className="rounded-md border border-edge bg-surface px-3 py-2 text-sm hover:border-sky-600 hover:bg-cream disabled:opacity-50"
            >
              {pricing ? "Pricing…" : "Re-price from Statbotics"}
            </button>
          </>
        )}
      </div>

      {user?.isAdmin && (
        <p className="-mt-4 mb-4 text-xs text-slate-500">
          EPA year defaults to last season. Leagues tied to an Offseason event (Chezy Champs, IRI, etc.) price
          from the current season's EPA instead — enter it once that season has concluded to (re)price those
          pools.
        </p>
      )}

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {priceMessage && <p className="mb-4 text-sm text-emerald-700">{priceMessage}</p>}

      {loading ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : teams.length === 0 ? (
        <div className="rounded-lg border border-edge bg-surface p-8 text-center">
          <p className="mb-2 text-slate-700">No teams cached yet.</p>
          <p className="text-sm text-slate-500">
            {user?.isAdmin
              ? "Hit “Sync from TBA” to pull the team list from The Blue Alliance."
              : "An admin needs to sync the team list from The Blue Alliance."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-edge">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Team</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Location</th>
                <th className="px-4 py-2 text-right font-medium">Price</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team.teamKey} className="border-t border-edge bg-surface/50">
                  <td className="px-4 py-2 font-mono font-semibold text-sky-600">{team.teamNumber}</td>
                  <td className="px-4 py-2">{team.nickname ?? "—"}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {[team.city, team.stateProv, team.country].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {team.price === null ? <span className="text-slate-400">—</span> : `$${team.price}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
