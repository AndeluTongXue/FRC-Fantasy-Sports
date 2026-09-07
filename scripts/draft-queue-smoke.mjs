/**
 * Verifies the draft queue: that it's private, that it's validated on save, and — the point
 * of the whole feature — that an expired pick clock drafts the manager's own top queued
 * team rather than the "best affordable team" fallback.
 *
 * `pick_seconds` is clamped to a 30s minimum server-side, so this script really does sit
 * through one clock expiry. Expect it to take about 45 seconds.
 *
 * Usage: node scripts/draft-queue-smoke.mjs [baseUrl]
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
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function connect(leagueId, cookie) {
  const socket = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${leagueId}/draft/ws`, {
    headers: { Cookie: cookie },
  });
  let latest = null;
  let lastError = null;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "state") latest = message.state;
    else lastError = message.message;
  });
  return {
    socket,
    ready: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    state: () => latest,
    lastError: () => lastError,
    send: (message) => socket.send(JSON.stringify(message)),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the pushed state rather than sleeping a fixed amount past the deadline. */
async function until(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const alice = await signIn(`queue-alice-${stamp}@example.com`, "Queue Alice");
const bob = await signIn(`queue-bob-${stamp}@example.com`, "Queue Bob");

const created = await api(alice.cookie, "/api/leagues", {
  method: "POST",
  body: JSON.stringify({
    name: `Queue Test ${stamp}`,
    leagueType: "season",
    rosterSize: 2,
    salaryCap: 200,
    pickSeconds: 30, // the server's minimum
  }),
});
const league = created.body.league;
await api(bob.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: league.inviteCode }),
});

// The pool is ordered by EPA descending, so the last entries have no EPA at all — exactly
// the teams the `bestAvailable` fallback would take last. Queueing one of those makes the
// difference between "the queue was used" and "the fallback happened to agree" unambiguous.
const pool = (await api(alice.cookie, `/api/leagues/${league.id}/pool?limit=200`)).body.teams;
const fallbackFavourite = pool[0];
const aliceTarget = pool[pool.length - 1];
const bobTarget = pool[pool.length - 2];
const shared = pool[pool.length - 3];

console.log(`Pool has ${pool.length} teams; fallback would take ${fallbackFavourite.teamNumber}.`);

console.log("\nQueues save, validate, and stay private:");
const aliceSave = await api(alice.cookie, `/api/leagues/${league.id}/queue`, {
  method: "PUT",
  body: JSON.stringify({ teamKeys: [aliceTarget.teamKey, shared.teamKey] }),
});
check("a queue saves", aliceSave.status === 200, `${aliceSave.status}`);
check(
  "and comes back in the order given",
  aliceSave.body.teams.map((t) => t.teamKey).join() === [aliceTarget.teamKey, shared.teamKey].join(),
  aliceSave.body.teams.map((t) => t.teamNumber).join(),
);

const bobSave = await api(bob.cookie, `/api/leagues/${league.id}/queue`, {
  method: "PUT",
  body: JSON.stringify({ teamKeys: [bobTarget.teamKey, shared.teamKey] }),
});
check("a second manager's queue saves independently", bobSave.status === 200, `${bobSave.status}`);

const aliceRead = await api(alice.cookie, `/api/leagues/${league.id}/queue`);
const bobRead = await api(bob.cookie, `/api/leagues/${league.id}/queue`);
check(
  "each manager reads back only their own",
  aliceRead.body.teams[0].teamKey === aliceTarget.teamKey && bobRead.body.teams[0].teamKey === bobTarget.teamKey,
  `alice=${aliceRead.body.teams[0].teamNumber} bob=${bobRead.body.teams[0].teamNumber}`,
);

const junk = await api(alice.cookie, `/api/leagues/${league.id}/queue`, {
  method: "PUT",
  body: JSON.stringify({ teamKeys: ["frc999999", aliceTarget.teamKey, aliceTarget.teamKey, shared.teamKey] }),
});
check(
  "unknown teams are dropped and duplicates collapsed",
  junk.body.teams.map((t) => t.teamKey).join() === [aliceTarget.teamKey, shared.teamKey].join(),
  junk.body.teams.map((t) => t.teamNumber).join(),
);

