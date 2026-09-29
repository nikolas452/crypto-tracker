# Crypto Tracker API

Backend project (API + background processes, no frontend) that polls cryptocurrency
prices from CoinGecko, stores history in MongoDB, and exposes a REST API to query
coins, history and stats. See `requerimientos/00-indice-y-convenciones.md` for the
full project index and conventions, `requerimientos/01-etapa-0-setup-base.md` for
Stage 0's requirements, `requerimientos/02-etapa-1-primer-job.md` for Stage 1's
requirements, `requerimientos/03-etapa-2-api-rest.md` for Stage 2's requirements,
`requerimientos/04-etapa-3-auth-firebase.md` for Stage 3's requirements,
`requerimientos/05-etapa-4-watchlists.md` for Stage 4's requirements, and
`requerimientos/06-etapa-5-alertas-email.md` for this stage's detailed requirements.

Stage 0 ("base setup") provided the base Express/TypeScript service: startup,
config validation, MongoDB connection, health checks, a single error format, and
graceful shutdown.

**Stage 1 ("primer job")** adds the project's first real background job: a second
process (`src/worker.ts`), separate from the API, that polls CoinGecko for prices
on a schedule (`node-cron`) and stores them as a MongoDB time-series collection,
with full execution tracking (`job_runs`) so the job's health is verifiable from
the database alone — no endpoints to read this data yet (that's Stage 2).

**Stage 2 ("api-rest")** opens that data over HTTP: `GET /api/v1/coins` (paginated
list with denormalized latest price), `GET /api/v1/coins/:coingeckoId` (detail),
`.../history` (raw or OHLC-bucketed price series with an optional SMA) and
`.../stats` (range statistics), plus `GET /api/v1/status` (public worker health)
and the provisional-admin-key-protected `GET /api/v1/admin/job-runs` /
`.../job-runs/:id`. It also adds a global rate limiter, per-endpoint HTTP caching,
and the `coins:rebuild-latest` / `backfill:history` maintenance scripts. See
"API endpoints (Stage 2)" below for the full contract.

**Stage 3 ("auth-firebase")** adds identity: Firebase Auth ID tokens verified
by the backend (`requireAuth`), an application `users` profile provisioned
just-in-time on first authenticated request, `GET`/`PATCH`/`DELETE /api/v1/me`,
role-based authorization (`requireRole`) replacing the provisional admin key on
`/api/v1/admin/*`, a per-uid rate limiter, and the development scripts needed
to obtain a token without a frontend (`auth:create-test-user`, `auth:token`,
`user:set-role`). See "API endpoints (Stage 2)" below (the `/me` and admin
sections) and "Firebase Auth: development scripts and the Auth emulator"
further down.

**Stage 4 ("watchlists")** adds the first data that belongs to a user: a
per-user watchlist of coins (`GET`/`POST /api/v1/me/watchlist`,
`PATCH`/`DELETE /api/v1/me/watchlist/:coingeckoId`), backed by a new
`watchlist_items` collection and the project's isolation rule (every query
scoped to the authenticated user, no endpoint ever accepts a client-supplied
`userId`). It also gives the admin real write power over the coin catalog
(`GET`/`POST /api/v1/admin/coins`, `PATCH /api/v1/admin/coins/:coingeckoId`),
extends `DELETE /api/v1/me` into a proper cascade that removes the user's
watchlist first, and makes `COINGECKO_API_KEY` required for the API process
too (previously only the worker/scripts needed it). See "API endpoints
(Stage 4 — watchlists)" below for the full contract.

**Stage 5 ("alertas-email")** closes the loop: the worker now acts on what it
collects instead of only recording it. A user defines a price or 24h-change
condition on a coin (`GET`/`POST /api/v1/me/alerts`,
`GET`/`PATCH`/`DELETE /api/v1/me/alerts/:id`), the worker evaluates every
`armed` alert as the final step of each `poll-prices` run, and a trigger
writes a `notifications` outbox row in the same transaction that flips the
alert. A second scheduled job (`send-notifications`) claims and sends those
notifications over SMTP with retry and backoff, so the price-collecting job
never talks to a mail server directly. Users read their own history at
`GET /api/v1/me/notifications`; admins get full diagnostic detail and two
extra operations at `GET /api/v1/admin/notifications`,
`POST /api/v1/admin/notifications/:id/retry` and
`POST /api/v1/admin/notifications/test-email`. This stage also makes MongoDB
run as a replica set — required for the multi-document transaction the
trigger uses — and routes all outgoing mail to a local Mailpit instance
instead of a production provider. See "API endpoints (Stage 5 — alerts &
notifications)" below for the full contract and "Known limitations" for the
trade-offs this stage accepts deliberately.

**Stage 6 ("agenda")** moves the schedule itself off the worker process's
memory and into MongoDB (`agenda_jobs`), using [Agenda](https://github.com/agenda/agenda)
6 instead of `node-cron`. This closes the three gaps Stage 1 explicitly
deferred: a manual `job:poll-prices` run can no longer collide with the
worker's (both now go through the same hand-built lease,
`src/lib/lease-lock.ts`), two workers coordinate through Agenda's own
per-document locking plus that lease instead of duplicating work, and a new
`GET`/`POST /api/v1/admin/jobs*` surface can list, trigger, disable and
enable any of the three jobs (`poll-prices`, `send-notifications`, and a new
daily `maintenance` job) from outside the worker process entirely. An
explicit retry policy gives `poll-prices` one delayed retry on a transient
CoinGecko failure; `GET /api/v1/status` now also reports the polling job's
`nextRunAt` and `disabled` flag. See "Background worker (Stage 6 — Agenda)"
and "API endpoints (Stage 6 — Agenda admin jobs)" below for the full
contract, and "Known limitations" for the divergences this stage found
against Agenda 6.2.6's actual (rather than documented) behavior.

## Requirements

- Node.js **24.x** (see `.node-version`). `engines.node` in `package.json` enforces
  `>=24 <25`.
- Docker (for a local MongoDB instance) or a MongoDB 8 instance reachable via URI.

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example environment file and adjust as needed:

   ```bash
   cp .env.example .env
   ```

   See the variable table below (all validated by `src/config/env.ts`).

3. Start MongoDB locally with Docker Compose:

   ```bash
   docker compose up -d
   ```

   This starts a single-node MongoDB 8 replica set (`rs0`) on `localhost:27017`
   — required from stage 5 onward, since transactions need a replica set — with
   data persisted in a named volume (`mongo_data`), plus a `mailpit` service for
   local email capture (see below). Point `MONGODB_URI` at
   `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`.

4. Run the API in development mode (auto-reload on file changes):

   ```bash
   npm run dev
   ```

   On success you should see an `API listening` log line. `GET http://localhost:3000/health`
   should respond with `{"status":"ok", ...}`.

## Environment variables

