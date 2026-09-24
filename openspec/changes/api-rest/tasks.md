## 1. Config and dependencies

- [x] 1.1 Extend `src/config/env.ts`'s Zod schema with the stage's new variables: `TRUST_PROXY` (integer, default 0 in development and 1 in production), `RATE_LIMIT_MAX` (default 300), `RATE_LIMIT_WINDOW_MIN` (default 15), `STALE_POLL_THRESHOLD_MIN` (default 30) and `ADMIN_API_KEY` (optional, minimum 32 characters when present).
- [x] 1.2 Add `express-rate-limit` 8.x to dependencies.
- [ ] 1.3 Update `.env.example` with the new variables and a comment each, including how to generate `ADMIN_API_KEY` with `openssl rand -hex 32`.

## 2. Coin model changes (coin-catalog)

- [x] 2.1 Extend the `coins` schema with the `latest` sub-document (`priceUsd`, `marketCapUsd`, `volume24hUsd`, `change24hPct`, `capturedAt`, `sourceUpdatedAt`), defaulting to `null`.
- [x] 2.2 Add `nameLower`, maintained by a `pre('save')` hook and set explicitly in the `seed:coins` upsert.
- [x] 2.3 Add the four new indexes: `{ isActive: 1, "latest.marketCapUsd": -1 }`, `{ isActive: 1, nameLower: 1 }`, `{ isActive: 1, symbol: 1 }` and `{ isActive: 1, "latest.change24hPct": -1 }`.
- [x] 2.4 Unit/integration tests: `nameLower` derivation on save and on seed upsert; `latest` defaults to `null`; the four indexes exist.

## 3. Job updates the latest projection (price-polling-job, job-run-tracking)

- [x] 3.1 Add `stats.latestUpdated` to the `job_runs` schema and to the run result type.
- [x] 3.2 Implement the post-`insertMany` step in `createPollPricesJob`: one `bulkWrite` with an `updateOne` per coin that received a new snapshot, `$set`ting `latest`.
- [x] 3.3 Make each `updateOne` conditional on `latest.capturedAt` being absent or `< capturedAt`, so an older run cannot overwrite newer values.
- [x] 3.4 On `bulkWrite` failure, close the run as `partial` with `error.code: LATEST_UPDATE_FAILED`, keeping the inserted snapshots.
- [x] 3.5 Unit tests with fake repos: coins skipped as unchanged produce no update operation; `stats.latestUpdated` counts correctly; a throwing `bulkWrite` yields `partial` with the expected code.
- [x] 3.6 Integration test **E2-5**: after a run, every coin's `latest` matches its most recent snapshot.
- [x] 3.7 Integration test **E2-6**: apply the latest refresh twice with `capturedAt` values in reverse order and assert the newer values survive.

## 4. Rate limiting and proxy trust (api-rate-limiting, http-server)

- [x] 4.1 Apply `app.set('trust proxy', config.TRUST_PROXY)` in `createApp`.
- [x] 4.2 Configure the global `express-rate-limit` limiter over `/api` with `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MIN`, standard `RateLimit-*` headers enabled and legacy `X-RateLimit-*` headers disabled (confirming the exact option names in the installed version).
- [x] 4.3 Implement the limiter's `handler` so a rejection returns 429 in the project's global error format with `error.code: RATE_LIMITED`.
- [x] 4.4 Mount the health routes before the limiter so `/health` and `/health/ready` stay exempt, and update the documented middleware order.
- [x] 4.5 Integration test **E2-15**: with `RATE_LIMIT_MAX=3`, the fourth consecutive `/api/v1/coins` request returns 429 `RATE_LIMITED` while `/health` still returns 200.
- [x] 4.6 Document the in-memory store's per-instance limitation and name Redis as the multi-instance fix.

## 5. Coin read endpoints (coin-read-api)

