/**
 * Verifies the minimum-salary-cap guarantee: it's the smallest cap that provably lets
 * every manager fill their roster no matter how the draft unfolds.
 *
 * The worst case for one manager is NOT the globally priciest teams — the other
 * (maxMembers - 1) managers can only ever hoard away (maxMembers - 1) * rosterSize teams
 * between them, and a manager always drafts the cheapest team still on the board. So the
 * true worst case is: opponents grab the `otherCapacity` cheapest teams first, and this
 * manager is left to fill their roster from the cheapest `rosterSize` teams that remain
 * after that (the price-ascending slice starting right after `otherCapacity`), not the top
 * `rosterSize` most expensive teams overall.
 *
 * Checks the math against that formula (both in a pool with slack and in an insufficient
 * pool, where it correctly collapses to the old "top rosterSize overall" bound), the
 * season-long pool being bounded rather than averaging 3000+ teams, the insufficient-pool
 * warning, and — the real proof — that a live draft actually completes with full rosters
 * for everyone when every owner's cap is set to exactly this minimum and each owner spends
 * as aggressively as the live reserve-budget rule ever allows (the exact worst-case
 * pressure the guarantee is supposed to withstand).
 *
 * Usage: node scripts/minimum-cap-smoke.mjs [baseUrl]
 */
import WebSocket from "ws";

import { confirmEmail } from "./lib/confirm-email.mjs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const failures = [];

function check(label, condition, detail = "") {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

async function signIn(email, displayName) {
  for (const path of ["/api/auth/signup", "/api/auth/login"]) {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "testpass123", displayName }),
    });
    if (response.ok) {
      const session = { cookie: response.headers.get("set-cookie").split(";")[0], user: (await response.json()).user };
      // League routes need a confirmed address, and a fresh signup starts unconfirmed.
      if (path === "/api/auth/signup") await confirmEmail(BASE, email);
      return session;
    }
  }
  throw new Error(`could not sign in ${email}`);
}

