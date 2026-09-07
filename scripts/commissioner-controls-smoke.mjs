/**
 * Verifies the commissioner's in-draft controls — pause/resume, clock extension, running the
 * on-clock manager's autopick early, and undoing a pick — and that a plain manager can invoke
 * none of them.
 *
 * The authorization half matters most: each of these is a way to take an extra turn if the
 * wrong person can reach it.
 *
 * Usage: node scripts/commissioner-controls-smoke.mjs [baseUrl]
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
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function connect(leagueId, cookie) {
  const socket = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${leagueId}/draft/ws`, {
    headers: { Cookie: cookie },
  });
  let latest = null;
  const errors = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "state") latest = message.state;
    else errors.push(message.message);
  });
  return {
    socket,
    ready: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    state: () => latest,
    errors,
    takeError: () => errors.pop() ?? null,
    send: (message) => socket.send(JSON.stringify(message)),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(400);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const boss = await signIn(`ctrl-boss-${stamp}@example.com`, "Commissioner");
const member = await signIn(`ctrl-member-${stamp}@example.com`, "Plain Member");

const league = (
  await api(boss.cookie, "/api/leagues", {
    method: "POST",
    body: JSON.stringify({
      name: `Controls Test ${stamp}`,
      leagueType: "season",
      rosterSize: 2,
      salaryCap: 200,
      pickSeconds: 300, // long, so nothing auto-drafts underneath these checks
    }),
  })
).body.league;
await api(member.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: league.inviteCode }),
});

const bossSocket = connect(league.id, boss.cookie);
const memberSocket = connect(league.id, member.cookie);
await Promise.all([bossSocket.ready, memberSocket.ready]);
await wait(300);

bossSocket.send({ type: "start" });
await until(() => bossSocket.state()?.status === "active", 8000, "the draft to start");

const cheapest = async (cookie) => {
  const pool = (await api(cookie, `/api/leagues/${league.id}/pool?limit=200`)).body.teams;
  return [...pool].sort((a, b) => a.price - b.price)[0];
};

console.log("A plain manager can't reach any of the controls:");
for (const message of [{ type: "pause" }, { type: "resume" }, { type: "extend" }, { type: "undo" }]) {
  memberSocket.errors.length = 0;
  memberSocket.send(message);
  await wait(500);
  check(`"${message.type}" is refused`, memberSocket.takeError() === "Only the commissioner can do that");
}
memberSocket.errors.length = 0;
memberSocket.send({ type: "autopick" });
await wait(600);
check(`"autopick" is refused`, memberSocket.takeError() === "Only the commissioner can do that");
check("and none of that started a pick", bossSocket.state().picks.length === 0, `${bossSocket.state().picks.length}`);

console.log("\nPausing stops the clock and blocks picking:");
const beforePause = bossSocket.state().deadline;
bossSocket.send({ type: "pause" });
await until(() => bossSocket.state()?.pausedRemainingMs !== null, 6000, "the pause to land");
check("the deadline is cleared", bossSocket.state().deadline === null);
check(
  "the time left is banked",
  bossSocket.state().pausedRemainingMs > 0 && bossSocket.state().pausedRemainingMs <= beforePause - Date.now() + 2000,
  `${Math.round(bossSocket.state().pausedRemainingMs / 1000)}s banked`,
);
check("every client sees the pause", memberSocket.state()?.pausedRemainingMs !== null);

const onClock = bossSocket.state().currentUserId;
const clockSocket = onClock === boss.user.id ? bossSocket : memberSocket;
const clockCookie = onClock === boss.user.id ? boss.cookie : member.cookie;
clockSocket.errors.length = 0;
clockSocket.send({ type: "pick", teamKey: (await cheapest(clockCookie)).teamKey });
await wait(600);
check(
  "the manager on the clock can't pick while paused",
  clockSocket.takeError() === "The commissioner has paused the draft",
);
check("still no picks", bossSocket.state().picks.length === 0, `${bossSocket.state().picks.length}`);

bossSocket.errors.length = 0;
bossSocket.send({ type: "autopick" });
await wait(600);
check("autodraft is refused while paused too", bossSocket.takeError() === "Resume the draft first");

console.log("\nExtending while paused adds to the banked time:");
const banked = bossSocket.state().pausedRemainingMs;
bossSocket.send({ type: "extend" });
await until(() => bossSocket.state().pausedRemainingMs > banked, 6000, "the extension");
check(
  "a paused clock gains 60s",
  Math.round((bossSocket.state().pausedRemainingMs - banked) / 1000) === 60,
  `+${Math.round((bossSocket.state().pausedRemainingMs - banked) / 1000)}s`,
);

console.log("\nResuming hands back the banked time rather than restarting the pick:");
const toRestore = bossSocket.state().pausedRemainingMs;
bossSocket.send({ type: "resume" });
await until(() => bossSocket.state()?.pausedRemainingMs === null, 6000, "the resume");
const restored = bossSocket.state().deadline - Date.now();
check(
  "the clock resumes where it stopped",
  Math.abs(restored - toRestore) < 3000,
  `${Math.round(restored / 1000)}s vs ${Math.round(toRestore / 1000)}s banked`,
);
// The banked time has had a 60s extension added to it above, so it is comfortably clear of
// the 300s a restarted pick would show — which is what makes this distinguishable at all.
check(
  "and is not a restarted pick",
  Math.abs(restored - 300_000) > 3000,
  `${Math.round(restored / 1000)}s, a restart would read 300s`,
);

console.log("\nExtending a running clock pushes the deadline out:");
const runningDeadline = bossSocket.state().deadline;
bossSocket.send({ type: "extend" });
await until(() => bossSocket.state().deadline > runningDeadline, 6000, "the extension");
check(
  "a running clock gains 60s",
  Math.round((bossSocket.state().deadline - runningDeadline) / 1000) === 60,
  `+${Math.round((bossSocket.state().deadline - runningDeadline) / 1000)}s`,
);

console.log("\nAutodraft takes from the on-clock manager's queue, not the commissioner's choice:");
const current = bossSocket.state().currentUserId;
const currentCookie = current === boss.user.id ? boss.cookie : member.cookie;

// A no-EPA team is exactly what the `bestAvailable` fallback would take last, so if autopick
// lands on it we know the queue drove the decision rather than the fallback agreeing by luck.
const wholePool = (await api(currentCookie, `/api/leagues/${league.id}/pool?limit=200`)).body.teams;
const fallbackFavourite = wholePool[0];
const target = wholePool[wholePool.length - 1];
await api(currentCookie, `/api/leagues/${league.id}/queue`, {
  method: "PUT",
  body: JSON.stringify({ teamKeys: [target.teamKey] }),
});

const budgetBefore = bossSocket.state().budgets[current];
bossSocket.send({ type: "autopick" });
await until(() => bossSocket.state().picks.length === 1, 8000, "the autopick");
const forced = bossSocket.state().picks[0];
check("the pick lands on the manager on the clock", forced.userId === current, `owner ${forced.userId === current}`);
check(
  "it takes their queued team",
  forced.teamKey === target.teamKey,
  `took ${forced.teamKey.replace("frc", "")}, queued ${target.teamNumber}`,
);
check(
  "not the team the commissioner would have picked",
  forced.teamKey !== fallbackFavourite.teamKey,
  `fallback favourite was ${fallbackFavourite.teamNumber}`,
);
check(
  "and is charged to their budget, not the commissioner's",
  bossSocket.state().budgets[current] === budgetBefore - target.price,
  `${budgetBefore} then ${bossSocket.state().budgets[current]}`,
);

console.log("\nUndo reverses it, refunds it, and rewinds the turn:");
bossSocket.send({ type: "undo" });
await until(() => bossSocket.state().picks.length === 0, 8000, "the undo");
check("the pick is gone", bossSocket.state().picks.length === 0);
check(
  "the budget is refunded",
  bossSocket.state().budgets[current] === budgetBefore,
  `${bossSocket.state().budgets[current]} vs ${budgetBefore}`,
);
check("the same manager is back on the clock", bossSocket.state().currentUserId === current);
check("the clock is running again", bossSocket.state().deadline > Date.now());

const afterUndo = (await api(boss.cookie, `/api/leagues/${league.id}`)).body.picks ?? [];
check("D1 no longer has the pick", !afterUndo.some((p) => p.teamKey === target.teamKey), `${afterUndo.length} rows`);

const backInPool = (await api(boss.cookie, `/api/leagues/${league.id}/pool?limit=200`)).body.teams;
check("the team is draftable again", backInPool.some((t) => t.teamKey === target.teamKey));

console.log("\nUndo on an empty draft is refused:");
bossSocket.errors.length = 0;
bossSocket.send({ type: "undo" });
await wait(600);
check("nothing to undo is an error, not a crash", bossSocket.takeError() === "There's nothing to undo");

console.log("\nUndo reopens a finished draft:");
let guard = 0;
while (bossSocket.state().status === "active" && guard++ < 10) {
  const who = bossSocket.state().currentUserId;
  const socket = who === boss.user.id ? bossSocket : memberSocket;
  const cookie = who === boss.user.id ? boss.cookie : member.cookie;
  const before = bossSocket.state().picks.length;
  socket.send({ type: "pick", teamKey: (await cheapest(cookie)).teamKey });
  await until(() => bossSocket.state().picks.length > before, 8000, `pick ${before + 1}`);
}
check("the draft completed", bossSocket.state().status === "complete", bossSocket.state().status);
const leagueDone = (await api(boss.cookie, `/api/leagues/${league.id}`)).body.league;
check("the league went active", leagueDone.status === "active", leagueDone.status);

bossSocket.send({ type: "undo" });
await until(() => bossSocket.state().status === "active", 8000, "the draft to reopen");
check("the draft is running again", bossSocket.state().status === "active");
const leagueReopened = (await api(boss.cookie, `/api/leagues/${league.id}`)).body.league;
check("and the league is back to drafting", leagueReopened.status === "drafting", leagueReopened.status);

bossSocket.socket.close();
memberSocket.socket.close();

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll commissioner-control checks passed.");
process.exit(failures.length ? 1 : 0);
