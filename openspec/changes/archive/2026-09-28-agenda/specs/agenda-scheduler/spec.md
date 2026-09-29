## ADDED Requirements

### Requirement: Agenda factory with an explicit role

The system SHALL expose `createAgenda({ db, role })` in `src/scheduler/agenda.ts`, where `role` is `'worker'` or `'producer'`, returning an Agenda instance configured with the Mongo backend bound to the `agenda_jobs` collection, `processEvery` from `AGENDA_PROCESS_EVERY` (default `'10 seconds'`), `maxConcurrency` from `AGENDA_MAX_CONCURRENCY` (default 5) and `defaultConcurrency` of 1.

#### Scenario: The factory returns a configured instance

- **WHEN** `createAgenda` is called with a database handle and a role
- **THEN** it returns an Agenda instance bound to the `agenda_jobs` collection with the configured polling interval and concurrency limits

### Requirement: Worker role registers and processes

With `role: 'worker'` the system SHALL register the job definitions and the event listeners, and SHALL call `start()` so this process consumes due jobs.

#### Scenario: The worker processes due jobs

- **WHEN** the worker's Agenda instance is started and a job is due
- **THEN** that job's handler executes in the worker process

### Requirement: Producer role never processes

With `role: 'producer'` the system SHALL NOT register any job definition and SHALL NOT call `start()`, so the process can enqueue work but never executes it.

#### Scenario: The API never runs a job

- **WHEN** the API is running and a job is enqueued with no worker active
- **THEN** the job remains pending and is executed only once a worker process starts

### Requirement: Single shared database connection

The system SHALL configure the Agenda backend against the existing Mongoose connection's database handle, and SHALL verify that Mongoose and Agenda resolve to the same MongoDB driver version. When they do not, the system SHALL fall back to configuring Agenda with the connection URI and SHALL document that a second connection is in use.

#### Scenario: Agenda shares the application's connection

- **WHEN** driver versions match and the worker starts
- **THEN** Agenda operates over the existing Mongoose connection rather than opening its own

### Requirement: Job names are centralized

The system SHALL define the job names once as a constant `JOB_NAMES = { POLL_PRICES: 'poll-prices', SEND_NOTIFICATIONS: 'send-notifications', MAINTENANCE: 'maintenance' }` used by every definition, producer call and admin endpoint.

#### Scenario: Every caller uses the shared constant

- **WHEN** a job is defined, enqueued or validated by name
- **THEN** the name comes from `JOB_NAMES` rather than a repeated string literal
