## ADDED Requirements

### Requirement: Job lifecycle event logging

The system SHALL log Agenda's `start` and `success` events at `debug` with `jobName` and `agendaJobId`, and its `fail` event at `error` with `jobName`, `agendaJobId`, `error.code` and the stack.

#### Scenario: A successful run logs at debug

- **WHEN** a job starts and completes successfully
- **THEN** `debug` log lines record the start and the success, each including `jobName` and `agendaJobId`

#### Scenario: A failure logs at error with its stack

- **WHEN** a job fails
- **THEN** an `error` log line records `jobName`, `agendaJobId`, the error code and the stack trace

### Requirement: Stacks stay out of the persisted failure reason

The system SHALL write the stack trace only to the log, never into Agenda's persisted `failReason` field.

#### Scenario: The stored failure reason carries no stack

- **WHEN** a job fails and Agenda stores a `failReason`
- **THEN** that stored value contains no stack trace

### Requirement: Periodic counter summary

The system SHALL maintain in-memory counters per job for `started`, `succeeded` and `failed`, and SHALL emit them at `info` every 10 minutes from the worker process.

#### Scenario: Counters are reported periodically

- **WHEN** the worker has been running for more than 10 minutes
- **THEN** an `info` log line reports the per-job started, succeeded and failed counts
