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
that would trigger it shows as unavailable before you even click). Each pick has a clock the commissioner sets at league creation and can change any time
before the draft starts (30–300s, defaulting to 90 — the same window the salary cap is
editable in, and locked for the same reason: once the draft begins the room's alarm is
already running on it). If it expires, the best affordable team within that same guard is auto-drafted — or, in the
rare case nothing qualifies (the cheap tier got bought up before your turn), the pick is
skipped and that roster slot goes unfilled; the draft room shows a warning when this is
about to happen to you.

**Commissioner controls** — a live draft can go wrong in ways the managers can't fix
themselves: a dropped connection, someone who stepped away, a misclick. The commissioner can
**pause** it (the clock stops and picking is blocked; resuming hands back the time that was
left rather than restarting the pick), **add 60 seconds** to the current pick, **autodraft**
for whoever is on the clock, and **undo the last pick** — which refunds it, puts that manager
back on the clock, and reopens the draft if it had already finished. All four are
commissioner-only: in a manager's hands each is a way to take an extra turn.

Autodraft runs exactly what the expiring clock would have run — first affordable team on that
manager's queue, or the best they can afford if they never set one — charged to their budget.
It shares one implementation with the alarm so the two can't drift, and the commissioner is
skipping the wait rather than choosing the team: which team to take is that manager's call,
and their queue already states it.

Undo returns the team to the pool but not to anyone's queue: drafting it deleted those rows
and nothing records who had queued it.

Deliberately not included: skipping a manager's pick outright. It permanently costs them a
roster slot, and drafting for them covers the same situation without the collateral damage.

**Draft queue** — each manager keeps a private ordered list of teams to take if their clock
expires. Autopick walks it and takes the first entry that's still undrafted, still in the
pool, and affordable within the reserve guard, skipping the rest — a queue written before
the draft can't know what the budget will look like by the time the clock runs out, so
stopping at the first unaffordable entry would strand people who queued expensive teams
first. Only when the queue yields nothing does it fall back to the old behaviour of taking
the best affordable team, which is a guess at what the manager wanted rather than a
statement of it. Drafting a team drops it from every queue in the league.

Reordering is drag-or-buttons. The drag is built on Pointer Events rather than the HTML5
drag-and-drop API, which never fires on touch — this list gets reordered on a phone at a
competition, and a desktop-only implementation would look fine there and do nothing. The
↑/↓ buttons stay as the keyboard path and as a precise fallback on a small target.

Queues are private: the route only ever reads back the signed-in manager's own, since seeing
an opponent's would be a large unearned advantage. They're editable from the draft room
before and during the draft, and go read-only once it finishes.

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
manager, so it is **enforced**, not merely suggested: creating a league below it, or editing
a cap down below it, is refused with the required figure named. Below that line the reserve
rule refuses every team from the very first pick — the clock expires, autopick finds nothing
(a queue is skipped the same way), the turn is skipped, and the draft ends with empty
rosters. It bites hardest at small elite events, where there is no cheap tier at all: a
43-team offseason field whose cheapest robot is $26 needs a far larger cap than a season
league drawing on 3000+ teams. Where the minimum exceeds the $500 ceiling the message says
to lower the roster size instead, since no cap can fix that, and where there's no cached
price data to judge against the check stands down rather than blocking. See
`minimumSalaryCap` in [`src/server/lib/pricing.ts`](src/server/lib/pricing.ts).

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

**Sign in with Google** — the recommended path, and the only one that needs no domain of
your own. Google vouches for the address, so the account is confirmed the moment it's
created and there's no password to reset. Standard authorization-code flow with PKCE:
`state` in an httpOnly cookie defends the callback against CSRF, and the `code_verifier`
against an intercepted code being redeemed by anyone else. See
[`src/server/lib/oauth.ts`](src/server/lib/oauth.ts).

