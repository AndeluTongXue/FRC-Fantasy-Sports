import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { FrcEvent } from "../../shared/types";
import { api } from "../lib/api";

interface MinimumCap {
  minimumCap: number;
  worstCaseAveragePrice: number;
  poolSize: number;
  universeSize: number;
  insufficientPool: boolean;
}

interface LeagueSummary {
  id: string;
  name: string;
  leagueType: string;
  eventKey: string | null;
  inviteCode: string;
  status: string;
  rosterSize: number;
  salaryCap: number;
  memberCount: number;
}

const statusLabels: Record<string, string> = {
  setup: "Waiting for owners",
  drafting: "Draft in progress",
  active: "Season underway",
  complete: "Finished",
};

export function Leagues() {
  const [leagues, setLeagues] = useState<LeagueSummary[]>([]);
  const [events, setEvents] = useState<FrcEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"none" | "create" | "join">("none");

  const [name, setName] = useState("");
  const [leagueType, setLeagueType] = useState<"single_event" | "season">("single_event");
  const [eventKey, setEventKey] = useState("");
  const [rosterSize, setRosterSize] = useState(6);
  const [maxMembers, setMaxMembers] = useState(8);
  const [salaryCap, setSalaryCap] = useState(200);
  const [inviteCode, setInviteCode] = useState("");
  const [minimumCap, setMinimumCap] = useState<MinimumCap | null>(null);

  async function refresh() {
    const data = await api.get<{ leagues: LeagueSummary[] }>("/leagues");
    setLeagues(data.leagues);
  }

  useEffect(() => {
    refresh()
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Failed to load leagues"))
      .finally(() => setLoading(false));
    api
      .get<{ events: FrcEvent[] }>("/events")
      .then((data) => setEvents(data.events))
      .catch(() => setEvents([]));
  }, []);

  useEffect(() => {
    if (leagueType === "single_event" && !eventKey) {
      setMinimumCap(null);
      return;
    }
    const params = new URLSearchParams({
      leagueType,
      rosterSize: String(rosterSize),
      maxMembers: String(maxMembers),
    });
    if (eventKey) params.set("eventKey", eventKey);

    const timer = setTimeout(() => {
      api
        .get<MinimumCap>(`/leagues/minimum-cap?${params}`)
        .then(setMinimumCap)
        .catch(() => setMinimumCap(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [leagueType, eventKey, rosterSize, maxMembers]);

  async function createLeague(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.post("/leagues", {
        name,
        leagueType,
        eventKey: leagueType === "single_event" ? eventKey : null,
        rosterSize,
        maxMembers,
        salaryCap,
      });
      setMode("none");
      setName("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create league");
    }
  }

  async function joinLeague(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.post("/leagues/join", { inviteCode });
      setMode("none");
      setInviteCode("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join league");
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">My Leagues</h1>
        <button
          type="button"
          onClick={() => setMode(mode === "join" ? "none" : "join")}
          className="rounded-md border border-edge bg-surface px-3 py-2 text-sm hover:border-sky-600 hover:bg-cream"
        >
          Join with code
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === "create" ? "none" : "create")}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
        >
          New league
        </button>
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {mode === "join" && (
        <form onSubmit={joinLeague} className="mb-6 flex gap-2 rounded-lg border border-edge bg-surface p-4">
          <input
            required
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
            placeholder="Invite code"
            className="flex-1 rounded-md border border-edge bg-surface-raised px-3 py-2 font-mono uppercase outline-none focus:border-sky-500"
          />
          <button type="submit" className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-700">
            Join
          </button>
        </form>
      )}

      {mode === "create" && (
        <form onSubmit={createLeague} className="mb-6 space-y-4 rounded-lg border border-edge bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm text-slate-700">League name</span>
              <input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm text-slate-700">Format</span>
              <select
                value={leagueType}
                onChange={(event) => setLeagueType(event.target.value as "single_event" | "season")}
                className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
              >
                <option value="single_event">Single event</option>
                <option value="season">Full season</option>
              </select>
            </label>

            {leagueType === "single_event" && (
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm text-slate-700">Event</span>
                <select
                  required
                  value={eventKey}
                  onChange={(event) => setEventKey(event.target.value)}
                  className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
                >
                  <option value="">Choose an event…</option>
                  {events.map((event) => (
                    <option key={event.eventKey} value={event.eventKey}>
                      {event.name} ({event.eventKey})
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="block">
              <span className="mb-1 block text-sm text-slate-700">Roster size</span>
              <input
                type="number"
                min={3}
                max={10}
                value={rosterSize}
                onChange={(event) => setRosterSize(Number(event.target.value))}
                className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm text-slate-700">Max managers</span>
              <input
                type="number"
                min={2}
                max={16}
                value={maxMembers}
                onChange={(event) => setMaxMembers(Number(event.target.value))}
                className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm text-slate-700">Salary cap</span>
              <input
                type="number"
                min={50}
                max={500}
                step={10}
                value={salaryCap}
                onChange={(event) => setSalaryCap(Number(event.target.value))}
                className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
              />
              {minimumCap && (
                <span className="mt-1 block text-xs text-slate-500">
                  Minimum: ${minimumCap.minimumCap} — the smallest cap that guarantees every manager can
                  still fill their roster, worst case (based on the {minimumCap.poolSize}{" "}
                  {leagueType === "season" ? "top-priced" : "priciest"} teams in the pool){" "}
                  <button
                    type="button"
                    onClick={() => setSalaryCap(minimumCap.minimumCap)}
                    className="text-sky-600 hover:underline"
                  >
                    Use this
                  </button>
                  {minimumCap.insufficientPool && (
                    <span className="mt-1 block text-amber-700">
                      Only {minimumCap.universeSize} teams are available — not enough for every manager to
                      fill a full roster regardless of cap. Lower the roster size or manager count.
                    </span>
                  )}
                </span>
              )}
            </label>
          </div>

          <button type="submit" className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-700">
            Create league
          </button>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : leagues.length === 0 ? (
        <div className="rounded-lg border border-edge bg-surface p-8 text-center">
          <p className="mb-2 text-slate-700">No leagues yet.</p>
          <p className="text-sm text-slate-500">Create one, or join a friend's with their invite code.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {leagues.map((league) => (
            <Link
              key={league.id}
              to={`/leagues/${league.id}`}
              className="rounded-lg border border-edge bg-surface p-4 transition-colors hover:border-sky-600 hover:bg-cream"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium">{league.name}</h2>
                <span className="shrink-0 rounded bg-cream px-2 py-0.5 text-xs text-slate-600">
                  {statusLabels[league.status] ?? league.status}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                {league.leagueType === "season" ? "Full season" : league.eventKey} · {league.memberCount}{" "}
                {league.memberCount === 1 ? "owner" : "owners"}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                {league.rosterSize} teams · ${league.salaryCap} cap · code{" "}
                <span className="font-mono text-slate-600">{league.inviteCode}</span>
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