const outsider = await signIn(`queue-outsider-${stamp}@example.com`, "Queue Outsider");
const forbidden = await api(outsider.cookie, `/api/leagues/${league.id}/queue`);
check("a non-member can't read a league's queues", forbidden.status === 403, `${forbidden.status}`);

console.log("\nAn expired clock drafts from the queue, not the fallback:");
const aliceSocket = connect(league.id, alice.cookie);
const bobSocket = connect(league.id, bob.cookie);
await Promise.all([aliceSocket.ready, bobSocket.ready]);
await wait(300);

aliceSocket.send({ type: "start" });
await until(() => aliceSocket.state()?.status === "active", 8000, "the draft to start");

const onClock = aliceSocket.state().currentUserId;
const whose = onClock === alice.user.id ? "alice" : "bob";
const expected = onClock === alice.user.id ? aliceTarget : bobTarget;
console.log(`  ${whose} is on the clock; letting the 30s clock expire…`);

await until(() => (aliceSocket.state()?.picks.length ?? 0) >= 1, 45000, "the clock to expire");
const autoPick = aliceSocket.state().picks[0];

check("the autopick went to the manager on the clock", autoPick.userId === onClock);
check(
  "it took their queued team",
  autoPick.teamKey === expected.teamKey,
  `took ${autoPick.teamKey.replace("frc", "")}, queued ${expected.teamNumber}`,
);
check(
  "not the highest-EPA team the fallback would have taken",
  autoPick.teamKey !== fallbackFavourite.teamKey,
  `fallback favourite was ${fallbackFavourite.teamNumber}`,
);

const afterCookie = onClock === alice.user.id ? alice.cookie : bob.cookie;
const afterPick = await api(afterCookie, `/api/leagues/${league.id}/queue`);
check(
  "the drafted team left their own queue",
  !afterPick.body.teams.some((t) => t.teamKey === expected.teamKey),
  afterPick.body.teams.map((t) => t.teamNumber).join() || "(empty)",
);

console.log("\nFinishing the draft by hand, then queues go read-only:");
// Both managers had `shared` queued second; whoever takes it should clear it from the other.
const otherCookie = onClock === alice.user.id ? bob.cookie : alice.cookie;
const beforeShared = await api(otherCookie, `/api/leagues/${league.id}/queue`);
const otherHadShared = beforeShared.body.teams.some((t) => t.teamKey === shared.teamKey);

let guard = 0;
while ((aliceSocket.state()?.status ?? "") === "active" && guard++ < 12) {
  const state = aliceSocket.state();
  const current = state.currentUserId;
  const socket = current === alice.user.id ? aliceSocket : bobSocket;
  const cookie = current === alice.user.id ? alice.cookie : bob.cookie;
  // The pool endpoint returns the highest-EPA teams first, so its tail is not reliably the
  // cheap end once picks have been made — sort by price rather than trusting the order.
  const options = (await api(cookie, `/api/leagues/${league.id}/pool?limit=200`)).body.teams;
  const cheapest = [...options].sort((a, b) => a.price - b.price)[0];
  const target = guard === 1 && otherHadShared && current !== onClock ? shared : cheapest;
  if (!target) throw new Error("no affordable team left to pick");
  const before = state.picks.length;
  socket.send({ type: "pick", teamKey: target.teamKey });
  await until(
    () => (aliceSocket.state()?.picks.length ?? 0) > before,
    8000,
    `pick ${before + 1} to register${socket.lastError() ? ` (server said: ${socket.lastError()})` : ""}`,
  );
}

check("the draft completed", aliceSocket.state()?.status === "complete", aliceSocket.state()?.status);

if (otherHadShared) {
  const otherAfter = await api(otherCookie, `/api/leagues/${league.id}/queue`);
  check(
    "a team drafted by someone else left the other manager's queue",
    !otherAfter.body.teams.some((t) => t.teamKey === shared.teamKey),
    otherAfter.body.teams.map((t) => t.teamNumber).join() || "(empty)",
  );
}

const afterDraft = await api(alice.cookie, `/api/leagues/${league.id}/queue`, {
  method: "PUT",
  body: JSON.stringify({ teamKeys: [fallbackFavourite.teamKey] }),
});
check("saving a queue after the draft is refused", afterDraft.status === 409, `${afterDraft.status}`);

aliceSocket.socket.close();
bobSocket.socket.close();

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll draft-queue checks passed.");
process.exit(failures.length ? 1 : 0);
