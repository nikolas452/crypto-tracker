## ADDED Requirements

### Requirement: JobRun document shape

The system SHALL define a `job_runs` collection with `jobName` (string, e.g. `"poll-prices"`), `trigger` (enum `schedule`/`manual`/`startup`), `status` (enum `running`/`success`/`partial`/`failed`/`skipped`), `skipReason` (enum `overlap`/`no_active_coins`/null), `startedAt` (Date, required), `finishedAt` (Date or null), `durationMs` (number or null), a `stats` object (`coinsRequested`, `coinsReturned`, `snapshotsInserted`, `skippedUnchanged`, `missingCoins`, `upstreamAttempts`), `error` (`{ code, message }` or null, never a full stack or secrets), and `workerId` (string, `hostname-pid`).

#### Scenario: JobRun document matches the fixed shape

- **WHEN** a job run completes
- **THEN** its document has `jobName`, `trigger`, `status`, `startedAt`, `finishedAt`, `durationMs`, `stats`, and `workerId`

### Requirement: Run status semantics

The system SHALL set `status: "success"` only when every requested coin was processed, `"partial"` when at least one coin was processed but some were missing, `"failed"` when no coin was processed due to an error, and `"skipped"` when no work was attempted (with `skipReason` set).

#### Scenario: All requested coins returned yields success

- **WHEN** every requested coin's price is returned and processed
- **THEN** the run's `status` is `"success"`

#### Scenario: Some but not all coins returned yields partial

- **WHEN** at least one requested coin is missing from the response but at least one was processed
- **THEN** the run's `status` is `"partial"`

### Requirement: Error field never leaks internals

The system SHALL store, on a failed run, only `error.code` and `error.message` — never a stack trace or any secret (such as the CoinGecko API key).

#### Scenario: Failed run's error field is safe to display

- **WHEN** a run fails due to an upstream error
- **THEN** `error` contains only `code` and `message`, with no stack trace or credential

### Requirement: Indexes for run history and status queries

The system SHALL maintain indexes on `{ jobName: 1, startedAt: -1 }` and `{ status: 1, startedAt: 1 }`.

#### Scenario: Latest runs for a job are queryable efficiently

- **WHEN** runs for `jobName: "poll-prices"` are queried ordered by `startedAt` descending
- **THEN** the query is served by the `{ jobName: 1, startedAt: -1 }` index

### Requirement: TTL-based run retention

The system SHALL maintain a TTL index on `startedAt` using `JOB_RUNS_RETENTION_DAYS` (default 30) so old run documents are removed automatically by MongoDB.

#### Scenario: TTL index exists with the configured retention

- **WHEN** the `job_runs` collection is inspected
- **THEN** a TTL index on `startedAt` exists with `expireAfterSeconds` matching `JOB_RUNS_RETENTION_DAYS × 86400`
