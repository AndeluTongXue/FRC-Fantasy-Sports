/**
 * Verifies email confirmation and password reset end to end.
 *
 * Reads the links out of `/api/auth/dev/outbox`, which only exists when no email provider is
 * configured and `EMAIL_DEV_OUTBOX=1` is in .dev.vars — so run this against a dev server with
 * RESEND_API_KEY unset. Resend itself isn't exercised here; the only thing that changes with
 * a key set is where `sendEmail` posts the same body.
 *
 * Usage: node scripts/auth-email-smoke.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? "http://localhost:5173";
const failures = [];

function check(label, condition, detail = "") {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? null,
  };
}

const post = (path, body, cookie) =>
  call(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: cookie ? { Cookie: cookie } : {},
  });

const get = (path, cookie) => call(path, { headers: cookie ? { Cookie: cookie } : {} });

async function signUp(email, password = "testpass123") {
  const result = await post("/api/auth/signup", { email, password, displayName: "Email Smoke" });
  if (result.status !== 201) throw new Error(`signup failed for ${email}: ${JSON.stringify(result.body)}`);
  return { email, password, cookie: result.cookie, user: result.body.user, emailSent: result.body.emailSent };
}

/** Pulls the link out of the most recent captured mail for an address. */
async function linkFor(email) {
  const result = await get(`/api/auth/dev/outbox?email=${encodeURIComponent(email)}`);
  if (result.status === 404 && result.body.error === "Not found") {
    throw new Error("GET /api/auth/dev/outbox is off — set EMAIL_DEV_OUTBOX=1 in .dev.vars and restart");
  }
  if (result.status !== 200) return null;
  const match = result.body.body.match(/https?:\/\/\S+/);
  return match ? { url: match[0], subject: result.body.subject } : null;
}

function tokenOf(url) {
  return new URL(url).searchParams.get("token");
}