- [x] 5.1 Implement the strict Zod query schema for `GET /api/v1/coins` (`page`, `limit`, `sort`, `order`, `q`) with coercion, defaults and per-`sort` default `order`.
- [x] 5.2 Implement the regex-escape helper and the anchored lowercase prefix search over `symbol` and `nameLower`.
- [x] 5.3 Implement the list service: one data query plus one `countDocuments` with the same filter, `isActive: true` only, coins with `latest: null` sorted last, no `$lookup`.
- [x] 5.4 Implement the output DTO (`coingeckoId`, `symbol`, `name`, `latest`) with no `_id` and no `__v`, and the `{ data, meta }` envelope.
- [x] 5.5 Implement `GET /api/v1/coins/:coingeckoId` with pattern validation (400), 404 for unknown or inactive coins, and `trackedSince` from `createdAt`.
- [x] 5.6 Unit tests: query schema defaults, coercion, rejections and strictness; regex escaping.
- [x] 5.7 Integration tests **E2-1** (pagination), **E2-2** (`q=BIT` case-insensitive prefix), **E2-3** (`sort=change24h&order=asc` with unpolled coins last) and **E2-4** (unknown query param → 400).
- [x] 5.8 Integration test for **RNF-2.2**: run `explain('executionStats')` on the list query and assert the plan uses `IXSCAN`, not `COLLSCAN`.

## 6. History endpoint (price-history-api)

- [x] 6.1 Implement the strict query schema: ISO-8601-with-offset `from`/`to`, `from < to`, `to` at most 5 minutes in the future, `interval` enum, `sma` 2-200 and only with `1h`/`1d`.
- [x] 6.2 Implement `selectInterval(from, to)` as a pure function (≤ 2 days → `raw`, ≤ 30 days → `1h`, else `1d`).
- [x] 6.3 Implement `assertRangeAllowed(interval, from, to)` as a pure function enforcing 7 / 90 / 365 days, throwing a `VALIDATION_ERROR` whose message suggests a coarser interval.
- [x] 6.4 Implement the `raw` path: `find` by `meta.coingeckoId` and `timestamp` range, ascending, projected; 400 suggesting `1h` when the range exceeds 2000 points.
- [x] 6.5 Implement the bucketed pipeline: `$match` → `$sort` ascending → `$group` by `$dateTrunc` (`hour`/`day`, `timezone: "UTC"`) with `open`/`high`/`low`/`close`/`avg`/`samples` → `$sort` by bucket ascending.
- [x] 6.6 Implement the optional `$setWindowFields` SMA over `close` with window `[-(sma - 1), 0]`, emitting `null` for the first `sma - 1` buckets.
- [x] 6.7 Implement the response envelope (`coingeckoId`, `interval`, `from`, `to`, `points`), `points: []` for an empty range and 404 for an unknown or inactive coin.
- [x] 6.8 Unit tests: interval selection table, maximum-range validation, `sma` warm-up boundary.
- [x] 6.9 Integration tests **E2-7** (3 known hours with hand-written expected OHLC), **E2-8** (`raw` over 10 days → 400 suggesting `1h`), **E2-9** (20-day range → `1h`) and **E2-10** (`sma=3` warm-up nulls then the exact average).
- [x] 6.10 Integration tests for the edge cases: single-sample bucket collapses `open`/`high`/`low`/`close`; `sma` larger than the bucket count yields all `null`; empty buckets are omitted.

## 7. Stats endpoint (price-stats-api)

- [x] 7.1 Implement the `range` enum schema (`24h`/`7d`/`30d`/`90d`, default `24h`) and the derived `from`/`to`.
- [x] 7.2 Implement the single pipeline computing `open`, `close`, `min`, `max`, `avg`, `samples`, `firstAt` and `lastAt`.
- [x] 7.3 Implement `changePct` rounded to 4 decimals, and the empty-range response (`samples: 0`, everything else `null`).
- [x] 7.4 Unit test the `changePct` calculation and rounding.
- [x] 7.5 Integration test **E2-11**: stats for an unknown coin returns 404; plus a hand-computed statistics assertion and the empty-range shape.

