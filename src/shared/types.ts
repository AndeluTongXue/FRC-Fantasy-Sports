export type LeagueType = "single_event" | "season";
export type LeagueStatus = "setup" | "drafting" | "active" | "complete";

export interface User {
  id: string;
  email: string;
  displayName: string;
  /** Gates `/api/admin/*` (the TBA/Statbotics sync jobs). Granted in D1, not in the app. */
  isAdmin: boolean;
  /** False until the confirmation link is clicked. Creating and joining leagues is gated
   * on it; everything else works either way. */
  emailVerified: boolean;
}

export interface Team {
  teamKey: string;
  teamNumber: number;
  nickname: string | null;
  name: string | null;
  city: string | null;
  stateProv: string | null;
  country: string | null;
  rookieYear: number | null;
}

export interface PricedTeam extends Team {
  price: number;
  epa: number | null;
}

export interface FrcEvent {
  eventKey: string;
  year: number;
  name: string;
  shortName: string | null;
  eventType: number | null;
  eventTypeString: string | null;
  week: number | null;
  startDate: string | null;
  endDate: string | null;
  city: string | null;
  stateProv: string | null;
  country: string | null;
}

export interface League {
  id: string;
  name: string;
  leagueType: LeagueType;
  eventKey: string | null;
  seasonYear: number;
  inviteCode: string;
  commissionerId: string;
  rosterSize: number;
  salaryCap: number;
  maxMembers: number;
  pickSeconds: number;
  scoringConfig: ScoringConfig;
  status: LeagueStatus;
  createdAt: number;
  /** When the draft should auto-start, or null if it must be started manually. Only
   * meaningful pre-draft — cleared once the draft actually starts, manually or not. */
  scheduledDraftAt: number | null;
}

export interface LeagueMember {
  userId: string;
  displayName: string;
  rosterName: string;
  draftPosition: number | null;
  joinedAt: number;
}

export interface DraftPick {
  pickNumber: number;
  userId: string;
  teamKey: string;
  price: number;
  draftedAt: number;
}

/** Point values applied to real FRC results. Overridable per league. */
export interface ScoringConfig {
  qualWin: number;
  qualTie: number;
  rankingPoint: number;
  allianceCaptain: number;
  alliancePick1: number;
  alliancePick2: number;
  alliancePick3: number;
  playoffWin: number;
  eventWinner: number;
  eventFinalist: number;
  awardImpact: number;
  awardEngineeringInspiration: number;
  awardOther: number;
  /** Multiplier applied to everything earned at a Championship event. */
  championshipMultiplier: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  qualWin: 10,
  qualTie: 3,
  // Teams bank 40-55 RP over a qual schedule, so a high per-RP value would swamp
  // everything playoffs and awards are worth. 2 keeps quals and eliminations comparable.
  rankingPoint: 2,
  allianceCaptain: 15,
  alliancePick1: 10,
  alliancePick2: 6,
  alliancePick3: 3,
  playoffWin: 20,
  eventWinner: 75,
  eventFinalist: 35,
  awardImpact: 30,
  awardEngineeringInspiration: 12,
  awardOther: 5,
  championshipMultiplier: 1.5,
};

export interface ApiError {
  error: string;
}

export type DraftStatus = "pending" | "active" | "complete";

export interface DraftState {
  status: DraftStatus;
  /** User ids in first-round order; later rounds snake through this list. */
  order: string[];
  currentPick: number;
  totalPicks: number;
  currentUserId: string | null;
  /** Epoch ms when the current pick auto-drafts, or null when the clock isn't running —
   * which includes being paused, so a paused room shows no countdown. */
  deadline: number | null;
  /** Milliseconds that were left on the clock when the commissioner paused, or null when the
   * draft isn't paused. Resuming gives that time back rather than restarting the pick. */
  pausedRemainingMs: number | null;
  /** Epoch ms when the draft auto-starts, or null. Only meaningful while `status` is
   * "pending" — cleared the moment the draft actually starts. */
  scheduledDraftAt: number | null;
  budgets: Record<string, number>;
  picks: DraftPick[];
  rosterSize: number;
  salaryCap: number;
  /** Ascending prices of the cheapest undrafted pool teams right now (enough of them to
   * cover any manager's reserve calculation — up to `totalPicks`). A manager with
   * `slotsAfterPick` slots left after their next pick should reserve the sum of the slice
   * starting right after the number of opponent picks that will land before their own
   * remaining slots are filled (see DraftRoom's reserveCost/othersPicksBeforeMyLast) — NOT
   * `slotsAfterPick` copies of the single cheapest price, which understates the cost
   * whenever more than one slot remains. */
  cheapestPrices: number[];
}

export type DraftClientMessage =
  | { type: "start" }
  | { type: "pick"; teamKey: string }
  // Commissioner-only, for when a draft goes wrong in a way the managers can't fix
  // themselves — a dropped connection, someone who stepped away, a misclick.
  | { type: "pause" }
  | { type: "resume" }
  | { type: "extend" }
  // Runs the manager's own autopick early, rather than letting the commissioner choose a
  // team for them: which team to take is that manager's call, and their queue already
  // states it.
  | { type: "autopick" }
  | { type: "undo" };

/** Seconds an "extend" adds to the current pick. */
export const CLOCK_EXTENSION_SECONDS = 60;

export type DraftServerMessage =
  | { type: "state"; state: DraftState }
  | { type: "error"; message: string };

/** Snake order: odd-numbered rounds run backwards. */
export function pickOwner(order: string[], pickIndex: number): string | null {
  if (order.length === 0) return null;
  const round = Math.floor(pickIndex / order.length);
  const slot = pickIndex % order.length;
  return order[round % 2 === 0 ? slot : order.length - 1 - slot];
}
