## ADDED Requirements

### Requirement: Adapters are thin and receive dependencies by closure

The system SHALL implement each Agenda handler as a thin adapter that reads `job.attrs.data`, calls the corresponding function in `src/jobs/*`, and translates the result, receiving its dependencies through a factory closure rather than importing them directly. The business logic SHALL remain unchanged and scheduler-agnostic.

#### Scenario: Job logic stays independent of the scheduler

- **WHEN** an adapter runs a job
- **THEN** the underlying job function is invoked with injected dependencies and has no reference to Agenda

### Requirement: Trigger derivation

The `poll-prices` adapter SHALL derive the run's trigger from `data.trigger`, defaulting to `agenda` when the field is absent.

#### Scenario: A scheduled run is attributed to the scheduler

- **WHEN** the recurring `poll-prices` job runs with no `trigger` in its data
- **THEN** the resulting `JobRun` has `trigger: "agenda"`

#### Scenario: An API-triggered run keeps its attribution

- **WHEN** a job is enqueued with `data.trigger` set to `api`
- **THEN** the resulting `JobRun` has `trigger: "api"`

### Requirement: Only a failed result throws

The `poll-prices` adapter SHALL throw `JobFailedError(code, message)` when the job's result is `failed`, so Agenda records the failure, and SHALL NOT throw for a `skipped` or `partial` result. The `JobRun` document SHALL be written before the error is thrown.

#### Scenario: A failed run is recorded by Agenda

- **WHEN** the polling job returns a `failed` result
- **THEN** the adapter throws and Agenda increments that job's failure count and records a failure reason

#### Scenario: A partial run is not a job failure

- **WHEN** the polling job returns a `partial` result
- **THEN** the adapter returns normally and Agenda does not record a failure

#### Scenario: A skipped run is not a job failure

- **WHEN** the polling job returns a `skipped` result because the lease was held
- **THEN** the adapter returns normally and Agenda does not record a failure

#### Scenario: The run document survives a thrown failure

- **WHEN** the adapter throws for a failed run
- **THEN** the corresponding `JobRun` document has already been written with its status and error

### Requirement: Send notifications adapter throws only on infrastructure failure

The `send-notifications` adapter SHALL throw only when an infrastructure failure prevents the job from running, and SHALL NOT throw for individual SMTP send failures, which the outbox handles through its own retry state.

#### Scenario: An individual send failure does not fail the job

- **WHEN** one notification fails to send with a transient SMTP error
- **THEN** the adapter returns normally and the notification is retried through the outbox

#### Scenario: A database outage fails the job

- **WHEN** the send job cannot reach the database at all
- **THEN** the adapter throws so Agenda records the failure
