import WebSocket from "ws";

const BASE = "http://localhost:5173";
const LEAGUE_ID = "9bd1c86e-2cf0-4c22-8ad5-30420a5620bf";
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

const owner = await signIn("andre@example.com", "Andre");
const rival = await signIn("rival-delete-test@example.com", "Rival");

console.log("Join as a second member:");
const join = await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: "LEPAVG" }),
});
check("rival joined the league", join.status === 200, JSON.stringify(join.body));

console.log("\nPermission check:");
const forbidden = await api(rival.cookie, `/api/leagues/${LEAGUE_ID}`, { method: "DELETE" });
check("non-commissioner cannot delete", forbidden.status === 403, `${forbidden.status} ${forbidden.body.error}`);

console.log("\nStart the draft so the Durable Object has live state + an alarm:");
const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${LEAGUE_ID}/draft/ws`, {
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
const del = await api(owner.cookie, `/api/leagues/${LEAGUE_ID}`, { method: "DELETE" });
check("delete succeeds", del.status === 200, JSON.stringify(del.body));

console.log("\nPost-delete checks:");
const gone = await api(owner.cookie, `/api/leagues/${LEAGUE_ID}`);
check("league no longer fetchable", gone.status === 404, `${gone.status} ${gone.body.error}`);

const listAfter = await api(owner.cookie, "/api/leagues");
check(
  "league removed from owner's league list",
  !listAfter.body.leagues.some((l) => l.id === LEAGUE_ID),
  `${listAfter.body.leagues.length} leagues remain`,
);

const deleteAgain = await api(owner.cookie, `/api/leagues/${LEAGUE_ID}`, { method: "DELETE" });
check("deleting again returns 404, not a crash", deleteAgain.status === 404, `${deleteAgain.status}`);

console.log("\nDraft room after deletion:");
const ws2 = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${LEAGUE_ID}/draft/ws`, {
  headers: { Cookie: owner.cookie },
});
const ws2Result = await new Promise((resolve) => {
  ws2.once("open", () => resolve("opened"));
  ws2.once("unexpected-response", (req, res) => resolve(`http ${res.statusCode}`));
  ws2.once("error", (e) => resolve(`error: ${e.message}`));
  setTimeout(() => resolve("timeout"), 5000);
});
check(
  "draft room WS rejects since membership check fails (league_members cascade-deleted)",
  ws2Result === "http 403",
  ws2Result,
);
try { ws2.close(); } catch {}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll delete-league checks passed.");
process.exit(failures.length ? 1 : 0);
