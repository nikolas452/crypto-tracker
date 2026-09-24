## Context

`setup-base` gave the API its middleware chain, error format and health checks; `primer-job` filled `price_snapshots` and `job_runs` but exposed none of it. This stage is the first one that has to answer read queries fast over a growing time series, so most of its decisions are about _where_ a value is computed: inside Mongo's aggregation framework, denormalized onto `coins`, or in Node. The functional shape (endpoints, query params, pipelines, limits) is fixed by `requerimientos/03-etapa-2-api-rest.md`; this document records the reasoning and the places where interpretation was needed.

One project-wide constraint shapes several decisions below: this is a learning project that must cost **$0** and whose server is started only to test, never left running. That does not change any endpoint contract in this stage, but it does change how the performance and quota requirements are read — see "Risks / Trade-offs".

## Goals / Non-Goals

**Goals:**

- Every read endpoint answers from an index, never a collection scan, and the list endpoint never joins back to the time series.
- The expensive shapes (OHLC bucketing, moving average, range statistics) are computed by Mongo in one pipeline each, so Node never holds a full range in memory.
- Input validation is total: nothing untyped reaches a service, and unknown query params are an error rather than a silent no-op.
- The admin surface is protected from day one, while being honest that its protection is a placeholder for stage 3.

**Non-Goals:**

- No cursor pagination. Offset pagination is correct for the list sizes this project will ever reach; the cursor alternative is documented so the trade-off is understood, not implemented.
- No gap filling in history buckets. A bucket with no samples is absent, not `null` — a client that wants holes can derive them from the bucket boundaries.
- No shared rate-limit store. The in-memory store is correct for one API instance; Redis is stage 8's subject.
- No multi-currency. USD only, as decided project-wide.

## Decisions

- **`coins.latest` is a denormalized copy, written by the job, never by a read**: the list endpoint has to show a current price for every coin, and reading that from `price_snapshots` would mean one lookup per row or a `$lookup` into a time-series collection on every request. Instead the writer pays once per run. _Rationale_: reads outnumber writes by a wide margin here, and the copy's staleness window is bounded by the poll interval. _Alternative considered_: a `$lookup` with `$topN` per coin — rejected because it makes the cheapest, most-called endpoint the most expensive one, and it would need an index the time-series format does not naturally provide.

- **The `latest` update is one conditional `bulkWrite`, not one update per coin**: each `updateOne` carries the filter `latest.capturedAt` missing or `< newCapturedAt`. _Rationale_: this is what makes E2-6 true by construction — an older run that finishes late simply matches nothing, so out-of-order completion is safe without any locking or ordering guarantee between runs. A per-coin update loop would have the same semantics but N round trips instead of one.

- **A failed `latest` write degrades the run, it does not fail it**: the snapshots are already inserted and are the durable record; `latest` is a cache that the next run rebuilds. So the run becomes `partial` with `error.code: LATEST_UPDATE_FAILED` rather than `failed`. _Rationale_: reporting `failed` would imply the price data was lost, which is wrong, and would make the `stale` flag on `/status` lie.

- **`nameLower` exists so the search regex never needs the `i` flag**: a case-insensitive regex cannot use an index efficiently. Storing a lowercased copy of `name` (and keeping `symbol` lowercase, as stage 1 already does) lets `q` be lowercased once and matched with an anchored, escaped `^`-prefix regex that an index can serve. _Rationale_: this is the difference between `IXSCAN` and `COLLSCAN` on the list endpoint, which RNF-2.2 makes a hard requirement. The escaping also closes the regex-injection and ReDoS hole that a raw user string would open.

- **Interval selection and range validation are pure functions, separate from the route**: `selectInterval(from, to)` and `assertRangeAllowed(interval, from, to)` take dates and return a decision. _Rationale_: E2-8 and E2-9 are then unit tests over a table of ranges rather than HTTP round trips, and the same rules can be reused by any future caller (for example an export endpoint) without going through Express.

- **The SMA's warm-up window returns `null` rather than a partial average**: `$setWindowFields` will happily average fewer documents than the window asks for at the start of the series, which produces a number that is not comparable with the rest. Emitting `null` for the first `sma - 1` buckets is the honest answer. _Rationale_: E2-10 depends on it, and a silently-shorter window is the kind of bug that only shows up as a wrong chart months later.

