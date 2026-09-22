## Context

`setup-base` established config validation, DB connection lifecycle, logging, and the error/shutdown machinery. This stage builds the first vertical slice of actual product behavior on top of it: a worker process that keeps a time series of crypto prices current. The technical decisions here (time-series collection shape, retry policy, dedup strategy, overlap protection) are already fixed by `requerimientos/02-etapa-1-primer-job.md`; this design explains the implementation approach and the reasoning, and calls out the places where interpretation was needed.

## Goals / Non-Goals

**Goals:**
- Reliable, observable execution: every run of the job is recorded, so "is the job healthy" is answerable from `job_runs` without grepping logs.
- Safe interaction with a rate-limited third party: CoinGecko's Demo plan allows 100 calls/min and 10,000/month; the client's batching, retry policy, and the job's own low-frequency schedule must respect that by construction, not by convention.
- A job function that is pure enough to unit test with fake dependencies, and a scheduler wrapper thin enough to trust without heavy testing.
- No data loss or duplication under the realistic failure modes: worker crash mid-run, overlapping ticks, transient upstream failures, Mongo hiccups.

**Non-Goals:**
- No read API for this data (stage 2), no alerting on it (stage 5), no persisted/distributed scheduler (stage 6 replaces `node-cron` with Agenda). This job runs on a single worker instance with an in-memory overlap guard, which is an accepted limitation until stage 6.
- No general-purpose retry/backoff utility shared across future integrations — this stage builds it once, scoped to the CoinGecko client, per `setup-base`'s established preference for concrete mechanism over premature abstraction.

## Decisions

- **Time-series collection created explicitly, never implicitly**: `ensureCollections()` runs before anything else touches `price_snapshots`, because MongoDB creates a *normal* collection on first insert if the time-series collection doesn't exist yet — and a normal collection can't be converted to time-series afterward. Every entrypoint that could be the first to touch Mongo (API, worker, scripts) calls it. On an existing collection, it validates `timeField`/`metaField` via `listCollections` rather than trusting that "the collection exists" means "it's shaped correctly" — a collision here is a configuration bug that should fail loudly at startup, not corrupt data silently.

- **`meta` holds only identity fields, never values that change per point**: MongoDB buckets time-series documents by the `meta` value. If a changing field (like price) were inside `meta`, every point would land in its own bucket, defeating the format's entire point (compression, fast range queries). `meta.coinId` + `meta.coingeckoId` are stored redundantly (the latter denormalized) specifically so queries by `coingeckoId` don't need a join back to `coins`.

- **Job business logic (`createPollPricesJob`) is fully decoupled from `node-cron`**: the job is a plain async function taking injected dependencies (`coinsRepo`, `snapshotsRepo`, `jobRunsRepo`, `coingecko`, `clock`, `logger`, `workerId`) and returning a result — it has no idea it's running on a schedule. `worker.ts` is the only module that knows about cron. *Rationale*: this is what makes E1-5 through E1-12 unit-testable without a real scheduler, and it's the same DI pattern `setup-base` already established (factory functions, no container).

- **Deduplication via one aggregation per run, not a query per coin**: comparing each requested coin's new price against its last stored `sourceUpdatedAt` is done with a single `$match` → `$sort` → `$group($first)` aggregation over `price_snapshots`, rather than N sequential queries. *Rationale*: this keeps the job's Mongo cost flat regardless of coin count, and matches the requirement's explicit call for "una sola agregación."

- **Retry/backoff/jitter lives inside the CoinGecko client, with an injectable sleep function**: `COINGECKO_MAX_RETRIES` (default 2) with 1s/3s waits ±20% jitter, only for retryable failures (timeouts, network errors, 5xx, 429-once). 401/403 and other 4xx never retry — they're caller/auth errors, not transient. *Rationale*: injecting the sleep function is what lets the retry and backoff unit tests run in milliseconds instead of actually waiting seconds.

- **The job never throws; `run()` always resolves with a result**: any exception during a run is caught, turns the `JobRun` into `failed` with a redacted `error.code`/`error.message`, and is logged with the full stack — but the promise still resolves. *Rationale*: a scheduler (`node-cron` today, `Agenda` in stage 6) must never crash because one run failed; the job's own error handling is the boundary that guarantees that, independent of which scheduler is driving it.

- **Overlap protection is an in-memory flag in `worker.ts`, not a DB lock**: acceptable because there's exactly one worker instance today (stage 6 explicitly defers real distributed locking to Agenda). The flag is released in a `finally`, so a thrown error can't leave the worker permanently "stuck" thinking a job is running.

- **Stale-run recovery runs once, at worker startup, not on a timer**: a `JobRun` stuck in `running` only happens when a previous worker process died mid-run; the next worker to start is the right place to reconcile that, before it schedules anything new.

- **Config validation stays a single schema, but `COINGECKO_API_KEY` is required only for worker/script entrypoints**: the API doesn't need CoinGecko until stage 4. Rather than forking the config module, the schema marks `COINGECKO_API_KEY` optional at the type level and each entrypoint (`worker.ts`, the seed script, the manual-run script) asserts it's present immediately after loading config, failing fast with the same fatal-log-and-exit-1 pattern as `setup-base`'s `app-config` capability. *Alternative considered*: two separate Zod schemas (API vs. worker) — rejected because it would duplicate every shared variable and create two sources of truth for the same environment.

## Risks / Trade-offs

- **[Risk]** CoinGecko changing response shape silently (a field renamed or removed) could pass unnoticed if validation is too loose. → **Mitigation**: the client validates the full response shape with Zod and throws `UpstreamError`/`COINGECKO_BAD_RESPONSE` on structural mismatches; only genuinely optional fields (market cap, volume, change) are allowed to be `null`.
- **[Risk]** The in-memory overlap guard and stale-run recovery only work correctly with exactly one worker process. Running two worker instances (e.g., a deploy overlap during a rolling restart) could produce duplicate runs. → **Mitigation**: this is an explicitly accepted limitation until stage 6 (Agenda-based locking); the manual-run script's own documentation already calls out the equivalent risk, and stage 1's deduplication (by `sourceUpdatedAt`) limits the damage to wasted API calls, not duplicate data.
- **[Risk]** A misconfigured `POLL_PRICES_CRON` (e.g., every minute instead of every 10) could burn through the monthly CoinGecko quota fast. → **Mitigation**: `cron.validate()` only checks syntax, not sanity; the README documents the quota formula from RNF-1.1 so a human reviews the number before deploying, and `stats.upstreamAttempts` on every `JobRun` makes runaway consumption visible in the data itself.
- **[Trade-off]** Storing `coingeckoId` redundantly in both `coins` and `price_snapshots.meta` violates normalization, but is required by the time-series format's `meta`-based bucketing and the desire to query snapshots without a lookup join. Accepted as a deliberate, documented denormalization.

## Migration Plan

Purely additive: new collections, new process, no changes to existing `setup-base` behavior or data. `ensureCollections()` is idempotent and safe to run against an empty database (fresh deploy) or one that already has `price_snapshots` correctly shaped (redeploy). Rollout order: seed coins once (`npm run seed:coins`), then start the worker; the worker's own startup runs `ensureCollections()` and stale-run recovery before scheduling anything, so there's no separate migration step to run by hand.

## Open Questions

- The default coin list for `seed:coins` (bitcoin, ethereum, solana, cardano, ripple, dogecoin, polkadot, chainlink, litecoin, avalanche-2) comes directly from the source requirement document. It's a config default, not a structural decision — trivial to change later without touching any other capability.
