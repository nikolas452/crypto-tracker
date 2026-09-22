## MODIFIED Requirements

### Requirement: Worker startup sequence
The system SHALL implement `src/worker.ts` as a process entrypoint with no HTTP server, which on startup: validates configuration (including this entrypoint's required `COINGECKO_API_KEY` and `SMTP_HOST`), connects to MongoDB, verifies that the connection supports transactions and exits 1 when it does not, runs `ensureCollections()`, calls `mailer.verify()` without aborting on failure, recovers stale runs, creates Agenda with `role: 'worker'`, registers the job definitions and event listeners, registers the recurring schedules with `every()`, cancels obsolete recurring documents, calls `await agenda.start()`, optionally enqueues one startup run of the polling job, and logs a startup summary.

#### Scenario: Worker never opens an HTTP port
- **WHEN** the worker process starts
- **THEN** no HTTP server is started at any point

#### Scenario: A non-replica-set connection stops startup
- **WHEN** the worker starts against a standalone MongoDB server
- **THEN** it exits with code 1 with a message stating that a replica set is required, before scheduling any job

#### Scenario: A failing mail verification does not stop startup
- **WHEN** `mailer.verify()` fails during startup
- **THEN** an `error` is logged and the worker continues starting and scheduling jobs

#### Scenario: Startup completes quickly
- **WHEN** the worker starts with Agenda
- **THEN** startup completes in under 5 seconds

### Requirement: Startup run goes through the lease
When `POLL_PRICES_RUN_ON_START` is `true` (default), the system SHALL enqueue one immediate `poll-prices` job with `trigger: "startup"` rather than invoking the job directly, so the lease decides whether it actually executes.

#### Scenario: A startup run defers to a worker already polling
- **WHEN** a second worker starts while the first is running `poll-prices`
- **THEN** the second worker's startup run is skipped with `skipReason: "locked"` instead of running concurrently

## REMOVED Requirements

### Requirement: Cron scheduling in UTC
**Reason**: Scheduling moved from `node-cron` to Agenda, where the schedule is persisted in `agenda_jobs` rather than held in process memory. `node-cron` is removed from the project's dependencies.
**Migration**: Cron expressions are now registered through Agenda's `every()` by the `agenda-job-definitions` capability, still evaluated in UTC and still read from `POLL_PRICES_CRON`, `SEND_NOTIFICATIONS_CRON` and `MAINTENANCE_CRON`. Expression validity is reported by Agenda at registration time instead of by `cron.validate()`.

### Requirement: In-memory overlap guard
**Reason**: An in-memory flag cannot coordinate between the worker, a second worker, or the manual `job:poll-prices` script, which was the limitation this stage exists to remove. It is superseded by Agenda's own job locking together with the `lease-lock` capability.
**Migration**: `poll-prices` is guarded by the lease lock, which records `status: "skipped"` with `skipReason: "locked"` when another owner holds it. `send-notifications` needs no guard because its atomic per-notification claim already prevents duplicate sends.

## MODIFIED Requirements

### Requirement: Ordered worker shutdown
On `SIGTERM`/`SIGINT`, the system SHALL call `agenda.drain(WORKER_SHUTDOWN_TIMEOUT_MS)` (default 30000) to wait for in-flight jobs to finish. If the result reports a timeout, the system SHALL log at `warn` how many jobs remained and call `agenda.stop()` to release their locks so another worker can retake them. It SHALL then disconnect MongoDB and exit.

#### Scenario: In-progress run is allowed to finish before shutdown completes
- **WHEN** `SIGTERM` is received while a run is in progress and it finishes within the timeout
- **THEN** the process exits only after that run's `JobRun` document is closed, with exit code 0

#### Scenario: A timed-out drain releases locks for another worker
- **WHEN** the drain timeout elapses with jobs still running
- **THEN** a `warn` reports the remaining count, `agenda.stop()` releases their locks, and the work is retaken by the next worker rather than lost

#### Scenario: A killed worker's lease expires
- **WHEN** the platform kills the process before shutdown completes
- **THEN** the Agenda lock expires after `lockLifetime` and the lease expires after its TTL, so the job becomes available again
