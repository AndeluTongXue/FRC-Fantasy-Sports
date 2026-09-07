/**
 * Verifies the three hardening rules:
 *   1. `/api/admin/*` is admin-only — a plain signed-in account gets 403 on every route
 *      (previously any signed-in account could trigger TBA/Statbotics syncs).
 *   2. Failed sign-ins are rate limited per email, and a correct password still works
 *      for an untouched account.
 *   3. `refresh-scores` is on a per-league cooldown, so members can't spam TBA.
 *
 * The admin *allow* path isn't covered here: `is_admin` is set directly in D1 on purpose,
 * so there's no API to grant it. Per-IP throttling also isn't covered — that key only
 * exists behind Cloudflare, which sets CF-Connecting-IP (wrangler dev does not).
 *
 * Usage: node scripts/hardening-smoke.mjs [baseUrl]
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

async function attemptLogin(email, password) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const member = await signIn(`hardening-member-${stamp}@example.com`, "Hardening Member");

console.log("Admin routes reject a non-admin account:");
check("signup does not grant admin", member.user.isAdmin === false, `isAdmin=${member.user.isAdmin}`);

for (const path of ["/api/admin/sync/teams", "/api/admin/sync/events", "/api/admin/price-teams"]) {
  const attempt = await api(member.cookie, path, { method: "POST" });
  check(`${path} is 403 for a non-admin`, attempt.status === 403, `${attempt.status} ${attempt.body.error}`);
}
const eventSync = await api(member.cookie, "/api/admin/sync/event/2024test", { method: "POST" });
check(
  "/api/admin/sync/event/:eventKey is 403 for a non-admin",
  eventSync.status === 403,
  `${eventSync.status} ${eventSync.body.error}`,
);

const anonymous = await api("", "/api/admin/sync/teams", { method: "POST" });
check("admin routes still reject anonymous callers", anonymous.status === 401, `${anonymous.status}`);

console.log("\nFailed sign-ins are throttled per email:");
const victimEmail = `hardening-victim-${stamp}@example.com`;
await signIn(victimEmail, "Hardening Victim");

let lockedAfter = null;
for (let attempt = 1; attempt <= 12 && lockedAfter === null; attempt++) {
  const result = await attemptLogin(victimEmail, `wrong-password-${attempt}`);
  if (result.status === 429) lockedAfter = attempt;
  else if (result.status !== 401) {
    check(`guess ${attempt} returns 401 until locked`, false, `${result.status} ${result.body.error}`);
    break;
  }
}
check(
  "password guessing locks out within 12 attempts",
  lockedAfter !== null,
  lockedAfter === null ? "never returned 429" : `429 on attempt ${lockedAfter}`,
);

const correctWhileLocked = await attemptLogin(victimEmail, "testpass123");
check(
  "the correct password is refused while locked out",
  correctWhileLocked.status === 429,
  `${correctWhileLocked.status} ${correctWhileLocked.body.error}`,
);

const bystanderEmail = `hardening-bystander-${stamp}@example.com`;
await signIn(bystanderEmail, "Hardening Bystander");
const bystanderLogin = await attemptLogin(bystanderEmail, "testpass123");
check(
  "another account is unaffected by the lockout",
  bystanderLogin.status === 200,
  `${bystanderLogin.status} ${bystanderLogin.body.error ?? ""}`,
);

console.log("\nrefresh-scores is on a per-league cooldown:");
const league = await api(member.cookie, "/api/leagues", {
  method: "POST",
  body: JSON.stringify({
    name: `Hardening Test ${stamp}`,
    leagueType: "season",
    rosterSize: 3,
    salaryCap: 200,
  }),
}).then((r) => r.body.league);

const outsider = await signIn(`hardening-outsider-${stamp}@example.com`, "Hardening Outsider");
const outsiderRefresh = await api(outsider.cookie, `/api/leagues/${league.id}/refresh-scores`, { method: "POST" });
check(
  "a non-member cannot trigger a refresh",
  outsiderRefresh.status === 403,
  `${outsiderRefresh.status} ${outsiderRefresh.body.error}`,
);

const firstRefresh = await api(member.cookie, `/api/leagues/${league.id}/refresh-scores`, { method: "POST" });
check("the first refresh is allowed", firstRefresh.status === 200, `${firstRefresh.status} ${JSON.stringify(firstRefresh.body)}`);

const secondRefresh = await api(member.cookie, `/api/leagues/${league.id}/refresh-scores`, { method: "POST" });
check(
  "an immediate second refresh is rejected",
  secondRefresh.status === 429,
  `${secondRefresh.status} ${secondRefresh.body.error}`,
);
check(
  "the cooldown response says how long to wait",
  typeof secondRefresh.body.retryAfter === "number" && secondRefresh.body.retryAfter > 0,
  `retryAfter=${secondRefresh.body.retryAfter}`,
);

const otherLeague = await api(member.cookie, "/api/leagues", {
  method: "POST",
  body: JSON.stringify({
    name: `Hardening Test B ${stamp}`,
    leagueType: "season",
    rosterSize: 3,
    salaryCap: 200,
  }),
}).then((r) => r.body.league);
const otherRefresh = await api(member.cookie, `/api/leagues/${otherLeague.id}/refresh-scores`, { method: "POST" });
check(
  "the cooldown is per league, not global",
  otherRefresh.status === 200,
  `${otherRefresh.status} ${JSON.stringify(otherRefresh.body)}`,
);

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll hardening checks passed.",
);
process.exit(failures.length ? 1 : 0);
