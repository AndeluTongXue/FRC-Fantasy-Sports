/**
 * Verifies scheduled drafts: setting a schedule at creation and afterward, editing and
 * canceling it, permission/status guards, validation bounds, and the actual auto-start
 * behavior (including the "not enough owners when the time arrives" failure path).
 *
 * The auto-start checks require waiting for a real Durable Object alarm to fire (the
 * server enforces at least a 1-minute lead, so there's no way to make this instant) —
 * expect this script to take a little over a minute.
 *
 * Usage: node scripts/schedule-draft-smoke.mjs [baseUrl]
 */
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

async function newLeague(cookie, extra = {}) {
  return api(cookie, "/api/leagues", {
    method: "POST",
    body: JSON.stringify({
      name: `Schedule Test ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      leagueType: "season",
      rosterSize: 3,
      salaryCap: 200,
      ...extra,
    }),
  }).then((r) => r.body.league);
}

async function pollUntil(fn, timeoutMs, intervalMs = 3000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last.done) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const owner = await signIn(`sched-owner-${stamp}@example.com`, "Sched Owner");
const rival = await signIn(`sched-rival-${stamp}@example.com`, "Sched Rival");
const outsider = await signIn(`sched-outsider-${stamp}@example.com`, "Sched Outsider");

const oneDayOut = Date.now() + 24 * 60 * 60 * 1000;

console.log("Validation bounds:");
const tooSoonLeague = await newLeague(owner.cookie);
const tooSoon = await api(owner.cookie, `/api/leagues/${tooSoonLeague.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({ scheduledDraftAt: Date.now() + 1000 }),
});
check("scheduling under a minute out is rejected", tooSoon.status === 400, `${tooSoon.status} ${tooSoon.body.error}`);

const tooFar = await api(owner.cookie, `/api/leagues/${tooSoonLeague.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({ scheduledDraftAt: Date.now() + 200 * 24 * 60 * 60 * 1000 }),
});
check("scheduling over 180 days out is rejected", tooFar.status === 400, `${tooFar.status} ${tooFar.body.error}`);

const missing = await api(owner.cookie, `/api/leagues/${tooSoonLeague.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({}),
});
check("a missing scheduledDraftAt is rejected", missing.status === 400, `${missing.status} ${missing.body.error}`);

console.log("\nScheduling at creation time:");
const createdWithSchedule = await newLeague(owner.cookie, { scheduledDraftAt: oneDayOut });
check(
  "the league is created with the schedule set",
  createdWithSchedule.scheduledDraftAt === oneDayOut,
  `scheduledDraftAt=${createdWithSchedule.scheduledDraftAt}`,
);
const fetchedAfterCreate = await api(owner.cookie, `/api/leagues/${createdWithSchedule.id}`);
check(
  "GET reflects the schedule set at creation",
  fetchedAfterCreate.body.league.scheduledDraftAt === oneDayOut,
);

console.log("\nSetting, editing, and canceling a schedule after creation:");
const league = await newLeague(owner.cookie);
await api(rival.cookie, "/api/leagues/join", { method: "POST", body: JSON.stringify({ inviteCode: league.inviteCode }) });

const outsiderSets = await api(outsider.cookie, `/api/leagues/${league.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({ scheduledDraftAt: oneDayOut }),
});
check("a non-member cannot schedule the draft", outsiderSets.status === 403, `${outsiderSets.status} ${outsiderSets.body.error}`);

const rivalSets = await api(rival.cookie, `/api/leagues/${league.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({ scheduledDraftAt: oneDayOut }),
});
check(
  "a member who isn't the commissioner cannot schedule the draft",
  rivalSets.status === 403,
  `${rivalSets.status} ${rivalSets.body.error}`,
);

const setSchedule = await api(owner.cookie, `/api/leagues/${league.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({ scheduledDraftAt: oneDayOut }),
});
check("the commissioner can schedule the draft", setSchedule.status === 200, `${setSchedule.status}`);

const twoDaysOut = Date.now() + 2 * 24 * 60 * 60 * 1000;
const rescheduled = await api(owner.cookie, `/api/leagues/${league.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({ scheduledDraftAt: twoDaysOut }),
});
check("the commissioner can reschedule", rescheduled.status === 200 && rescheduled.body.scheduledDraftAt === twoDaysOut);

const rivalDeletes = await api(rival.cookie, `/api/leagues/${league.id}/schedule`, { method: "DELETE" });
check(
  "a non-commissioner cannot cancel the schedule",
  rivalDeletes.status === 403,
  `${rivalDeletes.status} ${rivalDeletes.body.error}`,
);

const canceled = await api(owner.cookie, `/api/leagues/${league.id}/schedule`, { method: "DELETE" });
check("the commissioner can cancel the schedule", canceled.status === 200);
const afterCancel = await api(owner.cookie, `/api/leagues/${league.id}`);
check("the schedule reads back as null after canceling", afterCancel.body.league.scheduledDraftAt === null);

console.log("\nManually starting supersedes a pending schedule:");
const manualLeague = await newLeague(owner.cookie, { scheduledDraftAt: oneDayOut });
await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: manualLeague.inviteCode }),
});

