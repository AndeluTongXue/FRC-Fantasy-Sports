/**
 * Verifies leaving a league: a regular member leaving just removes their membership; the
 * commissioner leaving transfers ownership to the next-oldest member; the sole member
 * (commissioner with nobody else) is blocked and told to delete instead; and leaving is
 * blocked entirely once the draft has started.
 *
 * Usage: node scripts/leave-league-smoke.mjs [baseUrl]
 */
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

async function newLeague(cookie, overrides = {}) {
  return api(cookie, "/api/leagues", {
    method: "POST",
    body: JSON.stringify({
      name: `Leave Test ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      leagueType: "season",
      rosterSize: 3,
      salaryCap: 200,
      ...overrides,
    }),
  }).then((r) => r.body.league);
}

const owner = await signIn(`leave-owner-${Date.now()}@example.com`, "Leave Owner");
const rival = await signIn(`leave-rival-${Date.now()}@example.com`, "Leave Rival");
const third = await signIn(`leave-third-${Date.now()}@example.com`, "Leave Third");

console.log("Sole member (commissioner alone) is blocked:");
const soloLeague = await newLeague(owner.cookie);
const soloLeave = await api(owner.cookie, `/api/leagues/${soloLeague.id}/leave`, { method: "POST" });
check(
  "solo commissioner cannot leave",
  soloLeave.status === 400 && /delete the league instead/i.test(soloLeave.body.error),
  `${soloLeave.status} ${soloLeave.body.error}`,
);
const soloStillThere = await api(owner.cookie, `/api/leagues/${soloLeague.id}`);
check("league is untouched after the blocked attempt", soloStillThere.status === 200);

console.log("\nRegular member leaving:");
const twoLeague = await newLeague(owner.cookie);
await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: twoLeague.inviteCode }),
});
const rivalLeaves = await api(rival.cookie, `/api/leagues/${twoLeague.id}/leave`, { method: "POST" });
check("rival can leave", rivalLeaves.status === 200, JSON.stringify(rivalLeaves.body));

const afterRivalLeaves = await api(owner.cookie, `/api/leagues/${twoLeague.id}`);
check(
  "owner remains as the sole member, still commissioner",
  afterRivalLeaves.body.members.length === 1 && afterRivalLeaves.body.league.commissionerId === owner.user.id,
);
const rivalNoLongerMember = await api(rival.cookie, `/api/leagues/${twoLeague.id}`);
check("rival can no longer access the league", rivalNoLongerMember.status === 403);

console.log("\nCommissioner leaving transfers ownership to the next-oldest member:");
const transferLeague = await newLeague(owner.cookie);
await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: transferLeague.inviteCode }),
});
await api(third.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: transferLeague.inviteCode }),
});
const ownerLeaves = await api(owner.cookie, `/api/leagues/${transferLeague.id}/leave`, { method: "POST" });
check(
  "commissioner can leave when others remain",
  ownerLeaves.status === 200 && ownerLeaves.body.newCommissionerId === rival.user.id,
  JSON.stringify(ownerLeaves.body),
);

const afterTransfer = await api(rival.cookie, `/api/leagues/${transferLeague.id}`);
check("next-oldest member (rival) is now commissioner", afterTransfer.body.league.commissionerId === rival.user.id);
check(
  "original owner is no longer a member",
  !afterTransfer.body.members.some((m) => m.userId === owner.user.id),
);
check("third member is unaffected, still present", afterTransfer.body.members.some((m) => m.userId === third.user.id));
const ownerLockedOut = await api(owner.cookie, `/api/leagues/${transferLeague.id}`);
check("original owner can no longer access the league", ownerLockedOut.status === 403);

console.log("\nCan't leave once the league is full and drafting has begun:");
const draftLeague = await newLeague(owner.cookie);
await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: draftLeague.inviteCode }),
});
const startRes = await api(owner.cookie, `/api/leagues/${draftLeague.id}`);
check("league is in setup before starting", startRes.body.league.status === "setup");

// Drive the draft to 'drafting' via the DO's WebSocket start message.
const WebSocket = (await import("ws")).default;
const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${draftLeague.id}/draft/ws`, {
  headers: { Cookie: owner.cookie },
});
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
await new Promise((resolve) => ws.once("message", resolve));
ws.send(JSON.stringify({ type: "start" }));
await new Promise((resolve) => ws.once("message", resolve));
ws.close();

const rivalLeaveAfterStart = await api(rival.cookie, `/api/leagues/${draftLeague.id}/leave`, { method: "POST" });
check(
  "leaving is rejected once drafting has started",
  rivalLeaveAfterStart.status === 409,
  `${rivalLeaveAfterStart.status} ${rivalLeaveAfterStart.body.error}`,
);

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll leave-league checks passed.",
);
process.exit(failures.length ? 1 : 0);
