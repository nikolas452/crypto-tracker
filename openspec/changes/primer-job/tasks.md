## 1. Config and environment

- [x] 1.1 Extend `src/config/env.ts`'s Zod schema with the stage's new variables: `COINGECKO_API_KEY` (optional at schema level), `COINGECKO_BASE_URL` (default `https://api.coingecko.com/api/v3`), `COINGECKO_TIMEOUT_MS` (default 10000), `COINGECKO_MAX_RETRIES` (default 2, 0-5), `COINGECKO_MAX_IDS_PER_CALL` (default 50, 1-250), `POLL_PRICES_CRON` (default `*/10 * * * *`), `POLL_PRICES_RUN_ON_START` (default true), `SNAPSHOT_RETENTION_DAYS` (default 90, empty = no expiration), `JOB_RUNS_RETENTION_DAYS` (default 30), `STALE_RUN_THRESHOLD_MIN` (default 15), `WORKER_SHUTDOWN_TIMEOUT_MS` (default 30000).
- [x] 1.2 Add a small `assertCoinGeckoApiKey(config)` (or equivalent) helper used only by worker/script entrypoints, that fails fast (fatal log + exit 1) if `COINGECKO_API_KEY` is missing, reusing `setup-base`'s fail-fast pattern.
- [x] 1.3 Update `.env.example` with the new variables and comments.

## 2. Data models (coin-catalog, price-snapshot-store, job-run-tracking)

- [x] 2.1 Implement the `coins` Mongoose model/schema: `coingeckoId` (unique, lowercase, pattern-validated), `symbol`, `name`, `isActive` (default true), timestamps; indexes on `{ coingeckoId: 1 }` (unique) and `{ isActive: 1 }`.
- [x] 2.2 Implement the `price_snapshots` Mongoose model/schema for the time-series shape: `timestamp`, `meta.coinId`, `meta.coingeckoId`, `priceUsd`, `marketCapUsd`, `volume24hUsd`, `change24hPct`, `sourceUpdatedAt`; secondary index `{ "meta.coingeckoId": 1, timestamp: -1 }`.
- [x] 2.3 Implement the `job_runs` Mongoose model/schema: all fields from the spec, `status`/`trigger`/`skipReason` enums, `stats` sub-object; indexes `{ jobName: 1, startedAt: -1 }` and `{ status: 1, startedAt: 1 }`, plus a TTL index on `startedAt` using `JOB_RUNS_RETENTION_DAYS`.
- [x] 2.4 Implement `ensureCollections()`: create `price_snapshots` with time-series options if missing; if it exists, validate shape via `listCollections` (fatal + exit 1 on mismatch); apply `collMod` and log at `info` if `SNAPSHOT_RETENTION_DAYS` changed.
- [x] 2.5 Wire `ensureCollections()` into `src/server.ts` (API) startup, in addition to the worker and scripts (added in later task groups).
- [x] 2.6 Unit/integration tests: coin uniqueness constraint; time-series collection creation and shape validation (E1-3); fatal exit on wrong existing shape (E1-4); TTL index existence with expected `expireAfterSeconds`.

## 3. CoinGecko client

- [x] 3.1 Implement `src/integrations/coingecko/` with the `CoinGeckoClient` interface (`getSimplePrices`, `getMarkets`, `ping`) and `SimplePrice`/`MarketCoin` types, using native `fetch` with `AbortSignal.timeout(ms)`.
- [x] 3.2 Implement batching: split `ids` into chunks of `COINGECKO_MAX_IDS_PER_CALL`, request sequentially.
- [x] 3.3 Implement Zod response validation and field mapping (missing/null → null, except `usd`; invalid `usd` discards the coin with a `warn` log; malformed shape throws `COINGECKO_BAD_RESPONSE`).
- [x] 3.4 Implement the fixed error-mapping table (timeout/network/5xx retryable `COINGECKO_UNAVAILABLE`; 429 `COINGECKO_RATE_LIMITED` with `Retry-After` handling; 401/403 `COINGECKO_AUTH` non-retryable; other 4xx `COINGECKO_CLIENT_ERROR` non-retryable).
- [x] 3.5 Implement retry with backoff (1s, 3s) and ±20% jitter, `COINGECKO_MAX_RETRIES` bound, injectable sleep function; track total `attempts`.
- [x] 3.6 Implement request logging at `debug` (path without key, status, duration) and guarantee the API key never appears in logs or thrown error messages.
- [x] 3.7 Unit tests: field mapping incl. null/epoch-to-Date, invalid `usd` discard, malformed response, each error-table row, retries and `attempts` count, `Retry-After` capping, batching (120 ids / limit 50 → 3 sequential calls), key never in error messages.

