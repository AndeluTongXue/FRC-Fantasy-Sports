import { DurableObject } from "cloudflare:workers";
import type { DraftClientMessage, DraftServerMessage, DraftState } from "../../shared/types";
import { pickOwner } from "../../shared/types";
import type { Env } from "../lib/env";
import { pricingYearForLeague } from "../lib/pricing";
import { DEFAULT_TEAM_PRICE } from "../lib/statbotics";

interface LeagueConfig {
  id: string;
  league_type: string;
  event_key: string | null;
  season_year: number;
  commissioner_id: string;
  roster_size: number;
  salary_cap: number;
  pick_seconds: number;
}

/**
 * Live draft for one league. Holds the authoritative turn order, budgets and picks,
 * and pushes every change to connected owners over WebSocket. Completed picks are
 * mirrored into D1, which stays the system of record for rosters.
 */
export class DraftRoom extends DurableObject<Env> {
  private state: DraftState | null = null;
  private leagueId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<DraftState>("state")) ?? null;
      this.leagueId = (await ctx.storage.get<string>("leagueId")) ?? null;
    });
  }

  /**
   * Called when the league itself is deleted, so this room doesn't linger with a
   * scheduled alarm that would later fire against a league row that no longer exists.
   */
  async resetForDeletion(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.state = null;
    this.leagueId = null;
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(1000, "League deleted");
    }
  }

  async fetch(request: Request): Promise<Response> {
    const leagueId = request.headers.get("X-League-Id");
    const userId = request.headers.get("X-User-Id");
    if (!leagueId || !userId) return new Response("Missing draft identity", { status: 400 });

    if (this.leagueId !== leagueId) {
      this.leagueId = leagueId;
      await this.ctx.storage.put("leagueId", leagueId);
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [userId]);

    const state = this.state ?? (await this.buildPendingState());
    server.send(JSON.stringify({ type: "state", state } satisfies DraftServerMessage));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const userId = this.ctx.getTags(ws)[0];
    if (typeof raw !== "string") return;

    let message: DraftClientMessage;
    try {
      message = JSON.parse(raw) as DraftClientMessage;
    } catch {
      return this.sendError(ws, "Malformed message");
    }

    try {
      if (message.type === "start") await this.startDraft(userId);
      else if (message.type === "pick") await this.makePick(userId, message.teamKey);
    } catch (error) {
      this.sendError(ws, error instanceof Error ? error.message : "Draft action failed");
    }
  }

  /** Pick clock expired — auto-draft the best team the owner can still afford. */
  async alarm(): Promise<void> {
    if (!this.state || this.state.status !== "active") return;

    const onClock = this.state.currentUserId;
    if (!onClock) return;

    let league: LeagueConfig;
    try {
      league = await this.loadLeague();
    } catch {
      // League was deleted out from under this alarm — stop retrying instead of looping.
      await this.resetForDeletion();
      return;
    }
    const budget = this.state.budgets[onClock] ?? 0;
    const slotsAfterPick = this.slotsRemaining(onClock) - 1;
    const floor = await this.cheapestAvailable(league);
    const maxSpend = budget - slotsAfterPick * floor;

    const best = await this.bestAvailable(league, maxSpend);
    if (best) await this.applyPick(league, onClock, best.teamKey, best.price);
    else await this.advance(league);
  }

  private sendError(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ type: "error", message } satisfies DraftServerMessage));
  }

  private broadcast(): void {
    if (!this.state) return;
    const payload = JSON.stringify({ type: "state", state: this.state } satisfies DraftServerMessage);
    for (const socket of this.ctx.getWebSockets()) socket.send(payload);
  }

  private async persist(): Promise<void> {
    if (this.state) await this.ctx.storage.put("state", this.state);
  }

  private async loadLeague(): Promise<LeagueConfig> {
    const league = await this.env.DB.prepare(
      `SELECT id, league_type, event_key, season_year, commissioner_id, roster_size, salary_cap, pick_seconds
       FROM leagues WHERE id = ?`,
    )
      .bind(this.leagueId)
      .first<LeagueConfig>();
    if (!league) throw new Error("League not found");
    return league;
  }

  private async members(): Promise<{ user_id: string }[]> {
    const { results } = await this.env.DB.prepare(
      "SELECT user_id FROM league_members WHERE league_id = ? ORDER BY joined_at",
    )
      .bind(this.leagueId)
      .all<{ user_id: string }>();
    return results;
  }

  private async buildPendingState(): Promise<DraftState> {
    const league = await this.loadLeague();
    const roster = await this.members();
    return {
      status: "pending",
      order: roster.map((member) => member.user_id),
      currentPick: 0,
      totalPicks: roster.length * league.roster_size,
      currentUserId: null,
      deadline: null,
      budgets: Object.fromEntries(roster.map((member) => [member.user_id, league.salary_cap])),
      picks: [],
      rosterSize: league.roster_size,
      salaryCap: league.salary_cap,
      cheapestAvailable: await this.cheapestAvailable(league),
    };
  }

  private slotsRemaining(userId: string): number {
    if (!this.state) return 0;
    const taken = this.state.picks.filter((pick) => pick.userId === userId).length;
    return this.state.rosterSize - taken;
  }

  /** Team keys eligible for this league: an event's roster, or the whole season's teams. */
  private poolFilter(league: LeagueConfig): { clause: string; bindings: unknown[] } {
    if (league.league_type === "single_event" && league.event_key) {
      return {
        clause: "t.team_key IN (SELECT team_key FROM event_teams WHERE event_key = ?)",
        bindings: [league.event_key],
      };
    }
    return { clause: "1 = 1", bindings: [] };
  }

  private takenPlaceholders(): { clause: string; bindings: string[] } {
    const keys = this.state?.picks.map((pick) => pick.teamKey) ?? [];
    if (keys.length === 0) return { clause: "1 = 1", bindings: [] };
    return { clause: `t.team_key NOT IN (${keys.map(() => "?").join(",")})`, bindings: keys };
  }

  private async cheapestAvailable(league: LeagueConfig): Promise<number> {
    const pool = this.poolFilter(league);
    const taken = this.takenPlaceholders();
    const pricingYear = await pricingYearForLeague(this.env.DB, league);
    const row = await this.env.DB.prepare(
      `SELECT MIN(COALESCE(p.price, ?)) AS min_price
       FROM teams t
       LEFT JOIN team_prices p ON p.team_key = t.team_key AND p.season_year = ?
       WHERE ${pool.clause} AND ${taken.clause}`,
    )
      .bind(DEFAULT_TEAM_PRICE, pricingYear, ...pool.bindings, ...taken.bindings)
      .first<{ min_price: number | null }>();
    return row?.min_price ?? DEFAULT_TEAM_PRICE;
  }

  private async bestAvailable(
    league: LeagueConfig,
    maxSpend: number,
  ): Promise<{ teamKey: string; price: number } | null> {
    const pool = this.poolFilter(league);
    const taken = this.takenPlaceholders();
    const pricingYear = await pricingYearForLeague(this.env.DB, league);
    const row = await this.env.DB.prepare(
      `SELECT t.team_key, COALESCE(p.price, ?) AS price
       FROM teams t
       LEFT JOIN team_prices p ON p.team_key = t.team_key AND p.season_year = ?
       WHERE ${pool.clause} AND ${taken.clause} AND COALESCE(p.price, ?) <= ?
       ORDER BY COALESCE(p.epa, -1e9) DESC, price DESC
       LIMIT 1`,
    )
      .bind(
        DEFAULT_TEAM_PRICE,
        pricingYear,
        ...pool.bindings,
        ...taken.bindings,
        DEFAULT_TEAM_PRICE,
        maxSpend,
      )
      .first<{ team_key: string; price: number }>();
    return row ? { teamKey: row.team_key, price: row.price } : null;
  }

  private async priceOf(league: LeagueConfig, teamKey: string): Promise<number | null> {
    const pool = this.poolFilter(league);
    const pricingYear = await pricingYearForLeague(this.env.DB, league);
    const row = await this.env.DB.prepare(
      `SELECT COALESCE(p.price, ?) AS price
       FROM teams t
       LEFT JOIN team_prices p ON p.team_key = t.team_key AND p.season_year = ?
       WHERE t.team_key = ? AND ${pool.clause}`,
    )
      .bind(DEFAULT_TEAM_PRICE, pricingYear, teamKey, ...pool.bindings)
      .first<{ price: number }>();
    return row?.price ?? null;
  }

  private async startDraft(userId: string): Promise<void> {
    const league = await this.loadLeague();
    if (userId !== league.commissioner_id) throw new Error("Only the commissioner can start the draft");
    if (this.state?.status === "active") throw new Error("Draft is already running");
    if (this.state?.status === "complete") throw new Error("Draft is already finished");

    const roster = await this.members();
    if (roster.length < 2) throw new Error("Need at least 2 owners to draft");

    const order = roster.map((member) => member.user_id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    this.state = {
      status: "active",
      order,
      currentPick: 0,
      totalPicks: order.length * league.roster_size,
      currentUserId: order[0],
      deadline: Date.now() + league.pick_seconds * 1000,
      budgets: Object.fromEntries(order.map((id) => [id, league.salary_cap])),
      picks: [],
      rosterSize: league.roster_size,
      salaryCap: league.salary_cap,
      cheapestAvailable: await this.cheapestAvailable(league),
    };

    await this.env.DB.batch([
      ...order.map((id, index) =>
        this.env.DB.prepare(
          "UPDATE league_members SET draft_position = ? WHERE league_id = ? AND user_id = ?",
        ).bind(index, league.id, id),
      ),
      this.env.DB.prepare("UPDATE leagues SET status = 'drafting' WHERE id = ?").bind(league.id),
      this.env.DB.prepare("DELETE FROM draft_picks WHERE league_id = ?").bind(league.id),
    ]);

    await this.persist();
    await this.ctx.storage.setAlarm(this.state.deadline!);
    this.broadcast();
  }

  private async makePick(userId: string, teamKey: string): Promise<void> {
    if (!this.state || this.state.status !== "active") throw new Error("Draft is not running");
    if (this.state.currentUserId !== userId) throw new Error("It's not your turn");
    if (this.state.picks.some((pick) => pick.teamKey === teamKey)) throw new Error("That team is already drafted");

    const league = await this.loadLeague();
    const price = await this.priceOf(league, teamKey);
    if (price === null) throw new Error("That team isn't in this league's pool");

    const budget = this.state.budgets[userId] ?? 0;
    if (price > budget) throw new Error(`You only have $${budget} left`);

    const slotsAfterPick = this.slotsRemaining(userId) - 1;
    const floor = await this.cheapestAvailable(league);
    if (budget - price < slotsAfterPick * floor) {
      throw new Error(`Too expensive — you must leave at least $${slotsAfterPick * floor} to fill your roster`);
    }

    await this.applyPick(league, userId, teamKey, price);
  }

  private async applyPick(
    league: LeagueConfig,
    userId: string,
    teamKey: string,
    price: number,
  ): Promise<void> {
    if (!this.state) return;

    const pick = { pickNumber: this.state.currentPick, userId, teamKey, price, draftedAt: Date.now() };
    this.state.picks.push(pick);
    this.state.budgets[userId] = (this.state.budgets[userId] ?? 0) - price;

    await this.env.DB.prepare(
      `INSERT INTO draft_picks (league_id, pick_number, user_id, team_key, price, drafted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(league.id, pick.pickNumber, userId, teamKey, price, pick.draftedAt)
      .run();

    await this.advance(league);
  }

  private async advance(league: LeagueConfig): Promise<void> {
    if (!this.state) return;

    this.state.currentPick += 1;

    if (this.state.currentPick >= this.state.totalPicks) {
      this.state.status = "complete";
      this.state.currentUserId = null;
      this.state.deadline = null;
      await this.ctx.storage.deleteAlarm();
      await this.env.DB.prepare("UPDATE leagues SET status = 'active' WHERE id = ?").bind(league.id).run();
    } else {
      this.state.currentUserId = pickOwner(this.state.order, this.state.currentPick);
      this.state.deadline = Date.now() + league.pick_seconds * 1000;
      await this.ctx.storage.setAlarm(this.state.deadline);
    }

    // The pool may have shrunk (a pick was made) — keep the reserve-guard floor current
    // so clients can accurately predict which picks would be rejected.
    this.state.cheapestAvailable = await this.cheapestAvailable(league);

    await this.persist();
    this.broadcast();
  }
}