Accounts are keyed on Google's `sub`, not the email address — `sub` is stable for the life
of the Google account while the address on it can change, so matching on email would hand
the account to whoever inherits an old address. Signing in with Google on an address that
already has a password account **links** the two: same account, now reachable either way.
That's only safe because the ID token's `email_verified` claim is checked, and a token
whose claim is false is refused outright. An account created through Google has no password
(`password_hash` is `''`, which `verifyPassword` rejects), so password sign-in isn't
available for it until there's a UI to set one.

The ID token's signature isn't checked against Google's JWKS and doesn't need to be: it
arrives over a TLS connection opened directly to Google's token endpoint. Its claims are
still validated — an unchecked `aud` would let a token minted for someone else's OAuth
client be replayed at ours.

With `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` unset the button is hidden and both routes
404, so the app runs fine without them.

**Email confirmation** — signing up with a password mails a confirmation link and leaves the account
*unconfirmed*. You're signed in straight away and can browse teams, events and any league
you're already in, but creating or joining a league is blocked until you click the link —
those are the actions that put your address in front of other people. A banner across the
top says so and can resend the link. Accounts that predate this were grandfathered in as
confirmed: they signed up when no confirmation existed, and locking them out of leagues
they already run would be the worse outcome.

`GET /api/auth/providers` reports what this particular deploy can actually do, and the
sign-in pages hide what it can't: no OAuth client, no Google button; no way to deliver
email, no "Forgot your password?" link, and `forgot-password` answers 503 rather than the
usual generic success — that message would be a promise the deploy can't keep.

The gate only stands where a link can actually be delivered — a provider configured, or the
development outbox switched on. With neither, it degrades to the banner, because enforcing
it would lock every new account out of leagues forever waiting on a link that was never
going to arrive. See `canDeliverEmail` in [`src/server/lib/email.ts`](src/server/lib/email.ts).

