import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export interface LeagueDetail {
  league: {
    id: string;
    name: string;
    leagueType: string;
    eventKey: string | null;
    inviteCode: string;
    commissionerId: string;
    rosterSize: number;
    salaryCap: number;
    maxMembers: number;
    status: string;
  };
  members: {
    userId: string;
    displayName: string;
    rosterName: string;
    draftPosition: number | null;
    joinedAt: number;
  }[];
  picks: {
    pickNumber: number;
    userId: string;
    teamKey: string;
    teamNumber: number | null;
    nickname: string | null;
    price: number;
  }[];
}

export function League() {
  const { leagueId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<LeagueDetail | null>(null);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState("");
  const [editingCap, setEditingCap] = useState(false);
  const [capInput, setCapInput] = useState("");
  const [savingCap, setSavingCap] = useState(false);
  const [capError, setCapError] = useState("");
  const [capMinimum, setCapMinimum] = useState<{
    minimumCap: number;
    worstCaseAveragePrice: number;
    poolSize: number;
    universeSize: number;
    insufficientPool: boolean;
  } | null>(null);

  useEffect(() => {
    api
      .get<LeagueDetail>(`/leagues/${leagueId}`)
      .then(setDetail)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Failed to load league"));
  }, [leagueId]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!detail) return <p className="text-sm text-slate-600">Loading…</p>;

  const { league, members, picks } = detail;
  const spent = (userId: string) =>
    picks.filter((pick) => pick.userId === userId).reduce((total, pick) => total + pick.price, 0);
  const isCommissioner = league.commissionerId === user?.id;
  const canEditCap = isCommissioner && league.status === "setup";
  const canLeave = league.status === "setup";
  // members is already sorted by joinedAt ascending; the next-oldest other member is who'd
  // inherit commissioner duties if the current commissioner leaves.
  const nextCommissioner = members.find((member) => member.userId !== user?.id);

  function startEditingCap() {
    setCapInput(String(league.salaryCap));
    setCapError("");
    setCapMinimum(null);
    setEditingCap(true);

    const params = new URLSearchParams({
      leagueType: league.leagueType,
      rosterSize: String(league.rosterSize),
      maxMembers: String(league.maxMembers),
    });
    if (league.eventKey) params.set("eventKey", league.eventKey);
    api
      .get<{
        minimumCap: number;
        worstCaseAveragePrice: number;
        poolSize: number;
        universeSize: number;
        insufficientPool: boolean;
      }>(`/leagues/minimum-cap?${params}`)
      .then(setCapMinimum)
      .catch(() => setCapMinimum(null));
  }

  async function saveCap() {
    const salaryCap = Number(capInput);
    if (!Number.isInteger(salaryCap) || salaryCap < 50 || salaryCap > 500) {
      setCapError("Enter a whole number between $50 and $500");
      return;
    }
    setSavingCap(true);
    setCapError("");
    try {
      const updated = await api.patch<{ league: LeagueDetail["league"] }>(`/leagues/${league.id}`, { salaryCap });
      setDetail((prev) => prev && { ...prev, league: updated.league });
      setEditingCap(false);
    } catch (caught) {
      setCapError(caught instanceof Error ? caught.message : "Could not update budget");
    } finally {
      setSavingCap(false);
    }
  }

  async function leaveLeague() {
    setLeaving(true);
    setLeaveError("");
    try {
      await api.post(`/leagues/${league.id}/leave`);
      navigate("/");
    } catch (caught) {
      setLeaveError(caught instanceof Error ? caught.message : "Could not leave league");
      setLeaving(false);
    }
  }

  async function deleteLeague() {
    setDeleting(true);
    setDeleteError("");
    try {
      await api.delete(`/leagues/${league.id}`);
      navigate("/");
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "Could not delete league");
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{league.name}</h1>
          <p className="flex flex-wrap items-center gap-x-1 text-sm text-slate-600">
            <span>
              {league.leagueType === "season" ? "Full season" : league.eventKey} · {league.rosterSize} teams
              ·
            </span>
            {editingCap ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                $
                <input
                  type="number"
                  min={50}
                  max={500}
                  value={capInput}
                  onChange={(event) => setCapInput(event.target.value)}
                  className="w-16 rounded border border-edge bg-surface-raised px-1.5 py-0.5 text-sm outline-none focus:border-sky-500"
                  autoFocus
                />
                cap
                <button
                  type="button"
                  onClick={saveCap}
                  disabled={savingCap}
                  className="rounded bg-sky-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                >
                  {savingCap ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingCap(false)}
                  disabled={savingCap}
                  className="text-xs text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
                {capMinimum && (
                  <span className="block w-full text-xs text-slate-500">
                    Minimum: ${capMinimum.minimumCap} — guarantees every manager can still fill their
                    roster, worst case (from the {capMinimum.poolSize} priciest teams in the pool){" "}
                    <button
                      type="button"
                      onClick={() => setCapInput(String(capMinimum.minimumCap))}
                      className="text-sky-600 hover:underline"
                    >
                      Use this
                    </button>
                    {capMinimum.insufficientPool && (
                      <span className="mt-1 block text-amber-700">
                        Only {capMinimum.universeSize} teams are available — not enough for every manager
                        to fill a full roster regardless of cap.
                      </span>
                    )}
                  </span>
                )}
              </span>
            ) : (
              <span>
                ${league.salaryCap} cap
                {canEditCap && (
                  <button
                    type="button"
                    onClick={startEditingCap}
                    className="ml-1.5 text-xs text-sky-600 hover:underline"
                  >
                    Edit
                  </button>
                )}
              </span>
            )}
          </p>
          {capError && <p className="mt-1 text-xs text-red-600">{capError}</p>}
        </div>
        <div className="rounded-md border border-edge bg-surface px-3 py-2 text-sm">
          Invite code <span className="ml-1 font-mono text-sky-600">{league.inviteCode}</span>
        </div>
        <Link
          to={`/leagues/${league.id}/standings`}
          className="rounded-md border border-edge bg-surface px-4 py-2 text-sm hover:border-sky-600 hover:bg-cream"
        >
          Standings
        </Link>
        {league.status !== "complete" && (
          <Link
            to={`/leagues/${league.id}/draft`}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
          >
            {league.status === "setup" ? "Draft room" : "Enter draft"}
          </Link>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {members.map((member) => {
          const roster = picks.filter((pick) => pick.userId === member.userId);
          return (
            <div key={member.userId} className="rounded-lg border border-edge bg-surface p-4">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <div>
                  <h2 className="font-medium">{member.rosterName}</h2>
                  <p className="text-xs text-slate-500">{member.displayName}</p>
                </div>
                <span className="font-mono text-sm text-slate-600">
                  ${league.salaryCap - spent(member.userId)} left
                </span>
              </div>

              {roster.length === 0 ? (
                <p className="text-sm text-slate-500">No teams drafted yet.</p>
              ) : (
                <ul className="space-y-1">
                  {roster.map((pick) => (
                    <li key={pick.teamKey} className="flex justify-between gap-2 text-sm">
                      <span>
                        <span className="font-mono font-semibold text-sky-600">{pick.teamNumber}</span>{" "}
                        <span className="text-slate-700">{pick.nickname}</span>
                      </span>
                      <span className="font-mono text-slate-500">${pick.price}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {(canLeave || isCommissioner) && (
        <div className="mt-8 rounded-lg border border-red-300 bg-red-100 p-4">
          <h2 className="mb-1 text-sm font-medium text-red-800">Danger zone</h2>

          {canLeave && (
            <div className="mb-3 border-b border-red-200 pb-3 last:mb-0 last:border-0 last:pb-0">
              {leaveError && <p className="mb-2 text-sm text-red-600">{leaveError}</p>}
              {confirmingLeave ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-slate-700">
                    Leave “{league.name}”?{" "}
                    {isCommissioner &&
                      (nextCommissioner
                        ? `${nextCommissioner.rosterName} will become the new commissioner.`
                        : "You're the only member, so this isn't available — delete the league instead.")}
                  </p>
                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmingLeave(false)}
                      disabled={leaving}
                      className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm hover:border-sky-600 hover:bg-cream disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    {!(isCommissioner && !nextCommissioner) && (
                      <button
                        type="button"
                        onClick={leaveLeague}
                        disabled={leaving}
                        className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                      >
                        {leaving ? "Leaving…" : "Yes, leave"}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingLeave(true)}
                  className="rounded-md border border-red-400 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-200"
                >
                  Leave league
                </button>
              )}
            </div>
          )}

          {isCommissioner && (
            <div>
              {deleteError && <p className="mb-2 text-sm text-red-600">{deleteError}</p>}
              {confirmingDelete ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-slate-700">
                    Delete “{league.name}” permanently? This removes all members, picks, and scores — it
                    can't be undone.
                  </p>
                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleting}
                      className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm hover:border-sky-600 hover:bg-cream disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={deleteLeague}
                      disabled={deleting}
                      className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                    >
                      {deleting ? "Deleting…" : "Yes, delete it"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="rounded-md border border-red-400 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-200"
                >
                  Delete league
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
