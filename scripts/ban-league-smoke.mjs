/**
 * Verifies commissioner ban/unban: banning kicks a current member and blocks them from
 * rejoining, permissions are commissioner-only, self-ban is refused, banning is blocked
 * once the draft has started, and unbanning restores the ability to rejoin.
 *
 * Usage: node scripts/ban-league-smoke.mjs [baseUrl]
 */
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

async function newLeague(cookie) {
  return api(cookie, "/api/leagues", {
    method: "POST",
    body: JSON.stringify({
      name: `Ban Test ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      leagueType: "season",
      rosterSize: 3,
      salaryCap: 200,
    }),
  }).then((r) => r.body.league);
}

const owner = await signIn(`ban-owner-${Date.now()}@example.com`, "Ban Owner");
const rival = await signIn(`ban-rival-${Date.now()}@example.com`, "Ban Rival");
const bystander = await signIn(`ban-bystander-${Date.now()}@example.com`, "Ban Bystander");

console.log("Permissions and validation:");
const league = await newLeague(owner.cookie);
await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: league.inviteCode }),
});

const nonCommissionerBans = await api(rival.cookie, `/api/leagues/${league.id}/ban`, {
  method: "POST",
  body: JSON.stringify({ userId: owner.user.id }),
});
check(
  "non-commissioner cannot ban",
  nonCommissionerBans.status === 403,
  `${nonCommissionerBans.status} ${nonCommissionerBans.body.error}`,
);

const selfBan = await api(owner.cookie, `/api/leagues/${league.id}/ban`, {
  method: "POST",
  body: JSON.stringify({ userId: owner.user.id }),
});
check("commissioner cannot ban themselves", selfBan.status === 400, `${selfBan.status} ${selfBan.body.error}`);

console.log("\nBanning a current member:");
const ban = await api(owner.cookie, `/api/leagues/${league.id}/ban`, {
  method: "POST",
  body: JSON.stringify({ userId: rival.user.id }),
});
check("ban succeeds", ban.status === 200, JSON.stringify(ban.body));

const afterBan = await api(owner.cookie, `/api/leagues/${league.id}`);
check(
  "banned member is removed from the roster",
  !afterBan.body.members.some((m) => m.userId === rival.user.id),
);
check(
  "banned user appears in the commissioner's bannedUsers list",
  afterBan.body.bannedUsers.some((b) => b.userId === rival.user.id),
  JSON.stringify(afterBan.body.bannedUsers),
);
const rivalLockedOut = await api(rival.cookie, `/api/leagues/${league.id}`);
check("banned user can no longer view the league", rivalLockedOut.status === 403);

const bannedListHiddenFromNonCommissioner = await api(bystander.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: league.inviteCode }),
});
check("a non-banned user can still join normally", bannedListHiddenFromNonCommissioner.status === 200);
const bystanderView = await api(bystander.cookie, `/api/leagues/${league.id}`);
check(
  "bannedUsers is empty for a non-commissioner viewer",
  bystanderView.body.bannedUsers.length === 0,
  JSON.stringify(bystanderView.body.bannedUsers),
);

console.log("\nRejoining while banned is blocked:");
const rejoinAttempt = await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: league.inviteCode }),
});
check(
  "banned user cannot rejoin with the invite code",
  rejoinAttempt.status === 403 && /banned/i.test(rejoinAttempt.body.error),
  `${rejoinAttempt.status} ${rejoinAttempt.body.error}`,
);

console.log("\nUnbanning restores the ability to rejoin:");
const unbanByNonCommissioner = await api(bystander.cookie, `/api/leagues/${league.id}/unban`, {
  method: "POST",
  body: JSON.stringify({ userId: rival.user.id }),
});
check(
  "non-commissioner cannot unban",
  unbanByNonCommissioner.status === 403,
  `${unbanByNonCommissioner.status} ${unbanByNonCommissioner.body.error}`,
);

const unban = await api(owner.cookie, `/api/leagues/${league.id}/unban`, {
  method: "POST",
  body: JSON.stringify({ userId: rival.user.id }),
});
check("unban succeeds", unban.status === 200, JSON.stringify(unban.body));

const rejoinAfterUnban = await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: league.inviteCode }),
});
check("previously banned user can rejoin after being unbanned", rejoinAfterUnban.status === 200);

const afterUnbanDetail = await api(owner.cookie, `/api/leagues/${league.id}`);
check(
  "bannedUsers list is now empty",
  afterUnbanDetail.body.bannedUsers.length === 0,
  JSON.stringify(afterUnbanDetail.body.bannedUsers),
);

console.log("\nBanning is blocked once the draft has started:");
const draftLeague = await newLeague(owner.cookie);
const thirdRival = await signIn(`ban-rival2-${Date.now()}@example.com`, "Ban Rival 2");
await api(thirdRival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: draftLeague.inviteCode }),
});

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

const banAfterStart = await api(owner.cookie, `/api/leagues/${draftLeague.id}/ban`, {
  method: "POST",
  body: JSON.stringify({ userId: thirdRival.user.id }),
});
check(
  "banning is rejected once drafting has started",
  banAfterStart.status === 409,
  `${banAfterStart.status} ${banAfterStart.body.error}`,
);

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll ban-league checks passed.",
);
process.exit(failures.length ? 1 : 0);
