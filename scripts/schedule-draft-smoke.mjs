/**
 * Verifies commissioner-only, pre-draft-only draft scheduling: a schedule can be set at
 * creation or after, rescheduled, and cancelled (scheduledDraftAt: null), invalid/off-limits
 * attempts are rejected, and the schedule locks once the draft has started.
 *
 * Usage: node scripts/schedule-draft-smoke.mjs [baseUrl]
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

const owner = await signIn(`schedule-owner-${Date.now()}@example.com`, "Schedule Owner");
const rival = await signIn(`schedule-rival-${Date.now()}@example.com`, "Schedule Rival");

const inOneDay = Date.now() + 24 * 60 * 60 * 1000;

const { league } = await api(owner.cookie, "/api/leagues", {
  method: "POST",
  body: JSON.stringify({
    name: `Schedule Draft Test ${Date.now()}`,
    leagueType: "season",
    rosterSize: 3,
    salaryCap: 150,
    pickSeconds: 300,
    scheduledDraftAt: inOneDay,
  }),
}).then((r) => r.body);
console.log(`League ${league.id}, scheduled for ${league.scheduledDraftAt}\n`);

check("schedule set at creation", league.scheduledDraftAt === inOneDay, league.scheduledDraftAt);

await api(rival.cookie, "/api/leagues/join", { method: "POST", body: JSON.stringify({ inviteCode: league.inviteCode }) });

console.log("Validation:");
const pastDate = await api(owner.cookie, `/api/leagues/${league.id}`, {
  method: "PATCH",
  body: JSON.stringify({ scheduledDraftAt: Date.now() - 1000 }),
});
check("rejects a time in the past", pastDate.status === 400, `${pastDate.status} ${pastDate.body.error}`);

const notNumber = await api(owner.cookie, `/api/leagues/${league.id}`, {
  method: "PATCH",
  body: JSON.stringify({ scheduledDraftAt: "banana" }),
});
check("rejects a non-numeric value", notNumber.status === 400, `${notNumber.status} ${notNumber.body.error}`);

console.log("\nPermissions:");
const asRival = await api(rival.cookie, `/api/leagues/${league.id}`, {
  method: "PATCH",
  body: JSON.stringify({ scheduledDraftAt: inOneDay + 1000 }),
});
check("non-commissioner cannot schedule the draft", asRival.status === 403, `${asRival.status} ${asRival.body.error}`);

console.log("\nReschedule:");
const inTwoDays = Date.now() + 2 * 24 * 60 * 60 * 1000;
const rescheduled = await api(owner.cookie, `/api/leagues/${league.id}`, {
  method: "PATCH",
  body: JSON.stringify({ scheduledDraftAt: inTwoDays }),
});
check(
  "commissioner can reschedule",
  rescheduled.status === 200 && rescheduled.body.league.scheduledDraftAt === inTwoDays,
  JSON.stringify(rescheduled.body),
);

console.log("\nCancel:");
const cancelled = await api(owner.cookie, `/api/leagues/${league.id}`, {
  method: "PATCH",
  body: JSON.stringify({ scheduledDraftAt: null }),
});
check(
  "commissioner can cancel the schedule",
  cancelled.status === 200 && cancelled.body.league.scheduledDraftAt === null,
  JSON.stringify(cancelled.body),
);

const refetched = await api(owner.cookie, `/api/leagues/${league.id}`);
check("cancelled schedule persists on refetch", refetched.body.league.scheduledDraftAt === null, refetched.body.league.scheduledDraftAt);

console.log("\nLocked once drafting starts:");
const rescheduleForLockTest = await api(owner.cookie, `/api/leagues/${league.id}`, {
  method: "PATCH",
  body: JSON.stringify({ scheduledDraftAt: inOneDay }),
});
check("can schedule again before the draft starts", rescheduleForLockTest.status === 200, JSON.stringify(rescheduleForLockTest.body));

const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${league.id}/draft/ws`, { headers: { Cookie: owner.cookie } });
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
await new Promise((resolve) => ws.once("message", resolve));
ws.send(JSON.stringify({ type: "start" }));
await new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
ws.close();

const afterStart = await api(owner.cookie, `/api/leagues/${league.id}`, {
  method: "PATCH",
  body: JSON.stringify({ scheduledDraftAt: inTwoDays }),
});
check("cannot reschedule after the draft has started", afterStart.status === 409, `${afterStart.status} ${afterStart.body.error}`);

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll schedule-draft checks passed.");
process.exit(failures.length ? 1 : 0);
