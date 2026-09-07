/**
 * End-to-end check of the live draft: two owners connect over WebSocket, the
 * commissioner starts, and picks alternate in snake order with budgets enforced.
 *
 * Usage: node scripts/draft-smoke.mjs [baseUrl]
 */
import WebSocket from "ws";

import { confirmEmail } from "./lib/confirm-email.mjs";

const BASE = process.argv[2] ?? "http://localhost:5174";
const failures = [];

function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures.push(label);
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function signIn(email, password, displayName) {
  for (const path of ["/api/auth/signup", "/api/auth/login"]) {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName }),
    });
    if (response.ok) {
      const cookie = response.headers.get("set-cookie").split(";")[0];
      const { user } = await response.json();
      // League routes need a confirmed address, and a fresh signup starts unconfirmed.
      if (path === "/api/auth/signup") await confirmEmail(BASE, email);
      return { cookie, user };
    }
  }
  throw new Error(`Could not sign in ${email}`);
}

async function api(cookie, path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${body.error ?? response.status}`);
  return body;
}

/** Wraps a draft socket so tests can await the next state or error push. */
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
    socket,
    ready: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    next: () =>
      new Promise((resolve, reject) => {
        if (inbox.length) return resolve(inbox.shift());
        const timer = setTimeout(() => reject(new Error("timed out waiting for draft message")), 8000);
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      }),
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
}

const commissioner = await signIn("smoke-a@example.com", "testpass123", "Smoke A");
const rival = await signIn("smoke-b@example.com", "testpass123", "Smoke B");

const { league } = await api(commissioner.cookie, "/api/leagues", {
  method: "POST",
  body: JSON.stringify({
    name: `Smoke Draft ${Date.now()}`,
    leagueType: "single_event",
    eventKey: "2026casnv",
    rosterSize: 2,
    salaryCap: 150,
    pickSeconds: 300,
  }),
});
await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: league.inviteCode }),
});
console.log(`League ${league.id} (${league.inviteCode})\n`);

const alpha = connect(league.id, commissioner.cookie);
const beta = connect(league.id, rival.cookie);
await Promise.all([alpha.ready, beta.ready]);

console.log("Connection:");
const initial = await alpha.next();
await beta.next();
check("both owners receive initial state", initial.type === "state" && initial.state.status === "pending");

console.log("\nPermissions:");
beta.send({ type: "start" });
const denied = await beta.next();
check("non-commissioner cannot start", denied.type === "error", denied.message);

console.log("\nStart:");
alpha.send({ type: "start" });
const started = await alpha.next();
await beta.next();
check("draft goes active", started.state.status === "active");
check("clock is running", started.state.deadline > Date.now());
check("full budget for both", Object.values(started.state.budgets).every((b) => b === 150));

const order = started.state.order;
const sockets = {
  [commissioner.user.id]: { io: alpha, name: "commissioner" },
  [rival.user.id]: { io: beta, name: "rival" },
};

console.log("\nTurn enforcement:");
const offTurn = sockets[order[1]].io;
const { teams } = await api(commissioner.cookie, `/api/leagues/${league.id}/pool?limit=10`);
offTurn.send({ type: "pick", teamKey: teams[0].teamKey });
const wrongTurn = await offTurn.next();
check("off-turn pick rejected", wrongTurn.type === "error", wrongTurn.message);

console.log("\nBudget guard:");
const onClock = sockets[order[0]].io;
const priciest = teams[0];
onClock.send({ type: "pick", teamKey: priciest.teamKey });
const firstPick = await onClock.next();
await sockets[order[1]].io.next();
check("pick accepted", firstPick.state.picks.length === 1, `${priciest.teamNumber} for $${priciest.price}`);
check(
  "budget debited",
  firstPick.state.budgets[order[0]] === 150 - priciest.price,
  `$${firstPick.state.budgets[order[0]]} left`,
);
check("turn passed to next owner", firstPick.state.currentUserId === order[1]);

console.log("\nDuplicate guard:");
sockets[order[1]].io.send({ type: "pick", teamKey: priciest.teamKey });
const duplicate = await sockets[order[1]].io.next();
check("already-drafted team rejected", duplicate.type === "error", duplicate.message);

console.log("\nSnake order:");
const remaining = (await api(rival.cookie, `/api/leagues/${league.id}/pool?limit=10`)).teams;
sockets[order[1]].io.send({ type: "pick", teamKey: remaining[0].teamKey });
const second = await sockets[order[1]].io.next();
await sockets[order[0]].io.next();
check("round 2 reverses (same owner picks twice)", second.state.currentUserId === order[1]);

const stillOpen = (await api(rival.cookie, `/api/leagues/${league.id}/pool?limit=10`)).teams;
sockets[order[1]].io.send({ type: "pick", teamKey: stillOpen[0].teamKey });
const third = await sockets[order[1]].io.next();
await sockets[order[0]].io.next();
check("turn returns to first owner", third.state.currentUserId === order[0]);

console.log("\nCompletion:");
let latest = third.state;
while (latest.status === "active") {
  const onTurn = sockets[latest.currentUserId];
  const budget = latest.budgets[latest.currentUserId];
  const available = (await api(commissioner.cookie, `/api/leagues/${league.id}/pool?limit=60`)).teams;
  const affordable = [...available].reverse().find((team) => team.price <= budget);
  onTurn.io.send({ type: "pick", teamKey: affordable.teamKey });

  const [a, b] = await Promise.all([alpha.next(), beta.next()]);
  latest = (a.type === "state" ? a : b).state;
}

check("draft completes after every slot filled", latest.status === "complete");
check("no clock when complete", latest.deadline === null);
check("nobody overspent", Object.values(latest.budgets).every((remaining) => remaining >= 0));

const detail = await api(commissioner.cookie, `/api/leagues/${league.id}`);
check(
  "picks persisted to D1",
  detail.picks.length === latest.totalPicks,
  `${detail.picks.length}/${latest.totalPicks} rows`,
);
check("every owner filled their roster", order.every(
  (id) => detail.picks.filter((pick) => pick.userId === id).length === latest.rosterSize,
));
check("league marked active", detail.league.status === "active");

alpha.close();
beta.close();

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll draft checks passed.");
process.exit(failures.length ? 1 : 0);
