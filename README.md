# Crypto Tracker API

Backend project (API + background processes, no frontend) that polls cryptocurrency
prices from CoinGecko, stores history in MongoDB, and exposes a REST API to query
coins, history and stats. See `requerimientos/00-indice-y-convenciones.md` for the
full project index and conventions, `requerimientos/01-etapa-0-setup-base.md` for
Stage 0's requirements, `requerimientos/02-etapa-1-primer-job.md` for Stage 1's
requirements, and `requerimientos/03-etapa-2-api-rest.md` for this stage's
detailed requirements.

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

   This starts a single-node MongoDB 8 instance on `localhost:27017`, with data
   persisted in a named volume (`mongo_data`). See the comment inside
   `docker-compose.yml` for how to switch it to a one-node replica set (required
   starting from stage 5, for transactions).

4. Run the API in development mode (auto-reload on file changes):

   ```bash
   npm run dev
   ```

   On success you should see an `API listening` log line. `GET http://localhost:3000/health`
   should respond with `{"status":"ok", ...}`.

## Environment variables

| Variable                     | Type                                    | Required                    | Default                                          | Rules                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------- | --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                   | `development` \| `test` \| `production` | No                          | `development`                                    | —                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PORT`                       | integer                                 | No                          | `3000`                                           | 1–65535                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MONGODB_URI`                | string                                  | **Yes**                     | —                                                | Must start with `mongodb://` or `mongodb+srv://`                                                                                                                                                                                                                                                                                                                                                         |
| `MONGODB_DB_NAME`            | string                                  | No                          | `crypto_tracker`                                 | Non-empty                                                                                                                                                                                                                                                                                                                                                                                                |
| `LOG_LEVEL`                  | pino level                              | No                          | `info`                                           | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent`                                                                                                                                                                                                                                                                                                                                             |
| `SHUTDOWN_TIMEOUT_MS`        | integer                                 | No                          | `10000`                                          | >= 1000                                                                                                                                                                                                                                                                                                                                                                                                  |
| `COINGECKO_API_KEY`          | string                                  | **Only for worker/scripts** | —                                                | CoinGecko Demo plan key. Optional at the schema level (the API process doesn't need it until Stage 4); `worker.ts`, `seed:coins` and `job:poll-prices` each fail fast if it's missing                                                                                                                                                                                                                    |
| `COINGECKO_BASE_URL`         | string                                  | No                          | `https://api.coingecko.com/api/v3`               | Demo-key root, not `pro-api`                                                                                                                                                                                                                                                                                                                                                                             |
| `COINGECKO_TIMEOUT_MS`       | integer                                 | No                          | `10000`                                          | Per-attempt HTTP timeout                                                                                                                                                                                                                                                                                                                                                                                 |
| `COINGECKO_MAX_RETRIES`      | integer                                 | No                          | `2`                                              | 0–5                                                                                                                                                                                                                                                                                                                                                                                                      |
| `COINGECKO_MAX_IDS_PER_CALL` | integer                                 | No                          | `50`                                             | 1–250                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POLL_PRICES_CRON`           | cron expression                         | No                          | `*/10 * * * *`                                   | Validated with `cron.validate()`; runs in UTC                                                                                                                                                                                                                                                                                                                                                            |
| `POLL_PRICES_RUN_ON_START`   | boolean                                 | No                          | `true`                                           | Also runs the job once (`trigger: "startup"`) when the worker boots                                                                                                                                                                                                                                                                                                                                      |
| `SNAPSHOT_RETENTION_DAYS`    | integer \| empty                        | No                          | `90`                                             | TTL for `price_snapshots`; empty = no expiration                                                                                                                                                                                                                                                                                                                                                         |
| `JOB_RUNS_RETENTION_DAYS`    | integer                                 | No                          | `30`                                             | TTL for `job_runs`                                                                                                                                                                                                                                                                                                                                                                                       |
| `STALE_RUN_THRESHOLD_MIN`    | integer                                 | No                          | `15`                                             | A `running` `JobRun` older than this is recovered as `failed`/`STALE` on worker startup                                                                                                                                                                                                                                                                                                                  |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | integer                                 | No                          | `30000`                                          | Max time the worker waits for an in-progress run to finish during shutdown                                                                                                                                                                                                                                                                                                                               |
| `TRUST_PROXY`                | integer                                 | No                          | `0` in `development`/`test`, `1` in `production` | Passed to Express's `app.set('trust proxy', ...)`; controls which hop the rate limiter trusts for the client IP when behind a reverse proxy                                                                                                                                                                                                                                                              |
| `RATE_LIMIT_MAX`             | integer                                 | No                          | `300`                                            | Max requests per IP per `RATE_LIMIT_WINDOW_MIN` window, enforced on `/api` (not `/health`)                                                                                                                                                                                                                                                                                                               |
| `RATE_LIMIT_WINDOW_MIN`      | integer                                 | No                          | `15`                                             | Rate-limit window length, in minutes                                                                                                                                                                                                                                                                                                                                                                     |
| `STALE_POLL_THRESHOLD_MIN`   | integer                                 | No                          | `30`                                             | `GET /api/v1/status` reports `pollPrices.stale: true` when no `success`/`partial` `poll-prices` run finished within this many minutes                                                                                                                                                                                                                                                                    |
| `ADMIN_API_KEY`              | string                                  | No                          | — (unset)                                        | Minimum 32 characters when present. Required for `X-Admin-Key` on every `/api/v1/admin/*` route; when unset, those routes 404 as if they didn't exist. Generate one with `openssl rand -hex 32`. **Provisional**: this is a single shared secret with no rotation or per-caller identity, deliberately kept simple — it is replaced by real role-based authentication in the later `auth-firebase` stage |

`src/config/env.ts` is the **only** module allowed to read `process.env` (enforced
by an ESLint `no-restricted-properties` rule). Every other module imports the
validated, frozen `config` object from there. If a required variable is missing or
invalid, the process logs the invalid variable **names** (never their values) at
`fatal` and exits with code 1.

## npm scripts

| Script                         | What it does                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                  | API with auto-reload (`tsx watch src/server.ts`)                                                                                                                                                                 |
| `npm run dev:worker`           | Worker with auto-reload (`tsx watch src/worker.ts`)                                                                                                                                                              |
| `npm run build`                | Compiles `src/` to `dist/` with `tsc`                                                                                                                                                                            |
| `npm start`                    | Runs the compiled API (`node dist/server.js`)                                                                                                                                                                    |
| `npm run start:worker`         | Runs the compiled worker (`node dist/worker.js`)                                                                                                                                                                 |
| `npm run typecheck`            | `tsc --noEmit`                                                                                                                                                                                                   |
| `npm run lint`                 | ESLint                                                                                                                                                                                                           |
| `npm run format`               | Prettier (writes changes)                                                                                                                                                                                        |
| `npm test`                     | Runs the Vitest suite once                                                                                                                                                                                       |
| `npm run test:watch`           | Vitest in watch mode                                                                                                                                                                                             |
| `npm run test:coverage`        | Vitest with coverage report                                                                                                                                                                                      |
| `npm run seed:coins`           | Upserts the tracked coin catalog from CoinGecko (Stage 1)                                                                                                                                                        |
| `npm run job:poll-prices`      | Runs the `poll-prices` job exactly once, outside the scheduler (Stage 1)                                                                                                                                         |
| `npm run coins:rebuild-latest` | Recomputes `coins.latest` for every coin from its newest `price_snapshots` document; idempotent, safe to run any time (Stage 2)                                                                                  |
| `npm run backfill:history`     | Imports `price_snapshots` history for one coin from CoinGecko's `market_chart` endpoint: `npm run backfill:history -- <coingeckoId> --days <n>` (Stage 2, optional capability — see "Backfilling history" below) |
| `npm run perf:coins-list`      | Seeds a local dataset and measures RNF-2.1 latency for `GET /api/v1/coins`, `.../history` and `.../stats` (Stage 2) — see "Performance (RNF-2.1)" below                                                          |

## Background worker (Stage 1)

The worker (`src/worker.ts`) is a **separate process** from the API — it polls
CoinGecko for prices on a schedule and stores them as a time series. It needs
its own API key and, before it has anything to poll, a seeded coin catalog.

1. Get a free [CoinGecko Demo plan API key](https://www.coingecko.com/en/api/pricing)
   and set `COINGECKO_API_KEY` in your `.env`. The API process does not need
   this key (only Stage 4 will); `worker.ts`, `seed:coins` and
   `job:poll-prices` each fail fast if it's missing.
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

   On success you should see a startup log with `workerId`, the cron
   expression, and the active coin count, followed by one `poll-prices` run
   (`POLL_PRICES_RUN_ON_START` defaults to `true`) and then one run every
   `POLL_PRICES_CRON` interval (default: every 10 minutes, UTC).

4. To run the job once without the scheduler:

   ```bash
   npm run job:poll-prices
   ```

   **Overlap caveat:** this script does **not** coordinate with the worker's
   in-memory overlap guard — that flag only exists inside the worker
   process's memory. If you run this while the worker is mid-tick, both may
   execute concurrently. This is a documented limitation, not a bug: the
   job's own deduplication (by `sourceUpdatedAt`, one aggregation per run)
   prevents duplicate snapshot data even if both runs overlap. Real
   cross-process locking is deferred to Stage 6 (Agenda).

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
      "stale": false
    }
  }
}
```

`pollPrices.stale` is `true` when no `success`/`partial` run finished within
`STALE_POLL_THRESHOLD_MIN` minutes, including the case where no run has ever
completed. The response deliberately never includes an error message, code or
worker id — only whether the worker is alive.

### `GET /api/v1/admin/job-runs` and `GET /api/v1/admin/job-runs/:id`

Protected by the provisional `X-Admin-Key` header — see `ADMIN_API_KEY` in
"Environment variables" above. `Cache-Control: no-store`.

- **Unconfigured `ADMIN_API_KEY`:** every `/api/v1/admin/*` route responds
  `404 NOT_FOUND`, indistinguishable from a route that doesn't exist.
- **Missing or wrong `X-Admin-Key`:** `401 UNAUTHENTICATED`.
- **Correct key:** the request goes through.

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

## No secrets

`.env` is git-ignored. `.env.example` only contains non-sensitive placeholder
values. Never commit real MongoDB URIs, credentials or API keys.
