## ADDED Requirements

### Requirement: Evaluation input is limited to this run's updated coins

The system SHALL evaluate only alerts whose `coinId` is among the coins that received a new snapshot in the current run and whose `status` is `armed` or `triggered`, iterating with a cursor rather than loading the alert set into memory.

#### Scenario: Alerts on unchanged coins are not evaluated

- **WHEN** a run updates 2 of 10 coins
- **THEN** only alerts referencing those 2 coins are evaluated

#### Scenario: Evaluation streams rather than buffering

- **WHEN** the evaluation step runs
- **THEN** it iterates the matching alerts with a cursor and does not materialize the full result set

### Requirement: Transactional trigger

For a `TRIGGER` decision the system SHALL, inside `session.withTransaction()`, update the alert with the filter `{ _id, version, status: 'armed' }`, setting `status` to `completed` when `mode` is `once` and `triggered` otherwise, setting `lastTriggeredAt`, `lastTriggeredValue` and `lastEvaluatedAt`, and incrementing `version` and `triggerCount`; then load the user; then insert the `Notification` in `pending` with `dedupeKey = ${alertId}:${triggerCount + 1}`.

#### Scenario: A trigger flips the alert and queues exactly one notification

- **WHEN** an armed `PRICE_BELOW` alert with threshold 50000 is evaluated against a price of 49000
- **THEN** the alert becomes `triggered` with `triggerCount: 1` and exactly one `pending` notification exists with `dedupeKey` ending in `:1`

### Requirement: Version conflicts abort the trigger

When the conditional update matches no document because the alert changed between reading and writing, the system SHALL abort the transaction, increment `stats.triggerConflicts` and continue with the next alert, without creating a notification.

#### Scenario: A concurrently edited alert does not fire

- **WHEN** an alert's `version` changes between the read and the conditional write
- **THEN** the alert does not fire, no notification is created and `stats.triggerConflicts` is 1

### Requirement: Trigger requires a deliverable recipient

Within the transaction the system SHALL load the user and, when that user no longer exists or no longer has a verified email, SHALL abort the transaction and log at `warn`, leaving the alert unchanged.

#### Scenario: An unverifiable recipient aborts the trigger

- **WHEN** an alert fires for a user whose email is no longer verified
- **THEN** the transaction aborts, no notification is created, a `warn` is logged, and the alert remains `armed`

### Requirement: Duplicate notification insert is idempotent success

The system SHALL treat a duplicate-key error on `dedupeKey` during the transaction as a successful, already-recorded trigger rather than a failure.

#### Scenario: A repeated trigger insert does not fail the run

- **WHEN** the notification insert raises a duplicate-key error on `dedupeKey`
- **THEN** the step is treated as successful and the run continues without error

### Requirement: Rollback on notification insert failure

When the notification insert fails for any reason other than the duplicate key, the transaction SHALL roll back so the alert is left in its previous state.

#### Scenario: A failed insert leaves the alert armed

- **WHEN** inserting the notification throws inside the transaction
- **THEN** the alert's status is still `armed` and no notification exists

### Requirement: Non-transactional rearm

For a `REARM` decision the system SHALL issue `updateOne({ _id, version, status: 'triggered' }, { $set: { status: 'armed', lastEvaluatedAt: now }, $inc: { version: 1 } })` without a transaction.

#### Scenario: A rearm updates the alert without a transaction

- **WHEN** a triggered alert's rearm condition is met
- **THEN** its status becomes `armed` and no transaction is started

### Requirement: Cooldown and no-op write nothing

For a `COOLDOWN` or `NOOP` decision the system SHALL perform no write at all, including no update of `lastEvaluatedAt`, and SHALL document that `lastEvaluatedAt` reflects the last state change rather than the last evaluation.

#### Scenario: An alert in cooldown is not written

- **WHEN** an alert's decision is `COOLDOWN`
- **THEN** no write is issued for that alert and its `lastEvaluatedAt` is unchanged

### Requirement: Evaluation statistics

The system SHALL record `alertsEvaluated`, `alertsTriggered`, `alertsRearmed`, `alertsInCooldown` and `triggerConflicts` in the run's `JobRun.stats`.

#### Scenario: Evaluation counters reflect the run

- **WHEN** a run evaluates 5 alerts of which 1 triggers and 1 rearms
- **THEN** `stats.alertsEvaluated` is 5, `stats.alertsTriggered` is 1 and `stats.alertsRearmed` is 1

### Requirement: Evaluation failure degrades the run only

When the evaluation step fails as a whole, the system SHALL close the run as `partial` with `error.code: "ALERT_EVALUATION_FAILED"`, leave the stored prices untouched, and rely on the next run to evaluate with fresh values.

#### Scenario: A database failure during evaluation preserves prices

- **WHEN** the evaluation step throws after snapshots were inserted
- **THEN** the run's `status` is `"partial"` with `error.code: "ALERT_EVALUATION_FAILED"` and the inserted snapshots remain

### Requirement: Immediate dispatch after a trigger

When at least one alert triggered during the run, the system SHALL invoke `send-notifications` immediately after evaluation, respecting that job's own overlap guard, so a queued email does not wait for the next scheduled minute.

#### Scenario: A trigger dispatches without waiting for the scheduler

- **WHEN** a run produces at least one triggered alert
- **THEN** `send-notifications` is invoked at the end of that run rather than only at its next scheduled time

#### Scenario: A run with no triggers does not dispatch

- **WHEN** a run produces no triggered alert
- **THEN** `send-notifications` is not invoked by that run
