/**
 * Verifies the draft pool's sorting and filtering.
 *
 * The point of doing this in SQL rather than over the rows the client already holds: a
 * season pool is 3000+ teams and the endpoint returns 80, so filtering client-side would
 * answer "the cheapest of the highest-EPA 80" instead of "the cheapest". These checks use a
 * season league for exactly that reason — the ordering only proves anything when the pool is
 * far larger than the page.
 *
 * Usage: node scripts/pool-smoke.mjs [baseUrl]
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

const ascending = (values) => values.every((value, i) => i === 0 || values[i - 1] <= value);
const descending = (values) => values.every((value, i) => i === 0 || values[i - 1] >= value);

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const owner = await signIn(`pool-${stamp}@example.com`, "Pool Tester");

const league = (
  await api(owner.cookie, "/api/leagues", {
    method: "POST",
    body: JSON.stringify({ name: `Pool Test ${stamp}`, leagueType: "season", rosterSize: 3, salaryCap: 200 }),
  })
).body.league;

const pool = (qs) => api(owner.cookie, `/api/leagues/${league.id}/pool?${qs}`).then((r) => r.body.teams);

console.log("Sorting is applied across the whole pool, not the returned page:");
const byEpa = await pool("limit=40");
const byPriceAsc = await pool("limit=40&sort=priceAsc");
const byPriceDesc = await pool("limit=40&sort=priceDesc");
const byNumber = await pool("limit=40&sort=number");

check("default orders by EPA, descending", descending(byEpa.map((t) => t.epa ?? -Infinity)));
check("priceAsc orders by price, ascending", ascending(byPriceAsc.map((t) => t.price)), byPriceAsc.slice(0, 3).map((t) => `$${t.price}`).join(" "));
check("priceDesc orders by price, descending", descending(byPriceDesc.map((t) => t.price)), byPriceDesc.slice(0, 3).map((t) => `$${t.price}`).join(" "));
check("number orders by team number, ascending", ascending(byNumber.map((t) => t.teamNumber)), byNumber.slice(0, 3).map((t) => t.teamNumber).join(" "));

// The real test of server-side sorting: the cheapest team in the pool must not be reachable
// by sorting the default page. If it is, this whole endpoint could have been client-side.
const cheapest = byPriceAsc[0];
check(
  "priceAsc surfaces a team the default page never returned",
  !byEpa.some((t) => t.teamKey === cheapest.teamKey),
  `cheapest is ${cheapest.teamNumber} at $${cheapest.price}`,
);

console.log("");
console.log("The price ceiling filters in SQL:");
const ceiling = cheapest.price + 5;
const capped = await pool(`limit=40&sort=priceDesc&maxPrice=${ceiling}`);
check("nothing above the ceiling comes back", capped.every((t) => t.price <= ceiling), `max $${Math.max(...capped.map((t) => t.price))} vs ceiling $${ceiling}`);
check(
  "and it returns the most expensive teams within it, not the leftovers of an EPA page",
  capped.length > 0 && capped[0].price === Math.max(...capped.map((t) => t.price)),
  `top of the capped list is $${capped[0]?.price}`,
);

const zero = await pool("limit=40&maxPrice=0");
check("a ceiling of 0 returns nothing rather than being ignored", zero.length === 0, `${zero.length} teams`);

const negative = await pool("limit=40&maxPrice=-63");
check("a negative ceiling returns nothing too", negative.length === 0, `${negative.length} teams`);

console.log("");
console.log("Sort and filter compose with search, and bad input is inert:");
const searched = await pool("limit=20&sort=priceAsc&search=16");
check("search still applies", searched.every((t) => String(t.teamNumber).startsWith("16") || /16/.test(t.nickname ?? "")), searched.slice(0, 3).map((t) => t.teamNumber).join(" "));
check("and is still price-sorted", ascending(searched.map((t) => t.price)));

// `sort` lands in the SQL string, so it is whitelisted rather than interpolated.
const injected = await pool(`limit=5&sort=${encodeURIComponent("price; DROP TABLE teams;--")}`);
check("an unknown sort falls back instead of erroring", injected.length === 5);
check("and the teams table is still there", (await pool("limit=1")).length === 1);

const junkPrice = await pool("limit=5&maxPrice=banana");
check("a non-numeric ceiling is ignored, not applied as NaN", junkPrice.length === 5, `${junkPrice.length} teams`);

console.log("");
console.log("Membership still gates the endpoint:");
const outsider = await signIn(`pool-outsider-${stamp}@example.com`, "Outsider");
const forbidden = await api(outsider.cookie, `/api/leagues/${league.id}/pool?sort=priceAsc`);
check("a non-member is refused", forbidden.status === 403, `${forbidden.status}`);

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nAll pool checks passed.");
process.exit(failures.length ? 1 : 0);
