## MODIFIED Requirements

### Requirement: Worker startup sequence

The system SHALL implement `src/worker.ts` as a process entrypoint with no HTTP server, which on startup: validates configuration (including this entrypoint's required `COINGECKO_API_KEY` and `SMTP_HOST`), connects to MongoDB, verifies that the connection supports transactions and exits 1 when it does not, runs `ensureCollections()`, calls `mailer.verify()` without aborting on failure, recovers stale runs, validates the cron expressions, schedules both jobs, optionally runs the polling job once on start, and logs a startup summary.

#### Scenario: Worker never opens an HTTP port

- **WHEN** the worker process starts
- **THEN** no HTTP server is started at any point

#### Scenario: A non-replica-set connection stops startup

- **WHEN** the worker starts against a standalone MongoDB server
- **THEN** it exits with code 1 with a message stating that a replica set is required, before scheduling any job

#### Scenario: A failing mail verification does not stop startup

- **WHEN** `mailer.verify()` fails during startup
- **THEN** an `error` is logged and the worker continues starting and scheduling jobs

### Requirement: Cron scheduling in UTC

The system SHALL validate `POLL_PRICES_CRON` and `SEND_NOTIFICATIONS_CRON` with `cron.validate()`, exiting with code 1 if either is invalid, and SHALL schedule each job with `cron.schedule(expression, handler, { timezone: 'UTC', name: <job name> })`. If `POLL_PRICES_RUN_ON_START` is `true` (default), the polling job SHALL also run once immediately with `trigger: "startup"`.

#### Scenario: Invalid cron expression fails startup

- **WHEN** either cron expression is not valid
- **THEN** the worker exits with code 1 before scheduling anything

#### Scenario: Both jobs are scheduled in UTC

- **WHEN** the worker starts successfully
- **THEN** `poll-prices` and `send-notifications` are both scheduled with the UTC timezone

### Requirement: In-memory overlap guard

The system SHALL track an in-memory `isRunning` flag **per job**, so `poll-prices` and `send-notifications` guard each other independently. If a scheduled tick arrives while that job's flag is `true`, the system SHALL NOT execute the job, SHALL instead create a `JobRun` with `status: "skipped"` and `skipReason: "overlap"` (with equal `startedAt`/`finishedAt`), and SHALL log at `warn`. Each flag SHALL be released in a `finally` block so a job failure cannot leave it stuck.

#### Scenario: Overlapping tick is skipped without calling CoinGecko

- **WHEN** a scheduled tick arrives while the previous run of the same job is still in progress
- **THEN** a `JobRun` with `status: "skipped"` and `skipReason: "overlap"` is created, and no CoinGecko call is made for that tick

#### Scenario: One job running does not block the other

- **WHEN** `poll-prices` is running and a `send-notifications` tick arrives
- **THEN** `send-notifications` executes normally, because the guards are per job

### Requirement: Ordered worker shutdown

On `SIGTERM`/`SIGINT`, the system SHALL stop all cron tasks (`task.stop()`) so no new run starts, wait up to `WORKER_SHUTDOWN_TIMEOUT_MS` (default 30000) for any in-progress run of either job to finish, then disconnect MongoDB and exit with code 0. If the timeout elapses first, the system SHALL exit with code 1 without touching the in-progress run's document, leaving it for stale-run recovery on the next startup and, for a notification left in `sending`, for stale-lock recovery by the send job.

#### Scenario: In-progress run is allowed to finish before shutdown completes

- **WHEN** `SIGTERM` is received while a run is in progress and it finishes within the timeout
- **THEN** the process exits with code 0 only after that run's `JobRun` document is closed

#### Scenario: A notification left locked by a killed worker is recovered later

- **WHEN** the process exits on timeout while a notification is in `sending`
- **THEN** that notification is left untouched and is returned to `pending` by the next run's stale-lock recovery
