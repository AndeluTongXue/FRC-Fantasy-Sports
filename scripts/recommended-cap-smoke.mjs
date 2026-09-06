/**
 * Verifies the recommended-salary-cap estimate: a single-event league averages its whole
 * (small) event roster, a season-long league estimates from the top of the pool instead
 * of averaging all 3000+ teams, and the two produce meaningfully different numbers.
 *
 * Usage: node scripts/recommended-cap-smoke.mjs [baseUrl]
 */
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
    if (response.ok) return { cookie: response.headers.get("set-cookie").split(";")[0] };
  }
  throw new Error(`could not sign in ${email}`);
}

async function api(cookie, path) {
  const response = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const owner = await signIn(`recap-${Date.now()}@example.com`, "Recap Tester");

console.log("Validation:");
const missingEventKey = await api(
  owner.cookie,
  "/api/leagues/recommended-cap?leagueType=single_event&rosterSize=6&maxMembers=8",
);
check("single-event without eventKey is rejected", missingEventKey.status === 400, missingEventKey.body.error);

console.log("\nSingle-event league (small, bounded pool):");
const singleEvent = await api(
  owner.cookie,
  "/api/leagues/recommended-cap?leagueType=single_event&eventKey=2026casnv&rosterSize=6&maxMembers=8",
);
check("returns a recommendation", singleEvent.status === 200, JSON.stringify(singleEvent.body));
check(
  "sample size matches the event's actual roster (not capped at 48)",
  singleEvent.body.sampleSize > 0 && singleEvent.body.sampleSize < 100,
  singleEvent.body.sampleSize,
);
check(
  "recommendedCap = averagePrice * rosterSize (rounded to nearest $5)",
  Math.abs(singleEvent.body.recommendedCap - singleEvent.body.averagePrice * 6) <= 15,
  `${singleEvent.body.recommendedCap} vs ${singleEvent.body.averagePrice} * 6`,
);

console.log("\nSeason-long league (must NOT average all 3000+ teams):");
const season = await api(owner.cookie, "/api/leagues/recommended-cap?leagueType=season&rosterSize=6&maxMembers=8");
check("returns a recommendation", season.status === 200, JSON.stringify(season.body));
check(
  "sample size is bounded to the league's draft capacity (maxMembers * rosterSize = 48), not thousands",
  season.body.sampleSize <= 48,
  season.body.sampleSize,
);
check(
  "season average price is meaningfully above a naive whole-pool average (not diluted by scrubs)",
  season.body.averagePrice > 30,
  season.body.averagePrice,
);

console.log("\nOffseason event (should price from the just-finished season, not last year):");
const offseason = await api(
  owner.cookie,
  "/api/leagues/recommended-cap?leagueType=single_event&eventKey=2026cc&rosterSize=6&maxMembers=8",
);
check("returns a recommendation", offseason.status === 200, JSON.stringify(offseason.body));
check(
  "offseason average differs from in-season average for the same roster size (different EPA year)",
  offseason.body.averagePrice !== singleEvent.body.averagePrice,
  `${offseason.body.averagePrice} vs ${singleEvent.body.averagePrice}`,
);

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll recommended-cap checks passed.",
);
process.exit(failures.length ? 1 : 0);
