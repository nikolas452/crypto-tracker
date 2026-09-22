## MODIFIED Requirements

### Requirement: Job scheduling and run tracking
The system SHALL schedule `send-notifications` as an Agenda recurring job using `SEND_NOTIFICATIONS_CRON` (default every minute) with `concurrency: 1`, `lockLimit: 1` and a `lockLifetime` of 5 minutes, and SHALL record each execution as a `JobRun` with `jobName: "send-notifications"`. The job SHALL NOT use a lease lock, because its atomic per-notification claim already guarantees each notification is sent once; that reasoning SHALL be documented.

#### Scenario: The send job records its own runs
- **WHEN** `send-notifications` executes
- **THEN** a `JobRun` with `jobName: "send-notifications"` is created for that execution

#### Scenario: Concurrent send executions remain safe without a lease
- **WHEN** two `send-notifications` executions overlap across workers
- **THEN** each pending notification is claimed and sent exactly once, with no lease involved

#### Scenario: The absence of a lease is explained
- **WHEN** a developer reads the documentation for this job
- **THEN** it states that no lease is needed because the atomic claim prevents duplicate sends
