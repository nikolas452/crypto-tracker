## ADDED Requirements

### Requirement: Three job schedulers
At worker startup the system SHALL upsert exactly three job schedulers: `poll-prices` on the `POLL_PRICES_CRON` pattern, `maintenance` on `MAINTENANCE_CRON`, and `relay-notifications` every `RELAY_INTERVAL_MS` (default 120000), using BullMQ's job scheduler mechanism rather than the older repeatable-job mechanism.

#### Scenario: A fresh start creates exactly three schedulers
- **WHEN** the worker starts against an empty Redis
- **THEN** exactly 3 schedulers exist, named `poll-prices`, `maintenance` and `relay-notifications`

### Requirement: Idempotent scheduler upsert
The system SHALL upsert schedulers so that restarting the worker any number of times leaves exactly one scheduler per identifier, updating the existing one when its pattern changes.

#### Scenario: Repeated restarts do not duplicate schedulers
- **WHEN** the worker is restarted 3 times
- **THEN** exactly 3 schedulers still exist, one per identifier

#### Scenario: A changed cron pattern updates the existing scheduler
- **WHEN** `POLL_PRICES_CRON` changes and the worker restarts
- **THEN** the `poll-prices` scheduler reflects the new pattern without a second scheduler being created

### Requirement: Obsolete schedulers are removed
At startup the system SHALL remove every scheduler whose identifier is no longer part of the configured set.

#### Scenario: A removed scheduler does not linger
- **WHEN** a scheduler exists whose identifier is no longer configured and the worker starts
- **THEN** that scheduler is removed

### Requirement: Schedulers are rebuilt after data loss
Because schedulers are upserted at startup, the system SHALL restore them by restarting the worker after Redis has lost its data.

#### Scenario: Schedulers return after a flush
- **WHEN** Redis is flushed and the worker is restarted
- **THEN** the three schedulers exist again

### Requirement: Cron expression format
The system SHALL keep five-field cron expressions and SHALL document that BullMQ also accepts an optional seconds field which this project does not use.

#### Scenario: The expression format is documented
- **WHEN** a developer reads the scheduler documentation
- **THEN** it states that five-field expressions are used and that the optional seconds field is available but unused