## 8. Status endpoint (system-status-api)

- [x] 8.1 Implement the service that counts active coins and reads the most recent `poll-prices` run and the most recent `success`/`partial` run.
- [x] 8.2 Implement the `stale` rule against `STALE_POLL_THRESHOLD_MIN` using `clock.now()`, including the never-succeeded case.
- [x] 8.3 Implement the response DTO, guaranteeing no error message, code or worker identifier is included.
- [x] 8.4 Integration test **E2-12**: a last success 45 minutes ago yields `stale: true`; plus the no-runs-yet and recent-success cases.

## 9. Admin endpoints (admin-api-key, admin-job-runs-api)

- [x] 9.1 Implement `src/middlewares/requireAdminKey.ts`: read `X-Admin-Key`, reject on length mismatch without calling `timingSafeEqual`, otherwise compare with `crypto.timingSafeEqual`, 401 `UNAUTHENTICATED` on failure.
- [x] 9.2 Make every `/api/v1/admin` route respond 404 when `ADMIN_API_KEY` is unset.
- [x] 9.3 Implement `GET /api/v1/admin/job-runs`: strict query schema (`jobName`, comma-separated `status`, `from`, `to`, `page`, `limit` ≤ 100), `startedAt` descending, paginated envelope.
- [x] 9.4 Implement `GET /api/v1/admin/job-runs/:id`: 400 on an invalid ObjectId, 404 when absent, full document without `__v`.
- [x] 9.5 Unit tests for `requireAdminKey`: no header, wrong key, differing length, correct key and unconfigured key.
- [x] 9.6 Integration tests **E2-13** (401 without the header, paginated list with the correct key) and **E2-14** (404 for every admin route when `ADMIN_API_KEY` is unset).

## 10. HTTP caching (http-caching)

- [x] 10.1 Set `Cache-Control: public, max-age=60` on the four coin read endpoints.
- [x] 10.2 Set `Cache-Control: no-store` on `/api/v1/status` and on every `/api/v1/admin` route.
- [x] 10.3 Confirm Express's default weak `ETag` generation stays enabled for the cacheable endpoints.
- [x] 10.4 Integration test **E2-16**: repeating `GET /coins` with the received `ETag` in `If-None-Match` returns 304.

## 11. Maintenance scripts (data-maintenance-scripts)

- [x] 11.1 Implement `npm run coins:rebuild-latest`: recompute `latest` for every coin from its newest snapshot, idempotently, printing an updated / no-snapshots summary.
- [x] 11.2 Integration test: rebuild populates `latest` from stored snapshots, a second run is a no-op, and a coin without snapshots is reported rather than failing.
- [x] 11.3 (Optional) Verify in CoinGecko's live documentation whether the Demo plan exposes `/coins/{id}/market_chart` and at what granularity per requested day count; record the finding in the README before implementing.
- [x] 11.4 (Optional) Implement `npm run backfill:history -- <coingeckoId> --days <n>`: import points with `timestamp` and `sourceUpdatedAt` set to each point's own upstream timestamp.
- [x] 11.5 (Optional) Implement and document the chosen overlap rule (skip or replace existing points in the range) and the quota-consumption confirmation prompt.

## 12. Documentation and Definition of Done

- [x] 12.1 Add the npm scripts `coins:rebuild-latest` and, if implemented, `backfill:history`.
- [x] 12.2 Update the README with the new endpoints, the new variables, the `explain()` result documenting **RNF-2.2**, the rate-limit single-instance note, and the note that `ADMIN_API_KEY` is provisional until the auth stage.
- [x] 12.3 Update the `.http` collection with every new endpoint, including an admin request carrying `X-Admin-Key`.
- [x] 12.4 Write the performance script that seeds 90 days × 10 coins and measure **RNF-2.1** with `autocannon` or an equivalent tool, documenting the results.
- [x] 12.5 Confirm `typecheck`, `lint` and `test` all pass locally and in CI, and that no secret appears in the repo or its history.
