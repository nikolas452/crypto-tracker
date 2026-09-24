## ADDED Requirements

### Requirement: Three recurring job definitions

The system SHALL define exactly three jobs: `poll-prices` scheduled with `POLL_PRICES_CRON` at high priority, `send-notifications` scheduled with `SEND_NOTIFICATIONS_CRON` at high priority, each with `concurrency: 1`, `lockLimit: 1` and a `lockLifetime` of 5 minutes; and `maintenance` scheduled with `MAINTENANCE_CRON` (default `15 3 * * *`) at low priority with `concurrency: 1`, `lockLimit: 1` and a `lockLifetime` of 15 minutes.

#### Scenario: A fresh database gets exactly three recurring jobs

- **WHEN** the worker starts against an empty database
- **THEN** `agenda_jobs` contains exactly 3 recurring jobs named `poll-prices`, `send-notifications` and `maintenance`

### Requirement: Cron expressions are evaluated in UTC

The system SHALL evaluate every job's cron expression in UTC, passing an explicit `'UTC'` timezone option when the installed Agenda version supports one and otherwise running the process with `TZ=UTC`.

#### Scenario: Scheduling does not depend on the host timezone

- **WHEN** the worker runs on a host whose local timezone is not UTC
- **THEN** each job's next run time is computed from its cron expression interpreted in UTC

### Requirement: Idempotent recurring registration

The system SHALL call `every()` for each recurring job at every startup, so that repeated restarts leave exactly one recurring document per job name, and SHALL update the existing document when the cron expression changes.

#### Scenario: Restarting does not duplicate recurring jobs

- **WHEN** the worker is restarted 3 times
- **THEN** exactly 1 recurring document exists per job name

#### Scenario: A changed expression updates the existing schedule

- **WHEN** `POLL_PRICES_CRON` is changed to `*/15 * * * *` and the worker is restarted
- **THEN** the `poll-prices` recurring document's `nextRunAt` corresponds to the new interval

### Requirement: Registration does not re-enable a disabled job

The system SHALL NOT re-enable a recurring job that an administrator has disabled, even though `every()` is called again at startup.

#### Scenario: A disabled job survives a restart

- **WHEN** an administrator disables `poll-prices` and the worker is restarted
- **THEN** the job remains disabled and does not execute when its next run time passes

### Requirement: Obsolete recurring jobs are removed

At startup the system SHALL cancel every recurring document in `agenda_jobs` whose name is not present in `JOB_NAMES`.

#### Scenario: A renamed job leaves no orphan

- **WHEN** a recurring document exists whose name is no longer defined and the worker starts
- **THEN** that document is cancelled and no longer scheduled