- **`stale` is computed from `job_runs`, not from snapshot recency**: `/status` reports `stale: true` when there has been no `success`/`partial` run within `STALE_POLL_THRESHOLD_MIN`. _Rationale_: the question the endpoint answers is "is the worker alive", and a worker that runs and correctly skips (no active coins) is alive. Deriving it from the newest snapshot would report a healthy, idle system as broken.

- **`requireAdminKey` returns 404, not 401, when `ADMIN_API_KEY` is unset**: an unconfigured admin surface should be indistinguishable from one that does not exist. _Rationale_: 401 advertises that there is something there to attack. This is the same reason stage 5 later returns 404 instead of 403 for another user's alert. The comparison itself uses `crypto.timingSafeEqual` with a length pre-check, because `timingSafeEqual` throws on length mismatch and the length itself is not a secret worth defending.

- **The rate limiter is mounted on `/api`, explicitly not on `/health`**: platforms poll health endpoints frequently and from a small number of addresses; limiting them would cause a deploy to fail its own readiness check. _Rationale_: E2-15 asserts exactly this asymmetry.

- **Output DTOs are explicit, not `toJSON` transforms**: every endpoint builds its response object field by field. _Rationale_: RNF-2.5 forbids leaking `_id` and `__v`, and an explicit mapping fails visibly when a schema field is added, whereas a blanket transform silently starts exposing it.

## Risks / Trade-offs

- **[Risk]** `coins.latest` can disagree with the newest snapshot for the duration of a run, and permanently if a `bulkWrite` fails and no later run touches that coin. → **Mitigation**: `coins:rebuild-latest` recomputes the field from the time series for every coin and is safe to run at any time; the README documents it as the repair path, and `stats.latestUpdated` on each `JobRun` makes a persistent shortfall visible.
- **[Risk]** `syncIndexes`-style index drift: the four new compound indexes only help if the query shape matches them exactly (field order, sort direction). A later tweak to a sort option could silently fall back to a collection scan. → **Mitigation**: RNF-2.2 is covered by an integration test that runs `explain('executionStats')` on the list query and asserts `IXSCAN`, so drift fails CI rather than showing up as latency.
- **[Risk]** The `raw` interval's 2,000-point cap and the per-interval maximum ranges are protections against an unbounded response, but they are enforced after `from`/`to` are known and before the query runs — a range that is legal but dense could still be large. → **Mitigation**: the caps are derived from the project's own 10-minute poll interval, where 7 days of `raw` is ~1,008 points, leaving headroom; the 400 response names the coarser interval to use.
- **[Risk]** The in-memory rate-limit store means two API instances would each allow the full budget. → **Mitigation**: accepted and documented; a single instance is the only deployment this project will have before stage 8, which introduces the shared store.
- **[Trade-off]** Offset pagination degrades on deep pages because Mongo must still walk the skipped documents. With a catalog of tens of coins this is irrelevant. Accepted deliberately, with cursor pagination documented as the alternative so the limitation is understood rather than discovered.
- **[Trade-off]** `ADMIN_API_KEY` is a single shared secret with no rotation story and no per-caller identity. It is knowingly a placeholder: stage 3 deletes it. Keeping it this simple avoids building an auth system that is thrown away two stages later.

## Migration Plan

Additive with one data backfill. `coins.latest` and `nameLower` are absent on existing documents, so:

1. Deploy the schema and index changes (`autoIndex` in development creates the four new indexes; production index creation is `deploy-render`'s subject).
2. Run `npm run coins:rebuild-latest` once to populate `latest` and `nameLower` from existing snapshots. Until it runs, the list endpoint simply sorts those coins last, which is the same behavior as a coin that has never been polled — no endpoint breaks.
3. The next `poll-prices` run keeps `latest` current from then on.

Rollback is dropping the new indexes and ignoring the new fields; no existing collection changes shape, and `price_snapshots` is untouched.

## Open Questions

- The source document asks whether empty history buckets should be filled with `null` so a chart can show gaps. The default — do not fill — is what this change specifies. Revisiting it later is a pure output-shaping change to one pipeline stage and affects no stored data.
- `npm run backfill:history` depends on CoinGecko's Demo plan actually exposing `/coins/{id}/market_chart` and on what granularity it returns per requested day count, which the source document flags as needing verification against live documentation before implementation. The script is specified as optional for exactly this reason; if the endpoint is unavailable on the Demo plan, the capability's backfill requirements are dropped rather than reworked.
- The source document's overlap rule for backfilled points ("delete or skip existing points in the range") is left to be chosen and documented at implementation time. Skipping is the safer default, since deleting would discard genuinely-polled points in favour of lower-resolution imported ones.
