import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";

interface ScoreEntry {
  teamKey: string;
  teamNumber: number | null;
  nickname: string | null;
  eventKey: string;
  eventName: string | null;
  week: number | null;
  points: number;
  breakdown: Record<string, number>;
  counted: boolean;
}

interface OwnerStanding {
  userId: string;
  displayName: string;
  rosterName: string;
  points: number;
  entries: ScoreEntry[];
}

const breakdownLabels: Record<string, string> = {
  qualWins: "Qual wins",
  qualTies: "Qual ties",
  rankingPoints: "Ranking points",
  allianceSelection: "Alliance selection",
  playoffWins: "Playoff wins",
  eventWinner: "Event win",
  eventFinalist: "Finalist",
  awards: "Awards",
};

export function Standings() {
  const { leagueId = "" } = useParams();
  const [standings, setStandings] = useState<OwnerStanding[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [regularSeasonCap, setRegularSeasonCap] = useState(2);

  async function load() {
    const data = await api.get<{ standings: OwnerStanding[]; regularSeasonEventCap: number }>(
      `/leagues/${leagueId}/standings`,
    );
    setStandings(data.standings);
    setRegularSeasonCap(data.regularSeasonEventCap);
  }

  useEffect(() => {
    load()
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Failed to load standings"))
      .finally(() => setLoading(false));
  }, [leagueId]);

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      await api.post(`/leagues/${leagueId}/refresh-scores`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not refresh scores");
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-600">Loading…</p>;

  const leader = standings[0]?.points ?? 0;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link to={`/leagues/${leagueId}`} className="text-sm text-slate-600 hover:text-slate-900">
          ← Back to league
        </Link>
        <h1 className="flex-1 text-xl font-semibold">Standings</h1>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="rounded-md border border-edge bg-surface px-3 py-2 text-sm hover:border-sky-600 hover:bg-cream disabled:opacity-50"
        >
          {refreshing ? "Pulling results…" : "Refresh from TBA"}
        </button>
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {standings.every((owner) => owner.points === 0) && (
        <p className="mb-4 rounded-md border border-edge bg-surface px-4 py-3 text-sm text-slate-600">
          No results scored yet. Hit “Refresh from TBA” once your teams have played.
        </p>
      )}

      <p className="mb-4 text-xs text-slate-500">
        Each team's best {regularSeasonCap} regular-season events count toward the total — district and
        championship events always count in full. Events beyond the best {regularSeasonCap} are shown
        greyed out below.
      </p>

      <div className="space-y-3">
        {standings.map((owner, index) => (
          <div key={owner.userId} className="rounded-lg border border-edge bg-surface">
            <button
              type="button"
              onClick={() => setExpanded(expanded === owner.userId ? null : owner.userId)}
              className="flex w-full items-center gap-4 px-4 py-3 text-left"
            >
              <span className="w-6 font-mono text-lg text-slate-500">{index + 1}</span>
              <span className="flex-1">
                <span className="block font-medium">{owner.rosterName}</span>
                <span className="text-xs text-slate-500">{owner.displayName}</span>
              </span>
              <span className="text-right">
                <span className="block font-mono text-lg">{Math.round(owner.points)}</span>
                {index > 0 && (
                  <span className="text-xs text-slate-500">−{Math.round(leader - owner.points)}</span>
                )}
              </span>
              <span className="text-slate-400">{expanded === owner.userId ? "▲" : "▼"}</span>
            </button>

            {expanded === owner.userId && (
              <div className="border-t border-edge px-4 py-3">
                {owner.entries.length === 0 ? (
                  <p className="text-sm text-slate-500">No scored events yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {owner.entries.map((entry) => (
                      <li
                        key={`${entry.teamKey}-${entry.eventKey}`}
                        className={entry.counted ? undefined : "opacity-40"}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm">
                            <span className="font-mono font-semibold text-sky-600">{entry.teamNumber}</span>{" "}
                            <span className="text-slate-700">{entry.nickname}</span>
                            <span className="ml-2 text-xs text-slate-500">
                              {entry.eventName ?? entry.eventKey}
                            </span>
                            {!entry.counted && (
                              <span className="ml-2 rounded bg-cream px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                                Not counted
                              </span>
                            )}
                          </span>
                          <span className="font-mono text-sm">{Math.round(entry.points)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                          {Object.entries(entry.breakdown).map(([key, value]) => (
                            <span key={key}>
                              {breakdownLabels[key] ?? key} {Math.round(value)}
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
