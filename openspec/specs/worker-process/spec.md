## Purpose

This capability defines startup requirements shared by the worker and API entrypoints that depend on CoinGecko, ensuring missing configuration fails fast instead of surfacing later as runtime errors.

## Requirements

### Requirement: COINGECKO_API_KEY required for this entrypoint

The system SHALL require `COINGECKO_API_KEY` to be present when `worker.ts` starts, failing fast (fatal log, exit 1) if it is missing, using the same config-validation mechanism as `setup-base`'s `app-config` capability. The API entrypoint SHALL also require this variable, because the admin coin management endpoints call CoinGecko to validate coin identifiers.

#### Scenario: Missing API key fails the worker fast

- **WHEN** the worker starts without `COINGECKO_API_KEY` set
- **THEN** it logs a fatal error naming the missing variable and exits with code 1, without scheduling any job

#### Scenario: Missing API key fails the API fast

- **WHEN** the API starts without `COINGECKO_API_KEY` set
- **THEN** it logs a fatal error naming the missing variable and exits with code 1, without listening for requests

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
