import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DraftQueue } from "../components/DraftQueue";
import type { QueueTeam } from "../components/DraftQueue";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useCountdown, useDraft } from "../lib/useDraft";
import { formatDuration, formatScheduledDraft } from "../lib/schedule";
import { CLOCK_EXTENSION_SECONDS, pickOwner } from "../../shared/types";
import type { DraftState } from "../../shared/types";
import type { LeagueDetail } from "./League";

/** Same shape the queue returns, so a pool row can go straight onto the queue. */
type PoolTeam = QueueTeam;

/** Exactly how many of the OTHER managers' picks will land between now and this manager's
 * own final remaining pick, given the fixed snake order — mirrors DraftRoom's
 * othersPicksBeforeMyLast exactly, using the same pickOwner the server uses to advance
 * turns, so the client can predict a pick's legality without duplicating server state. */
function othersPicksBeforeMyLast(state: DraftState, userId: string, slotsAfterPick: number): number {
  if (slotsAfterPick <= 0) return 0;
  let mine = 0;
  let others = 0;
  for (let index = state.currentPick + 1; index < state.totalPicks; index++) {
    if (pickOwner(state.order, index) === userId) {
      mine++;
      if (mine >= slotsAfterPick) break;
    } else {
      others++;
    }
  }
  return others;
}

