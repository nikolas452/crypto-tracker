## ADDED Requirements

### Requirement: Worker startup sequence
The system SHALL implement `src/worker.ts` as a process entrypoint with no HTTP server, which on startup: validates configuration (including this entrypoint's required `COINGECKO_API_KEY`), connects to MongoDB and runs `ensureCollections()`, recovers stale runs, validates the cron expression, schedules the job, optionally runs it once on start, and logs a startup summary.

#### Scenario: Worker never opens an HTTP port
- **WHEN** the worker process starts
- **THEN** no HTTP server is started at any point

### Requirement: COINGECKO_API_KEY required for this entrypoint
The system SHALL require `COINGECKO_API_KEY` to be present when `worker.ts` starts, failing fast (fatal log, exit 1) if it is missing, using the same config-validation mechanism as `setup-base`'s `app-config` capability. The API entrypoint SHALL NOT require this variable.

#### Scenario: Missing API key fails the worker fast
- **WHEN** the worker starts without `COINGECKO_API_KEY` set
- **THEN** it logs a fatal error naming the missing variable and exits with code 1, without scheduling any job

### Requirement: Stale run recovery on startup
On startup, the system SHALL mark as `failed` (with `error.code: "STALE"`) every `JobRun` with `status: "running"` and `startedAt` older than `now - STALE_RUN_THRESHOLD_MIN` (default 15 minutes).

#### Scenario: A stale running JobRun is recovered on startup
- **WHEN** a `JobRun` has `status: "running"` and `startedAt` 20 minutes in the past, and the worker starts
- **THEN** that run's `status` becomes `"failed"` with `error.code: "STALE"`

### Requirement: Cron scheduling in UTC
The system SHALL validate `POLL_PRICES_CRON` with `cron.validate()`, exiting with code 1 if invalid, and SHALL schedule the job with `cron.schedule(POLL_PRICES_CRON, handler, { timezone: 'UTC', name: 'poll-prices' })`. If `POLL_PRICES_RUN_ON_START` is `true` (default), the job SHALL also run once immediately with `trigger: "startup"`.

#### Scenario: Invalid cron expression fails startup
- **WHEN** `POLL_PRICES_CRON` is not a valid cron expression
- **THEN** the worker exits with code 1 before scheduling anything

### Requirement: In-memory overlap guard
The system SHALL track an in-memory `isRunning` flag per job. If a scheduled tick arrives while the flag is `true`, the system SHALL NOT execute the job, SHALL instead create a `JobRun` with `status: "skipped"` and `skipReason: "overlap"` (with equal `startedAt`/`finishedAt`), and SHALL log at `warn`. The flag SHALL be released in a `finally` block so a job failure cannot leave it stuck.

#### Scenario: Overlapping tick is skipped without calling CoinGecko
- **WHEN** a scheduled tick arrives while the previous run of the same job is still in progress
- **THEN** a `JobRun` with `status: "skipped"` and `skipReason: "overlap"` is created, and no CoinGecko call is made for that tick

### Requirement: Ordered worker shutdown
On `SIGTERM`/`SIGINT`, the system SHALL stop all cron tasks (`task.stop()`) so no new run starts, wait up to `WORKER_SHUTDOWN_TIMEOUT_MS` (default 30000) for any in-progress run to finish, then disconnect MongoDB and exit with code 0. If the timeout elapses first, the system SHALL exit with code 1 without touching the in-progress run's document, leaving it for stale-run recovery on the next startup.

#### Scenario: In-progress run is allowed to finish before shutdown completes
- **WHEN** `SIGTERM` is received while a run is in progress and it finishes within the timeout
- **THEN** the process exits with code 0 only after that run's `JobRun` document is closed
