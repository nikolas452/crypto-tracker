## ADDED Requirements

### Requirement: The two schedulers never run together
The system SHALL require that the Agenda worker be stopped before the BullMQ worker is started, so the same jobs are never processed by both, and SHALL document that as an absolute rule.

#### Scenario: The cutover is sequential
- **WHEN** the migration is performed
- **THEN** the Agenda worker is stopped before the BullMQ worker starts, and at no point are both consuming the same jobs

### Requirement: Migration script
The system SHALL provide `npm run migrate:agenda-to-bullmq`, which cancels the jobs held in `agenda_jobs`, enqueues every notification MongoDB still lists as `pending` in the same way the relay does, and reports what it did.

#### Scenario: Pending notifications survive the cutover
- **WHEN** the migration script runs with notifications still pending from the Agenda era
- **THEN** each is enqueued as a `send-notification` job and the script reports the count

#### Scenario: Agenda's scheduled jobs are cancelled
- **WHEN** the migration script runs
- **THEN** the jobs in `agenda_jobs` are cancelled so nothing remains scheduled there

### Requirement: Staged retirement of Agenda
After a documented period of stable operation, the system SHALL drop the `agenda_jobs` collection and remove the `agenda` and `@agendajs/mongo-backend` dependencies.

#### Scenario: Agenda is fully removed after the stable period
- **WHEN** the stable period has passed and retirement is performed
- **THEN** the `agenda_jobs` collection is dropped and neither Agenda package remains in `package.json`

### Requirement: Rollback remains possible before retirement
The system SHALL keep rollback available until Agenda is retired, by stopping the BullMQ worker and restarting the Agenda one, relying on the notifications outbox being the shared authoritative state.

#### Scenario: Reverting loses no notifications
- **WHEN** the BullMQ worker is stopped and the Agenda worker restarted before retirement
- **THEN** pending notifications are still delivered, because both paths read the same outbox

### Requirement: Contract changes are documented
The system SHALL document every admin endpoint whose contract changed in the migration, specifically that job enable and disable are superseded by queue pause and resume.

#### Scenario: The endpoint changes are written down
- **WHEN** a developer reads the migration documentation
- **THEN** it states which admin endpoints kept their contract and which were replaced