const createLeague = (cookie) =>
  post(
    "/api/leagues",
    {
      name: `Email Smoke ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      leagueType: "season",
      rosterSize: 3,
      salaryCap: 200,
    },
    cookie,
  );

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ── Confirmation ────────────────────────────────────────────────────────────────────────
console.log("Signup leaves the account unconfirmed and mails a link:");
const alice = await signUp(`email-alice-${stamp}@example.com`);
check("signup reports emailVerified false", alice.user.emailVerified === false, `got ${alice.user.emailVerified}`);
check("signup reports the mail went out", alice.emailSent === true, `emailSent=${alice.emailSent}`);

const verifyMail = await linkFor(alice.email);
check("a confirmation email was produced", verifyMail !== null, verifyMail?.subject ?? "none");
check("it points at /verify-email", verifyMail?.url.includes("/verify-email?token=") === true, verifyMail?.url);

console.log("An unconfirmed account is blocked from leagues but nothing else:");
const blockedCreate = await createLeague(alice.cookie);
check("creating a league is 403", blockedCreate.status === 403, `${blockedCreate.status} ${blockedCreate.body.error ?? ""}`);

const blockedJoin = await post("/api/leagues/join", { inviteCode: "NOPE12" }, alice.cookie);
check("joining a league is 403", blockedJoin.status === 403, `${blockedJoin.status}`);

const listLeagues = await get("/api/leagues", alice.cookie);
check("listing leagues still works", listLeagues.status === 200, `${listLeagues.status}`);
const listTeams = await get("/api/teams?limit=1", alice.cookie);
check("browsing teams still works", listTeams.status === 200, `${listTeams.status}`);

console.log("Confirmation links redeem once:");
const badToken = await post("/api/auth/verify-email", { token: "not-a-real-token" });
check("a garbage token is rejected", badToken.status === 400, `${badToken.status}`);

const verifyToken = tokenOf(verifyMail.url);
const confirmed = await post("/api/auth/verify-email", { token: verifyToken });
check("the real token confirms", confirmed.status === 200, `${confirmed.status} ${confirmed.body.error ?? ""}`);

const replayed = await post("/api/auth/verify-email", { token: verifyToken });
check("replaying the same token fails", replayed.status === 400, `${replayed.status}`);

const meAfter = await get("/api/auth/me", alice.cookie);
check("/auth/me now reports confirmed", meAfter.body.user?.emailVerified === true, `${meAfter.body.user?.emailVerified}`);

const allowedCreate = await createLeague(alice.cookie);
check("a confirmed account can create a league", allowedCreate.status === 201, `${allowedCreate.status} ${allowedCreate.body.error ?? ""}`);

console.log("Resend issues a fresh link and retires the old one:");
const bob = await signUp(`email-bob-${stamp}@example.com`);
const firstLink = await linkFor(bob.email);
const resent = await post("/api/auth/resend-verification", undefined, bob.cookie);
check("resend succeeds", resent.status === 200, `${resent.status}`);
const secondLink = await linkFor(bob.email);
check("the new link differs", secondLink?.url !== firstLink?.url);
const staleVerify = await post("/api/auth/verify-email", { token: tokenOf(firstLink.url) });
check("the superseded link no longer works", staleVerify.status === 400, `${staleVerify.status}`);
const freshVerify = await post("/api/auth/verify-email", { token: tokenOf(secondLink.url) });
check("the newest link works", freshVerify.status === 200, `${freshVerify.status}`);

// ── Password reset ──────────────────────────────────────────────────────────────────────
console.log("Forgot-password does not reveal whether an address is registered:");
const unknown = `email-nobody-${stamp}@example.com`;
const unknownAsk = await post("/api/auth/forgot-password", { email: unknown });
const carol = await signUp(`email-carol-${stamp}@example.com`);
const knownAsk = await post("/api/auth/forgot-password", { email: carol.email });
check("unknown address gets 200", unknownAsk.status === 200, `${unknownAsk.status}`);
check("known address gets the same status", knownAsk.status === unknownAsk.status);
check(
  "and the identical body",
  JSON.stringify(knownAsk.body) === JSON.stringify(unknownAsk.body),
  JSON.stringify(unknownAsk.body),
);
const unknownMail = await linkFor(unknown);
check("no mail is produced for the unknown address", unknownMail === null);

console.log("The reset link sets a new password and invalidates everything else:");
const resetMail = await linkFor(carol.email);
check("a reset email was produced", resetMail !== null, resetMail?.subject ?? "none");
check("it points at /reset-password", resetMail?.url.includes("/reset-password?token=") === true, resetMail?.url);

const resetToken = tokenOf(resetMail.url);
const crossPurpose = await post("/api/auth/verify-email", { token: resetToken });
check("a reset token is not a confirmation token", crossPurpose.status === 400, `${crossPurpose.status}`);

// Length is checked before the token is redeemed, so a typo here must not burn the link —
// the successful reset below uses this same token.
const tooShort = await post("/api/auth/reset-password", { token: resetToken, password: "short" });
check("a too-short password is rejected", tooShort.status === 400, `${tooShort.status}`);

const newPassword = "brand-new-pass-99";
const reset = await post("/api/auth/reset-password", { token: resetToken, password: newPassword });
check("the reset succeeds", reset.status === 200, `${reset.status} ${reset.body.error ?? ""}`);
check("it hands back a session", reset.cookie !== null);
check(
  "and confirms the address on the way through",
  reset.body.user?.emailVerified === true,
  `${reset.body.user?.emailVerified}`,
);

const oldSession = await get("/api/auth/me", carol.cookie);
check("the pre-reset session is dead", oldSession.status === 401, `${oldSession.status}`);
const newSession = await get("/api/auth/me", reset.cookie);
check("the new session works", newSession.status === 200, `${newSession.status}`);

const oldPassword = await post("/api/auth/login", { email: carol.email, password: carol.password });
check("the old password is rejected", oldPassword.status === 401, `${oldPassword.status}`);
const signedIn = await post("/api/auth/login", { email: carol.email, password: newPassword });
check("the new password works", signedIn.status === 200, `${signedIn.status}`);

const replayedReset = await post("/api/auth/reset-password", { token: resetToken, password: "another-pass-99" });
check("the reset token is single-use", replayedReset.status === 400, `${replayedReset.status}`);

console.log("Reset email is rate limited per address:");
const dave = await signUp(`email-dave-${stamp}@example.com`);
let throttled = null;
for (let attempt = 0; attempt < 8 && throttled === null; attempt++) {
  const response = await post("/api/auth/forgot-password", { email: dave.email });
  if (response.status === 429) throttled = attempt + 1;
}
check("a burst of reset requests hits 429", throttled !== null, throttled ? `on request ${throttled}` : "never");

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll checks passed.");
process.exit(failures.length ? 1 : 0);
