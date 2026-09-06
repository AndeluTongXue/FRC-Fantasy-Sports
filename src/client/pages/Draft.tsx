import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useCountdown, useDraft } from "../lib/useDraft";
import type { LeagueDetail } from "./League";

interface PoolTeam {
  teamKey: string;
  teamNumber: number;
  nickname: string | null;
  price: number;
  epa: number | null;
}

export function Draft() {
  const { leagueId = "" } = useParams();
  const { user } = useAuth();
  const { state, error, connected, start, pick, dismissError } = useDraft(leagueId);
  const [detail, setDetail] = useState<LeagueDetail | null>(null);
  const [pool, setPool] = useState<PoolTeam[]>([]);
  const [search, setSearch] = useState("");
  const remaining = useCountdown(state?.deadline ?? null);

  useEffect(() => {
    api.get<LeagueDetail>(`/leagues/${leagueId}`).then(setDetail).catch(() => setDetail(null));
  }, [leagueId]);

  const picksMade = state?.picks.length ?? 0;
  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .get<{ teams: PoolTeam[] }>(`/leagues/${leagueId}/pool?search=${encodeURIComponent(search)}&limit=80`)
        .then((data) => setPool(data.teams))
        .catch(() => setPool([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [leagueId, search, picksMade]);

  if (!detail || !state) return <p className="text-sm text-slate-600">Connecting to draft room…</p>;

  const nameOf = (userId: string | null) =>
    detail.members.find((member) => member.userId === userId)?.rosterName ?? "—";
  const myTurn = state.currentUserId === user?.id;
  const myBudget = state.budgets[user?.id ?? ""] ?? 0;
  const isCommissioner = detail.league.commissionerId === user?.id;
  const round = Math.floor(state.currentPick / Math.max(state.order.length, 1)) + 1;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <Link to={`/leagues/${leagueId}`} className="text-sm text-slate-600 hover:text-slate-900">
            ← {detail.league.name}
          </Link>
          <h1 className="text-xl font-semibold">Draft room</h1>
        </div>
        <span className={`text-xs ${connected ? "text-emerald-600" : "text-amber-600"}`}>
          {connected ? "● live" : "○ reconnecting"}
        </span>
      </div>

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-300 bg-red-100 px-4 py-2">
          <p className="text-sm text-red-800">{error}</p>
          <button type="button" onClick={dismissError} className="text-sm font-medium text-red-700 hover:text-red-900">
            Dismiss
          </button>
        </div>
      )}

      {state.status === "pending" && (
        <div className="mb-6 rounded-lg border border-edge bg-surface p-6 text-center">
          <p className="mb-1 text-slate-700">Waiting for the commissioner to start the draft.</p>
          <p className="mb-4 text-sm text-slate-500">
            {detail.members.length} of {detail.league.maxMembers} owners have joined · share code{" "}
            <span className="font-mono text-sky-600">{detail.league.inviteCode}</span>
          </p>
          {isCommissioner && (
            <button
              type="button"
              onClick={start}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
            >
              Start draft
            </button>
          )}
        </div>
      )}

      {state.status === "active" && (
        <div
          className={`mb-6 rounded-lg border p-4 ${
            myTurn ? "border-sky-500 bg-sky-50" : "border-edge bg-surface"
          }`}
        >
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex-1">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Round {round} · Pick {state.currentPick + 1} of {state.totalPicks}
              </p>
              <p className="text-lg font-medium">
                {myTurn ? "You're on the clock" : `${nameOf(state.currentUserId)} is picking`}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-slate-500">Time left</p>
              <p className={`font-mono text-2xl ${remaining !== null && remaining <= 10 ? "text-red-600" : ""}`}>
                {remaining === null ? "—" : `0:${String(remaining).padStart(2, "0")}`}
              </p>
            </div>
          </div>
        </div>
      )}

      {state.status === "complete" && (
        <div className="mb-6 rounded-lg border border-emerald-300 bg-emerald-100 p-4 text-center">
          <p className="font-medium text-emerald-800">Draft complete — rosters are locked in.</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <div className="mb-3 flex items-center gap-3">
            <h2 className="font-medium">Available teams</h2>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search…"
              className="flex-1 rounded-md border border-edge bg-surface px-3 py-1.5 text-sm outline-none focus:border-sky-500 sm:max-w-xs"
            />
            {state.status === "active" && (
              <span className="font-mono text-sm text-slate-600">${myBudget} left</span>
            )}
          </div>

          <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-edge">
            <table className="w-full text-sm">
              <tbody>
                {pool.map((team) => {
                  const affordable = team.price <= myBudget;
                  return (
                    <tr key={team.teamKey} className="border-b border-edge last:border-0">
                      <td className="px-3 py-2 font-mono font-semibold text-sky-600">{team.teamNumber}</td>
                      <td className="px-3 py-2">{team.nickname}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">
                        {team.epa === null ? "—" : team.epa.toFixed(0)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">${team.price}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          disabled={!myTurn || state.status !== "active" || !affordable}
                          onClick={() => pick(team.teamKey)}
                          className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:bg-surface-raised disabled:text-slate-400"
                        >
                          Draft
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h2 className="mb-3 font-medium">Owners</h2>
          <div className="space-y-3">
            {(state.order.length ? state.order : detail.members.map((member) => member.userId)).map(
              (ownerId, index) => {
                const roster = state.picks.filter((entry) => entry.userId === ownerId);
                const onClock = state.currentUserId === ownerId;
                return (
                  <div
                    key={ownerId}
                    className={`rounded-lg border p-3 ${
                      onClock ? "border-sky-500 bg-sky-50" : "border-edge bg-surface"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">
                        {state.order.length > 0 && <span className="text-slate-500">{index + 1}. </span>}
                        {nameOf(ownerId)}
                      </span>
                      <span className="font-mono text-xs text-slate-600">${state.budgets[ownerId] ?? 0}</span>
                    </div>
                    <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                      {roster.map((entry) => {
                        const team = detail.picks.find((p) => p.teamKey === entry.teamKey);
                        return (
                          <li key={entry.teamKey}>
                            <span className="font-mono text-sky-600">
                              {team?.teamNumber ?? entry.teamKey.replace("frc", "")}
                            </span>{" "}
                            ${entry.price}
                          </li>
                        );
                      })}
                      {Array.from({ length: state.rosterSize - roster.length }).map((_, slot) => (
                        <li key={`empty-${slot}`} className="text-slate-300">
                          empty
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              },
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
