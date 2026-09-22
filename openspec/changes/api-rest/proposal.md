## Why

The worker from `primer-job` has been filling `price_snapshots` and `job_runs` since stage 1, but nothing can read that data: the API still only answers `/health`. This stage opens the collected time series over HTTP — coin list with latest price, history at three resolutions, per-range statistics, and job health — and is where the project practises query-param validation, offset pagination, Mongo aggregation pipelines, index design, rate limiting and HTTP caching. Every later stage (auth, watchlists, alerts) attaches to the endpoints and the `coins.latest` projection introduced here.

## What Changes

- Add a denormalized `latest` sub-document and a `nameLower` field to `coins`, plus four new compound indexes that serve the list endpoint's sort and search paths without touching the time series.
- Extend the `poll-prices` job with a final `bulkWrite` step that refreshes `coins.latest` for every coin that got a new snapshot, guarded so a slow older run can never overwrite newer data, and add `stats.latestUpdated` to `JobRun`.
- Add the public read endpoints: `GET /api/v1/coins`, `GET /api/v1/coins/:coingeckoId`, `GET /api/v1/coins/:coingeckoId/history` (intervals `raw`/`1h`/`1d`, OHLC buckets via `$dateTrunc`, optional SMA via `$setWindowFields`) and `GET /api/v1/coins/:coingeckoId/stats`.
- Add `GET /api/v1/status`, a public, uncached summary of worker health including a `stale` flag.
- Add `GET /api/v1/admin/job-runs` and `GET /api/v1/admin/job-runs/:id`, protected by a **temporary** `X-Admin-Key` middleware that compares in constant time and makes every `/admin` route return 404 when `ADMIN_API_KEY` is unset. This protection is explicitly provisional and is replaced by role-based auth in `auth-firebase`.
- Add `trust proxy` configuration and a global IP-based rate limiter over `/api`, with `/health` and `/health/ready` deliberately exempt.
- Add per-endpoint `Cache-Control` headers and verify Express's weak `ETag` produces `304` on a matching `If-None-Match`.
- Add `npm run coins:rebuild-latest` (repair/initialize `latest` from the newest snapshot per coin) and the optional `npm run backfill:history` script.
- Add the stage's new environment variables: `TRUST_PROXY`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MIN`, `STALE_POLL_THRESHOLD_MIN` and the optional `ADMIN_API_KEY`.
- No user authentication (`auth-firebase`), no coin writes from the API (`watchlists`), no cursor pagination — out of scope here, as the source requirement document states.

## Capabilities

### New Capabilities
- `coin-read-api`: `GET /api/v1/coins` (offset pagination, `sort`/`order`/`q` with strict rejection of unknown params, escaped prefix search over `symbol`/`nameLower`, coins without `latest` sorted last) and `GET /api/v1/coins/:coingeckoId` (404 for unknown or inactive coins, `trackedSince`).
- `price-history-api`: `GET /api/v1/coins/:coingeckoId/history` — automatic interval selection, per-interval maximum ranges, the `raw` point cap, the `$dateTrunc` OHLC pipeline, the optional `$setWindowFields` simple moving average with `null` for the first `sma - 1` buckets, and the no-gap-filling rule.
- `price-stats-api`: `GET /api/v1/coins/:coingeckoId/stats` — the single pipeline computing `open`/`close`/`min`/`max`/`avg`/`samples`/`firstAt`/`lastAt` over a `range` enum, the `changePct` formula, and the empty-range response shape.
- `system-status-api`: `GET /api/v1/status` — active coin count, last run / last success of `poll-prices`, the `stale` rule against `STALE_POLL_THRESHOLD_MIN`, and the guarantee that no internal error detail is exposed.
- `admin-api-key`: the provisional `requireAdminKey` middleware — constant-time comparison of `X-Admin-Key` against `ADMIN_API_KEY`, 401 on mismatch, and 404 for all `/admin` routes when the variable is unset.
- `admin-job-runs-api`: `GET /api/v1/admin/job-runs` (filters `jobName`, multi-valued `status`, `from`, `to`, paginated, newest first) and `GET /api/v1/admin/job-runs/:id`, both `no-store`.
- `api-rate-limiting`: `trust proxy` configuration and the global per-IP limiter over `/api` returning the project's `RATE_LIMITED` error format, with the health endpoints exempt and the single-instance in-memory store limitation documented.
- `http-caching`: the per-endpoint `Cache-Control` contract (`public, max-age=60` for coin reads, `no-store` for status and admin) and `ETag`/`If-None-Match` revalidation.
- `data-maintenance-scripts`: `npm run coins:rebuild-latest` (idempotent recomputation of `latest` for every coin) and the optional `npm run backfill:history` (CoinGecko `market_chart` import with a quota-consumption confirmation prompt and a documented overlap rule).

### Modified Capabilities
- `coin-catalog`: the `coins` document gains the `latest` sub-document (`priceUsd`, `marketCapUsd`, `volume24hUsd`, `change24hPct`, `capturedAt`, `sourceUpdatedAt`), a `nameLower` field maintained on save and on seed upsert, and four new indexes supporting sorting by market cap and 24h change and prefix search by name and symbol.
- `price-polling-job`: the run now has a final step that refreshes `coins.latest` in one `bulkWrite` with a staleness guard per coin, reports `stats.latestUpdated`, and downgrades the run to `partial` with `error.code: LATEST_UPDATE_FAILED` if that write fails without discarding the snapshots already inserted.
- `job-run-tracking`: the `stats` object gains `latestUpdated`.
- `http-server`: the middleware chain gains `trust proxy` configuration and the global rate limiter mounted on `/api`, ahead of the application routes and outside the health endpoints.

## Impact

- Extends `src/modules/coins/` with the `latest`/`nameLower` schema additions, new indexes, output DTOs, Zod query schemas, service, controller and routes.
- Adds `src/modules/snapshots/` read services (history and stats aggregation pipelines) and their route/controller layer.
- Adds `src/modules/job-runs/` read services plus the admin router under `/api/v1/admin`.
- Adds `src/middlewares/requireAdminKey.ts` and the rate-limiting middleware wiring in `src/app.ts`.
- Extends `src/jobs/pollPrices.ts` with the `latest` refresh step, and `src/modules/job-runs/` with the new stat field.
- Adds `src/scripts/rebuildLatest.ts` and the optional `src/scripts/backfillHistory.ts`.
- Extends `.env.example`, the config schema, the README (including the documented `explain()` result for RNF-2.2) and the `.http` collection.
- Adds `express-rate-limit` 8.x as a dependency.
- No change to `setup-base`'s error format, shutdown or health behavior, and no change to the `price_snapshots` collection shape.
