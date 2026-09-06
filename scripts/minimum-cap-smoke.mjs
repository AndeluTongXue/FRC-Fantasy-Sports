/**
 * Verifies the minimum-salary-cap guarantee: it's the smallest cap that provably lets
 * every manager fill their roster no matter how the draft unfolds. Checks the math
 * (worst-case sum of the priciest teams in the relevant pool), the season-long pool
 * being bounded rather than averaging 3000+ teams, the insufficient-pool warning, and
 * — the real proof — that a live draft actually completes with full rosters for
 * everyone when every owner's cap is set to exactly this minimum and picks adversarially
 * (always taking the most expensive affordable team, to stress-test the guarantee).
 *
 * Usage: node scripts/minimum-cap-smoke.mjs [baseUrl]
 */
import WebSocket from "ws";

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
      return { cookie: response.headers.get("set-cookie").split(";")[0], user: (await response.json()).user };
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
const prices = pool.body.teams.map((t) => t.price).sort((a, b) => b - a);
const expectedWorstCase = prices.slice(0, 4).reduce((sum, p) => sum + p, 0);
const expectedMinimum = Math.ceil(expectedWorstCase / 5) * 5;
check(
  "minimum = sum of the 4 priciest teams at the event, rounded up to $5",
  singleEvent.body.minimumCap === expectedMinimum,
  `${singleEvent.body.minimumCap} vs expected ${expectedMinimum}`,
);
check(
  "poolSize is capped at maxMembers*rosterSize=32, not the full 37-team roster",
  singleEvent.body.poolSize === 32,
  singleEvent.body.poolSize,
);
check("universeSize reports the event's actual full roster", singleEvent.body.universeSize === pool.body.teams.length);
check("not flagged insufficient (32 needed fits in this ~37-team event)", singleEvent.body.insufficientPool === false);

console.log("\nSeason-long league (must NOT average 3000+ teams):");
const season = await api(owner.cookie, "/api/leagues/minimum-cap?leagueType=season&rosterSize=6&maxMembers=8");
check("returns a minimum", season.status === 200, JSON.stringify(season.body));
check(
  "pool bounded to maxMembers*rosterSize=48, not thousands",
  season.body.poolSize <= 48,
  season.body.poolSize,
);
check(
  "season minimum is meaningfully large (worst case draws from elite teams, not the whole 3000+ pool)",
  season.body.minimumCap > 200,
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
  // Adversarial: always grab the single MOST expensive team still affordable, to burn
  // through budget as aggressively as the reserve rule allows — the exact worst case the
  // minimum cap is supposed to guard against.
  const budget = latest.budgets[latest.currentUserId];
  const affordable = available.filter((t) => t.price <= budget).sort((a, b) => b.price - a.price);
  const choice = affordable[0] ?? available.at(-1);
  sockets[latest.currentUserId].send({ type: "pick", teamKey: choice.teamKey });
  const [a, b] = await Promise.all([alpha.next(), beta.next()]);
  const msg = a.type === "state" ? a : b;
  if (msg.type === "error") anyRejected = true;
  latest = msg.state ?? latest;
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