**Password reset** — `POST /api/auth/forgot-password` mails a link, and answers identically
whether or not the address has an account, so it can't be used to test which addresses are
registered. Redeeming it sets the new password, drops **every** session the account had
(the whole point of a reset is defeated if the other party's session survives it), and
signs you in on the spot. It also marks the address confirmed, since clicking the link
proves the same thing confirmation proves — so "I never got the confirmation email" isn't a
dead end.

Both links carry a random 32-byte token of which only the SHA-256 digest is stored, the same
way sessions work: a D1 leak isn't enough to take over an account. They're single-use,
scoped to one purpose (a reset token is not a confirmation token), invalidated if the
account's address changes, and expire — 24 hours for confirmation, 1 hour for a reset.
Asking for a second link retires the first. Routes that send mail are limited to 5 per
address and 20 per IP per 15 minutes, because the address being mailed is one the *caller*
typed: unlimited, they'd be a way to make us bury a stranger's inbox.

Mail goes out through [Resend](https://resend.com) — set `RESEND_API_KEY` as a secret and
`EMAIL_FROM` to an address on a domain you've verified with them. Swapping providers is the
one `sendEmail` function in [`src/server/lib/email.ts`](src/server/lib/email.ts). `APP_URL`
in `wrangler.jsonc` is the origin the emailed links point at; leave it empty and links fall
back to the request's own origin, which trusts a client-supplied `Host` header — fine
locally, not on a deploy, where someone could request a reset for your address and have the
link point at a host they control.

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

For Google sign-in locally, create an OAuth client at
[console.cloud.google.com](https://console.cloud.google.com) (APIs & Services → Credentials →
OAuth client ID → Web application), add `http://localhost:5173/api/auth/google/callback` as
an authorized redirect URI, and put the id and secret in `.dev.vars`.

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

With `RESEND_API_KEY` unset and `EMAIL_DEV_OUTBOX=1`, confirmation and reset mail isn't
sent — it's captured in D1 and readable at `/api/auth/dev/outbox?email=...`, so you can copy
the link out of it:

```bash
curl 'http://localhost:5173/api/auth/dev/outbox?email=you@example.com'
```

`EMAIL_DEV_OUTBOX` gates both the capture and the route, and belongs in `.dev.vars` and
nowhere else — on a deploy it would hand anyone a reset link for any address.

## Tests

These scripts drive the real API and WebSocket draft against a running dev server. They all
sign accounts up, and league routes need a confirmed address, so the dev server needs
`EMAIL_DEV_OUTBOX=1` and no `RESEND_API_KEY` — the scripts read each confirmation link back
out of the outbox ([`scripts/lib/confirm-email.mjs`](scripts/lib/confirm-email.mjs)).

```bash
node scripts/draft-smoke.mjs         # turn order, budget guards, snake reversal, completion
node scripts/season-smoke.mjs        # season-long scoring, including the best-2-regular-events cap
node scripts/delete-league-smoke.mjs # commissioner-only delete, D1 cleanup, draft room teardown
node scripts/edit-budget-smoke.mjs   # commissioner-only, pre-draft-only salary cap and pick clock editing
node scripts/minimum-cap-smoke.mjs   # minimum-cap math + a live adversarial draft proving the guarantee holds
node scripts/leave-league-smoke.mjs  # leaving pre-draft, commissioner transfer, solo-member block, post-draft lock
node scripts/ban-league-smoke.mjs    # commissioner-only ban/unban, kick + rejoin block, self-ban refused, post-draft lock
node scripts/hardening-smoke.mjs    # admin-only sync routes, failed-sign-in lockout, refresh-scores cooldown
node scripts/schedule-draft-smoke.mjs # scheduling at creation/after, edit/cancel, permissions, real auto-start
node scripts/auth-email-smoke.mjs    # confirmation gating, single-use links, reset + session invalidation, no address enumeration
node scripts/google-oauth-smoke.mjs  # PKCE/state on the way out, every callback refusal on the way back
node scripts/draft-queue-smoke.mjs   # queue privacy/validation, and an expired clock drafting from the queue
node scripts/commissioner-controls-smoke.mjs # pause/resume/extend/autodraft/undo, and that a manager can invoke none of them
```

`draft-queue-smoke.mjs` takes about 45 seconds: `pick_seconds` is clamped to a 30s minimum,
so it really does sit through a clock expiry rather than simulating one.

`google-oauth-smoke.mjs` covers both configurations: with no OAuth client it checks the
routes are absent, and with one (dummy values are enough) it checks the redirect and the
callback's guards. Consent at accounts.google.com can't be automated, so sign in through
the UI once to cover the happy path.

`draft-smoke.mjs` and `season-smoke.mjs` default to port 5174; pass
`http://localhost:5173` if that's where your dev server is.

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
npx wrangler secret put RESEND_API_KEY       # account email, optional; see "Accounts and rate limits"
npx wrangler secret put GOOGLE_CLIENT_SECRET # Google sign-in, optional
npm run deploy
```

Set `APP_URL` (your real origin) in `wrangler.jsonc` before deploying — the emailed links
and the OAuth redirect URI are both built from it. `GOOGLE_CLIENT_ID` goes there too (it's
not a secret; it travels in the redirect URL), and the OAuth client needs
`<APP_URL>/api/auth/google/callback` on its authorized redirect list, matching exactly.
`EMAIL_FROM` needs an address on a domain verified with Resend. Without `RESEND_API_KEY` the app still runs,
but confirmation and reset mail is dropped (with a warning in the logs) rather than stored
— so nobody new can create or join a league.

Then sign up on the deployed app and promote that account, so it can run the sync jobs:

```bash
npx wrangler d1 execute frc-fantasy-db --remote \
  --command "UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"
```

The cron trigger (every 10 minutes) refreshes the event list daily, pulls results for any
event happening that day, and rescores active leagues from cached data — no external calls
beyond TBA.

## Not built yet

- Changing your own email address or display name (there's no account settings page yet)
- Setting a password on an account created through Google (it can only sign in with Google)
- Trades and waivers
