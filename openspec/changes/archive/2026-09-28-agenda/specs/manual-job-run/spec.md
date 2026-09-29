## MODIFIED Requirements

### Requirement: Documented overlap limitation

The system SHALL have `npm run job:poll-prices` acquire the same `poll-prices` lease the worker uses, so a manual run that coincides with a worker-driven run is skipped rather than executed concurrently. When the lease cannot be acquired, the script SHALL record a `JobRun` with `status: "skipped"` and `skipReason: "locked"` and exit without error. The previously documented limitation — that the manual script could not coordinate with the worker's in-memory guard — no longer applies.

#### Scenario: A manual run skips while the worker is polling

- **WHEN** `job:poll-prices` is started while the worker holds the `poll-prices` lease
- **THEN** the manual run records `status: "skipped"` with `skipReason: "locked"`, makes no CoinGecko call, and exits with code 0

#### Scenario: A manual run proceeds when no lease is held

- **WHEN** `job:poll-prices` is started while no other process holds the lease
- **THEN** it acquires the lease, runs the job once, and releases the lease when finished
