# FRC Fantasy Sports

Fantasy sports for FIRST Robotics Competition. Draft real FRC teams in a live snake draft
with a salary cap, then score points from their actual results at events — for a single
event or across a whole season.

Runs entirely on Cloudflare: a Worker serves both the React app and the API, D1 stores
everything, and a Durable Object runs each live draft room.

## Stack

| Piece | Choice |
| --- | --- |
| Frontend | React 19 + Vite + Tailwind, served as static assets by the Worker |
| API | Hono on Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Live draft | Durable Object per league, WebSockets + alarms for the pick clock |
| Team data | The Blue Alliance API (in-season results) |
| Draft pricing | Statbotics EPA from the prior season, cached once into D1 |

## How the game works

**Draft** — snake order, but every team carries a fixed price and each owner has a salary
cap. You draft in turn and can take any team you can still afford, with a guard that stops
you spending so much you can't fill your roster (the client mirrors this exactly, so a team
that would trigger it shows as unavailable before you even click). Each pick has a clock; if
it expires, the best affordable team within that same guard is auto-drafted — or, in the
rare case nothing qualifies (the cheap tier got bought up before your turn), the pick is
skipped and that roster slot goes unfilled; the draft room shows a warning when this is
about to happen to you.

The commissioner can schedule an auto-start time for the draft — at creation, or any time
before it actually starts, from the league page. It's backed by the same Durable Object
alarm the pick clock uses, so it fires precisely rather than on the 10-minute cron tick;
the commissioner can still start early regardless, which supersedes the schedule. If the
scheduled time arrives without at least 2 owners in the league, the schedule is cancelled
(not retried) and the draft stays in manual-start mode.

**Pricing** — teams are priced from a Statbotics final EPA percentile on a continuous
curve ($5–$75: `price = 5 + 70 × (1 − (1 − percentile)^0.4)`, rounded to the nearest
dollar), so two teams a hair apart in EPA land on distinct — if close — prices instead of
being bucketed onto the same number. Still steep at the top: only a true handful of elite
teams pull away toward $75. See `priceForPercentile` in
[`src/server/lib/statbotics.ts`](src/server/lib/statbotics.ts). Prices are cached
permanently in D1 (rows are keyed by the literal EPA year fetched, so multiple years can
be cached at once without clobbering each other). Statbotics is read only by this one
job — its frequent outages never affect a draft or in-season scoring — and teams with no
cached EPA (rookies) fall back to $10.

Which year a league prices from depends on the *season* it drafts for, not the calendar
year: a league drafting for a season still in progress uses last year's final EPA, since
this year's isn't complete yet. The one exception is a single-event league tied to an
**Offseason** event (Chezy Champs, IRI, etc.) — those happen after the season has fully
concluded, so that season's own EPA is both final and far more current than reaching back
a year. See `pricingYearForLeague` in [`src/server/lib/pricing.ts`](src/server/lib/pricing.ts).
The "Re-price from Statbotics" button on the Teams page (admin-only) defaults to last
year; enter the current season in its year field once it's over to price offseason-event
leagues from it instead — same thing as `POST /api/admin/price-teams?year=`, which it
calls.

