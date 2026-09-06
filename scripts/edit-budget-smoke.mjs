/**
 * Verifies commissioner-only, pre-draft-only budget editing: valid changes take effect
 * immediately in the draft room, invalid/off-limits attempts are rejected, and the
 * budget locks once the draft has started.
 *
 * Usage: node scripts/edit-budget-smoke.mjs [baseUrl]
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

console.log("\nLocked once drafting starts:");
ws.send(JSON.stringify({ type: "start" }));
await new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
ws.close();

const afterStart = await api(owner.cookie, `/api/leagues/${league.id}`, { method: "PATCH", body: JSON.stringify({ salaryCap: 300 }) });
check("cannot edit after the draft has started", afterStart.status === 409, `${afterStart.status} ${afterStart.body.error}`);

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll edit-budget checks passed.");
process.exit(failures.length ? 1 : 0);
