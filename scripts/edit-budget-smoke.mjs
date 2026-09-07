/**
 * Verifies commissioner-only, pre-draft-only budget editing: valid changes take effect
 * immediately in the draft room, invalid/off-limits attempts are rejected, and the
 * budget locks once the draft has started.
 *
 * Also covers the pick clock, editable in the same window and under the same rules.
 *
 * Usage: node scripts/edit-budget-smoke.mjs [baseUrl]
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

const owner = await signIn(`budget-owner-${Date.now()}@example.com`, "Budget Owner");
const rival = await signIn(`budget-rival-${Date.now()}@example.com`, "Budget Rival");

const { league } = await api(owner.cookie, "/api/leagues", {
  method: "POST",
  body: JSON.stringify({
    name: `Budget Edit Test ${Date.now()}`,
    leagueType: "season",
    rosterSize: 3,
    salaryCap: 150,
    pickSeconds: 300,
  }),
}).then((r) => r.body);
console.log(`League ${league.id}, starting cap $${league.salaryCap}\n`);

await api(rival.cookie, "/api/leagues/join", { method: "POST", body: JSON.stringify({ inviteCode: league.inviteCode }) });

console.log("Validation:");
const tooLow = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ salaryCap: 10 }) });
check("rejects below the $50 floor", tooLow.status === 400, `${tooLow.status} ${tooLow.body.error}`);

const tooHigh = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ salaryCap: 9999 }) });
check("rejects above the $500 ceiling", tooHigh.status === 400, `${tooHigh.status} ${tooHigh.body.error}`);

const notNumber = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ salaryCap: "banana" }) });
check("rejects a non-numeric value", notNumber.status === 400, `${notNumber.status} ${notNumber.body.error}`);

console.log("\nPermissions:");
const asRival = await api(rival.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ salaryCap: 200 }) });
check("non-commissioner cannot edit the budget", asRival.status === 403, `${asRival.status} ${asRival.body.error}`);

console.log("\nValid edit:");
const edited = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ salaryCap: 250 }) });
check("commissioner can raise the cap", edited.status === 200 && edited.body.league.salaryCap === 250, JSON.stringify(edited.body));

const refetched = await api(owner.cookie, `/api/leagues/${league.id}`);
check("new cap persists on refetch", refetched.body.league.salaryCap === 250, refetched.body.league.salaryCap);

console.log("\nDraft room reflects the new cap before the draft starts:");
const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${league.id}/draft/ws`, { headers: { Cookie: owner.cookie } });
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
const pendingState = await new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
check(
  "pending draft state uses the updated cap",
  pendingState.state?.salaryCap === 250 && Object.values(pendingState.state.budgets).every((b) => b === 250),
  JSON.stringify(pendingState.state?.budgets),
);

console.log("");
console.log("Pick clock validation:");
const clockTooLow = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ pickSeconds: 29 }) });
check("rejects below the 30s floor", clockTooLow.status === 400, `${clockTooLow.status} ${clockTooLow.body.error}`);

const clockTooHigh = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ pickSeconds: 301 }) });
check("rejects above the 300s ceiling", clockTooHigh.status === 400, `${clockTooHigh.status}`);

const clockFractional = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ pickSeconds: 45.5 }) });
check("rejects a fractional value", clockFractional.status === 400, `${clockFractional.status}`);

const clockAsRival = await api(rival.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ pickSeconds: 60 }) });
check("non-commissioner cannot edit the clock", clockAsRival.status === 403, `${clockAsRival.status}`);

const stillOriginal = await api(owner.cookie, `/api/leagues/${league.id}`);
check("none of that changed the stored value", stillOriginal.body.league.pickSeconds === 300, stillOriginal.body.league.pickSeconds);

console.log("");
console.log("Valid pick clock edit:");
const clockEdited = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ pickSeconds: 45 }) });
check("commissioner can shorten the clock", clockEdited.status === 200 && clockEdited.body.league.pickSeconds === 45, `${clockEdited.body.league?.pickSeconds}`);
check("and a clock-only edit leaves the cap alone", clockEdited.body.league.salaryCap === 250, `${clockEdited.body.league.salaryCap}`);

const bothAtOnce = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ salaryCap: 260, pickSeconds: 40 }) });
check("both settings can change in one request", bothAtOnce.body.league.salaryCap === 260 && bothAtOnce.body.league.pickSeconds === 40, JSON.stringify({ cap: bothAtOnce.body.league.salaryCap, clock: bothAtOnce.body.league.pickSeconds }));

const clockRefetched = await api(owner.cookie, `/api/leagues/${league.id}`);
check("the new clock persists on refetch", clockRefetched.body.league.pickSeconds === 40, clockRefetched.body.league.pickSeconds);

console.log("\nLocked once drafting starts:");
ws.send(JSON.stringify({ type: "start" }));
const started = await new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
const firstPickSeconds = Math.round((started.state.deadline - Date.now()) / 1000);
check(
  "the draft runs on the edited clock, not the one set at creation",
  Math.abs(firstPickSeconds - 40) <= 3,
  `${firstPickSeconds}s; created with 300s, edited to 40s`,
);
ws.close();

const afterStart = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ salaryCap: 300 }) });
check("cannot edit the cap after the draft has started", afterStart.status === 409, `${afterStart.status} ${afterStart.body.error}`);

const clockAfterStart = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ pickSeconds: 90 }) });
check("cannot edit the clock after the draft has started", clockAfterStart.status === 409, `${clockAfterStart.status}`);

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll edit-budget checks passed.");
process.exit(failures.length ? 1 : 0);
