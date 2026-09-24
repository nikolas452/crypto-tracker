## Why

The API base from `setup-base` runs, connects to MongoDB, and reports health — but the project's core purpose (tracking crypto prices over time) has no data yet. This stage adds the first real job: a separate worker process that polls CoinGecko for prices on a schedule and stores them as a time series, with full tracking of every run so the job's health can be verified without reading logs by hand. Every later stage (read API, alerts) depends on this data existing.

## What Changes

- Add three MongoDB collections: `coins` (catalog of tracked coins), `price_snapshots` (a time-series collection storing price points), and `job_runs` (execution history for every job run).
- Add `ensureCollections()`, run at startup by the API, the worker, and scripts, which creates `price_snapshots` with the correct time-series options if missing, and fails fast if it already exists with the wrong shape.
- Add a CoinGecko HTTP client (`src/integrations/coingecko/`) with batching, per-attempt timeouts, retry with exponential backoff and jitter, a fixed error-to-status mapping (including 429 rate-limit handling), and strict never-log-the-key behavior.
- Add `npm run seed:coins`, an idempotent script that upserts the tracked coin catalog from CoinGecko's markets endpoint.
- Add the `poll-prices` job (`createPollPricesJob(deps)`): loads active coins, fetches simple prices, deduplicates against each coin's last stored snapshot via a single aggregation, inserts new snapshots, and records the outcome as a `JobRun` — the job function itself never throws.
- Add a new process entrypoint, `src/worker.ts`: validates config (including a `COINGECKO_API_KEY` required only for this entrypoint), connects to Mongo, recovers `JobRun`s left `running` by a crashed previous process (marks them `failed`/`STALE`), schedules the job with `node-cron` in UTC, guards against overlapping runs, and shuts down in an ordered way.
- Add `npm run job:poll-prices` for a single manual run of the job outside the scheduler.
- Add the new npm scripts (`dev:worker`, `start:worker`, `seed:coins`, `job:poll-prices`) and the stage's new environment variables.
- No read endpoints (stage 2), no alerts (stage 5), no persisted scheduler (stage 6) — out of scope here, as the source requirement document states.

## Capabilities

### New Capabilities

- `coin-catalog`: the `coins` collection — schema, uniqueness on `coingeckoId`, `isActive` flag that the job uses to decide what to poll.
- `price-snapshot-store`: the `price_snapshots` time-series collection, its fixed shape (`timestamp`, `meta.coinId`, `meta.coingeckoId`, price fields), its secondary index, and `ensureCollections()`'s creation/validation/retention-update behavior.
- `job-run-tracking`: the `job_runs` collection — the run lifecycle (`running` → `success`/`partial`/`failed`/`skipped`), its stats fields, indexes, and TTL-based retention.
- `coingecko-client`: the `CoinGeckoClient` contract (`getSimplePrices`, `getMarkets`, `ping`), batching, timeouts, the retry/backoff/jitter policy, the error mapping table, and API-key redaction.
- `coin-seed`: the `seed:coins` script — argument parsing, normalization, idempotent upsert, invalid-id reporting, exit codes.
- `price-polling-job`: `createPollPricesJob(deps)`'s run logic — active-coin loading, price fetching, aggregation-based deduplication, insertion, status computation, and its never-throws contract.
- `worker-process`: the `worker.ts` entrypoint — startup sequence, stale-run recovery, cron scheduling in UTC, the in-memory overlap guard, and ordered shutdown.
- `manual-job-run`: the `job:poll-prices` script — single manual execution, its exit-code contract, and its documented overlap limitation relative to the worker.

### Modified Capabilities

None — this stage only adds new collections, a new external integration, and a new process; nothing from `setup-base` changes its existing behavior. (`ensureCollections()` and the worker reuse `setup-base`'s `connectDb`/`disconnectDb`, config validation, and logger as-is.)

## Impact

- Adds `src/modules/coins/`, `src/modules/snapshots/` (or equivalent), and `src/modules/job-runs/` model/schema files, following the project's per-domain folder convention.
- Adds `src/integrations/coingecko/` (client, types, error mapping).
- Adds `src/jobs/pollPrices.ts` (or equivalent) with the job's pure logic, decoupled from the scheduler.
- Adds `src/worker.ts` as a second process entrypoint alongside the existing `src/server.ts`.
- Adds `src/scripts/seedCoins.ts` and `src/scripts/pollPricesOnce.ts` (or equivalent) for the two npm scripts.
- Extends `.env.example` and the config schema with the stage's new variables, with `COINGECKO_API_KEY` required only for worker/script entrypoints, not the API.
- No changes to existing `src/app.ts`, `src/server.ts` behavior, or the `setup-base` specs — this is purely additive alongside them.
