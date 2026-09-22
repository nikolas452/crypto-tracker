## ADDED Requirements

### Requirement: Per-coin evaluation reusing existing logic
The `evaluate-alerts` processor SHALL evaluate the alerts for exactly one coin, using the same pure `decide` function and the same trigger transaction as before, so alert semantics are unchanged.

#### Scenario: Evaluation covers only its own coin
- **WHEN** an `evaluate-alerts` job runs for one coin
- **THEN** only alerts referencing that coin are evaluated

#### Scenario: Trigger semantics are unchanged
- **WHEN** an alert's condition is met within a per-coin evaluation job
- **THEN** the alert is flipped and its notification inserted in the same transaction, with the same version guard and dedupe key as before

### Requirement: Notification enqueued only after commit
The system SHALL enqueue the `send-notification` job **after** the transaction commits and never inside it, using the job id `notif:<notificationId>`.

#### Scenario: The queue job follows the commit
- **WHEN** an alert triggers and its transaction commits
- **THEN** a `send-notification` job with id `notif:<notificationId>` is enqueued after the commit

#### Scenario: An aborted transaction enqueues nothing
- **WHEN** the trigger transaction aborts
- **THEN** no `send-notification` job is enqueued

### Requirement: Failed enqueue falls back to the relay
When the post-commit enqueue fails, the system SHALL leave the notification `pending` in MongoDB and rely on `relay-notifications` to enqueue it later.

#### Scenario: A failed enqueue is repaired by the relay
- **WHEN** the post-commit `add` fails
- **THEN** the notification remains `pending` and is enqueued by the relay on its next execution

### Requirement: Statistics reported through logs
The system SHALL report per-evaluation statistics through the job's logs rather than creating a `JobRun` per coin, and SHALL document that choice.

#### Scenario: Per-coin evaluation creates no run document
- **WHEN** an `evaluate-alerts` job completes
- **THEN** its counts appear in the job's log output and no `JobRun` document is created for it

### Requirement: Infrastructure failures are retried
The system SHALL throw on infrastructure failures so BullMQ retries the job with the `alerts` queue's exponential backoff.

#### Scenario: A database outage retries the evaluation
- **WHEN** the database is unreachable during evaluation
- **THEN** the processor throws and the job is retried with exponential backoff

### Requirement: Duplicate evaluation remains safe
The system SHALL remain correct if the same coin and capture time are evaluated more than once, because the alert's `version` guard and the notification's unique `dedupeKey` both prevent a duplicate trigger.

#### Scenario: A repeated evaluation produces no second notification
- **WHEN** the same evaluation runs twice for the same alert and capture time
- **THEN** only one notification exists for that trigger
