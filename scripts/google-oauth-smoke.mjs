/**
 * Verifies everything about the Google sign-in flow that can be checked without a real
 * Google account: the shape of the outbound authorization request, and every way the
 * callback is supposed to refuse.
 *
 * The token exchange itself needs a real user consenting at accounts.google.com, so the
 * happy path is not covered here — sign in through the UI once to confirm that end.
 *
 * Runs in one of two modes depending on the dev server:
 *   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET unset — checks the routes are absent and the
 *     button is hidden.
 *   - set (dummy values are fine) — checks the redirect, PKCE, and the callback's guards.
 *
 * Usage: node scripts/google-oauth-smoke.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? "http://localhost:5173";
const failures = [];

function check(label, condition, detail = "") {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

/** Every OAuth route answers with a redirect, so nothing here may follow one. */
async function raw(path, cookie) {
  const response = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { Cookie: cookie } : {},
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    setCookie: response.headers.get("set-cookie") ?? "",
    body: await response.json().catch(() => ({})),
  };
}

const providers = await fetch(`${BASE}/api/auth/providers`).then((r) => r.json());
console.log(`Google OAuth is ${providers.google ? "configured" : "not configured"} on this server.\n`);

if (!providers.google) {
  console.log("Unconfigured server hides the feature entirely:");
  const start = await raw("/api/auth/google/start");
  check("the start route 404s", start.status === 404, `${start.status}`);
  const callback = await raw("/api/auth/google/callback?code=x&state=y");
  check("the callback route 404s", callback.status === 404, `${callback.status}`);
  check("providers reports google false", providers.google === false);
  console.log("\nSet GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .dev.vars to exercise the rest.");
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll checks passed.");
  process.exit(failures.length ? 1 : 0);
}

console.log("The start route sends the browser to Google with a PKCE challenge:");
const start = await raw("/api/auth/google/start");
check("it redirects", start.status === 302, `${start.status}`);

const target = new URL(start.location);
check("to Google's authorization endpoint", target.origin + target.pathname === "https://accounts.google.com/o/oauth2/v2/auth", target.origin + target.pathname);
check("asking for an authorization code", target.searchParams.get("response_type") === "code");
check("with the openid email scope", target.searchParams.get("scope") === "openid email profile", target.searchParams.get("scope"));
check("and a redirect_uri pointing back at us", target.searchParams.get("redirect_uri") === `${BASE}/api/auth/google/callback`, target.searchParams.get("redirect_uri"));
check("PKCE uses S256, not plain", target.searchParams.get("code_challenge_method") === "S256", target.searchParams.get("code_challenge_method"));
check("a code challenge is present", (target.searchParams.get("code_challenge") ?? "").length >= 43);
check("a state value is present", (target.searchParams.get("state") ?? "").length >= 43);

const handshakeCookie = start.setCookie.split(";")[0];
check("the handshake is stored in a cookie", handshakeCookie.startsWith("ffs_oauth="), handshakeCookie.slice(0, 20));
check("that cookie is HttpOnly", /HttpOnly/i.test(start.setCookie));
check("and SameSite=Lax, so the callback still carries it", /SameSite=Lax/i.test(start.setCookie));

// The verifier must never be guessable from the challenge, and must never leave the cookie.
check("the verifier is not in the redirect URL", !start.location.includes("code_verifier"));

console.log("\nA second start issues a different state:");
const second = await raw("/api/auth/google/start");
const secondState = new URL(second.location).searchParams.get("state");
check("state is not reused across attempts", secondState !== target.searchParams.get("state"));

console.log("\nThe callback refuses everything it should:");
const oauthError = (location) => new URL(location, BASE).searchParams.get("oauthError");

const noCookie = await raw(`/api/auth/google/callback?code=abc&state=${target.searchParams.get("state")}`);
check("no handshake cookie is rejected", noCookie.status === 302 && Boolean(oauthError(noCookie.location)), oauthError(noCookie.location) ?? `${noCookie.status}`);

const wrongState = await raw("/api/auth/google/callback?code=abc&state=not-the-right-state", handshakeCookie);
check("a mismatched state is rejected", wrongState.status === 302 && Boolean(oauthError(wrongState.location)), oauthError(wrongState.location) ?? `${wrongState.status}`);

const noState = await raw("/api/auth/google/callback?code=abc", handshakeCookie);
check("a missing state is rejected", noState.status === 302 && Boolean(oauthError(noState.location)), oauthError(noState.location) ?? `${noState.status}`);

const noCode = await raw(`/api/auth/google/callback?state=${target.searchParams.get("state")}`, handshakeCookie);
check("a missing code is rejected", noCode.status === 302 && Boolean(oauthError(noCode.location)), oauthError(noCode.location) ?? `${noCode.status}`);

const denied = await raw(`/api/auth/google/callback?error=access_denied&state=${target.searchParams.get("state")}`, handshakeCookie);
check("a cancelled consent screen is handled", denied.status === 302 && /cancelled/i.test(oauthError(denied.location) ?? ""), oauthError(denied.location) ?? "");

// Matching state, but the code is junk — this one really does call Google's token endpoint.
const badCode = await raw(`/api/auth/google/callback?code=definitely-not-a-real-code&state=${target.searchParams.get("state")}`, handshakeCookie);
check("a bogus authorization code is rejected", badCode.status === 302 && Boolean(oauthError(badCode.location)), oauthError(badCode.location) ?? `${badCode.status}`);
check("and no session is issued on failure", !badCode.setCookie.includes("ffs_session="), badCode.setCookie.slice(0, 40));

console.log("\nNone of the refusals signed anyone in:");
for (const [label, result] of [["no cookie", noCookie], ["wrong state", wrongState], ["missing code", noCode], ["cancelled", denied]]) {
  check(`${label} issued no session cookie`, !result.setCookie.includes("ffs_session="));
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll checks passed.");
process.exit(failures.length ? 1 : 0);