async function api(cookie, path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const owner = await signIn(`mincap-${Date.now()}@example.com`, "Mincap Tester");

console.log("Validation:");
const missingEventKey = await api(owner.cookie, "/api/leagues/minimum-cap?leagueType=single_event&rosterSize=6&maxMembers=8");
check("single-event without eventKey is rejected", missingEventKey.status === 400, missingEventKey.body.error);

console.log("\nSingle-event league — the math:");
// rosterSize=4, maxMembers=8 => 32 needed, which fits inside this ~37-team event roster.
const singleEvent = await api(
  owner.cookie,
  "/api/leagues/minimum-cap?leagueType=single_event&eventKey=2026casnv&rosterSize=4&maxMembers=8",
);
check("returns a minimum", singleEvent.status === 200, JSON.stringify(singleEvent.body));

const pool = await api(owner.cookie, "/api/teams?eventKey=2026casnv&limit=100");
const pricesAsc = pool.body.teams.map((t) => t.price).sort((a, b) => a - b);
// rosterSize=4, maxMembers=8 => the other 7 managers can hoard at most 28 teams between
// them; this manager's worst case is the cheapest 4 teams left after that.
const otherCapacity = 7 * 4;
const offset = Math.min(otherCapacity, pricesAsc.length - 4);
const expectedWorstCase = pricesAsc.slice(offset, offset + 4).reduce((sum, p) => sum + p, 0);
const expectedMinimum = Math.ceil(expectedWorstCase / 5) * 5;
check(
  "minimum = sum of the 4 cheapest teams left after opponents hoard 28, rounded up to $5",
  singleEvent.body.minimumCap === expectedMinimum,
  `${singleEvent.body.minimumCap} vs expected ${expectedMinimum}`,
);
check(
  "worstCaseOpponentPicks is (maxMembers-1)*rosterSize=28, not the full 37-team roster",
  singleEvent.body.worstCaseOpponentPicks === 28,
  singleEvent.body.worstCaseOpponentPicks,
);
check("universeSize reports the event's actual full roster", singleEvent.body.universeSize === pool.body.teams.length);
check("not flagged insufficient (32 needed fits in this ~37-team event)", singleEvent.body.insufficientPool === false);

console.log("\nSeason-long league (must NOT price off the top of a 3000+ team pool):");
const season = await api(owner.cookie, "/api/leagues/minimum-cap?leagueType=season&rosterSize=6&maxMembers=8");
check("returns a minimum", season.status === 200, JSON.stringify(season.body));
check(
  "worstCaseOpponentPicks is (maxMembers-1)*rosterSize=42, not the full 3000+ pool",
  season.body.worstCaseOpponentPicks === 42,
  season.body.worstCaseOpponentPicks,
);
check(
  // With ~3690 teams to choose from, opponents hoarding the cheapest 42 barely dents the
  // pool — this manager's worst case still lands among cheap, not elite, teams. Guards
  // against the old bug, which priced this off the 6 most expensive teams in all of FRC.
  "season minimum is modest — worst case lands near the cheap end of the pool, not the elite end",
  season.body.minimumCap > 0 && season.body.minimumCap < 200,
  season.body.minimumCap,
);

console.log("\nInsufficient-pool detection:");
const tooManyManagers = await api(
  owner.cookie,
  "/api/leagues/minimum-cap?leagueType=single_event&eventKey=2026casnv&rosterSize=10&maxMembers=16",
);
check(
  "flags insufficient when maxMembers*rosterSize exceeds the event's teams",
  tooManyManagers.body.insufficientPool === true,
  JSON.stringify(tooManyManagers.body),
);
// Not enough teams for every manager to fill a roster at all, let alone leave slack —
// the worst case here correctly collapses to the old "top rosterSize overall" bound.
const pricesDesc = pool.body.teams.map((t) => t.price).sort((a, b) => b - a);
const expectedInsufficientWorstCase = pricesDesc.slice(0, 10).reduce((sum, p) => sum + p, 0);
const expectedInsufficientMinimum = Math.ceil(expectedInsufficientWorstCase / 5) * 5;
check(
  "insufficient-pool minimum collapses to the sum of the 10 priciest teams at the event",
  tooManyManagers.body.minimumCap === expectedInsufficientMinimum,
  `${tooManyManagers.body.minimumCap} vs expected ${expectedInsufficientMinimum}`,
);

console.log("\nThe real proof — a live draft at exactly the minimum cap, picked adversarially:");
const rival = await signIn(`mincap-rival-${Date.now()}@example.com`, "Mincap Rival");
// maxMembers matches the real 2 participants below, so this is a tight proof of the exact
// guarantee for this league — not a looser bound borrowed from some other league size.
const proofMinimum = await api(
  owner.cookie,
  "/api/leagues/minimum-cap?leagueType=single_event&eventKey=2026casnv&rosterSize=4&maxMembers=2",
);
console.log(`  Using cap $${proofMinimum.body.minimumCap} for a 2-owner, 4-slot draft\n`);

const { league } = await api(owner.cookie, "/api/leagues", {
  method: "POST",
  body: JSON.stringify({
    name: `Minimum Cap Proof ${Date.now()}`,
    leagueType: "single_event",
    eventKey: "2026casnv",
    rosterSize: 4,
    maxMembers: 2,
    salaryCap: proofMinimum.body.minimumCap,
  }),
}).then((r) => r.body);
await api(rival.cookie, "/api/leagues/join", { method: "POST", body: JSON.stringify({ inviteCode: league.inviteCode }) });

/** Mirrors DraftRoom's othersPicksBeforeMyLast / shared/types.ts pickOwner exactly. */
function pickOwner(order, pickIndex) {
  if (order.length === 0) return null;
  const round = Math.floor(pickIndex / order.length);
  const slot = pickIndex % order.length;
  return order[round % 2 === 0 ? slot : order.length - 1 - slot];
}

function othersPicksBeforeMyLast(state, userId, slotsAfterPick) {
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

function connect(leagueId, cookie) {
  const socket = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${leagueId}/draft/ws`, {
    headers: { Cookie: cookie },
  });
  const waiters = [];
  const inbox = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    next: () =>
      new Promise((resolve, reject) => {
        if (inbox.length) return resolve(inbox.shift());
        const timer = setTimeout(() => reject(new Error("timed out")), 10000);
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      }),
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
}

const alpha = connect(league.id, owner.cookie);
const beta = connect(league.id, rival.cookie);
await Promise.all([alpha.ready, beta.ready]);
await alpha.next();
await beta.next();

alpha.send({ type: "start" });
let latest = (await alpha.next()).state;
await beta.next();
const sockets = { [owner.user.id]: alpha, [rival.user.id]: beta };

let picksAttempted = 0;
let anyRejected = false;
while (latest.status === "active" && picksAttempted < 20) {
  picksAttempted++;
  const available = (await api(owner.cookie, `/api/leagues/${league.id}/pool?limit=100`)).body.teams;
  // Adversarial: spend as aggressively as the live reserve-budget rule ever allows (the
  // same maxSpend the real draft UI computes), always grabbing the priciest team within
  // that — the exact worst-case pressure the minimum cap is supposed to withstand. Ignoring
  // the reserve floor here would make this a stress test of nothing: the whole point of a
  // *minimum* cap is that it has zero slack for spending that disrespects the reserve rule.
  const budget = latest.budgets[latest.currentUserId];
  const slotsRemaining = latest.rosterSize - latest.picks.filter((p) => p.userId === latest.currentUserId).length;
  const slotsAfterPick = Math.max(slotsRemaining - 1, 0);
  const otherCapacity = othersPicksBeforeMyLast(latest, latest.currentUserId, slotsAfterPick);
  const reserve = latest.cheapestPrices
    .slice(otherCapacity, otherCapacity + slotsAfterPick)
    .reduce((sum, p) => sum + p, 0);
  const maxSpend = budget - reserve;
  const affordable = available.filter((t) => t.price <= maxSpend).sort((a, b) => b.price - a.price);
  const cheapest = available.slice().sort((a, b) => a.price - b.price)[0];
  const choice = affordable[0] ?? cheapest;

  const picker = sockets[latest.currentUserId];
  const other = picker === alpha ? beta : alpha;
  picker.send({ type: "pick", teamKey: choice.teamKey });
  const pickerMsg = await picker.next();
  if (pickerMsg.type === "error") {
    anyRejected = true;
    break; // would otherwise hang forever waiting on `other`, which never hears about a rejected pick
  }
  await other.next();
  latest = pickerMsg.state;
}

check("no pick was ever rejected under adversarial play", !anyRejected);
check("draft completed (didn't hang / infinite-loop)", latest.status === "complete", latest.status);
check(
  "every owner filled their full roster — the minimum cap held up under worst-case picking",
  latest.picks.length === latest.totalPicks,
  `${latest.picks.length}/${latest.totalPicks} picks made`,
);
for (const ownerId of latest.order) {
  const rosterCount = latest.picks.filter((p) => p.userId === ownerId).length;
  check(`owner ${ownerId.slice(0, 8)} has a full roster (4 teams)`, rosterCount === 4, rosterCount);
}

alpha.close();
beta.close();

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll minimum-cap checks passed.");
process.exit(failures.length ? 1 : 0);
