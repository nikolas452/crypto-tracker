## ADDED Requirements

### Requirement: Single-notification job carries only an identifier
The `send-notification` job's data SHALL contain only the notification's identifier; the recipient address and payload SHALL be read from MongoDB when the job is processed, so no personal data travels through the queue.

#### Scenario: The queue carries no recipient address
- **WHEN** a `send-notification` job is inspected in the queue
- **THEN** its data contains the notification id and no email address or message body

### Requirement: Claim by identifier
The processor SHALL claim the notification with `findOneAndUpdate({ _id, status: 'pending' }, { $set: { status: 'sending', lockedAt, lockedBy } })`. When the filter matches nothing — because the notification was already sent, cancelled, or claimed elsewhere — the job SHALL finish **without error**.

#### Scenario: A duplicate delivery finishes harmlessly
- **WHEN** a `send-notification` job runs for a notification that is no longer `pending`
- **THEN** the job completes successfully without sending anything

#### Scenario: A cancelled notification is not sent
- **WHEN** the notification was cancelled because its user was deleted
- **THEN** the claim matches nothing and the job finishes without sending

### Requirement: Successful send outcome
On success the system SHALL mark the notification `sent` with its `sentAt` and `providerMessageId`, using the `lockedBy` filter so a superseded worker cannot overwrite it.

#### Scenario: A sent notification records its provider id
- **WHEN** the send succeeds
- **THEN** the notification's status is `sent` with `sentAt` and `providerMessageId` populated

### Requirement: Permanent failure ends the job immediately
On a permanent send failure the system SHALL mark the notification `failed` in MongoDB with `lastError.permanent: true` and SHALL throw an unrecoverable error so BullMQ makes no further attempt.

#### Scenario: A 550 rejection is not retried
- **WHEN** the send fails with SMTP code 550
- **THEN** the notification is `failed` with `lastError.permanent: true` and the job is not retried

### Requirement: Transient failure defers to the queue's backoff
On a transient send failure the system SHALL increment `attempts` in MongoDB, return the notification's status to `pending`, and throw so BullMQ retries with the `notifications` queue's exponential backoff.

#### Scenario: A transient failure is retried with backoff
- **WHEN** the send fails with a transient SMTP error and attempts remain
- **THEN** the notification returns to `pending` with an incremented `attempts` and the job is retried with exponential backoff

### Requirement: Last attempt marks failed before throwing
When `attemptsMade + 1` has reached the job's configured attempts, the system SHALL mark the notification `failed` in MongoDB **before** throwing, so the database and the queue agree on the outcome.

#### Scenario: Exhausted attempts agree in both stores
- **WHEN** the final attempt fails transiently
- **THEN** the notification is `failed` in MongoDB and the job is `failed` in the queue

### Requirement: Retry timing is owned by the queue
The system SHALL treat `notifications.nextAttemptAt` as informational only, since BullMQ now controls when a retry occurs, and SHALL document that.

#### Scenario: The informational field is documented
- **WHEN** a developer reads the notification documentation
- **THEN** it states that `nextAttemptAt` no longer controls retry timing

### Requirement: Relay re-enqueues from the durable store
The system SHALL run `relay-notifications` every `RELAY_INTERVAL_MS`, finding notifications that have been `pending` for more than about two minutes and enqueueing them with the job id `notif:<id>`, which BullMQ ignores when that job already exists. It SHALL also recover notifications stuck in `sending` by the same lock-timeout rule used previously.

#### Scenario: A notification with no queue job is recovered
- **WHEN** a notification is `pending` in MongoDB with no corresponding queue job
- **THEN** the relay enqueues it on its next execution

#### Scenario: Total queue data loss is fully recovered
- **WHEN** Redis is flushed while notifications are pending, and the worker is restarted
- **THEN** after the relay interval the schedulers exist again and every pending notification is enqueued and sent

#### Scenario: A stuck sending notification is recovered
- **WHEN** a notification has been in `sending` beyond the lock timeout
- **THEN** the relay returns it to `pending` so it can be enqueued and retried

### Requirement: MongoDB is the source of truth
The system SHALL treat MongoDB as authoritative for notification state and Redis as transport only, and SHALL document that the relay is what makes queue data loss recoverable.

#### Scenario: The authority relationship is documented
- **WHEN** a developer reads the queue documentation
- **THEN** it states that MongoDB is the source of truth and that the relay rebuilds queue state from it

### Requirement: Re-enqueueing a retained failed job
The system SHALL ensure that re-enqueueing a notification whose previous job is still retained in the `failed` state actually produces a live job, by removing the failed job before adding or by using the queue's own retry mechanism.

#### Scenario: An admin retry produces a live job
- **WHEN** an administrator retries a notification whose queue job is retained as `failed`
- **THEN** the old job is removed or retried so that a live job exists for it
