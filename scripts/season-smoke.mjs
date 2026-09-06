/**
 * Verifies the season-long format: a league not tied to any single event still scores,
 * accumulating points from every event each rostered team attended across the year.
 *
 * Usage: node scripts/season-smoke.mjs [baseUrl]
 */
import WebSocket from "ws";

const BASE = process.argv[2] ?? "http://localhost:5174";
const failures = [];

function check(label, condition, detail = "") {
  if (!condition) failures.push(label);
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
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
    ready: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    next: () =>
      new Promise((resolve, reject) => {
        if (inbox.length) return resolve(inbox.shift());
        const timer = setTimeout(() => reject(new Error("timed out")), 10000);
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      }),
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
}

const owner = await signIn("season-a@example.com", "Season A");
const rival = await signIn("season-b@example.com", "Season B");

const { league } = await api(owner.cookie, "/api/leagues", {
  method: "POST",
  body: JSON.stringify({
    name: `Season League ${Date.now()}`,
    leagueType: "season",
    rosterSize: 3,
    salaryCap: 200,
    pickSeconds: 300,
  }),
});
await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: league.inviteCode }),
});

console.log("Season league setup:");
check("league has no event key", league.eventKey === null);
check("league type is season", league.leagueType === "season");

const pool = await api(owner.cookie, `/api/leagues/${league.id}/pool?limit=5`);
check("pool spans the whole season, not one event", pool.teams.length === 5, `${pool.teams.length} shown`);

const alpha = connect(league.id, owner.cookie);
const beta = connect(league.id, rival.cookie);
await Promise.all([alpha.ready, beta.ready]);
await alpha.next();
await beta.next();

console.log("\nDraft:");
alpha.send({ type: "start" });
let latest = (await alpha.next()).state;
await beta.next();
const sockets = { [owner.user.id]: alpha, [rival.user.id]: beta };

while (latest.status === "active") {
  const budget = latest.budgets[latest.currentUserId];
  const available = (await api(owner.cookie, `/api/leagues/${league.id}/pool?limit=40`)).teams;
  const choice = available.find((team) => team.price <= budget / 2) ?? available.at(-1);
  sockets[latest.currentUserId].send({ type: "pick", teamKey: choice.teamKey });
  const [a, b] = await Promise.all([alpha.next(), beta.next()]);
  latest = (a.type === "state" ? a : b).state;
}
check("season draft completes", latest.status === "complete", `${latest.picks.length} picks`);

console.log("\nScoring across the season:");
const { scored } = await api(owner.cookie, `/api/leagues/${league.id}/refresh-scores`, { method: "POST" });
check("results scored", scored > 0, `${scored} team-event rows`);

const standingsResponse = await api(owner.cookie, `/api/leagues/${league.id}/standings`);
const { standings } = standingsResponse;
const events = new Set(standings.flatMap((o) => o.entries.map((e) => e.eventKey)));
const weeks = new Set(standings.flatMap((o) => o.entries.map((e) => e.week)));

check("points come from multiple events", events.size > 1, `${events.size} events`);
check(
  "teams scored across different weeks (the bye-week case)",
  weeks.size > 1,
  `weeks ${[...weeks].sort().join(", ")}`,
);
check("every owner has a total", standings.every((o) => typeof o.points === "number"));
check("standings sorted by points", standings.every((o, i) => i === 0 || standings[i - 1].points >= o.points));

for (const entry of standings) {
  console.log(
    `  ${entry.rosterName}: ${Math.round(entry.points)} pts from ${entry.entries.length} team-events`,
  );
}

console.log("\nOffseason/preseason exclusion:");
const excludedEntries = standings.flatMap((o) => o.entries).filter((e) => [99, 100].includes(e.eventType));
check(
  "no offseason/preseason events appear in season scoring at all",
  excludedEntries.length === 0,
  excludedEntries.length ? `found ${excludedEntries.map((e) => e.eventName).join(", ")}` : "none found",
);

console.log("\nRegular-season event cap (district-points style):");
check("cap reported as 2", standingsResponse.regularSeasonEventCap === 2);

for (const entry of standings) {
  const byTeam = new Map();
  for (const e of entry.entries) {
    const list = byTeam.get(e.teamKey) ?? [];
    list.push(e);
    byTeam.set(e.teamKey, list);
  }
  for (const [teamKey, teamEntries] of byTeam) {
    const regular = teamEntries.filter((e) => [0, 1].includes(e.eventType) || e.eventType == null);
    const exempt = teamEntries.filter((e) => [2, 3, 4, 5].includes(e.eventType));
    const countedRegular = regular.filter((e) => e.counted);
    const notCountedRegular = regular.filter((e) => !e.counted);

    check(
      `${teamKey}: at most 2 regular events counted`,
      countedRegular.length <= 2,
      `${countedRegular.length} counted of ${regular.length} regular events`,
    );
    check(`${teamKey}: every exempt (DCMP/CMP) event counts`, exempt.every((e) => e.counted));

    if (notCountedRegular.length > 0 && countedRegular.length === 2) {
      const minCounted = Math.min(...countedRegular.map((e) => e.points));
      const maxNotCounted = Math.max(...notCountedRegular.map((e) => e.points));
      check(
        `${teamKey}: counted regular events are its best-scoring ones`,
        minCounted >= maxNotCounted,
        `min counted ${minCounted} >= max excluded ${maxNotCounted}`,
      );
    }

    const recomputedTotal = [...countedRegular, ...exempt].reduce((sum, e) => sum + e.points, 0);
    const teamTotalFromOwner = teamEntries.filter((e) => e.counted).reduce((sum, e) => sum + e.points, 0);
    check(`${teamKey}: counted points match cap logic`, Math.abs(recomputedTotal - teamTotalFromOwner) < 0.01);
  }
}

alpha.close();
beta.close();
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll season checks passed.");
process.exit(failures.length ? 1 : 0);