## 4. Coin seed script

- [x] 4.1 Implement `npm run seed:coins`: parse optional CLI argument (comma-separated ids) or use the 10-coin default list; normalize (trim, lowercase) and de-duplicate.
- [x] 4.2 Call `getMarkets(ids)`, upsert `coins` by `coingeckoId` (update `name`/`symbol`, set `isActive: true`); collect ids CoinGecko didn't return as invalid.
- [x] 4.3 Print the summary (created / updated / invalid) and set the exit code (0 if ≥1 valid coin, 1 otherwise).
- [x] 4.4 Integration test: idempotent seed with a fake CoinGecko client (E1-1); mixed valid/invalid id list (E1-2).

## 5. Price polling job

- [x] 5.1 Implement `createPollPricesJob(deps)` with injected `coinsRepo`, `snapshotsRepo`, `jobRunsRepo`, `coingecko`, `clock`, `logger`, `workerId`; returns `run(trigger): Promise<JobRunResult>`.
- [x] 5.2 Implement the run steps: create `JobRun` (`running`, `startedAt: clock.now()`); load active coins (skip as `no_active_coins` if none); call `getSimplePrices`.
- [x] 5.3 Implement the single-aggregation deduplication (`$match`/`$sort`/`$group($first)`) against `price_snapshots` and the skip-if-unchanged logic (`stats.skippedUnchanged`).
- [x] 5.4 Implement `insertMany(docs, { ordered: false })` with a shared `timestamp` per run; track `stats.missingCoins` for coins not returned.
- [x] 5.5 Implement run closure: compute `status` (`success`/`partial`/`failed`) from `missingCoins`/processed count; set `finishedAt`, `durationMs`, `stats`.
- [x] 5.6 Implement the catch-all: on any exception, close the run as `failed` with `error.code`/`error.message`, log at `error` with stack, and ensure `run()` never rejects.
- [x] 5.7 Implement start/end `info` logging with `runId`, `trigger`, `status`, `durationMs`, `stats`.
- [x] 5.8 Unit tests with fake repos/client: E1-5 through E1-9 and E1-12; confirm `run()` never throws even when a dependency rejects; state computation (`success`/`partial`/`failed`) as a pure function.

## 6. Worker entrypoint

- [x] 6.1 Implement `src/worker.ts`: load config, assert `COINGECKO_API_KEY`, connect to Mongo, run `ensureCollections()`.
- [x] 6.2 Implement stale-run recovery: mark `JobRun`s `running` with `startedAt` older than `STALE_RUN_THRESHOLD_MIN` as `failed`/`STALE` (E1-11).
- [x] 6.3 Implement cron setup: `cron.validate(POLL_PRICES_CRON)` (exit 1 if invalid), `cron.schedule(..., { timezone: 'UTC', name: 'poll-prices' })`; run once with `trigger: "startup"` if `POLL_PRICES_RUN_ON_START`.
- [x] 6.4 Implement the in-memory overlap guard: `isRunning` flag, `skipped`/`overlap` `JobRun` on a concurrent tick, flag released in `finally`.
- [x] 6.5 Implement startup logging: `workerId`, cron expression, active coin count.
- [x] 6.6 Implement ordered shutdown on `SIGTERM`/`SIGINT`: stop cron tasks, wait up to `WORKER_SHUTDOWN_TIMEOUT_MS` for an in-progress run, disconnect Mongo, exit 0; exit 1 without touching the run document if the timeout elapses.
- [x] 6.7 Unit/integration tests: overlap guard with two concurrent invocations (E1-10); stale-run recovery (E1-11) with `mongodb-memory-server`.

## 7. Manual job run script

- [x] 7.1 Implement `npm run job:poll-prices`: connect, `ensureCollections()`, run the job once with `trigger: "manual"`, print the result.
- [x] 7.2 Implement the exit-code mapping (0 for success/partial/skipped, 1 for failed).
- [ ] 7.3 Document the overlap limitation relative to the worker (no shared lock; deduplication mitigates duplicate data) in the README.

## 8. npm scripts and documentation

- [x] 8.1 Add npm scripts: `dev:worker`, `start:worker`, `seed:coins`, `job:poll-prices`.
- [ ] 8.2 Update the README with: how to run the worker in development, how to seed coins, how to run the job manually, the quota formula from RNF-1.1, and manual verification steps for the 30-minute Compass check.
- [ ] 8.3 Confirm `typecheck`, `lint`, and `test` all pass, and that the CoinGecko API key never appears in the repo, logs, or git history.
