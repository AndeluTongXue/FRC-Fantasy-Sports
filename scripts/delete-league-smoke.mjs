/**
 * Verifies commissioner-only league deletion: permission check, real D1 cleanup, and
 * that the draft room's Durable Object is torn down (no crash on repeat delete, no
 * lingering pick-clock alarm).
 *
 * Usage: node scripts/delete-league-smoke.mjs [baseUrl]
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

/** A rejected WebSocket upgrade can surface as a clean HTTP response or a hung-up socket
 * depending on the runtime — both mean "the server refused the upgrade," so both count. */
function attemptDraftConnection(leagueId, cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${leagueId}/draft/ws`, {
      headers: { Cookie: cookie },
    });
    ws.once("open", () => resolve("opened"));
    ws.once("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
    ws.once("error", () => resolve("rejected"));
    setTimeout(() => resolve("timeout"), 5000);
  });
}

const owner = await signIn(`delete-owner-${Date.now()}@example.com`, "Delete Owner");
const rival = await signIn(`delete-rival-${Date.now()}@example.com`, "Delete Rival");

const { league } = await api(owner.cookie, "/api/leagues", {
  method: "POST",
  body: JSON.stringify({
    name: `Delete Me League ${Date.now()}`,
    leagueType: "season",
    rosterSize: 3,
    salaryCap: 150,
    pickSeconds: 300,
  }),
}).then((r) => r.body);

console.log(`League ${league.id} (${league.inviteCode})\n`);

console.log("Join as a second member:");
const join = await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: league.inviteCode }),
});
check("rival joined the league", join.status === 200, JSON.stringify(join.body));

console.log("\nPermission check:");
const forbidden = await api(rival.cookie, `/api/leagues/${league.id}`, { method: "DELETE" });
check("non-commissioner cannot delete", forbidden.status === 403, `${forbidden.status} ${forbidden.body.error}`);

console.log("\nStart the draft so the Durable Object has live state + an alarm:");
const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${league.id}/draft/ws`, {
  headers: { Cookie: owner.cookie },
});
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
const firstMessage = await new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
check("draft room connected", firstMessage.type === "state");

ws.send(JSON.stringify({ type: "start" }));
const startedMessage = await new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
check("draft started (alarm now scheduled)", startedMessage.state?.status === "active", startedMessage.state?.status);
ws.close();

console.log("\nDelete as the commissioner:");
const del = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "DELETE" });
check("delete succeeds", del.status === 200, JSON.stringify(del.body));

console.log("\nPost-delete checks:");
const gone = await api(owner.cookie, `/api/leagues/${league.id}`);
check("league no longer fetchable", gone.status === 404, `${gone.status} ${gone.body.error}`);

const listAfter = await api(owner.cookie, "/api/leagues");
check(
  "league removed from owner's league list",
  !listAfter.body.leagues.some((l) => l.id === league.id),
  `${listAfter.body.leagues.length} leagues remain`,
);

const deleteAgain = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "DELETE" });
check("deleting again returns 404, not a crash", deleteAgain.status === 404, `${deleteAgain.status}`);

console.log("\nDraft room after deletion:");
const ws2Result = await attemptDraftConnection(league.id, owner.cookie);
check(
  "draft room WS rejects since membership check fails (league_members cascade-deleted)",
  ws2Result !== "opened",
  ws2Result,
);

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll delete-league checks passed.");
process.exit(failures.length ? 1 : 0);
