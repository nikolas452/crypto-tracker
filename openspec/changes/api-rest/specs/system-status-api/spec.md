## ADDED Requirements

### Requirement: Public status endpoint
The system SHALL expose `GET /api/v1/status` without authentication, responding `{ data: { activeCoins, pollPrices: { lastSuccessAt, lastRunAt, lastRunStatus, stale } } }`, where `activeCoins` is the count of coins with `isActive: true`.

#### Scenario: Status is readable without credentials
- **WHEN** an unauthenticated client calls `GET /api/v1/status`
- **THEN** the response is 200 with `activeCoins` and a `pollPrices` summary

### Requirement: Last run and last success derivation
The system SHALL set `lastRunAt` and `lastRunStatus` from the most recent `JobRun` with `jobName: "poll-prices"`, and `lastSuccessAt` from the `finishedAt` of the most recent such run whose status is `success` or `partial`.

#### Scenario: A partial run counts as a success for liveness
- **WHEN** the most recent completed `poll-prices` run has `status: "partial"`
- **THEN** `lastSuccessAt` is that run's `finishedAt`

#### Scenario: No runs yet yields null timestamps
- **WHEN** no `poll-prices` run has ever been recorded
- **THEN** `lastRunAt`, `lastRunStatus` and `lastSuccessAt` are `null`

### Requirement: Staleness flag
The system SHALL set `stale` to `true` when there has been no `success` or `partial` run within the last `STALE_POLL_THRESHOLD_MIN` minutes (default 30), or when there has never been one, and to `false` otherwise.

#### Scenario: A worker silent for 45 minutes reports stale
- **WHEN** the most recent successful `poll-prices` run finished 45 minutes ago and the threshold is 30 minutes
- **THEN** `stale` is `true`

#### Scenario: A recent successful run reports healthy
- **WHEN** a successful `poll-prices` run finished 5 minutes ago and the threshold is 30 minutes
- **THEN** `stale` is `false`

### Requirement: Status never exposes internals
The system SHALL NOT include error messages, error codes, stack traces, worker identifiers or any other internal detail in the status response.

#### Scenario: A failed last run does not leak its error
- **WHEN** the most recent `poll-prices` run has `status: "failed"` with a populated `error` field
- **THEN** the response reports `lastRunStatus: "failed"` and contains no error message or code