| Variable                      | Type                                    | Required                     | Default                                          | Rules                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------- | ---------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | `development` \| `test` \| `production` | No                           | `development`                                    | —                                                                                                                                                                                                                                                                                                                                              |
| `PORT`                        | integer                                 | No                           | `3000`                                           | 1–65535                                                                                                                                                                                                                                                                                                                                        |
| `MONGODB_URI`                 | string                                  | **Yes**                      | —                                                | Must start with `mongodb://` or `mongodb+srv://`                                                                                                                                                                                                                                                                                               |
| `MONGODB_DB_NAME`             | string                                  | No                           | `crypto_tracker`                                 | Non-empty                                                                                                                                                                                                                                                                                                                                      |
| `LOG_LEVEL`                   | pino level                              | No                           | `info`                                           | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent`                                                                                                                                                                                                                                                                                   |
| `SHUTDOWN_TIMEOUT_MS`         | integer                                 | No                           | `10000`                                          | >= 1000                                                                                                                                                                                                                                                                                                                                        |
| `COINGECKO_API_KEY`           | string                                  | **Yes**                      | —                                                | CoinGecko Demo plan key. Optional at the schema level (so `parseEnv` stays testable without it), but every entrypoint that can touch CoinGecko fails fast if it's missing: `worker.ts`, `seed:coins`, `job:poll-prices` and, since Stage 4, the API itself (`server.ts`) — its admin coin endpoints call CoinGecko to validate a `coingeckoId` |
| `COINGECKO_BASE_URL`          | string                                  | No                           | `https://api.coingecko.com/api/v3`               | Demo-key root, not `pro-api`                                                                                                                                                                                                                                                                                                                   |
| `COINGECKO_TIMEOUT_MS`        | integer                                 | No                           | `10000`                                          | Per-attempt HTTP timeout                                                                                                                                                                                                                                                                                                                       |
| `COINGECKO_MAX_RETRIES`       | integer                                 | No                           | `2`                                              | 0–5                                                                                                                                                                                                                                                                                                                                            |
| `COINGECKO_MAX_IDS_PER_CALL`  | integer                                 | No                           | `50`                                             | 1–250                                                                                                                                                                                                                                                                                                                                          |
| `COINGECKO_READINESS_ENABLED` | boolean                                 | No                           | `false`                                          | Adds an optional `coingecko` entry to `GET /health/ready`. Disabled by default: an upstream CoinGecko outage should never take the API out of a deploy platform's rotation, since the read endpoints never call CoinGecko                                                                                                                      |
| `POLL_PRICES_CRON`            | cron expression                         | No                           | `*/10 * * * *`                                   | Since Stage 6, registered through Agenda's `every()`, still evaluated in UTC; an invalid expression is reported by Agenda at registration (`nextRunAt: null`) rather than by `cron.validate()`, and the worker still fails fast on it                                                                                                        |
| `POLL_PRICES_RUN_ON_START`    | boolean                                 | No                           | `true`                                           | Enqueues one `poll-prices` job with `trigger: "startup"` when the worker boots — the lease still decides whether it actually runs                                                                                                                                                                                                             |
| `SNAPSHOT_RETENTION_DAYS`     | integer \| empty                        | No                           | `90`                                             | TTL for `price_snapshots`; empty = no expiration                                                                                                                                                                                                                                                                                               |
| `JOB_RUNS_RETENTION_DAYS`     | integer                                 | No                           | `30`                                             | TTL for `job_runs`                                                                                                                                                                                                                                                                                                                             |
| `STALE_RUN_THRESHOLD_MIN`     | integer                                 | No                           | `15`                                             | A `running` `JobRun` older than this is recovered as `failed`/`STALE` on worker startup                                                                                                                                                                                                                                                        |
| `WORKER_SHUTDOWN_TIMEOUT_MS`  | integer                                 | No                           | `30000`                                          | Max time the worker waits for an in-progress run to finish during shutdown                                                                                                                                                                                                                                                                     |
| `TRUST_PROXY`                 | integer                                 | No                           | `0` in `development`/`test`, `1` in `production` | Passed to Express's `app.set('trust proxy', ...)`; controls which hop the rate limiter trusts for the client IP when behind a reverse proxy                                                                                                                                                                                                    |
| `RATE_LIMIT_MAX`              | integer                                 | No                           | `300`                                            | Max requests per IP per `RATE_LIMIT_WINDOW_MIN` window, enforced on `/api` (not `/health`)                                                                                                                                                                                                                                                     |
| `RATE_LIMIT_WINDOW_MIN`       | integer                                 | No                           | `15`                                             | Rate-limit window length, in minutes                                                                                                                                                                                                                                                                                                           |
| `STALE_POLL_THRESHOLD_MIN`    | integer                                 | No                           | `30`                                             | `GET /api/v1/status` reports `pollPrices.stale: true` when no `success`/`partial` `poll-prices` run finished within this many minutes                                                                                                                                                                                                          |
| `FIREBASE_PROJECT_ID`         | string                                  | **Only without an emulator** | —                                                | Firebase project id. Required together with `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` unless `FIREBASE_AUTH_EMULATOR_HOST` is set (`assertFirebaseCredentials`)                                                                                                                                                                           |
| `FIREBASE_CLIENT_EMAIL`       | string                                  | **Only without an emulator** | —                                                | Service account client email, from the same JSON key as `FIREBASE_PRIVATE_KEY`                                                                                                                                                                                                                                                                 |
| `FIREBASE_PRIVATE_KEY`        | string (**secret**)                     | **Only without an emulator** | —                                                | Service account private key. Escaped `\n` sequences are normalized to real newlines at startup; never log or commit this value                                                                                                                                                                                                                 |
| `FIREBASE_WEB_API_KEY`        | string                                  | No                           | —                                                | Only used by the `auth:token` dev script to call the Identity Toolkit REST API; the API process itself never needs it. Optional when `FIREBASE_AUTH_EMULATOR_HOST` is set (the emulator ignores the key's value)                                                                                                                               |
| `FIREBASE_AUTH_EMULATOR_HOST` | string                                  | No (dev only)                | —                                                | e.g. `127.0.0.1:9099`. Points both `firebase-admin` and the dev scripts at the local Auth emulator instead of a real Firebase project. The process refuses to start if this is set while `NODE_ENV=production` (E3-13)                                                                                                                         |
| `USER_RATE_LIMIT_PER_MIN`     | integer                                 | No                           | `120`                                            | Per-`uid` request budget, enforced after `requireAuth` in addition to the global per-IP limiter                                                                                                                                                                                                                                                |
| `LAST_SEEN_THROTTLE_MIN`      | integer                                 | No                           | `5`                                              | Minimum age of `lastSeenAt` before an authenticated request refreshes it                                                                                                                                                                                                                                                                       |
| `WATCHLIST_MAX_ITEMS`         | integer                                 | No                           | `50`                                             | Per-user cap on `watchlist_items` (spec watchlist-store). Checked before insert, not atomically — see "The watchlist item cap" below                                                                                                                                                                                                           |
| `SMTP_HOST`                   | string                                  | **Only for the worker**      | —                                                | Optional at the schema level (same reason as `COINGECKO_API_KEY`), but the worker fails fast if missing, together with `MAIL_FROM` (`assertSmtpCredentials`) — the API process never sends mail, so it never requires it. `localhost` for local Mailpit                                                                                     |
| `SMTP_PORT`                   | integer                                 | No                           | `587`                                            | 1–65535. `1025` for local Mailpit                                                                                                                                                                                                                                                                                                                |
| `SMTP_USER`                   | string                                  | No                           | —                                                | Local Mailpit needs no authentication, so this stays empty in development                                                                                                                                                                                                                                                                       |
| `SMTP_PASS`                   | string (**secret**)                     | No                           | —                                                | Same as `SMTP_USER` — empty against local Mailpit                                                                                                                                                                                                                                                                                                |
| `MAIL_FROM`                   | string                                  | **Only for the worker**      | —                                                | Required together with `SMTP_HOST` in the worker (`assertSmtpCredentials`). Stays a documented placeholder value — never a real production sender, see "The Mailpit local workflow" below                                                                                                                                                    |
| `MAIL_DISPLAY_TIMEZONE`       | string                                  | No                           | `America/Argentina/Buenos_Aires`                 | IANA timezone shown in the email body alongside the UTC timestamp that's always included too                                                                                                                                                                                                                                                    |
| `MAIL_MAX_PER_MINUTE`         | integer                                 | No                           | `30`                                              | Caps how many notifications `send-notifications` sends per run; the rest wait for the next run                                                                                                                                                                                                                                                  |
| `ALERTS_MAX_ACTIVE`           | integer                                 | No                           | `20`                                              | Per-user cap on alerts in `armed`+`triggered` (spec alert-store); enforced on creation and on re-enabling a disabled alert                                                                                                                                                                                                                      |
| `SEND_NOTIFICATIONS_CRON`     | cron expression                         | No                           | `* * * * *`                                      | Same Agenda registration as `POLL_PRICES_CRON` since Stage 6; still UTC                                                                                                                                                                                                                                                                         |
| `NOTIFY_BATCH_SIZE`           | integer                                 | No                           | `20`                                              | Notifications claimed per `send-notifications` run                                                                                                                                                                                                                                                                                               |
| `NOTIFY_MAX_ATTEMPTS`         | integer                                 | No                           | `5`                                               | Attempts allowed before a transient failure becomes permanently `failed`                                                                                                                                                                                                                                                                         |
| `NOTIFY_LOCK_TIMEOUT_MIN`     | integer                                 | No                           | `10`                                              | Age after which a `sending` lock is considered stale and recovered by another run; also the bound on the at-least-once duplicate window — see "Known limitations" below                                                                                                                                                                        |
| `NOTIFICATIONS_RETENTION_DAYS`| integer                                 | No                           | `90`                                              | TTL for the `notifications` collection                                                                                                                                                                                                                                                                                                            |
| `SCHEDULER`                   | string                                  | No                           | `agenda`                                          | Documented future extension point; `"agenda"` is the only supported value today (`node-cron` was removed, not kept behind a switch)                                                                                                                                                                                                              |
| `AGENDA_PROCESS_EVERY`        | interval string or ms                   | No                           | `10 seconds`                                      | How often Agenda polls `agenda_jobs` for due work; introduces scheduling latency up to this value. **Never write a bare `"N milliseconds"` string here or anywhere Agenda parses an interval** — its `human-interval` dependency matches the `second` substring inside `milliseconds` and silently misreads it as `N` **seconds**; pass a plain millisecond number instead |
| `AGENDA_MAX_CONCURRENCY`      | integer                                 | No                           | `5`                                                | Max jobs Agenda processes concurrently in one worker process, across all job names                                                                                                                                                                                                                                                                |
| `AGENDA_ONE_OFF_RETENTION_DAYS`| integer                                | No                           | `7`                                                | Days a finished non-recurring `agenda_jobs` document (created by `agenda.now()`/`.schedule()`) is kept before the `maintenance` job prunes it                                                                                                                                                                                                    |
| `MAINTENANCE_CRON`            | cron expression                         | No                           | `15 3 * * *`                                      | Daily housekeeping job: recovers stale `job_runs`, prunes finished one-off `agenda_jobs` documents, and warns about recent notification failures and stale polling. UTC, via Agenda's `every()`                                                                                                                                                  |
| `POLL_LOCK_TTL_MS`            | integer                                 | No                           | `300000`                                          | TTL of the `poll-prices` lease (`src/lib/lease-lock.ts`); bounds how long a dead holder can block the resource                                                                                                                                                                                                                                    |
| `POLL_MAX_JOB_RETRIES`        | integer                                 | No                           | `1`                                                | Extra retries allowed after a transient `poll-prices` failure (`COINGECKO_UNAVAILABLE`, `COINGECKO_RATE_LIMITED`, `ALERT_EVALUATION_FAILED`) before giving up; `COINGECKO_AUTH`/`INTERNAL` are never retried, and a retry is suppressed when the next recurring run is under 3 minutes away                                                    |

`src/config/env.ts` is the **only** module allowed to read `process.env` (enforced
by an ESLint `no-restricted-properties` rule). Every other module imports the
validated, frozen `config` object from there. If a required variable is missing or
invalid, the process logs the invalid variable **names** (never their values) at
`fatal` and exits with code 1.

**`ADMIN_API_KEY` has been removed** (Stage 3, `auth-firebase`): the provisional
`X-Admin-Key` header is gone, along with the variable itself and the
`requireAdminKey` middleware. `/api/v1/admin/*` is now protected by
`requireAuth({ checkRevoked: true })` + `requireRole('admin')` — see "API
endpoints (Stage 2)" below.

## npm scripts

| Script                          | What it does                                                                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                   | API with auto-reload (`tsx watch src/server.ts`)                                                                                                                                                                       |
| `npm run dev:worker`            | Worker with auto-reload (`tsx watch src/worker.ts`)                                                                                                                                                                    |
| `npm run build`                 | Compiles `src/` to `dist/` with `tsc`                                                                                                                                                                                  |
| `npm start`                     | Runs the compiled API (`node dist/server.js`)                                                                                                                                                                          |
| `npm run start:worker`          | Runs the compiled worker (`node dist/worker.js`)                                                                                                                                                                       |
| `npm run typecheck`             | `tsc --noEmit`                                                                                                                                                                                                         |
| `npm run lint`                  | ESLint                                                                                                                                                                                                                 |
| `npm run format`                | Prettier (writes changes)                                                                                                                                                                                              |
| `npm test`                      | Runs the Vitest suite once                                                                                                                                                                                             |
| `npm run test:watch`            | Vitest in watch mode                                                                                                                                                                                                   |
| `npm run test:coverage`         | Vitest with coverage report                                                                                                                                                                                            |
| `npm run seed:coins`            | Upserts the tracked coin catalog from CoinGecko (Stage 1)                                                                                                                                                              |
| `npm run job:poll-prices`       | Runs the `poll-prices` job exactly once, outside the scheduler (Stage 1)                                                                                                                                               |
| `npm run coins:rebuild-latest`  | Recomputes `coins.latest` for every coin from its newest `price_snapshots` document; idempotent, safe to run any time (Stage 2)                                                                                        |
| `npm run backfill:history`      | Imports `price_snapshots` history for one coin from CoinGecko's `market_chart` endpoint: `npm run backfill:history -- <coingeckoId> --days <n>` (Stage 2, optional capability — see "Backfilling history" below)       |
| `npm run perf:coins-list`       | Seeds a local dataset and measures RNF-2.1 latency for `GET /api/v1/coins`, `.../history` and `.../stats` (Stage 2) — see "Performance (RNF-2.1)" below                                                                |
| `npm run auth:create-test-user` | Creates a Firebase user with a verified email; `-- --email <e> --password <p> [--admin]` also provisions and promotes its Mongo profile to `role: "admin"` (Stage 3). Refuses to run with `NODE_ENV=production`        |
| `npm run auth:token`            | Signs in with email/password against the Identity Toolkit REST API and prints **only** the ID token to stdout: `npm run auth:token -- --email <e> --password <p>` (Stage 3). Refuses to run with `NODE_ENV=production` |
| `npm run user:set-role`         | Finds a user by email and sets its Mongo `role`: `npm run user:set-role -- --email <e> --role <user\|admin>` (Stage 3). Prints the previous → new role, or an actionable error if the user has no profile yet          |
| `npm run perf:watchlist`        | Seeds one user with 50 watchlist items and measures RNF-4.1 latency for `GET /api/v1/me/watchlist` (Stage 4) — see "Performance (RNF-4.1)" below                                                                       |
| `npm run perf:alerts-evaluation`| Seeds 1,000 alerts across 10 coins (none triggering) and measures RNF-5.1 latency for `evaluateAlerts`, the alert-evaluation step inside `poll-prices` (Stage 5) — see "Performance (RNF-5.1)" below                    |

## Background worker (Stage 6 — Agenda)

The worker (`src/worker.ts`) is a **separate process** from the API. Since
Stage 6, its schedule lives in MongoDB (`agenda_jobs`, via
[Agenda](https://github.com/agenda/agenda) 6) instead of in the process's own
memory: it survives a restart, is visible from outside the worker (see "API
endpoints (Stage 6 — Agenda admin jobs)" below), and is safe with two workers
running at once. The worker is the only process that constructs Agenda with
`role: "worker"` — it defines all three jobs, registers them as recurring,
and calls `agenda.start()`; the API constructs it with `role: "producer"`
and never calls `start()`, so it can enqueue work but never execute it.

Three jobs are scheduled:

- **`poll-prices`** — polls CoinGecko for prices and stores them as a time
  series, then evaluates every `armed` alert against the coins that just
  updated (see "API endpoints (Stage 5 — alerts & notifications)" below).
  Guarded by a hand-built lease (`src/lib/lease-lock.ts`, `POLL_LOCK_TTL_MS`)
  in addition to Agenda's own per-name locking — Agenda's `lockLimit` bounds
  how many jobs **of the same name** one instance runs at once, but does
  nothing to stop a recurring document and a one-off one (or two workers)
  from running the same job concurrently, which is exactly the gap the lease
  closes. A held lease records `status: "skipped"`, `skipReason: "locked"`
  and makes no CoinGecko call.
- **`send-notifications`** — claims and sends any `pending` notification the
  evaluation step queued, over SMTP, with retry and backoff. `poll-prices`
  also triggers it immediately (fire-and-forget, via `agenda.now()`)
  whenever a run causes at least one alert to fire, instead of waiting for
  its own next tick. It deliberately has **no** lease: its atomic
  per-notification claim (`pending` → `sending` in one `findOneAndUpdate`)
  already guarantees each notification is sent once no matter how many
  copies of the job run, so a lease would only serialize work that is
  already safe to parallelize.
- **`maintenance`** (new in Stage 6) — a daily, low-priority job with four
  independent steps that never block each other: recovers `job_runs` still
  `running` past `STALE_RUN_THRESHOLD_MIN` (the same check the worker runs
  once at startup, now also run daily), prunes non-recurring `agenda_jobs`
  documents finished more than `AGENDA_ONE_OFF_RETENTION_DAYS` ago, and logs
  a `warn` for notifications that failed in the last 24 hours and for a
  stale `poll-prices` (same rule `GET /api/v1/status` uses). It is never
  retried — see "Known limitations" below for why.

It needs its own CoinGecko API key, valid SMTP settings and, before it has
anything to poll, a seeded coin catalog.

1. Get a free [CoinGecko Demo plan API key](https://www.coingecko.com/en/api/pricing)
   and set `COINGECKO_API_KEY` in your `.env`. Since Stage 4 (watchlists),
   the API process needs it too — its admin coin endpoints call CoinGecko;
   `worker.ts`, `seed:coins`, `job:poll-prices` and `server.ts` each fail
   fast if it's missing. Since Stage 5, the worker also fails fast if
   `SMTP_HOST`/`MAIL_FROM` are missing (`assertSmtpCredentials`) — set them
   to `localhost`/a placeholder address for local Mailpit (see "The Mailpit
   local workflow" below).
2. Seed the coin catalog (idempotent — safe to run again):

   ```bash
   npm run seed:coins
   # or with an explicit list:
   npm run seed:coins -- bitcoin,ethereum
   ```

3. Run the worker in development mode:

   ```bash
   npm run dev:worker
   ```

   On success you should see a startup log with `workerId` and both cron
   expressions (`pollPricesCron`, `sendNotificationsCron`), followed by one
   `poll-prices` run through the lease (`POLL_PRICES_RUN_ON_START` defaults
   to `true`) and then one run every `POLL_PRICES_CRON` interval (default:
   every 10 minutes, UTC) — up to `AGENDA_PROCESS_EVERY` (default 10s) of
   scheduling latency on top of that. `send-notifications` starts on its own
   schedule right away (`SEND_NOTIFICATIONS_CRON` default: every minute,
   UTC) — it simply finds nothing `pending` to claim until an alert actually
   triggers. `maintenance` runs once daily (`MAINTENANCE_CRON` default
   03:15 UTC).

4. To run the polling job once without the scheduler:

   ```bash
   npm run job:poll-prices
   ```

   Since Stage 6 this acquires the same lease the worker uses: if the worker
   is mid-tick, the script records `status: "skipped"`, `skipReason:
   "locked"` and exits 0 instead of racing it — the overlap limitation
   documented through Stage 5 no longer applies.

### CoinGecko quota

The Demo plan allows 100 calls/minute and **10,000 calls/month**. Estimate
monthly consumption with:

```
calls/month ≈ (60 / interval_min) × 24 × 31 × ceil(coins / 50)
```

With the defaults (10 coins, `POLL_PRICES_CRON` every 10 minutes), that's
≈ 4,464 calls/month from the scheduler alone — comfortably under the cap, but
leave headroom for `seed:coins` runs and manual `job:poll-prices` executions
when budgeting a shorter interval or a larger coin list.

**Since Stage 5, this quota is no longer the binding constraint on polling
frequency for this project.** The worker here is only ever started to test
or develop against, never run continuously in production, so it can't
realistically approach 10,000 calls/month regardless of interval. The
batching, retry caps and interval defaults documented above stay exactly as
they are — this is a relaxation of what limits polling frequency during
development, not a removal of the guidance itself; a deployment that did run
the worker continuously would still need to budget against the real quota
the same way.

## Running tests

```bash
npm test
```

- **Unit tests** (`tests/unit`): pure functions and modules with fake dependencies,
  no network and no real database.
- **Integration tests** (`tests/integration`): the real Express app (`createApp`)
  exercised with `supertest`, against an in-memory MongoDB
  (`mongodb-memory-server`). No real Mongo, no open TCP port, and no external
  network calls are needed — the in-memory Mongo binary is downloaded once and
  cached locally by `mongodb-memory-server`.

## Endpoints (Stage 0)

- `GET /health` — liveness. Never touches the database. `200 { status: "ok", uptimeSeconds, timestamp }`.
- `GET /health/ready` — readiness. Checks Mongo connectivity (with a 2s ping timeout).
  `200 { status: "ready", checks: { mongo: "up" }, timestamp }` or
  `503 { status: "not_ready", checks: { mongo: "down" }, timestamp }`. This is the
  only endpoint that does **not** use the project's global error format.

Every other error response uses the single global shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Descripción legible",
    "details": [{ "path": "query.limit", "message": "Debe ser <= 100" }],
    "requestId": "b3f1..."
  }
}
```

See `requests.http` for ready-to-run sample requests.

## API endpoints (Stage 2)

All Stage 2 endpoints are mounted under `/api/v1`, sit behind the global rate
limiter (see "Rate limiting" below), and validate every input with a strict Zod
schema — an unknown query parameter is always a `400 VALIDATION_ERROR`. Error
responses use the same global shape shown above. Every example below is also a
runnable request in `requests.http`.

### `GET /api/v1/coins`

Paginated list of active coins with their denormalized latest price.
`Cache-Control: public, max-age=60`.

| Param   | Type                                             | Default                                                       | Notes                                                                                |
| ------- | ------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `page`  | integer ≥ 1                                      | `1`                                                           |                                                                                      |
| `limit` | integer 1–100                                    | `20`                                                          |                                                                                      |
| `sort`  | `marketCap` \| `name` \| `symbol` \| `change24h` | `marketCap`                                                   |                                                                                      |
| `order` | `asc` \| `desc`                                  | `desc` for `marketCap`/`change24h`, `asc` for `name`/`symbol` |                                                                                      |
| `q`     | string, 1–50 chars                               | —                                                             | Case-insensitive, escaped prefix match on `name`/`symbol` (never treated as a regex) |

Coins that have never been polled (`latest: null`) always sort last, whatever `order` is.

```
GET /api/v1/coins?limit=2&sort=marketCap
```

```json
{
  "data": [
    {
      "coingeckoId": "bitcoin",
      "symbol": "btc",
      "name": "Bitcoin",
      "latest": {
        "priceUsd": 50000,
        "marketCapUsd": 950000000000,
        "volume24hUsd": 25000000000,
        "change24hPct": 1.23,
        "capturedAt": "2026-09-23T12:00:00.000Z"
      }
    },
    { "coingeckoId": "ethereum", "symbol": "eth", "name": "Ethereum", "latest": null }
  ],
  "meta": { "page": 1, "limit": 2, "total": 10, "totalPages": 5 }
}
```

### `GET /api/v1/coins/:coingeckoId`

Detail for one active coin. `404 NOT_FOUND` for an unknown or inactive id.
`Cache-Control: public, max-age=60`.

```json
{
  "data": {
    "coingeckoId": "bitcoin",
    "symbol": "btc",
    "name": "Bitcoin",
    "latest": {
      "priceUsd": 50000,
      "marketCapUsd": 950000000000,
      "volume24hUsd": 25000000000,
      "change24hPct": 1.23,
      "capturedAt": "2026-09-23T12:00:00.000Z"
    },
    "trackedSince": "2026-01-01T00:00:00.000Z"
  }
}
```

### `GET /api/v1/coins/:coingeckoId/history`

Price history, raw points or OHLC candles. `404 NOT_FOUND` for an unknown or
inactive coin. `Cache-Control: public, max-age=60`.

| Param         | Type                                 | Default                                                                  | Notes                                                                                                                                                                                                  |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `from` / `to` | ISO-8601 with an explicit offset/`Z` | `to`: now; `from`: `to` − 7 days                                         | `from` must be strictly before `to`; `to` at most 5 minutes in the future                                                                                                                              |
| `interval`    | `raw` \| `1h` \| `1d`                | auto-selected from the range (`raw` ≤ 2 days, `1h` ≤ 30 days, else `1d`) | Each interval caps its max range (`raw`: 7 days, `1h`: 90 days, `1d`: 365 days); exceeding it is a 400 naming the next coarser interval. `raw` additionally refuses (400) a response over 2,000 points |
| `sma`         | integer 2–200                        | —                                                                        | Simple moving average over each bucket's `close`; only valid with `interval=1h`/`1d`. The first `sma - 1` buckets get `sma: null` (warm-up, never a partial average)                                   |

Raw:

```
GET /api/v1/coins/bitcoin/history?interval=raw&from=2026-09-22T00:00:00Z&to=2026-09-22T01:00:00Z
```

```json
{
  "data": {
    "coingeckoId": "bitcoin",
    "interval": "raw",
    "from": "2026-09-22T00:00:00.000Z",
    "to": "2026-09-22T01:00:00.000Z",
    "points": [
      {
        "t": "2026-09-22T00:00:00.000Z",
        "priceUsd": 49800,
        "marketCapUsd": 945000000000,
        "volume24hUsd": 24000000000,
        "change24hPct": 0.9
      }
    ]
  }
}
```

Bucketed, with `sma`:

```
GET /api/v1/coins/bitcoin/history?interval=1h&from=2026-08-24T00:00:00Z&to=2026-09-23T00:00:00Z&sma=3
```

```json
{
  "data": {
    "coingeckoId": "bitcoin",
    "interval": "1h",
    "from": "2026-08-24T00:00:00.000Z",
    "to": "2026-09-23T00:00:00.000Z",
    "points": [
      {
        "t": "2026-08-24T00:00:00.000Z",
        "open": 49500,
        "high": 49600,
        "low": 49400,
        "close": 49550,
        "avg": 49512.5,
        "samples": 6,
        "sma": null
      },
      {
        "t": "2026-08-24T01:00:00.000Z",
        "open": 49550,
        "high": 49700,
        "low": 49500,
        "close": 49650,
        "avg": 49590,
        "samples": 6,
        "sma": null
      },
      {
        "t": "2026-08-24T02:00:00.000Z",
        "open": 49650,
        "high": 49750,
        "low": 49600,
        "close": 49700,
        "avg": 49680,
        "samples": 6,
        "sma": 49633.33
      }
    ]
  }
}
```

A bucket with no samples in it is simply absent from `points` — history is never gap-filled.

### `GET /api/v1/coins/:coingeckoId/stats`

Range statistics over `price_snapshots`. `404 NOT_FOUND` for an unknown or
inactive coin. `Cache-Control: public, max-age=60`.

| Param   | Type                            | Default | Notes                                              |
| ------- | ------------------------------- | ------- | -------------------------------------------------- |
| `range` | `24h` \| `7d` \| `30d` \| `90d` | `24h`   | `from`/`to` are derived from `range`, ending "now" |

```
GET /api/v1/coins/bitcoin/stats?range=7d
```

```json
{
  "data": {
    "coingeckoId": "bitcoin",
    "range": "7d",
    "from": "2026-09-16T12:00:00.000Z",
    "to": "2026-09-23T12:00:00.000Z",
    "open": 48000,
    "close": 50000,
    "changePct": 4.1667,
    "min": 47500,
    "max": 50500,
    "avg": 48900.25,
    "samples": 1008,
    "firstAt": "2026-09-16T12:00:00.000Z",
    "lastAt": "2026-09-23T11:50:00.000Z"
  }
}
```

`changePct` is `(close - open) / open × 100`, rounded to 4 decimals. An empty
range (no snapshots) returns `samples: 0` with every other field `null` —
never an error.

### `GET /api/v1/status`

Public, uncached summary of the `poll-prices` worker's health. No admin key
required. `Cache-Control: no-store`.

```json
{
  "data": {
    "activeCoins": 10,
    "pollPrices": {
      "lastSuccessAt": "2026-09-23T11:50:00.000Z",
      "lastRunAt": "2026-09-23T11:50:00.000Z",
      "lastRunStatus": "success",
      "stale": false,
      "nextRunAt": "2026-09-23T12:00:00.000Z",
      "disabled": false
    }
  }
}
```

`pollPrices.stale` is `true` when no `success`/`partial` run finished within
`STALE_POLL_THRESHOLD_MIN` minutes, including the case where no run has ever
completed. `nextRunAt` and `disabled` (Stage 6) read the recurring `poll-prices`
document in `agenda_jobs`; `nextRunAt` is `null` until a worker has registered
the job at least once. The response deliberately never includes an error
message, code or worker id — only whether the worker is alive.

### `GET`, `PATCH`, `DELETE /api/v1/me`

The authenticated user's own profile (spec me-endpoints). Requires
`Authorization: Bearer <Firebase ID token>`; `DELETE` additionally checks
token revocation (`checkRevoked: true`).

**Documented limitation — `checkRevoked` is off by default:** `GET`/`PATCH
/api/v1/me` (and every other route that doesn't explicitly pass
`checkRevoked: true`) verify the token's signature but do **not** call
Firebase to check whether it has been revoked. `verifyIdToken` without that
check is a local, no-network-round-trip operation; adding one on every
request would trade a rare worst case for a cost paid by every read. The
consequence: a user disabled or deleted in Firebase keeps ordinary access to
these routes until their existing ID token naturally expires (at most one
hour). Only the operations that can do real damage — `DELETE /api/v1/me` and
everything under `/api/v1/admin/*` — pass `checkRevoked: true` and take effect
immediately. See design.md's "Decisions" section for the full rationale.

- `GET /api/v1/me` — `{ data: { id, email, emailVerified, displayName, role, createdAt } }`.
- `PATCH /api/v1/me` — strict body `{ displayName?: string | null }`, with at
  least that field present. It's the only editable field: `email` and `role`
  are both rejected with `400 VALIDATION_ERROR`, same as any other unknown
  field.
- `DELETE /api/v1/me` — `204` with no body.

**`DELETE /api/v1/me` only removes this application's own data — it never
touches the underlying Firebase account.** The Firebase account keeps working
exactly as before, so if the same, still-valid ID token is used again for any
authenticated request afterwards, a brand-new, empty profile
(`role: "user"`, `displayName: null`) is silently re-provisioned for that
`firebaseUid` — the same just-in-time provisioning that creates a profile the
first time a given Firebase user is ever seen. This is a deliberate,
documented trade-off (see the Open Questions in `openspec/changes/auth-firebase/design.md`),
not an oversight: to actually stop that user from coming back, the
corresponding Firebase account has to be deleted separately (e.g. from the
Firebase console, or with `getAuth().deleteUser(uid)`), which this endpoint
does not do on its own.

### `GET /api/v1/admin/job-runs` and `GET /api/v1/admin/job-runs/:id`

Protected by `requireAuth({ checkRevoked: true })` + `requireRole('admin')`
(spec role-authorization) — every `/api/v1/admin/*` route requires
`Authorization: Bearer <Firebase ID token>` belonging to a Mongo profile with
`role: "admin"`. `Cache-Control: no-store`.

- **Missing or malformed token:** `401 UNAUTHENTICATED`.
- **Valid token, `role: "user"`:** `403 FORBIDDEN`.
- **Valid token, `role: "admin"`:** the request goes through.

There's no registration or promotion endpoint: the first admin has to be
created out-of-band with `npm run auth:create-test-user -- --email <e>
--password <p> --admin` (dev/emulator) or promoted with `npm run
user:set-role -- --email <e> --role admin` after that user has authenticated
at least once — see "Firebase Auth: development scripts and the Auth
emulator" below. The old `X-Admin-Key` header and `ADMIN_API_KEY` variable no
longer exist; a request that still sends `X-Admin-Key` and no token gets the
same `401 UNAUTHENTICATED` as any other unauthenticated request.

| Param (list only) | Type                 | Notes                                                               |
| ----------------- | -------------------- | ------------------------------------------------------------------- |
| `jobName`         | string               | Exact match, e.g. `poll-prices`                                     |
| `status`          | comma-separated      | One or more of `running`, `success`, `partial`, `failed`, `skipped` |
| `from` / `to`     | ISO-8601 with offset | Filters on `startedAt`                                              |
| `page` / `limit`  | integer              | `limit` capped at 100                                               |

```
GET /api/v1/admin/job-runs?status=success,partial&limit=2
X-Admin-Key: <your ADMIN_API_KEY>
```

```json
{
  "data": [
    {
      "id": "651f1c2e8b1e2a0012a3b456",
      "jobName": "poll-prices",
      "trigger": "schedule",
      "status": "success",
      "skipReason": null,
      "startedAt": "2026-09-23T11:50:00.000Z",
      "finishedAt": "2026-09-23T11:50:02.150Z",
      "durationMs": 2150,
      "stats": {
        "coinsRequested": 10,
        "coinsReturned": 10,
        "snapshotsInserted": 10,
        "skippedUnchanged": 0,
        "missingCoins": [],
        "upstreamAttempts": 1,
        "latestUpdated": 10
      },
      "error": null,
      "workerId": "worker-abc123"
    }
  ],
  "meta": { "page": 1, "limit": 2, "total": 1, "totalPages": 1 }
}
```

`GET /api/v1/admin/job-runs/:id` returns that same document shape at `data`
(not wrapped in `{ data, meta }`); `400 VALIDATION_ERROR` for a malformed id,
`404 NOT_FOUND` for an unknown one.

**Since Stage 6**, a `JobRun` document also carries `agendaJobId` (the Agenda
document that produced it, `null` for pre-Stage-6 history) and `attempt`
(`1`, or `2` for the retry policy's single retry). `trigger` gains `agenda`,
`retry` and `api` (`schedule` is kept only on runs recorded before this
stage); `skipReason` gains `locked`, recorded when the `poll-prices` lease
was held by another owner.

## API endpoints (Stage 6 — Agenda admin jobs)

Same guard as job-runs: `requireAuth({ checkRevoked: true })` +
`requireRole('admin')`, `Cache-Control: no-store`. Backed by Agenda's
**producer** instance — these endpoints enqueue or (des)habilitan work, they
never execute a job inside the request; a job enqueued while no worker is
running simply waits (see E6-14 in the test suite).

### `GET /api/v1/admin/jobs`

Lists the three recurring jobs with their schedule and last outcome.
`?includeOneOff=true` additionally lists one-off jobs (manual triggers,
retries, the alert-triggered `send-notifications` dispatch) from the last 24
hours.

```json
{
  "data": {
    "recurring": [
      {
        "name": "poll-prices",
        "schedule": "*/10 * * * *",
        "nextRunAt": "2026-09-23T12:00:00.000Z",
        "lastRunAt": "2026-09-23T11:50:00.000Z",
        "lastFinishedAt": "2026-09-23T11:50:02.150Z",
        "failCount": 0,
        "failReason": null,
        "failedAt": null,
        "lockedAt": null,
        "disabled": false,
        "lastJobRun": { "status": "success", "finishedAt": "2026-09-23T11:50:02.150Z" }
      }
    ]
  }
}
```

### `POST /api/v1/admin/jobs/:name/run`

Enqueues `name` (one of `poll-prices`, `send-notifications`, `maintenance`)
with `data: { trigger: "api", userId: <calling admin's id> }` and responds
**`202 Accepted`** — not `200`: the work has not happened yet, it will within
`AGENDA_PROCESS_EVERY` plus execution time, once a worker picks it up.

```json
{ "data": { "agendaJobId": "651f...", "name": "poll-prices", "queuedAt": "2026-09-23T11:59:58.000Z" } }
```

- An unknown `name` (not in the three above) → `404 NOT_FOUND`.
- A non-admin caller → `403 FORBIDDEN`.
- The job is currently disabled → `409 CONFLICT`.
- More than one trigger for the same job name within 30 seconds →
  `429 RATE_LIMITED` — a fixed per-job-name budget, protecting the CoinGecko
  quota from repeated manual triggers.

### `POST /api/v1/admin/jobs/:name/disable` and `POST /api/v1/admin/jobs/:name/enable`

`200 { "data": { "name": "poll-prices", "disabled": true } }`. A disabled job
does not execute even when its next scheduled run passes, and — this is the
non-obvious part — restarting the worker does **not** silently re-enable it:
the idempotent `every()` registration on startup checks the current
`disabled` flag first and restores it after re-registering the schedule.

## API endpoints (Stage 4 — watchlists)

All four watchlist routes require `Authorization: Bearer <Firebase ID token>`
(`requireAuth()`, no `checkRevoked`) and share the per-uid rate limiter.
`Cache-Control: private, no-cache` is set on the whole `/api/v1/me/watchlist`
prefix — the response belongs to one user and must never end up in a shared
cache.

### `GET /api/v1/me/watchlist`

Every item the authenticated user follows, joined with its coin's current
`latest` projection via a `$match`/`$lookup`/`$unwind`/`$sort` aggregation.

| Param   | Type                                              | Default                                                        | Notes |
| ------- | ------------------------------------------------- | -------------------------------------------------------------- | ----- |
| `sort`  | `addedAt` \| `name` \| `change24h` \| `marketCap` | `addedAt`                                                      |       |
| `order` | `asc` \| `desc`                                   | `desc` for `addedAt`/`change24h`/`marketCap`, `asc` for `name` |       |

```json
{
  "data": [
    {
      "coingeckoId": "bitcoin",
      "symbol": "btc",
      "name": "Bitcoin",
      "isActive": true,
      "note": "largo plazo",
      "addedAt": "2026-09-16T21:00:00.000Z",
      "latest": {
        "priceUsd": 64210.12,
        "marketCapUsd": 1265000000000,
        "volume24hUsd": 25000000000,
        "change24hPct": -1.23,
        "capturedAt": "2026-09-23T12:00:00.000Z"
      }
    }
  ],
  "meta": { "count": 1, "max": 50 }
}
```

No item ever carries `userId`, `_id` or `__v` (RNF-4.3): a watchlist item is
identified by its `coingeckoId` within the caller's own list. A coin the
admin later deactivates stays listed with `isActive: false` and its last
known `latest` — the polling job simply stops advancing it (see `PATCH
/api/v1/admin/coins/:coingeckoId` below).

**The listing is deliberately unpaginated.** There is no `page`/`limit`
query parameter, and every matching item is returned in one response. This
is safe _only_ because `WATCHLIST_MAX_ITEMS` bounds the result size — if
that cap were ever raised substantially, pagination would have to be
reintroduced alongside it. `meta.max` always echoes the configured cap so a
client can tell how close a user is to it.

### `POST /api/v1/me/watchlist`

Strict body `{ coingeckoId: string, note?: string | null }`. Validations run
in this **fixed order**, never reordered:

1. Body shape → `400 VALIDATION_ERROR`.
2. The coin exists and is active → `404 NOT_FOUND` otherwise (an inactive or
   unknown coin looks identical from the outside on purpose).
3. Current item count is below `WATCHLIST_MAX_ITEMS` → `422 UNPROCESSABLE`
   with `details: { reason: "LIMIT_REACHED" }` otherwise.
4. Insertion. A duplicate `{ userId, coinId }` (`E11000` from the unique
   index) becomes `409 CONFLICT`.

On success: `201` with the item in the same shape `GET` uses, plus a
`Location: /api/v1/me/watchlist/<coingeckoId>` header.

**The watchlist item cap is checked non-atomically.** Step 3 counts, then
step 4 inserts — two separate round trips. Two concurrent `POST` requests
from the same user can both read the count below the cap and both insert,
leaving the user with `WATCHLIST_MAX_ITEMS + 1` items. This is an accepted,
documented limitation (design.md), not a bug: the overshoot is bounded by
the number of truly simultaneous requests, self-corrects the moment the user
removes anything, and has no consequence beyond a slightly longer list. The
strictly atomic alternative — a counter on the `users` document updated with
a conditional `$inc` — was considered and rejected for now because it adds a
second source of truth for the item count and a reconciliation problem of
its own; see design.md's Open Questions if that trade-off ever needs
revisiting.

### `PATCH /api/v1/me/watchlist/:coingeckoId`

Strict body `{ note: string | null }` (required — an empty body is
`400 VALIDATION_ERROR`, unlike `POST` where `note` is optional). Resolves the
coin by `coingeckoId` **whether it is active or not** — editing the note of a
coin you already follow costs nothing and shouldn't be blocked just because
an admin later deactivated it. `404 NOT_FOUND` when the caller doesn't
follow that coin at all.

### `DELETE /api/v1/me/watchlist/:coingeckoId`

Always `204`, even when the item didn't exist or the `coingeckoId` matches no
coin at all — `DELETE` is idempotent by definition, and the postcondition
("this coin is not in your watchlist") already holds either way. Only a
`coingeckoId` that fails the id pattern is `400 VALIDATION_ERROR`.

### Coin id normalization

Both `PATCH` and `DELETE` lowercase their `:coingeckoId` path parameter
_before_ validating it against the pattern, so `/watchlist/Bitcoin` resolves
exactly like `/watchlist/bitcoin`. `POST`'s body `coingeckoId` is **not**
normalized this way — an uppercase value simply matches no stored coin
(always lowercase) and resolves to the same `404` as an unknown id.

### Isolation between users (RF-4.5 / spec user-data-isolation)

Every watchlist query is scoped by the authenticated user's `_id`; no route
in this module ever reads a `userId` from a request body, query string or
path parameter (a client-supplied `userId` field is simply rejected by the
strict body schema, same as any other unknown field). Every watchlist
service function takes `userId` as an explicit first parameter rather than
reading it from ambient request state — a service that forgot to scope its
query would have an unused argument sitting right there, not silent ambient
state.

### `GET /api/v1/admin/coins`, `POST /api/v1/admin/coins` and `PATCH /api/v1/admin/coins/:coingeckoId`

Same admin guard as `/api/v1/admin/job-runs` above
(`requireAuth({ checkRevoked: true })` + `requireRole('admin')`,
`Cache-Control: no-store`).

- **`GET`** — paginated (`page`/`limit`, same shape as `GET /api/v1/coins`),
  includes **inactive** coins (unlike the public read API), takes an optional
  `isActive=true|false` filter, and each entry carries `watchersCount` — how
  many `watchlist_items` reference it, computed with a `$group` restricted to
  the coins on the current page only (never the whole catalog).
- **`POST`** — strict body `{ coingeckoId }`. Validates against CoinGecko
  with `getMarkets([id])` **before writing anything**: an id CoinGecko
  doesn't recognize is `422` with `details: { reason: "UNKNOWN_COINGECKO_ID" }`,
  and a failed CoinGecko call itself is `502 UPSTREAM_ERROR`. If the coin
  doesn't exist yet, it's created active (`201`); if it exists but is
  inactive, it's reactivated (`200`); if it's already active, `409
CONFLICT`. Both create and reactivate refresh `name`/`symbol` from
  CoinGecko. **Each successful call consumes one CoinGecko API call** against
  the monthly quota — see "CoinGecko quota" above.
- **`PATCH`** — strict body `{ isActive: boolean }`, `200` with the coin and
  its `watchersCount` (so the admin can see how many users are affected by a
  deactivation before/after doing it). Deactivating a coin makes the next
  `poll-prices` run skip it (it only queries `findActive()`), while its
  `price_snapshots` history and any `watchlist_items` referencing it are left
  untouched.

Every admin coin create, reactivate and activation-toggle is logged at
`info`, naming the acting admin's `userId`.

**There is no `DELETE` for coins, on purpose.** Deleting a coin document
would orphan every `watchlist_items` row referencing it and strand its
`price_snapshots` history in a time series nothing points at anymore. Soft
deactivation (`PATCH { isActive: false }`) keeps the history queryable and
every reference valid, and it's fully reversible: `POST` with an existing
inactive id reactivates it. A `DELETE` request against an admin coin path
simply falls through to the global `404` handler — no such route is
registered.

### Account deletion cascade

`DELETE /api/v1/me` (see above) now delegates to
`usersService.deleteAccount(userId)`, which deletes the user's
`watchlist_items` **before** the `users` document itself — never the other
way around, so an interruption mid-delete can never leave orphaned items
whose owner no longer exists. The cascade is safe to re-run: both deletes are
plain `deleteMany`/`deleteOne` calls, which are no-ops (not errors) against
documents that are already gone. `usersService` never queries
`watchlist_items` directly — it calls the watchlist module's own deletion
function, so a later stage (alerts, notifications) extends the cascade by
adding one more call, never by learning another module's schema.

### Rate limiting

The global limiter (`src/middlewares/rateLimiter.ts`) is mounted on `/api`
only — `/health` and `/health/ready` are deliberately exempt, so a deployment
platform polling readiness never fails its own health check because of
application traffic. A rejection is `429` in the project's global error
format, `error.code: "RATE_LIMITED"`.

It uses `express-rate-limit`'s default `MemoryStore`, which is scoped to a
single Node process. Running more than one API instance behind a load
balancer would give **each instance its own independent budget** instead of a
shared one — e.g. two instances each configured with `RATE_LIMIT_MAX=300`
would together allow up to 600 requests per window, not 300, without either
instance ever knowing. This project runs a single API instance for now; a
shared store (`rate-limit-redis`, backed by the Redis instance the
`bullmq-redis` stage introduces) is the documented fix once there's more than
one instance to coordinate.

### RNF-2.2 — no collection scans, verified with `explain()`

`tests/integration/coinsApi.test.ts`'s `RNF-2.2: the default list query plan
uses IXSCAN, not COLLSCAN` test runs

```ts
CoinModel.find({ isActive: true })
  .select({ coingeckoId: 1, symbol: 1, name: 1, latest: 1, _id: 0 })
  .sort({ 'latest.marketCapUsd': -1 })
  .limit(20)
  .explain('executionStats');
```

— the exact shape of `GET /api/v1/coins`'s default query — and asserts the
winning plan's stages contain `IXSCAN` and never `COLLSCAN`. Running that same
query locally (`mongodb-memory-server`, MongoDB 8) against a seeded coin
produces this winning plan:

```
LIMIT (limitAmount: 20)
└─ PROJECTION_SIMPLE
   └─ FETCH
      └─ IXSCAN
         indexName:  "isActive_1_latest.marketCapUsd_-1"
         keyPattern: { isActive: 1, "latest.marketCapUsd": -1 }
         direction:  forward
```

The compound index `{ isActive: 1, 'latest.marketCapUsd': -1 }` (defined in
`coins.model.ts`) serves both the `isActive: true` filter and the `-1` sort in
a single pass — there is no separate `SORT` stage and no `COLLSCAN` anywhere
in the plan. The list endpoint's other three query shapes (`sort=name`,
`sort=symbol`, `sort=change24h`, and the `q` prefix search) are each served
the same way by one of the catalog's other three compound indexes
(`{ isActive: 1, nameLower: 1 }`, `{ isActive: 1, symbol: 1 }`,
`{ isActive: 1, 'latest.change24hPct': -1 }`).

### Performance (RNF-2.1)

`npm run perf:coins-list` seeds a dataset shaped like RNF-2.1's own numbers —
**10 coins, 90 days of history every 10 minutes (≈ 12,960 points/coin,
matching the spec's "≈ 13.000 puntos por moneda")** — into a throwaway
`mongodb-memory-server` instance, then measures p50/p95/p99 latency for the
three endpoints RNF-2.1 sets a budget for, using `supertest` against the real
`createApp()` (no separate server process, no new dependency — see the
script's own doc comment for why this was chosen over `autocannon`, which
isn't an existing dependency here).

Measured locally (Windows, Node 22, MongoDB 8 via `mongodb-memory-server`):

| Endpoint                                 | RNF-2.1 target (p95) | Measured p50 | Measured p95 | Measured p99 | Result   |
| ---------------------------------------- | -------------------- | ------------ | ------------ | ------------ | -------- |
| `GET /api/v1/coins`                      | < 50 ms              | 3.90 ms      | 4.56 ms      | 5.27 ms      | **PASS** |
| `GET /.../history?interval=1h` (30 days) | < 200 ms             | 18.08 ms     | 20.96 ms     | 23.80 ms     | **PASS** |
| `GET /.../stats?range=90d`               | < 200 ms             | 7.77 ms      | 8.71 ms      | 9.94 ms      | **PASS** |

All three endpoints pass RNF-2.1 with wide headroom at this catalog/history
size — expected, since each is served by a single index (list) or a single
aggregation pipeline over an indexed time-series range (history/stats), never
an in-Node scan. Re-run `npm run perf:coins-list` to reproduce; numbers vary
with hardware.

### Performance (RNF-4.1)

`npm run perf:watchlist` (tarea 8.4) seeds one user with `WATCHLIST_MAX_ITEMS`
(50) watchlist items, each joined to its own active coin with a populated
`latest`, then measures p50/p95/p99 latency for `GET /api/v1/me/watchlist` —
the only endpoint RNF-4.1 sets a budget for. Same approach as
`perf:coins-list`: `mongodb-memory-server` + `supertest` in the same process.

Measured locally (Windows, Node 22, MongoDB 8 via `mongodb-memory-server`):

| Endpoint                              | RNF-4.1 target (p95) | Measured p50 | Measured p95 | Measured p99 | Result   |
| ------------------------------------- | -------------------- | ------------ | ------------ | ------------ | -------- |
| `GET /api/v1/me/watchlist` (50 items) | < 50 ms              | 10.35 ms     | 12.47 ms     | 15.04 ms     | **PASS** |

Comfortably under budget — the aggregation matches on the indexed `userId`
prefix of `{ userId: 1, addedAt: -1 }` and `$lookup`s at most 50 documents by
`coins._id`, the primary key (see "RNF-4.2" below). Re-run `npm run
perf:watchlist` to reproduce; numbers vary with hardware.

### RNF-4.2 — the watchlist listing query uses an index, never a collection scan

`tests/integration/watchlistApi.test.ts`'s `RNF-4.2: the listing aggregation
uses an IXSCAN on { userId: 1, addedAt: -1 }, never a COLLSCAN` test runs the
exact `$match`/`$lookup`/`$unwind`/`$sort` aggregation `GET
/api/v1/me/watchlist` uses (with the default `sort=addedAt`) through
`.explain('executionStats')` and asserts the plan contains `IXSCAN` on the
`userId_1_addedAt_-1` index and never a `COLLSCAN`. The `{ userId: 1,
addedAt: -1 }` compound index (defined in `watchlist.model.ts`) serves the
`$match: { userId }` stage that opens the pipeline, so the join and sort that
follow only ever run over one user's own (at most `WATCHLIST_MAX_ITEMS`)
documents.

### Backfilling history (optional, RF-2.11)

`npm run backfill:history -- <coingeckoId> --days <n>` imports historical
points for one coin from CoinGecko's `GET /coins/{id}/market_chart`, which the
Demo/Public plan does expose — confirmed against CoinGecko's live API
documentation (task 11.3) and recorded next to the client call in
`src/integrations/coingecko/coingecko.client.ts`. That endpoint takes no
`interval` param on the Demo plan (an explicit `interval` is Pro-plan-only);
granularity is chosen automatically from `days`: **≤ 1 day → ~5-minutely,
2–90 days → hourly, > 90 days → daily**.

A point whose exact upstream timestamp already exists for that coin is
**skipped**, never deleted-and-replaced — deleting would discard a
genuinely-polled point in favour of a lower-resolution imported one
(design.md's chosen overlap rule). The script prints how many points were
imported vs. skipped, and prompts for confirmation before running (`--yes`/
`--force` to skip the prompt) since it consumes one call from CoinGecko's
monthly quota per invocation.

## API endpoints (Stage 5 — alerts & notifications)

All five `/api/v1/me/alerts` routes and `GET /api/v1/me/notifications` require
`Authorization: Bearer <Firebase ID token>` (`requireAuth()`, no
`checkRevoked`) and share the per-uid rate limiter. `Cache-Control: private,
no-cache` is set on both prefixes, same as the watchlist routes — these
responses belong to one user and must never end up in a shared cache. The
three `/api/v1/admin/notifications` routes share the same admin guard as
`/api/v1/admin/job-runs` and `/api/v1/admin/coins`
(`requireAuth({ checkRevoked: true })` + `requireRole('admin')`,
`Cache-Control: no-store`).

### `GET /api/v1/me/alerts`

Every alert the authenticated user owns, paginated and ordered by `createdAt`
descending, each carrying its coin's identity and current `latest` values.

| Param         | Type            | Default | Notes                                              |
| ------------- | --------------- | ------- | --------------------------------------------------- |
| `status`      | comma-separated | —       | One or more of `armed`, `triggered`, `completed`, `disabled` |
| `coingeckoId` | string          | —       | Filters to one coin                                |
| `page`        | integer ≥ 1     | `1`     |                                                     |
| `limit`       | integer 1–100   | `20`    |                                                     |

```json
{
  "data": [
    {
      "id": "651f1c2e8b1e2a0012a3b789",
      "coingeckoId": "bitcoin",
      "type": "PRICE_BELOW",
      "threshold": 50000,
      "mode": "recurring",
      "status": "armed",
      "cooldownMinutes": 60,
      "rearmPct": 1,
      "note": "largo plazo",
      "version": 0,
      "triggerCount": 0,
      "lastTriggeredAt": null,
      "lastTriggeredValue": null,
      "lastEvaluatedAt": null,
      "createdAt": "2026-09-23T12:00:00.000Z",
      "updatedAt": "2026-09-23T12:00:00.000Z",
      "coin": {
        "symbol": "btc",
        "name": "Bitcoin",
        "isActive": true,
        "latest": { "priceUsd": 64210.12, "change24hPct": -1.23 }
      }
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

### `POST /api/v1/me/alerts`

Strict body `{ coingeckoId, type, threshold, mode?, cooldownMinutes?, rearmPct?, note? }`.
`type` is one of `PRICE_ABOVE`, `PRICE_BELOW` or `CHANGE_24H_ABS_GTE`, and the
valid range of `threshold` depends on it: `PRICE_ABOVE`/`PRICE_BELOW` accept
any value `> 0` and `<= 1e9`; `CHANGE_24H_ABS_GTE` accepts `0.1`–`100`
(percentage points). `mode` defaults to `recurring` (the alternative,
`once`, is accepted by the schema but evaluation still treats every alert
the same way — see `alert-evaluation`'s spec for the exact rearm/cooldown
rules that apply regardless of `mode`). Validations run in this **fixed
order**, never reordered:

1. Body shape → `400 VALIDATION_ERROR`.
2. The caller has a verified email → `422 UNPROCESSABLE` with
   `details.reason: "EMAIL_NOT_VERIFIED"` otherwise — the recipient is
   always the account's own verified email, never a client-supplied
   address.
3. The coin exists and is active → `404 NOT_FOUND` otherwise.
4. The caller's active-alert count (`armed` + `triggered`) is below
   `ALERTS_MAX_ACTIVE` → `422 UNPROCESSABLE` with
   `details.reason: "LIMIT_REACHED"` otherwise.

On success: `201` with the alert in the same shape `GET` uses, plus a
`Location: /api/v1/me/alerts/<id>` header and a `meta` block reporting the
coin's current value and whether the condition is already met:

```json
{
  "data": { "id": "651f1c2e8b1e2a0012a3b789", "coingeckoId": "bitcoin", "type": "PRICE_BELOW", "threshold": 70000, "status": "armed", "...": "..." },
  "meta": { "currentValue": 64210.12, "conditionCurrentlyMet": true }
}
```

**The alert is never evaluated during the creation request itself** — it is
always created `armed`, even when `meta.conditionCurrentlyMet` is `true`. It
fires on the next `poll-prices` run that evaluates it, same as any other
alert.

### `GET /api/v1/me/alerts/:id`

`400 VALIDATION_ERROR` when `id` is not a valid ObjectId; `404 NOT_FOUND`
both when the alert doesn't exist and when it belongs to another user — the
response never reveals which case it is, same rule the watchlist and
job-runs endpoints already follow.

### `PATCH /api/v1/me/alerts/:id`

Strict body `{ threshold?, cooldownMinutes?, rearmPct?, note?, mode?, enabled? }`
with at least one field present. `type` is **not** a key of this schema at
all — `.strict()` already rejects a body that includes it with
`400 VALIDATION_ERROR`, the same mechanism `POST /api/v1/me/watchlist/:coingeckoId`
uses to keep `coingeckoId` out of its own body.

- **`enabled: false`** moves the alert to `disabled`, whatever its current
  status.
- **`enabled: true`** from `disabled` or `completed` moves it to `armed`
  and counts toward `ALERTS_MAX_ACTIVE` — `422 UNPROCESSABLE` with
  `details.reason: "LIMIT_REACHED"` if the caller is already at the cap.
- **Changing `threshold` on a `triggered` alert re-arms it**: its status
  becomes `armed` again, while `lastTriggeredAt` and `triggerCount` keep
  their previous values — the alert's trigger history isn't reset just
  because the condition that will fire it next changed.
- Every modification is an `updateOne({ _id, userId }, { $set: ..., $inc: { version: 1 } })`,
  so an evaluation run holding the alert's previous `version` fails to match
  and simply re-reads it on the next tick (see "Optimistic concurrency" in
  `design.md`).

`404 NOT_FOUND` for another user's alert or an unknown id, same rule as `GET`.

### `DELETE /api/v1/me/alerts/:id`

Deletes the alert and moves any of its `pending` notifications to
`cancelled`, leaving one already `sending` to finish — deleting the alert
mid-send doesn't yank back an email that's already in flight. Always `204`,
including when the alert doesn't exist or belongs to another user, in which
case nothing is deleted (same idempotent-`DELETE` rule as the watchlist).

### `GET /api/v1/me/notifications`

The authenticated user's own notification history.

| Param    | Type                                                | Default | Notes |
| -------- | ---------------------------------------------------- | ------- | ----- |
| `status` | `pending`\|`sending`\|`sent`\|`failed`\|`cancelled`   | —       | Single value, unlike `alerts`' comma-separated `status` |
| `page`   | integer ≥ 1                                          | `1`     |       |
| `limit`  | integer 1–100                                        | `20`    |       |

```json
{
  "data": [
    {
      "id": "651f1c2e8b1e2a0012a3b900",
      "alertId": "651f1c2e8b1e2a0012a3b789",
      "status": "failed",
      "to": "ni***@gmail.com",
      "payload": {
        "coingeckoId": "bitcoin",
        "coinName": "Bitcoin",
        "symbol": "btc",
        "alertType": "PRICE_BELOW",
        "threshold": 70000,
        "value": 64210.12,
        "priceUsd": 64210.12,
        "change24hPct": -1.23,
        "triggeredAt": "2026-09-23T12:10:00.000Z",
        "note": "largo plazo"
      },
      "attempts": 5,
      "sentAt": null,
      "createdAt": "2026-09-23T12:10:00.000Z",
      "lastError": { "code": "SMTP_UNAVAILABLE" }
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`to` is always masked (never the full address); `lockedBy`, `dedupeKey` and
`lastError.message`/`.permanent` are never present — when a notification
failed, only `lastError.code` is shown. The full diagnostic detail exists
only in the admin listing below.

### `GET`, `POST /api/v1/admin/notifications/:id/retry`, `POST /api/v1/admin/notifications/test-email`

Admin-only (see the guard note above). `GET` accepts `status`, `userId`,
`from`/`to` and `page`/`limit`, and returns the **same** shape as the user
listing plus the full `lastError` object (`code`, `message`, `permanent`)
and `lockedBy` — the extra fields a user is never shown.

`POST /:id/retry` requeues a `failed` notification: `status: "pending"`,
`attempts: 0`, `nextAttemptAt: now`, `lastError: null`, done as one atomic
conditional `findOneAndUpdate` rather than a read-then-write. When that
match fails, a **second, distinct check decides the response**: an unknown
`id` is `404 NOT_FOUND`, while an id that exists but isn't `failed` (e.g.
already `sent`) is `409 CONFLICT` — the spec only defines `failed → pending`
as success and any other status as a conflict, so a missing document is
treated as "not found" rather than folded into that same 409.

`POST /test-email` sends a fixed test message immediately to the calling
admin's **own** email — never a client-supplied address — and creates **no**
`notifications` document at all: it bypasses the outbox entirely, so it's
useful for confirming SMTP connectivity without waiting on a real alert.
`200` with `{ data: { messageId } }` on success; `502 UPSTREAM_ERROR` with
the mailer's own error code (`SMTP_REJECTED`/`SMTP_UNAVAILABLE`) in
`details.reason` when the send itself fails.

### The replica-set requirement

Alert triggers need a real multi-document transaction (flipping the alert to
`triggered` and inserting its notification atomically), and MongoDB only
supports transactions against a replica set. **Both the API and the worker
verify replica-set support at startup and exit with code `1` and an
explanatory log line if it isn't satisfied** — this fails fast and legibly
at boot rather than obscurely on the first trigger. `docker compose up`
already gives you a working single-node set (see "Getting started" above);
if you're pointing at your own MongoDB instance instead, it needs to be
initialized as a replica set too.

### The Mailpit local workflow

Every email this project sends goes to **Mailpit**, a local SMTP sink
started by `docker compose up` — nothing ever reaches a real inbox. View
everything the worker has sent, including full HTML rendering, at
**http://localhost:8025**.

`MAIL_FROM` is a **documented placeholder**, never a real production sender
address, and choosing a production SMTP provider, registering a domain, and
configuring SPF/DKIM records are all explicitly **out of scope** for this
project. This isn't laziness: the project has to cost \$0 and its server is
only ever started to test, never run continuously — a production sender
would have nothing to send from and nothing to keep warm, and SPF/DKIM,
deliverability and spam behavior are properties of a domain and a paid
provider, not of this codebase. None of this stage's actual lesson —the
outbox, the transaction, the atomic claim, the backoff, the dedupe key—
depends on which SMTP server receives the mail, because the boundary is
plain SMTP either way; adopting a real provider later would be a
configuration change, not a redesign.

### Performance (RNF-5.1)

`npm run perf:alerts-evaluation` seeds 1,000 alerts spread across 10 coins,
built so none of them trigger, then measures how long `evaluateAlerts` (the
alert-evaluation step `poll-prices` runs after storing prices) takes over
that set — the one operation RNF-5.1 sets a budget for.

Measured locally (Windows, MongoDB 8 via `MongoMemoryReplSet`):

| Operation                                    | RNF-5.1 target | Measured | Result   |
| --------------------------------------------- | --------------- | -------- | -------- |
| `evaluateAlerts` (1,000 alerts, 10 coins, nothing triggers) | < 2000 ms       | 35.56 ms | **PASS** |

Comfortably under budget — the `{ coinId: 1, status: 1 }` index restricts the
evaluation cursor to alerts on coins that actually changed in this run, and
`decide()` itself is a pure in-memory function with no per-alert database
round trip. Re-run `npm run perf:alerts-evaluation` to reproduce; numbers
vary with hardware.

## Known limitations

The behaviors below are accepted, documented trade-offs (see each stage's
`design.md` "Risks / Trade-offs") rather than bugs:

- **Agenda 6.2.6's `stop()` does not release the lock of a job that is
  actually running — only ones queued locally but not yet started** (see
  `JobProcessor.stop()`: "Running jobs keep their database locks until they
  complete or the lock expires"). The worker's shutdown sequence still calls
  `agenda.drain(WORKER_SHUTDOWN_TIMEOUT_MS)` then `agenda.stop()` on a
  timeout, matching the source requirement's stated intent, but the literal
  recovery mechanism for a job still in flight when the process exits is
  always `lockLifetime` expiry (5 minutes for `poll-prices`/
  `send-notifications`, 15 for `maintenance`) plus the lease's own TTL —
  whether `stop()` was called or the process was killed outright makes no
  difference. This is documented here because it's a real divergence from
  what the wording of the requirement this stage implements suggests, found
  and confirmed by reading Agenda's source directly.
- **Never write a bare `"N milliseconds"` interval string anywhere Agenda
  parses one** (`AGENDA_PROCESS_EVERY`, `agenda.processEvery()`,
  `agenda.every()`'s interval argument). Agenda's `human-interval` dependency
  matches on the substring `second` and would read `"200 milliseconds"` as
  **200 seconds** — an easy, silent 1000x error found while writing this
  stage's own tests. Pass a plain millisecond number (`agenda.processEvery(200)`)
  instead; multi-unit strings like `"10 seconds"` are unaffected.
- **A rolling restart can briefly run the previous cron expression.**
  Because `every()`'s idempotent upsert means "whichever worker called it
  last defines the schedule," during a rolling deploy the last instance
  still running the old code can re-register the old `POLL_PRICES_CRON`/
  `SEND_NOTIFICATIONS_CRON`/`MAINTENANCE_CRON` after a newer instance already
  registered the new one, for as long as both are up. The window is bounded
  by the deployment itself, and one cycle at the wrong interval has no
  lasting effect — accepted rather than solved with a version-stamped
  registration.
- **`send-notifications` and `maintenance` are never retried on failure**,
  unlike `poll-prices`. They rely on their own next scheduled run instead:
  `send-notifications`'s atomic per-notification claim makes a bare re-run
  exactly as safe as a dedicated retry, and `maintenance` is a once-daily
  housekeeping job where a failure today simply tries again tomorrow — a
  retry listener for either would be complexity with no correctness benefit.
- **Verified, not a limitation:** `@agendajs/mongo-backend`'s peer dependency
  on the MongoDB driver could in principle mismatch Mongoose's own — `npm ls
  mongodb` was checked before wiring the shared connection and confirmed
  mongoose 9.10.1 resolves `mongodb@7.6.0`, which satisfies `@agendajs/mongo-backend@4.0.3`'s
  `^6.0.0 || ^7.0.0` requirement (alongside its exact `agenda@6.2.6` peer).
  Agenda shares the existing connection; no second connection was needed.
- **A duplicate email is possible.** Delivery is at-least-once, not
  exactly-once: if the worker process dies between a successful SMTP handoff
  and the write that marks the notification `sent`, another run's stale-lock
  recovery re-sends the exact same email. This is bounded by
  `NOTIFY_LOCK_TIMEOUT_MIN` — a duplicate can only happen within that window
  — and the duplicate is always an exact copy, never a new or different
  event. Exactly-once delivery isn't achievable here; it would require
  coordination with the mail provider that no plain SMTP server offers.
- **A price spike within one polling window is invisible.** If a price
  crosses an alert's threshold and comes back within a single
  `POLL_PRICES_CRON` interval, no run ever samples the moment it was past
  the threshold, so the alert never fires. This is inherent to periodic
  sampling, not something more correctness in this stage could fix — only a
  shorter polling interval narrows it, at the cost of more CoinGecko calls.
- **`lastEvaluatedAt` means "last state change," not "last evaluated."** It
  only updates when an evaluation actually triggers or re-arms an alert; a
  run that decides `COOLDOWN` or `NOOP` (the condition isn't met, or it is
  but the alert is still cooling down) leaves it untouched. This is
  deliberate: writing a timestamp for every alert on every run — potentially
  thousands of writes per tick at scale — would cost real throughput to
  record a fact nothing actually queries for. Don't read `lastEvaluatedAt`
  as "this alert was checked at this time"; read it as "this alert last
  changed state at this time."

## Firebase Auth: development scripts and the Auth emulator

There is no frontend in this project, so obtaining a Firebase ID token for
manual testing is itself a problem the three `auth:*`/`user:*` scripts exist
to solve (spec auth-dev-scripts). Two setups work:

### Option A — a real Firebase project

1. Create a Firebase project with the **Email/Password** sign-in provider
   enabled, generate a service-account key (Project settings → Service
   accounts → Generate new private key), and set `FIREBASE_PROJECT_ID`,
   `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` in `.env` from it.
2. Set `FIREBASE_WEB_API_KEY` (Project settings → General → Web API Key) so
   `auth:token` can call the Identity Toolkit REST API.
3. Create a test user and obtain a token as shown below.

### Option B — the local Auth emulator (no real Firebase project needed)

1. Install the [Firebase CLI](https://firebase.google.com/docs/cli) (`npm
install -g firebase-tools`) and a Java runtime — the emulator suite
   requires **JDK 11 or higher** ([Firebase's own prerequisites](https://firebase.google.com/docs/emulator-suite/install_and_configure)).
2. Start only the Auth emulator:

   ```bash
   firebase emulators:start --only auth
   ```

   By default it listens on `127.0.0.1:9099`.

3. Set in `.env`:

   ```
   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
   ```

   With this set, `initializeFirebaseAdmin()` logs a `warn` and both
   `firebase-admin` and the dev scripts talk to the emulator instead of a
   real project — `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY`
   and `FIREBASE_WEB_API_KEY` are not required in this mode
   (`assertFirebaseCredentials`; `auth:token` falls back to a placeholder
   API key the emulator ignores). The emulator's data is in-memory only and
   resets every time it restarts. **Never set this in production** — the
   process refuses to start if it's combined with `NODE_ENV=production`
   (E3-13).

### Obtaining and using a token (either option)

```bash
# 1. Create a test user (add --admin to also provision an admin Mongo profile)
npm run auth:create-test-user -- --email test@example.com --password Passw0rd!

# 2. Get an ID token — --silent avoids npm's own banner lines polluting stdout
TOKEN=$(npm run --silent auth:token -- --email test@example.com --password Passw0rd!)

# 3. Call an authenticated endpoint
curl http://localhost:3000/api/v1/me -H "Authorization: Bearer $TOKEN"

# 4. Promote (or demote) a user that has already authenticated at least once
npm run user:set-role -- --email test@example.com --role admin
```

`user:set-role` reports "no Mongo profile found" for an email that has never
successfully authenticated (its profile is only created just-in-time on the
first valid token, or by `auth:create-test-user --admin`) — the message tells
you to authenticate once first, or use `auth:create-test-user`.

### E3-14 — manual verification: the documented emulator workflow works end-to-end

This scenario is documented, not automated (an automated version needs a
running emulator this project's CI/sandbox doesn't provide — see the optional
suite in `tests/integration/`, skipped when `FIREBASE_AUTH_EMULATOR_HOST` is
unset). Verify it by hand:

1. Follow "Option B" above to start the emulator and point `.env` at it.
2. Run `npm run dev` in one terminal.
3. In another terminal, run the four commands under "Obtaining and using a
   token" above.
4. **Expected:** step 1 prints `Created Firebase user: uid=... email=...`;
   step 2's `$TOKEN` is a single non-empty JWT-looking string with nothing
   else around it; step 3 responds `200` with
   `{ "data": { "email": "test@example.com", "role": "user", ... } }`
   (freshly provisioned); step 4 prints
   `Role for test@example.com: user -> admin`, and a repeat of step 3
   afterwards still responds `200` (the token itself doesn't change, only
   the stored role — which the next request re-reads).

## Manual verification steps

Some acceptance scenarios can't be reliably automated in a fast test suite and
are verified manually instead:

### E0-8 — missing `MONGODB_URI` exits with code 1

1. Ensure `.env` does **not** define `MONGODB_URI` (or run without a `.env` file
   and without the variable exported).
2. Run `npm run dev` (or `node --import tsx src/server.ts`).
3. **Expected:** the process logs a `fatal` line whose payload names
   `MONGODB_URI` among `invalidVariables` — and never logs any variable's
   value — then exits with status code `1` before attempting any DB connection
   or HTTP listen.
4. You can confirm the exit code from a shell with `echo $?` (bash) or
   `echo $LASTEXITCODE` (PowerShell) right after the process exits.

### E0-9 — in-flight request survives `SIGTERM`, then the process exits 0

1. Temporarily add (or use a debugger breakpoint on) a slow test route, e.g. a
   handler that awaits `setTimeout(resolve, 5000)` before responding — or reuse
   `createApp({ registerTestRoutes })` from a throwaway script.
2. Start the server: `npm run dev`.
3. Send a request to the slow route (e.g. `curl http://localhost:3000/__slow`).
4. While that request is still in flight, send `SIGTERM` to the process
   (`kill -TERM <pid>` on Linux/macOS, or `Stop-Process -Id <pid>` /
   Ctrl+C on the same terminal on Windows — Ctrl+C actually sends `SIGINT`,
   which follows the identical shutdown path).
5. **Expected:** the log shows `shutdown iniciado`, the in-flight request still
   completes successfully (the client receives its response), and only
   afterwards does the process exit with code `0`.

### E1 — 30-minute worker verification (Compass)

This one can't be reliably automated and is verified by hand:

1. Set a real `COINGECKO_API_KEY` in `.env` and run `npm run seed:coins`.
2. Start the worker: `npm run dev:worker`.
3. Let it run for at least 30 minutes (three ticks at the default 10-minute
   interval), then open the database in MongoDB Compass (or `mongosh`) and
   check:
   - `price_snapshots` has new documents for each active coin, one batch per
     tick, all documents in a batch sharing the same `timestamp`.
   - `job_runs` has one document per tick, `status: "success"` (or
     `"partial"`/`"skipped"` if something legitimately didn't return data),
     with `stats` populated and `error: null`.
   - No document in either collection contains the CoinGecko API key or any
     other secret.
4. Stop the worker with `Ctrl+C` (`SIGINT`) and confirm it logs
   `shutdown iniciado`, waits for any in-progress run, and exits cleanly.

### E6-6 — two workers, 30 minutes, no overlapping `poll-prices` (Compass)

Verifies that Agenda's own locking plus the lease genuinely prevent two
workers from running the same job concurrently — the automated suite covers
the same mechanism against a single test process's two in-memory Agenda
instances (`tests/integration/schedulerAdapters.test.ts`), but only a real
30-minute run with two OS processes confirms it end-to-end.

1. Set a real `COINGECKO_API_KEY` in `.env`, run `npm run seed:coins`, and
   make sure MongoDB is running as a replica set (`docker compose up -d`).
2. Start two worker processes against the **same** `MONGODB_URI`, in two
   terminals: `npm run dev:worker` in each.
3. Let both run for at least 30 minutes, then inspect `job_runs` in Compass
   (or `mongosh`) filtered to `jobName: "poll-prices"`:
   - No two `status: "success"` documents have overlapping
     `[startedAt, finishedAt]` ranges.
   - Some runs from the second worker to reach a given tick are
     `status: "skipped"`, `skipReason: "locked"` — expected, not an error.
4. Stop both with `Ctrl+C` and confirm each logs a clean shutdown.

### RNF-6.2 — killing a worker mid-run recovers within `lockLifetime` + `processEvery` + the lease TTL

1. Same setup as above, but only **one** worker running.
2. Trigger a run (`POST /api/v1/admin/jobs/poll-prices/run` once the API is
   also up, or wait for the next scheduled tick) and, while it's in flight,
   kill the worker process hard: `kill -9 <pid>` (Linux/macOS) — a real
   `SIGKILL`, not `Ctrl+C`, so no shutdown handler runs at all.
3. Start a **new** worker process against the same database.
4. **Expected:** within `lockLifetime` (5 minutes for `poll-prices`) plus
   `AGENDA_PROCESS_EVERY`, plus `POLL_LOCK_TTL_MS` for the lease
   independently, the new worker picks the job back up and completes it —
   confirm a `job_runs` document for that tick eventually reaches
   `status: "success"` (or a legitimate terminal state), never stuck at
   `running` forever.

### E5-18 — an already-satisfied alert produces a real email in Mailpit

This is the one acceptance scenario in the alertas-email stage that genuinely
needs a live SMTP sink to observe, so it's verified by hand rather than in the
automated suite (which uses `FakeMailer` for exactly this reason — see
`tests/integration/sendNotifications.test.ts`/`alertEvaluation.test.ts` for
the equivalent automated coverage of every other behavior this manual check
touches).

1. `docker compose up -d` — starts the replica-set MongoDB and Mailpit. Wait
   until `docker compose ps` shows `mongo` as `healthy`.
2. Set a real `COINGECKO_API_KEY` in `.env`, plus (at minimum)
   `SMTP_HOST=localhost`, `SMTP_PORT=1025` and `MAIL_FROM=alerts@crypto-tracker.local`
   — Mailpit needs no `SMTP_USER`/`SMTP_PASS`. Point `MONGODB_URI` at
   `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`.
3. `npm run seed:coins` (needs at least one active coin, e.g. `bitcoin`).
4. Get an auth token for a user with a **verified email** (see "Firebase Auth:
   development scripts" above) and create an alert whose condition is already
   true against the coin's current price — e.g. a `PRICE_BELOW` alert whose
   `threshold` is comfortably above the coin's latest stored price:

   ```bash
   curl -X POST http://localhost:3000/api/v1/me/alerts \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"coingeckoId": "bitcoin", "type": "PRICE_BELOW", "threshold": 1000000000}'
   ```

   The response's `meta.conditionCurrentlyMet` should already be `true` — the
   alert is created `armed` but not evaluated during this request (spec
   alert-api), so nothing has fired yet.
5. Start the worker: `npm run dev:worker` (or `npm run job:poll-prices` for
   just one polling tick, followed by `npm run dev:worker` briefly so
   `send-notifications`' own schedule — default every minute — has a chance to
   claim and send the resulting notification; running the full worker is
   simpler, since a triggered alert also dispatches `send-notifications`
   immediately via its own overlap guard, per the alert-evaluation spec).
6. **Expected:** within about a minute, a message appears at
   **http://localhost:8025** addressed to the alert owner's email, with a
   subject naming the coin and the condition (see `src/modules/notifications/templates/alert-triggered.ts`).
   Opening it in Mailpit's UI shows both the HTML and plain-text bodies, the
   triggering value, and the `PATCH /api/v1/me/alerts/<id>` call that disables
   the alert.
7. `docker compose down` when done (add `-v` to also drop the replica set's
   volume if you want a completely clean slate next time).

## No secrets

`.env` is git-ignored. `.env.example` only contains non-sensitive placeholder
values. Never commit real MongoDB URIs, credentials or API keys.
