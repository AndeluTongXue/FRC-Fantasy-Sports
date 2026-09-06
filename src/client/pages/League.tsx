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
  members: { userId: string; displayName: string; rosterName: string; draftPosition: number | null }[];
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

  useEffect(() => {
    api
      .get<LeagueDetail>(`/leagues/${leagueId}`)
      .then(setDetail)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Failed to load league"));
  }, [leagueId]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!detail) return <p className="text-sm text-slate-400">Loading…</p>;

  const { league, members, picks } = detail;
  const spent = (userId: string) =>
    picks.filter((pick) => pick.userId === userId).reduce((total, pick) => total + pick.price, 0);
  const isCommissioner = league.commissionerId === user?.id;

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
          <p className="text-sm text-slate-400">
            {league.leagueType === "season" ? "Full season" : league.eventKey} · {league.rosterSize} teams · $
            {league.salaryCap} cap
          </p>
        </div>
        <div className="rounded-md border border-edge bg-surface px-3 py-2 text-sm">
          Invite code <span className="ml-1 font-mono text-sky-400">{league.inviteCode}</span>
        </div>
        <Link
          to={`/leagues/${league.id}/standings`}
          className="rounded-md border border-edge bg-surface px-4 py-2 text-sm hover:border-sky-500"
        >
          Standings
        </Link>
        {league.status !== "complete" && (
          <Link
            to={`/leagues/${league.id}/draft`}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
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
                <span className="font-mono text-sm text-slate-400">
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
                        <span className="font-mono font-semibold text-sky-400">{pick.teamNumber}</span>{" "}
                        <span className="text-slate-300">{pick.nickname}</span>
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

      {isCommissioner && (
        <div className="mt-8 rounded-lg border border-red-900/50 bg-red-950/20 p-4">
          <h2 className="mb-1 text-sm font-medium text-red-300">Danger zone</h2>
          {deleteError && <p className="mb-2 text-sm text-red-400">{deleteError}</p>}
          {confirmingDelete ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-slate-300">
                Delete “{league.name}” permanently? This removes all members, picks, and scores — it
                can't be undone.
              </p>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                  className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm hover:border-sky-500 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={deleteLeague}
                  disabled={deleting}
                  className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Yes, delete it"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-md border border-red-800 px-3 py-1.5 text-sm text-red-300 hover:bg-red-900/30"
            >
              Delete league
            </button>
          )}
        </div>
      )}
    </div>
  );
}
