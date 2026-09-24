## ADDED Requirements

### Requirement: Job factory and dependencies

The system SHALL implement the job as `createPollPricesJob(deps)`, where `deps` includes `coinsRepo`, `snapshotsRepo`, `jobRunsRepo`, `coingecko`, `clock`, `logger`, and `workerId`, returning a `run(trigger): Promise<JobRunResult>` function with no knowledge of any scheduler.

#### Scenario: Job runs correctly with fake dependencies

- **WHEN** `run(trigger)` is called with fake repos and a fake CoinGecko client
- **THEN** it completes using only the injected dependencies, making no real network or scheduler calls

### Requirement: No active coins short-circuits the run

If there are no coins with `isActive: true`, the run SHALL close immediately as `skipped` with `skipReason: "no_active_coins"`, without calling CoinGecko.

#### Scenario: No active coins skips without calling CoinGecko

- **WHEN** `run()` is called and no coin has `isActive: true`
- **THEN** the resulting `JobRun` has `status: "skipped"` and `skipReason: "no_active_coins"`, and the CoinGecko client is never called

### Requirement: Deduplication via a single aggregation

The system SHALL determine, in one aggregation over `price_snapshots` (`$match` on requested `meta.coingeckoId` → `$sort` by `timestamp` descending → `$group` with `$first`), each requested coin's most recent `sourceUpdatedAt`. A coin whose new `sourceUpdatedAt` equals its last stored value SHALL be skipped (counted in `stats.skippedUnchanged`) and not inserted; if either value is `null`, the point SHALL be inserted.

#### Scenario: Unchanged price is not duplicated

- **WHEN** CoinGecko returns the same `last_updated_at` for bitcoin as its most recent stored snapshot
- **THEN** no new snapshot is inserted for bitcoin and `stats.skippedUnchanged` is incremented

### Requirement: Snapshot insertion shares one timestamp per run

The system SHALL insert new snapshots with `insertMany(docs, { ordered: false })`, all sharing the same `timestamp` value (the `clock.now()` captured when the run started), so all points from one run are aligned in time.

#### Scenario: All snapshots from one run share a timestamp

- **WHEN** a run inserts snapshots for 3 coins
- **THEN** all 3 inserted documents have the identical `timestamp` value

### Requirement: Missing coins are tracked and reflected in status

Coins requested but not returned by CoinGecko SHALL be recorded in `stats.missingCoins` and logged at `warn`. The run's final `status` SHALL be `"success"` if `missingCoins` is empty, `"partial"` if some but not all coins are missing, and `"failed"` if none came back.

#### Scenario: Partial response yields a partial run

- **WHEN** CoinGecko returns 2 of 3 requested coins
- **THEN** the run's `status` is `"partial"` and the missing coin appears in `stats.missingCoins`

### Requirement: The job function never throws

Any exception during a run SHALL be caught, close the `JobRun` as `failed` with `error.code` (the upstream error's code, or `"INTERNAL"`) and `error.message`, and be logged at `error` with its stack. `run()` SHALL always resolve, never reject.

#### Scenario: An unexpected error still resolves with a failed result

- **WHEN** an unexpected exception occurs during a run
- **THEN** `run()` resolves (does not throw) with a result whose `status` is `"failed"` and whose `error` field is populated

### Requirement: Run start/end logging

The system SHALL log at `info` both the start and the end of a run, including `runId`, `trigger`, `status`, `durationMs`, and `stats`.

#### Scenario: Every run produces a start and end log line

- **WHEN** a run completes, regardless of outcome
- **THEN** an `info` log line exists for the run's start and another for its end, both including `runId`
