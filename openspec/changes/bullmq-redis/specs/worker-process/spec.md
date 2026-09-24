## MODIFIED Requirements

### Requirement: Worker startup sequence

The system SHALL implement `src/worker.ts` as a process entrypoint with no HTTP server, which on startup: validates configuration (including this entrypoint's required `COINGECKO_API_KEY`, `SMTP_HOST` and `REDIS_URL`), connects to MongoDB, verifies that the connection supports transactions and exits 1 when it does not, runs `ensureCollections()`, calls `mailer.verify()` without aborting on failure, verifies Redis connectivity and its eviction policy, recovers stale runs, upserts the job schedulers and removes obsolete ones, creates the BullMQ workers for the queues named in `WORKER_QUEUES`, and logs a startup summary.

#### Scenario: Worker never opens an HTTP port

- **WHEN** the worker process starts
- **THEN** no HTTP server is started at any point

#### Scenario: A non-replica-set connection stops startup

- **WHEN** the worker starts against a standalone MongoDB server
- **THEN** it exits with code 1 with a message stating that a replica set is required, before creating any worker

#### Scenario: A failing mail verification does not stop startup

- **WHEN** `mailer.verify()` fails during startup
- **THEN** an `error` is logged and the worker continues starting

#### Scenario: Queue consumers are created for the configured queues

- **WHEN** the worker starts with default configuration
- **THEN** it creates BullMQ workers for `prices`, `alerts`, `notifications` and `maintenance`

### Requirement: Startup run goes through the lease

When `POLL_PRICES_RUN_ON_START` is `true` (default), the system SHALL enqueue one immediate `poll-prices` job rather than invoking the job directly, so the lease decides whether it actually executes.

#### Scenario: A startup run defers to a worker already polling

- **WHEN** a second worker starts while the first is running `poll-prices`
- **THEN** the second worker's startup run is skipped with `skipReason: "locked"` instead of running concurrently

### Requirement: Ordered worker shutdown

On `SIGTERM`/`SIGINT`, the system SHALL close every BullMQ worker, waiting for in-flight jobs up to `WORKER_SHUTDOWN_TIMEOUT_MS` (default 30000), then close the queues, then the Redis connections, then disconnect MongoDB, and exit. Any job not finished within the timeout SHALL be left for BullMQ's stalled-job detection to return to its queue.

#### Scenario: In-progress run is allowed to finish before shutdown completes

- **WHEN** `SIGTERM` is received while a job is in progress and it finishes within the timeout
- **THEN** the process exits with code 0 only after that job completes

#### Scenario: An in-flight send completes before shutdown

- **WHEN** `SIGTERM` arrives during a `send-notification` job that finishes within the timeout
- **THEN** the message is sent, the notification is marked `sent`, and the process exits with code 0

#### Scenario: Resources are closed in order

- **WHEN** the worker shuts down
- **THEN** workers close before queues, queues before Redis connections, and Redis before MongoDB

#### Scenario: An unfinished job is returned to its queue

- **WHEN** the shutdown timeout elapses with a job still running
- **THEN** that job is left for stalled-job detection to return to its queue rather than being marked failed
