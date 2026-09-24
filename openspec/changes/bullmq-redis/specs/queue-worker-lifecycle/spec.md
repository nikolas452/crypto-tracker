## ADDED Requirements

### Requirement: One worker process hosting the configured workers

The system SHALL have a single `worker.ts` process create the BullMQ workers for the queues named in `WORKER_QUEUES` (default all four), so a deployment can dedicate a process to a subset of queues.

#### Scenario: All queues are consumed by default

- **WHEN** the worker starts with default configuration
- **THEN** it creates workers for `prices`, `alerts`, `notifications` and `maintenance`

#### Scenario: A process can be dedicated to one queue

- **WHEN** `WORKER_QUEUES` names only `notifications`
- **THEN** the process consumes only that queue

### Requirement: Error listeners on every queue and worker

The system SHALL attach an `error` listener to every `Queue` and every `Worker`, logging at `error`, as the library's production guidance requires.

#### Scenario: A connection error is logged rather than silently dropped

- **WHEN** a queue or worker emits an `error` event
- **THEN** it is logged at `error` with the queue name

### Requirement: Job outcome logging

The system SHALL log each worker's `failed` events at `warn` and `completed` events at `debug`, including `queue`, `jobId`, `attemptsMade` and the error code where present.

#### Scenario: A failed job is logged with its attempt count

- **WHEN** a job fails
- **THEN** a `warn` log records the queue, job id, attempts made and error code

### Requirement: Ordered shutdown

On `SIGTERM`/`SIGINT` the system SHALL close all workers — waiting for in-flight jobs up to `WORKER_SHUTDOWN_TIMEOUT_MS` — then close the queues, then the Redis connections, then MongoDB, and exit.

#### Scenario: An in-flight send completes before shutdown

- **WHEN** `SIGTERM` arrives while a `send-notification` job is running and it finishes within the timeout
- **THEN** the message is sent, the notification is marked `sent`, and the process exits with code 0

#### Scenario: Resources are closed in order

- **WHEN** the worker shuts down
- **THEN** workers close before queues, queues before Redis connections, and Redis before MongoDB

### Requirement: Stalled jobs are returned to the queue

The system SHALL rely on BullMQ's stalled-job detection to return to the queue any job whose worker stopped processing it, and SHALL document that the notification claim makes reprocessing safe.

#### Scenario: A killed worker's job is reprocessed safely

- **WHEN** a worker is killed mid-job and BullMQ detects the job as stalled
- **THEN** the job is returned to the queue and its reprocessing is made safe by the MongoDB claim
