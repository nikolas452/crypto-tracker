## ADDED Requirements

### Requirement: Price logic unchanged, alert evaluation removed

The `poll-prices` processor SHALL run the existing price collection and `latest` refresh logic and SHALL record its `JobRun` exactly as before, but SHALL NOT evaluate alerts inline.

#### Scenario: The polling job no longer evaluates alerts

- **WHEN** `poll-prices` runs
- **THEN** it stores snapshots and refreshes `latest`, and performs no alert evaluation of its own

### Requirement: Fan-out to per-coin evaluation jobs

For each coin that received a new snapshot, the system SHALL enqueue one `evaluate-alerts` job carrying `{ coinId, capturedAt, value }`, adding them in a single bulk operation with the deterministic job id from the queue topology.

#### Scenario: Four updated coins produce four evaluation jobs

- **WHEN** a run updates 4 coins
- **THEN** 4 `evaluate-alerts` jobs are enqueued with distinct job ids

#### Scenario: Re-enqueueing the same batch creates no duplicates

- **WHEN** the same batch of coin and `capturedAt` pairs is enqueued again
- **THEN** no additional jobs are created

### Requirement: Enqueue failure degrades the run

When enqueueing the evaluation jobs fails, the system SHALL close the run as `partial` with `error.code: "ENQUEUE_FAILED"`, retaining the stored prices, and SHALL rely on the next run producing a new `capturedAt` to evaluate those alerts.

#### Scenario: A Redis outage does not lose price data

- **WHEN** Redis is unreachable at the moment of the fan-out
- **THEN** the run's status is `"partial"` with `error.code: "ENQUEUE_FAILED"` and the inserted snapshots remain

### Requirement: Failure handling drives BullMQ retries

When the price collection itself returns a `failed` result, the processor SHALL throw so BullMQ applies the queue's `attempts` and `backoff`, and SHALL throw `COINGECKO_AUTH` failures as unrecoverable so no retry is attempted.

#### Scenario: A transient upstream failure is retried by the queue

- **WHEN** the polling job fails with a transient upstream error
- **THEN** the processor throws and BullMQ retries according to the `prices` queue's attempts and backoff

#### Scenario: An authentication failure is not retried

- **WHEN** the polling job fails with `COINGECKO_AUTH`
- **THEN** the processor throws an unrecoverable error and BullMQ makes no further attempt

### Requirement: Cross-worker exclusion keeps the lease lock

The system SHALL continue to guard `poll-prices` with the lease lock, because per-worker concurrency does not prevent a scheduled job and a manually triggered one from running simultaneously across workers. If the installed BullMQ version offers a suitable global queue concurrency control, substituting it SHALL be a documented decision.

#### Scenario: A held lease still skips the run

- **WHEN** the `poll-prices` lease is held by another owner and the processor runs
- **THEN** a `JobRun` with `status: "skipped"` and `skipReason: "locked"` is recorded and no CoinGecko call is made
