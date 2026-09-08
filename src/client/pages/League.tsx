import { useEffect, useState } from "react";
import { CopyButton } from "../components/CopyButton";
import { MAX_PICK_SECONDS, MIN_PICK_SECONDS } from "../../shared/types";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { earliestScheduleInputValue, formatScheduledDraft, toLocalInputValue } from "../lib/schedule";
import { DEFAULT_SCORING } from "../../shared/types";
import type { ScoringConfig } from "../../shared/types";

const SCORING_FIELDS: { key: keyof ScoringConfig; label: string; step?: number }[] = [
  { key: "qualWin", label: "Qual win" },
  { key: "qualTie", label: "Qual tie" },
  { key: "rankingPoint", label: "Ranking point" },
  { key: "allianceCaptain", label: "Alliance captain" },
  { key: "alliancePick1", label: "Alliance 1st pick" },
  { key: "alliancePick2", label: "Alliance 2nd pick" },
  { key: "alliancePick3", label: "Alliance 3rd pick" },
  { key: "playoffWin", label: "Playoff win" },
  { key: "eventWinner", label: "Event winner" },
  { key: "eventFinalist", label: "Event finalist" },
  { key: "awardImpact", label: "Impact award" },
  { key: "awardEngineeringInspiration", label: "Engineering Inspiration award" },
  { key: "awardOther", label: "Other award" },
  { key: "championshipMultiplier", label: "Championship multiplier", step: 0.1 },
];

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
    pickSeconds: number;
    maxMembers: number;
    status: string;
    scheduledDraftAt: number | null;
    scoringConfig: ScoringConfig;
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
  bannedUsers: { userId: string; displayName: string; bannedAt: number }[];
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
  const [banningUserId, setBanningUserId] = useState<string | null>(null);
  const [banningInFlight, setBanningInFlight] = useState(false);
  const [banError, setBanError] = useState("");
  const [unbanningUserId, setUnbanningUserId] = useState<string | null>(null);
  const [unbanError, setUnbanError] = useState("");
  const [editingCap, setEditingCap] = useState(false);
  const [capInput, setCapInput] = useState("");
  const [savingCap, setSavingCap] = useState(false);
  const [capError, setCapError] = useState("");
  const [editingClock, setEditingClock] = useState(false);
  const [clockInput, setClockInput] = useState("");
  const [savingClock, setSavingClock] = useState(false);
  const [clockError, setClockError] = useState("");
  const [editingRosterName, setEditingRosterName] = useState(false);
  const [rosterNameInput, setRosterNameInput] = useState("");
  const [savingRosterName, setSavingRosterName] = useState(false);
  const [rosterNameError, setRosterNameError] = useState("");
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduleInput, setScheduleInput] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [editingScoring, setEditingScoring] = useState(false);
  const [scoringInput, setScoringInput] = useState<Record<string, string>>({});
  const [savingScoring, setSavingScoring] = useState(false);
  const [scoringError, setScoringError] = useState("");
  const [capMinimum, setCapMinimum] = useState<{
    minimumCap: number;
    worstCaseAveragePrice: number;
    worstCaseOpponentPicks: number;
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

  const { league, members, picks, bannedUsers } = detail;
  const spent = (userId: string) =>
    picks.filter((pick) => pick.userId === userId).reduce((total, pick) => total + pick.price, 0);
  const isCommissioner = league.commissionerId === user?.id;
  // Same window as the budget: once the draft starts its alarm is already running on the
  // old value, and rosters are already being priced against the old cap.
  const canEditCap = isCommissioner && league.status === "setup";
  const canEditClock = canEditCap;
  const canBan = isCommissioner && league.status === "setup";
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
        worstCaseOpponentPicks: number;
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

  async function saveClock() {
    const pickSeconds = Number(clockInput);
    if (!Number.isInteger(pickSeconds) || pickSeconds < MIN_PICK_SECONDS || pickSeconds > MAX_PICK_SECONDS) {
      setClockError(`Enter a whole number between ${MIN_PICK_SECONDS} and ${MAX_PICK_SECONDS}`);
      return;
    }
    setSavingClock(true);
    setClockError("");
    try {
      const updated = await api.patch<{ league: LeagueDetail["league"] }>(`/leagues/${league.id}`, {
        pickSeconds,
      });
      setDetail((prev) => prev && { ...prev, league: updated.league });
      setEditingClock(false);
    } catch (caught) {
      setClockError(caught instanceof Error ? caught.message : "Could not update the pick clock");
    } finally {
      setSavingClock(false);
    }
  }

  function startEditingRosterName(currentName: string) {
    setRosterNameInput(currentName);
    setRosterNameError("");
    setEditingRosterName(true);
  }

  async function saveRosterName() {
    const rosterName = rosterNameInput.trim();
    if (!rosterName) {
      setRosterNameError("Team name can't be empty");
      return;
    }
    if (rosterName.length > 40) {
      setRosterNameError("Team name must be 40 characters or fewer");
      return;
    }
    setSavingRosterName(true);
    setRosterNameError("");
    try {
      await api.patch(`/leagues/${league.id}/roster-name`, { rosterName });
      setDetail(
        (prev) =>
          prev && {
            ...prev,
            members: prev.members.map((member) =>
              member.userId === user?.id ? { ...member, rosterName } : member,
            ),
          },
      );
      setEditingRosterName(false);
    } catch (caught) {
      setRosterNameError(caught instanceof Error ? caught.message : "Could not rename team");
    } finally {
      setSavingRosterName(false);
    }
  }

  function startEditingSchedule() {
    setScheduleInput(league.scheduledDraftAt !== null ? toLocalInputValue(league.scheduledDraftAt) : "");
    setScheduleError("");
    setEditingSchedule(true);
  }

  async function saveSchedule() {
    if (!scheduleInput) {
      setScheduleError("Pick a date and time");
      return;
    }
    const scheduledDraftAt = new Date(scheduleInput).getTime();
    if (!Number.isFinite(scheduledDraftAt)) {
      setScheduleError("That doesn't look like a valid date and time");
      return;
    }
    setSavingSchedule(true);
    setScheduleError("");
    try {
      await api.put(`/leagues/${league.id}/schedule`, { scheduledDraftAt });
      setDetail((prev) => prev && { ...prev, league: { ...prev.league, scheduledDraftAt } });
      setEditingSchedule(false);
    } catch (caught) {
      setScheduleError(caught instanceof Error ? caught.message : "Could not schedule the draft");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function removeSchedule() {
    setSavingSchedule(true);
    setScheduleError("");
    try {
      await api.delete(`/leagues/${league.id}/schedule`);
      setDetail((prev) => prev && { ...prev, league: { ...prev.league, scheduledDraftAt: null } });
      setEditingSchedule(false);
    } catch (caught) {
      setScheduleError(caught instanceof Error ? caught.message : "Could not cancel the schedule");
    } finally {
      setSavingSchedule(false);
    }
  }

  function startEditingScoring() {
    const input: Record<string, string> = {};
    for (const field of SCORING_FIELDS) input[field.key] = String(league.scoringConfig[field.key]);
    setScoringInput(input);
    setScoringError("");
    setEditingScoring(true);
  }

  function resetScoringToDefaults() {
    const input: Record<string, string> = {};
    for (const field of SCORING_FIELDS) input[field.key] = String(DEFAULT_SCORING[field.key]);
    setScoringInput(input);
  }

  async function saveScoring() {
    const scoringConfig = {} as ScoringConfig;
    for (const field of SCORING_FIELDS) {
      const value = Number(scoringInput[field.key]);
      if (!Number.isFinite(value)) {
        setScoringError(`${field.label} must be a number`);
        return;
      }
      scoringConfig[field.key] = value;
    }
    setSavingScoring(true);
    setScoringError("");
    try {
      const result = await api.put<{ scoringConfig: ScoringConfig }>(`/leagues/${league.id}/scoring`, {
        scoringConfig,
      });
      setDetail((prev) => prev && { ...prev, league: { ...prev.league, scoringConfig: result.scoringConfig } });
      setEditingScoring(false);
    } catch (caught) {
      setScoringError(caught instanceof Error ? caught.message : "Could not update scoring weights");
    } finally {
      setSavingScoring(false);
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

  async function refetch() {
    setDetail(await api.get<LeagueDetail>(`/leagues/${league.id}`));
  }

  async function banMember(userId: string) {
    setBanningInFlight(true);
    setBanError("");
    try {
      await api.post(`/leagues/${league.id}/ban`, { userId });
      setBanningUserId(null);
      await refetch();
    } catch (caught) {
      setBanError(caught instanceof Error ? caught.message : "Could not ban member");
    } finally {
      setBanningInFlight(false);
    }
  }

  async function unbanUser(userId: string) {
    setUnbanningUserId(userId);
    setUnbanError("");
    try {
      await api.post(`/leagues/${league.id}/unban`, { userId });
      await refetch();
    } catch (caught) {
      setUnbanError(caught instanceof Error ? caught.message : "Could not unban user");
    } finally {
      setUnbanningUserId(null);
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
                    Minimum: ${capMinimum.minimumCap}{" "}
                    <button
                      type="button"
                      onClick={() => setCapInput(String(capMinimum.minimumCap))}
                      className="text-sky-600 hover:underline"
                    >
                      Use this
                    </button>
                    {capMinimum.insufficientPool && (
                      <span className="mt-1 block text-amber-700">
                        Only {capMinimum.universeSize} teams — not enough for a full roster each.
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
          {editingClock ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <input
                type="number"
                min={MIN_PICK_SECONDS}
                max={MAX_PICK_SECONDS}
                step={15}
                value={clockInput}
                onChange={(event) => setClockInput(event.target.value)}
                className="w-20 rounded border border-edge bg-surface-raised px-2 py-0.5 text-sm outline-none focus:border-sky-500"
              />
              s per pick
              <button
                type="button"
                onClick={saveClock}
                disabled={savingClock}
                className="rounded bg-sky-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
              >
                {savingClock ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setEditingClock(false)}
                disabled={savingClock}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            </span>
          ) : (
            <span>
              {league.pickSeconds}s per pick
              {canEditClock && (
                <button
                  type="button"
                  onClick={() => {
                    setClockInput(String(league.pickSeconds));
                    setClockError("");
                    setEditingClock(true);
                  }}
                  className="ml-1.5 text-xs text-sky-600 hover:underline"
                >
                  Edit
                </button>
              )}
            </span>
          )}
          {clockError && <p className="mt-1 text-xs text-red-600">{clockError}</p>}
        </div>
        <div className="rounded-md border border-edge bg-surface px-3 py-2 text-sm">
          Invite code <span className="ml-1 font-mono text-sky-600">{league.inviteCode}</span>
          <CopyButton value={league.inviteCode} label="Copy invite code" className="ml-1.5" />
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

      {league.status === "setup" && (
        <div className="mb-6 rounded-lg border border-edge bg-surface p-4">
          <h2 className="mb-2 text-sm font-medium text-slate-700">Draft schedule</h2>
          {scheduleError && <p className="mb-2 text-xs text-red-600">{scheduleError}</p>}
          {editingSchedule ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="datetime-local"
                min={earliestScheduleInputValue()}
                value={scheduleInput}
                onChange={(event) => setScheduleInput(event.target.value)}
                autoFocus
                className="rounded-md border border-edge bg-surface-raised px-3 py-1.5 text-sm outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={saveSchedule}
                disabled={savingSchedule}
                className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
              >
                {savingSchedule ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setEditingSchedule(false)}
                disabled={savingSchedule}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            </div>
          ) : league.scheduledDraftAt !== null ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-slate-700">
                Draft starts automatically {formatScheduledDraft(league.scheduledDraftAt)}.
              </p>
              {isCommissioner && (
                <div className="ml-auto flex gap-3 text-xs">
                  <button type="button" onClick={startEditingSchedule} className="text-sky-600 hover:underline">
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={removeSchedule}
                    disabled={savingSchedule}
                    className="text-red-700 hover:underline disabled:opacity-50"
                  >
                    Cancel schedule
                  </button>
                </div>
              )}
            </div>
          ) : isCommissioner ? (
            <button
              type="button"
              onClick={startEditingSchedule}
              className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm hover:border-sky-600 hover:bg-cream"
            >
              Schedule the draft
            </button>
          ) : (
            <p className="text-sm text-slate-500">The commissioner hasn't scheduled a start time yet.</p>
          )}
        </div>
      )}

      {league.status === "setup" && (
        <div className="mb-6 rounded-lg border border-edge bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-700">Scoring weights</h2>
            {isCommissioner && !editingScoring && (
              <button type="button" onClick={startEditingScoring} className="text-xs text-sky-600 hover:underline">
                Edit
              </button>
            )}
          </div>
          {scoringError && <p className="mb-2 text-xs text-red-600">{scoringError}</p>}
          {editingScoring ? (
            <div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {SCORING_FIELDS.map((field) => (
                  <label key={field.key} className="block text-xs">
                    <span className="mb-1 block text-slate-600">{field.label}</span>
                    <input
                      type="number"
                      step={field.step ?? 1}
                      value={scoringInput[field.key] ?? ""}
                      onChange={(event) =>
                        setScoringInput((prev) => ({ ...prev, [field.key]: event.target.value }))
                      }
                      className="w-full rounded border border-edge bg-surface-raised px-2 py-1 text-sm outline-none focus:border-sky-500"
                    />
                  </label>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={saveScoring}
                  disabled={savingScoring}
                  className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                >
                  {savingScoring ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={resetScoringToDefaults}
                  disabled={savingScoring}
                  className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm hover:border-sky-600 hover:bg-cream disabled:opacity-50"
                >
                  Reset to defaults
                </button>
                <button
                  type="button"
                  onClick={() => setEditingScoring(false)}
                  disabled={savingScoring}
                  className="text-sm text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Qual win/tie {league.scoringConfig.qualWin}/{league.scoringConfig.qualTie} · RP{" "}
              {league.scoringConfig.rankingPoint} · alliance captain/1st/2nd/3rd{" "}
              {league.scoringConfig.allianceCaptain}/{league.scoringConfig.alliancePick1}/
              {league.scoringConfig.alliancePick2}/{league.scoringConfig.alliancePick3} · playoff win{" "}
              {league.scoringConfig.playoffWin} · event win/finalist {league.scoringConfig.eventWinner}/
              {league.scoringConfig.eventFinalist} · awards {league.scoringConfig.awardImpact}/
              {league.scoringConfig.awardEngineeringInspiration}/{league.scoringConfig.awardOther} ·
              championship ×{league.scoringConfig.championshipMultiplier}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {members.map((member) => {
          const roster = picks.filter((pick) => pick.userId === member.userId);
          return (
            <div key={member.userId} className="rounded-lg border border-edge bg-surface p-4">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <div>
                  {editingRosterName && member.userId === user?.id ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        type="text"
                        value={rosterNameInput}
                        onChange={(event) => setRosterNameInput(event.target.value)}
                        maxLength={40}
                        autoFocus
                        className="rounded border border-edge bg-surface-raised px-1.5 py-0.5 text-sm font-medium outline-none focus:border-sky-500"
                      />
                      <button
                        type="button"
                        onClick={saveRosterName}
                        disabled={savingRosterName}
                        className="rounded bg-sky-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                      >
                        {savingRosterName ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingRosterName(false)}
                        disabled={savingRosterName}
                        className="text-xs text-slate-500 hover:text-slate-700"
                      >
                        Cancel
                      </button>
                      {rosterNameError && <p className="w-full text-xs text-red-600">{rosterNameError}</p>}
                    </div>
                  ) : (
                    <h2 className="font-medium">
                      {member.rosterName}
                      {member.userId === user?.id && (
                        <button
                          type="button"
                          onClick={() => startEditingRosterName(member.rosterName)}
                          className="ml-1.5 text-xs text-sky-600 hover:underline"
                        >
                          Edit
                        </button>
                      )}
                    </h2>
                  )}
                  <p className="text-xs text-slate-500">{member.displayName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-slate-600">
                    ${league.salaryCap - spent(member.userId)} left
                  </span>
                  {canBan && member.userId !== user?.id && banningUserId !== member.userId && (
                    <button
                      type="button"
                      onClick={() => {
                        setBanningUserId(member.userId);
                        setBanError("");
                      }}
                      className="text-xs text-red-700 hover:underline"
                    >
                      Ban
                    </button>
                  )}
                </div>
              </div>

              {banningUserId === member.userId && (
                <div className="mb-3 rounded-md border border-red-300 bg-red-100 p-2">
                  <p className="mb-2 text-xs text-slate-700">
                    Ban {member.rosterName}? They'll be removed from the league and won't be able to rejoin
                    unless unbanned.
                  </p>
                  {banError && <p className="mb-2 text-xs text-red-600">{banError}</p>}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setBanningUserId(null)}
                      disabled={banningInFlight}
                      className="rounded-md border border-edge bg-surface px-2 py-1 text-xs hover:border-sky-600 hover:bg-cream disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => banMember(member.userId)}
                      disabled={banningInFlight}
                      className="rounded-md bg-red-700 px-2 py-1 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
                    >
                      {banningInFlight ? "Banning…" : "Yes, ban"}
                    </button>
                  </div>
                </div>
              )}

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

      {isCommissioner && (
        <div className="mt-8 rounded-lg border border-edge bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-700">Banned users</h2>
          {unbanError && <p className="mb-2 text-sm text-red-600">{unbanError}</p>}
          {bannedUsers.length === 0 ? (
            <p className="text-sm text-slate-500">No banned users.</p>
          ) : (
            <ul className="space-y-2">
              {bannedUsers.map((banned) => (
                <li key={banned.userId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-slate-700">{banned.displayName}</span>
                  <button
                    type="button"
                    onClick={() => unbanUser(banned.userId)}
                    disabled={unbanningUserId === banned.userId}
                    className="rounded-md border border-edge bg-surface px-3 py-1 text-xs hover:border-sky-600 hover:bg-cream disabled:opacity-50"
                  >
                    {unbanningUserId === banned.userId ? "Unbanning…" : "Unban"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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