const WebSocket = (await import("ws")).default;
async function connectDraft(cookie, leagueId) {
  const socket = new WebSocket(`${BASE.replace("http", "ws")}/api/leagues/${leagueId}/draft/ws`, {
    headers: { Cookie: cookie },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}
function nextMessage(socket) {
  return new Promise((resolve) => socket.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
}

const manualSocket = await connectDraft(owner.cookie, manualLeague.id);
const initialManualState = await nextMessage(manualSocket);
check(
  "the pending state carries the schedule",
  initialManualState.state.scheduledDraftAt === oneDayOut,
  JSON.stringify(initialManualState.state.scheduledDraftAt),
);

manualSocket.send(JSON.stringify({ type: "start" }));
const afterManualStart = await nextMessage(manualSocket);
check("manual start still works with a schedule pending", afterManualStart.state.status === "active");
check(
  "manual start clears the schedule",
  afterManualStart.state.scheduledDraftAt === null,
  JSON.stringify(afterManualStart.state.scheduledDraftAt),
);
manualSocket.close();

const manualLeagueRow = await api(owner.cookie, `/api/leagues/${manualLeague.id}`);
check("D1 also shows the schedule cleared after manual start", manualLeagueRow.body.league.scheduledDraftAt === null);

const rescheduleAfterStart = await api(owner.cookie, `/api/leagues/${manualLeague.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({ scheduledDraftAt: oneDayOut }),
});
check(
  "scheduling is rejected once the draft has started",
  rescheduleAfterStart.status === 409,
  `${rescheduleAfterStart.status} ${rescheduleAfterStart.body.error}`,
);

console.log("\nAuto-start when the scheduled time arrives (this takes about a minute):");
const AUTO_START_LEAD_MS = 65_000; // just over the server's 1-minute floor

const autoLeague = await newLeague(owner.cookie);
await api(rival.cookie, "/api/leagues/join", {
  method: "POST",
  body: JSON.stringify({ inviteCode: autoLeague.inviteCode }),
});
const soloLeague = await newLeague(owner.cookie); // only the commissioner — never reaches 2 owners

const autoAt = Date.now() + AUTO_START_LEAD_MS;
const soloAt = Date.now() + AUTO_START_LEAD_MS;
await api(owner.cookie, `/api/leagues/${autoLeague.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({ scheduledDraftAt: autoAt }),
});
await api(owner.cookie, `/api/leagues/${soloLeague.id}/schedule`, {
  method: "PUT",
  body: JSON.stringify({ scheduledDraftAt: soloAt }),
});

const autoSocket = await connectDraft(owner.cookie, autoLeague.id);
await nextMessage(autoSocket); // initial pending state

let autoStarted = null;
const autoStartedPromise = nextMessage(autoSocket).then((msg) => {
  autoStarted = msg;
});

const soloResult = await pollUntil(
  async () => {
    const fetched = await api(owner.cookie, `/api/leagues/${soloLeague.id}`);
    return { done: fetched.body.league.scheduledDraftAt === null, league: fetched.body.league };
  },
  120_000,
);
await autoStartedPromise.catch(() => {});
autoSocket.close();

check(
  "a league with enough owners auto-starts at the scheduled time",
  autoStarted?.state?.status === "active",
  autoStarted ? `status=${autoStarted.state.status}` : "no state message received in time",
);
check(
  "auto-start clears the schedule",
  autoStarted?.state?.scheduledDraftAt === null,
  JSON.stringify(autoStarted?.state?.scheduledDraftAt),
);

const autoLeagueRow = await api(owner.cookie, `/api/leagues/${autoLeague.id}`);
check("D1 reflects the auto-started league as drafting", autoLeagueRow.body.league.status === "drafting");

check(
  "a league that never reaches 2 owners cancels its schedule instead of starting",
  soloResult.league?.scheduledDraftAt === null,
  JSON.stringify(soloResult.league),
);
check(
  "that league's status stays in setup",
  soloResult.league?.status === "setup",
  soloResult.league?.status,
);

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll schedule-draft checks passed.",
);
process.exit(failures.length ? 1 : 0);
