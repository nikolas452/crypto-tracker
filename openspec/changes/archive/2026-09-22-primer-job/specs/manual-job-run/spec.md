## ADDED Requirements

### Requirement: Single manual execution

The system SHALL provide `npm run job:poll-prices`, which connects to MongoDB, runs `ensureCollections()`, executes the `poll-prices` job exactly once with `trigger: "manual"`, prints the result, and exits.

#### Scenario: Manual run executes exactly once

- **WHEN** `job:poll-prices` is run
- **THEN** the job executes exactly one time with `trigger: "manual"` and the process then exits

### Requirement: Exit code reflects run outcome

The system SHALL exit with code 0 if the run's status is `"success"`, `"partial"`, or `"skipped"`, and with code 1 if it is `"failed"`.

#### Scenario: Failed manual run exits non-zero

- **WHEN** the manual run's status is `"failed"`
- **THEN** the process exits with code 1

### Requirement: Documented overlap limitation

The system SHALL NOT coordinate with the worker's in-memory overlap guard, since it runs as a separate process. This limitation SHALL be documented, noting that snapshot deduplication (by `sourceUpdatedAt`) prevents duplicate data points even if the manual run coincides with a worker-triggered run.

#### Scenario: Manual run can coincide with a worker run without duplicating data

- **WHEN** a manual run executes at the same time as a worker-scheduled run
- **THEN** both may execute, but deduplication prevents duplicate snapshot data for the same price update
