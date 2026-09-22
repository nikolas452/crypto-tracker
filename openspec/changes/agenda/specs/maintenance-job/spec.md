## ADDED Requirements

### Requirement: Maintenance job with independent steps
The system SHALL implement a `maintenance` job that records its own `JobRun` and executes its steps independently, so that a step failing is logged and the following steps still run.

#### Scenario: A failing step does not stop the job
- **WHEN** one maintenance step throws
- **THEN** the failure is logged and the remaining steps still execute

#### Scenario: The maintenance job records its own run
- **WHEN** `maintenance` executes
- **THEN** a `JobRun` with `jobName: "maintenance"` is created

### Requirement: Stale run recovery step
The system SHALL mark as `failed` with `error.code: "STALE"` every `JobRun` still in `running` whose `startedAt` is older than `now − STALE_RUN_THRESHOLD_MIN`, applying the same rule the worker applies at startup.

#### Scenario: A hung run is recovered by maintenance
- **WHEN** a `JobRun` has been `running` for longer than the stale threshold and maintenance executes
- **THEN** that run's status becomes `failed` with `error.code: "STALE"`

### Requirement: One-off job pruning step
The system SHALL cancel non-recurring `agenda_jobs` documents that finished more than `AGENDA_ONE_OFF_RETENTION_DAYS` (default 7) ago, and SHALL leave recurring documents untouched.

#### Scenario: Old one-off jobs are removed and recurring ones are kept
- **WHEN** one-off jobs finished 10 days ago and maintenance executes
- **THEN** those documents are removed while the recurring job documents remain

### Requirement: Failed notification reporting step
The system SHALL log at `warn`, with a count, when any notification entered `failed` in the last 24 hours.

#### Scenario: Recent delivery failures are surfaced
- **WHEN** 3 notifications failed in the last 24 hours and maintenance executes
- **THEN** a `warn` log reports that count

### Requirement: Stale polling reporting step
The system SHALL log at `warn` when `poll-prices` is stale by the same rule the status endpoint uses.

#### Scenario: A silent polling job is surfaced
- **WHEN** no successful `poll-prices` run has occurred within the staleness threshold and maintenance executes
- **THEN** a `warn` log reports that the polling job is stale