export function Draft() {
  const { leagueId = "" } = useParams();
  const { user } = useAuth();
  const { state, error, connected, start, pick, pause, resume, extend, autopick, undo, dismissError } =
    useDraft(leagueId, user?.id ?? null);
  const [detail, setDetail] = useState<LeagueDetail | null>(null);
  const [pool, setPool] = useState<PoolTeam[]>([]);
  const [queue, setQueue] = useState<QueueTeam[]>([]);
  const [queueError, setQueueError] = useState("");
  const [search, setSearch] = useState("");
  const remaining = useCountdown(state?.deadline ?? null);
  const scheduledRemaining = useCountdown(state?.scheduledDraftAt ?? null);

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

  // Reloaded on every pick, not just on mount: drafting a team drops it from every queue in
  // the league, so someone else's pick can shorten this one.
  useEffect(() => {
    api
      .get<{ teams: QueueTeam[] }>(`/leagues/${leagueId}/queue`)
      .then((data) => setQueue(data.teams))
      .catch(() => setQueue([]));
  }, [leagueId, picksMade]);

  /** Optimistic: the reorder buttons should feel instant, and the server's answer is
   * authoritative if it disagrees (it filters out anything drafted in the meantime). */
  function saveQueue(next: QueueTeam[]) {
    const previous = queue;
    setQueue(next);
    setQueueError("");
    api
      .put<{ teams: QueueTeam[] }>(`/leagues/${leagueId}/queue`, { teamKeys: next.map((team) => team.teamKey) })
      .then((data) => setQueue(data.teams))
      .catch((caught: unknown) => {
        setQueue(previous);
        setQueueError(caught instanceof Error ? caught.message : "Could not save your queue");
      });
  }

  if (!detail || !state) return <p className="text-sm text-slate-600">Connecting to draft room…</p>;

  const nameOf = (userId: string | null) =>
    detail.members.find((member) => member.userId === userId)?.rosterName ?? "—";
  const myTurn = state.currentUserId === user?.id;
  const myBudget = state.budgets[user?.id ?? ""] ?? 0;
  const isCommissioner = detail.league.commissionerId === user?.id;
  const round = Math.floor(state.currentPick / Math.max(state.order.length, 1)) + 1;

  // A room persisted before cheapestPrices existed can still push the old state shape (the
  // server heals it on connect, but never render-crash the whole page over a missing field).
  const cheapestPrices = state.cheapestPrices ?? [];

  // Mirrors the server's reserve-budget guard exactly: a pick is only legal if enough
  // budget is left afterward to still afford the teams opponents will leave behind for each
  // remaining slot. That's the price-ascending slice starting right after however many
  // opponent picks land before this manager's own roster is full — not `slots * cheapest`,
  // which both overstates what's affordable (each team sells once) and ignores that
  // opponents get chances to hoard cheap teams in between this manager's own turns.
  const mySlotsRemaining = state.rosterSize - state.picks.filter((entry) => entry.userId === user?.id).length;
  const slotsAfterPick = Math.max(mySlotsRemaining - 1, 0);
  const otherCapacity = user ? othersPicksBeforeMyLast(state, user.id, slotsAfterPick) : 0;
  const reserve = cheapestPrices
    .slice(otherCapacity, otherCapacity + slotsAfterPick)
    .reduce((sum, price) => sum + price, 0);
  const maxSpend = myBudget - reserve;
  const cheapestAvailable = cheapestPrices[0] ?? Infinity;
  const queueLocked = state.status === "complete";
  const paused = state.pausedRemainingMs !== null;
  // The commissioner can run the on-clock manager's autopick early, but only for someone
  // else — their own turn is theirs to take.
  const canAutopickForOther = isCommissioner && state.status === "active" && !paused && !myTurn;
  const canDraftRow = (price: number) => myTurn && state.status === "active" && !paused && price <= maxSpend;
  const stuckNoLegalPick =
    myTurn && state.status === "active" && mySlotsRemaining > 0 && maxSpend < cheapestAvailable;

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
          {state.scheduledDraftAt !== null && (
            <p className="mb-4 text-sm text-sky-700">
              Scheduled for {formatScheduledDraft(state.scheduledDraftAt)} — starting in{" "}
              {formatDuration(scheduledRemaining ?? 0)}
            </p>
          )}
          {isCommissioner && (
            <button
              type="button"
              onClick={start}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
            >
              {state.scheduledDraftAt !== null ? "Start now" : "Start draft"}
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
                {paused
                  ? "paused"
                  : remaining === null
                    ? "—"
                    : // Minutes matter: pick_seconds goes up to 300, and the commissioner can
                      // add another 60 on top, so a hardcoded "0:" read "0:298".
                      `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}
              </p>
            </div>
          </div>
          {paused && (
            <p className="mt-3 rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900">
              The commissioner paused the draft. The clock is stopped and nobody can pick until it
              resumes.
            </p>
          )}
          {stuckNoLegalPick && (
            <p className="mt-3 text-sm text-amber-700">
              You can't afford any remaining team without leaving yourself unable to fill your other roster
              spots — this pick will be skipped when the clock runs out.
            </p>
          )}
        </div>
      )}

      {isCommissioner && (state.status === "active" || state.status === "complete") && (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-surface px-4 py-3">
          <span className="mr-1 text-xs uppercase tracking-wide text-slate-500">Commissioner</span>
          {state.status === "active" && (
            <>
              <button
                type="button"
                onClick={paused ? resume : pause}
                className="rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-surface-raised"
              >
                {paused ? "Resume draft" : "Pause draft"}
              </button>
              <button
                type="button"
                onClick={extend}
                className="rounded-md border border-edge px-3 py-1.5 text-sm text-slate-700 hover:bg-surface-raised"
              >
                +{CLOCK_EXTENSION_SECONDS}s to this pick
              </button>
              <button
                type="button"
                onClick={autopick}
                disabled={!canAutopickForOther}
                className="rounded-md border border-edge px-3 py-1.5 text-sm text-slate-700 hover:bg-surface-raised disabled:opacity-40"
              >
                {canAutopickForOther
                  ? `Autodraft for ${nameOf(state.currentUserId)}`
                  : "Autodraft this pick"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={undo}
            disabled={state.picks.length === 0}
            className="rounded-md border border-edge px-3 py-1.5 text-sm text-slate-700 hover:bg-surface-raised disabled:opacity-40"
          >
            Undo last pick
          </button>
          <span className="text-xs text-slate-500">
            {state.status === "complete"
              ? "Undoing reopens the draft and puts that manager back on the clock."
              : canAutopickForOther
                ? "Autodrafting takes from their queue, or the best team they can afford."
                : "Pausing keeps the time left on the clock rather than restarting the pick."}
          </span>
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
                  const queuedAt = queue.findIndex((entry) => entry.teamKey === team.teamKey);
                  return (
                    <tr key={team.teamKey} className="border-b border-edge last:border-0">
                      <td className="px-3 py-2 font-mono font-semibold text-sky-600">{team.teamNumber}</td>
                      <td className="px-3 py-2">{team.nickname}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">
                        {team.epa === null ? "—" : team.epa.toFixed(0)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">${team.price}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {!queueLocked &&
                            (queuedAt >= 0 ? (
                              <button
                                type="button"
                                title="Remove from your queue"
                                onClick={() => saveQueue(queue.filter((entry) => entry.teamKey !== team.teamKey))}
                                className="rounded bg-sky-100 px-2 py-1 font-mono text-xs font-medium text-sky-700 hover:bg-sky-200"
                              >
                                #{queuedAt + 1}
                              </button>
                            ) : (
                              <button
                                type="button"
                                title="Add to your queue"
                                onClick={() => saveQueue([...queue, team])}
                                className="rounded border border-edge px-2 py-1 text-xs text-slate-600 hover:bg-surface-raised"
                              >
                                + Queue
                              </button>
                            ))}
                          <button
                            type="button"
                            disabled={!canDraftRow(team.price)}
                            onClick={() => pick(team.teamKey)}
                            className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:bg-surface-raised disabled:text-slate-400"
                          >
                            Draft
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          {queueError && <p className="mb-3 text-sm text-red-600">{queueError}</p>}

          <DraftQueue
            teams={queue}
            maxSpend={maxSpend}
            locked={queueLocked}
            onReorder={saveQueue}
            onRemove={(teamKey) => saveQueue(queue.filter((entry) => entry.teamKey !== teamKey))}
          />

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