**Minimum cap** — league creation (and the pre-draft budget editor) suggest a starting
salary cap: the smallest cap that's *guaranteed* safe, no matter how the draft unfolds.
Ownership is exclusive, so across a whole league at most `maxMembers × rosterSize` teams
ever get drafted — the "relevant pool" (for a single-event league that's just its own
roster; a season-long league's pool would otherwise be the entire season's 3000+ teams,
so it's capped the same way). The worst case for any one manager is being forced into the
`rosterSize` *most expensive* teams within that pool (e.g. if the cheap tier gets bought up
by others before their turn) — the minimum cap is the sum of those prices, rounded **up**
to the nearest $5 so rounding never eats into the safety margin. This is exactly the
guarantee the live draft room's reserve-budget rule (below) depends on to never strand a
manager. See `minimumSalaryCap` in [`src/server/lib/pricing.ts`](src/server/lib/pricing.ts).

**Scoring** — from The Blue Alliance only:

| Result | Default points |
| --- | --- |
| Qual win / tie | 10 / 3 |
| Ranking point | 2 each |
| Alliance captain / 1st / 2nd / 3rd pick | 15 / 10 / 6 / 3 |
| Playoff win | 20 |
| Event win / finalist | 75 / 35 |
| Impact / Engineering Inspiration / other award | 30 / 12 / 5 |
| Championship event | 1.5× everything |

Every league stores its own copy of these weights, so tuning the defaults never rewrites
history for an existing league.

**Season-long leagues** avoid the "teams compete on different weekends" problem by dropping
head-to-head matchups: standings are a running total of everything your teams earn at every
event they attend all year. A team with no event that week simply contributes nothing, the
same way a bye works in other fantasy sports.

To stop "attends more events" from being an advantage on its own, each team's own total is
capped the same way FRC's district point system works: only its best 2 Regional/District
results count, while every District Championship and Championship (division or Einstein)
event always counts in full. The standings page greys out and labels the events that didn't
make a team's best 2. Offseason and preseason events are excluded from season-long scoring
entirely — not merely capped — since they aren't part of the official season; an explicit
single-event league tied to an offseason event (e.g. Chezy Champs) is unaffected and scores
normally, since that's a deliberate choice, not season-long auto-discovery.

**League membership** — the commissioner (whoever created the league) can edit the budget
and delete the league at any time; any member can leave or rename their own team, and any
member can leave, but only before the draft starts, since a mid-draft roster with no owner
is a bigger mess than just not allowing it. If the commissioner leaves and others remain,
ownership passes to whoever joined earliest after them; if they're the only member, they're
pointed at deleting the league instead.

The commissioner can also ban a member — kicking them immediately and blocking them from
rejoining with the invite code until unbanned — from a "Banned users" list on the league
page. Same pre-draft-only restriction as leaving, for the same reason (a kicked mid-draft
roster has no good outcome). A ban check is by account id, so it's a moderation tool for
"this specific account is causing problems," not a hard guarantee against someone signing up
again under a new email.

## Accounts and rate limits

**Admins** — `/api/admin/*` (the TBA and Statbotics sync jobs) is admin-only. Those jobs
spend our third-party API quota, so being signed in isn't enough: an account needs
`users.is_admin`, which is set directly in D1 and deliberately has no API or UI for
granting it. That avoids the usual "first account to sign up becomes admin" race on a
public deploy. The admin-only buttons on the Teams and Events pages (syncing, re-pricing)
only render for admins, and the flag is read per request, so promoting an account takes
effect on the next page load with no re-login.

**Sign-in throttling** — failed sign-ins are counted per email (10 per 15 minutes) and per
IP (50, looser because a shared NAT legitimately produces some), and the limit is checked
before the password hash is verified so a locked-out attacker can't keep burning CPU. A
successful sign-in clears that email's counter — which needs the real password, so it
can't be used to reset someone else's. Only Cloudflare's `CF-Connecting-IP` is trusted for
the IP key; `X-Forwarded-For` is client-supplied and honouring it would let an attacker
rotate the header to sidestep the limit. Locally there's no such header, so only the
per-email counter applies.

**Score refresh cooldown** — `POST /api/leagues/:id/refresh-scores` is the one path a
regular member can use that reaches TBA (a season league asks TBA for every rostered
team's schedule), so it's limited to once per 5 minutes per league. The cron rescores from
cached data regardless, so the cooldown only delays a manual nudge.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # add your TBA key from thebluealliance.com/account
npm run db:migrate:local
npm run dev
```

Then sign up in the app and grant yourself admin, so you can seed the data:

```bash
npx wrangler d1 execute frc-fantasy-db --local \
  --command "UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"
```

Reload the app and seed — each of these is also a button on the Teams or Events page for
an admin account ("Sync from TBA" on both; "Re-price from Statbotics" on Teams only):

```bash
curl -b cookies.txt -X POST http://localhost:5173/api/admin/sync/teams
curl -b cookies.txt -X POST http://localhost:5173/api/admin/sync/events
curl -b cookies.txt -X POST http://localhost:5173/api/admin/price-teams
```

`SEASON_YEAR` in `wrangler.jsonc` controls which season the app serves; pricing reads the
season before it.

## Tests

These scripts drive the real API and WebSocket draft against a running dev server:

```bash
node scripts/draft-smoke.mjs         # turn order, budget guards, snake reversal, completion
node scripts/season-smoke.mjs        # season-long scoring, including the best-2-regular-events cap
node scripts/delete-league-smoke.mjs # commissioner-only delete, D1 cleanup, draft room teardown
node scripts/edit-budget-smoke.mjs   # commissioner-only, pre-draft-only salary cap editing
node scripts/minimum-cap-smoke.mjs   # minimum-cap math + a live adversarial draft proving the guarantee holds
node scripts/leave-league-smoke.mjs  # leaving pre-draft, commissioner transfer, solo-member block, post-draft lock
node scripts/ban-league-smoke.mjs    # commissioner-only ban/unban, kick + rejoin block, self-ban refused, post-draft lock
node scripts/hardening-smoke.mjs    # admin-only sync routes, failed-sign-in lockout, refresh-scores cooldown
node scripts/schedule-draft-smoke.mjs # scheduling at creation/after, edit/cancel, permissions, real auto-start
```

## Deploying to Cloudflare

Runs on the Workers **Free** plan — `DraftRoom` uses SQLite-backed Durable Object storage
(`new_sqlite_classes` in `wrangler.jsonc`), which Cloudflare doesn't gate behind a paid
plan the way the older KV-backed Durable Objects are. Free-plan caps apply (Workers
requests/day, D1 rows read/written per day, Durable Object request and storage limits) —
fine for a handful of leagues, but worth watching in the Cloudflare dashboard's Usage tab
if this grows.

```bash
npx wrangler d1 create frc-fantasy-db      # put the returned database_id in wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put TBA_API_KEY
npm run deploy
```

Then sign up on the deployed app and promote that account, so it can run the sync jobs:

```bash
npx wrangler d1 execute frc-fantasy-db --remote \
  --command "UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"
```

The cron trigger (every 10 minutes) refreshes the event list daily, pulls results for any
event happening that day, and rescores active leagues from cached data — no external calls
beyond TBA.

## Not built yet

- Password reset (needs an email provider)
- Commissioner UI for editing scoring weights (the column exists; only defaults are written)
- Trades and waivers
