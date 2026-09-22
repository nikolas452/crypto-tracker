## ADDED Requirements

### Requirement: Job scheduling and run tracking
The system SHALL schedule `send-notifications` with `SEND_NOTIFICATIONS_CRON` (default every minute), give it its own overlap guard independent of `poll-prices`, and record each execution as a `JobRun` with `jobName: "send-notifications"`.

#### Scenario: The send job records its own runs
- **WHEN** `send-notifications` executes
- **THEN** a `JobRun` with `jobName: "send-notifications"` is created for that execution

#### Scenario: Overlapping send ticks are guarded independently
- **WHEN** a `send-notifications` tick arrives while a previous one is still running
- **THEN** it is skipped without affecting `poll-prices` scheduling

### Requirement: Stale lock recovery
At the start of each run the system SHALL return to `pending` every notification in `sending` whose `lockedAt` is older than `now − NOTIFY_LOCK_TIMEOUT_MIN` (default 10), incrementing `attempts` and setting `nextAttemptAt` to `now`, counting them in `stats.recoveredStale`. When that increment reaches `maxAttempts`, the notification SHALL become `failed` instead.

#### Scenario: A hung send is recovered and retried in the same run
- **WHEN** a notification has been in `sending` with a `lockedAt` 15 minutes old and the job runs
- **THEN** it returns to `pending` and is claimed and sent during that same run

#### Scenario: Recovery that exhausts attempts fails the notification
- **WHEN** a stale notification's incremented `attempts` reaches `maxAttempts`
- **THEN** its status becomes `failed` rather than `pending`

### Requirement: Atomic claim loop
The system SHALL claim work in a loop, up to `NOTIFY_BATCH_SIZE` (default 20) notifications, with `findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: now } }, { $set: { status: 'sending', lockedAt: now, lockedBy: workerId } }, { sort: { nextAttemptAt: 1 }, new: true })`, ending the loop when the operation returns `null`.

#### Scenario: Two concurrent workers never claim the same notification
- **WHEN** two `send-notifications` executions with different worker identifiers run concurrently against 10 pending notifications
- **THEN** each notification is claimed by exactly one of them and is sent exactly once

#### Scenario: The loop ends when nothing is claimable
- **WHEN** no pending notification has a `nextAttemptAt` at or before now
- **THEN** the claim loop ends immediately without sending

### Requirement: Cancelled when the user is gone
For each claimed notification the system SHALL verify the user still exists and, when they do not, SHALL set the notification to `cancelled` without sending.

#### Scenario: A deleted user's queued mail is cancelled
- **WHEN** a claimed notification belongs to a user who no longer exists
- **THEN** its status becomes `cancelled` and no message is sent

### Requirement: Successful send outcome
On a successful send the system SHALL set `status: "sent"`, `sentAt`, `providerMessageId` and clear the lock fields.

#### Scenario: A sent notification records its provider id
- **WHEN** a claimed notification is sent successfully
- **THEN** its status is `sent`, `sentAt` is populated and `providerMessageId` holds the mailer's message id

### Requirement: Permanent failure outcome
On a permanent send failure the system SHALL set `status: "failed"` and populate `lastError` with `permanent: true` on the first attempt, without scheduling a retry.

#### Scenario: A 550 rejection fails immediately
- **WHEN** a send fails with SMTP code 550
- **THEN** the notification's status is `failed` on the first attempt with `lastError.permanent: true`

### Requirement: Transient failure retry with backoff
On a transient send failure the system SHALL increment `attempts`; when `attempts` reaches `maxAttempts` it SHALL set `status: "failed"`, otherwise it SHALL return the notification to `pending` with `nextAttemptAt = now + backoff[attempts - 1]`, where `backoff` is `[1, 5, 15, 60]` minutes with ±10% jitter.

#### Scenario: A transient failure schedules the first retry
- **WHEN** a send fails transiently on the first attempt
- **THEN** the notification returns to `pending` with `attempts: 1` and a `nextAttemptAt` approximately one minute in the future

#### Scenario: Exhausted attempts end in failure
- **WHEN** a notification fails transiently on five successive attempts with `maxAttempts` of 5
- **THEN** its final status is `failed`

### Requirement: Post-send updates are owner-scoped
The system SHALL apply every update issued after the send attempt with the filter `{ _id, status: 'sending', lockedBy: workerId }`, so a slow worker cannot overwrite a notification another process has already recovered.

#### Scenario: A late update from a superseded worker is discarded
- **WHEN** a worker completes a send after its lock was recovered by another process
- **THEN** its update matches no document and the recovering process's state is preserved

### Requirement: Sequential sending under a per-minute cap
The system SHALL send the claimed batch sequentially and SHALL stop the batch when `MAIL_MAX_PER_MINUTE` (default 30) has been reached, leaving the remaining notifications for the next execution.

#### Scenario: The per-minute cap truncates the batch
- **WHEN** more notifications are claimable than `MAIL_MAX_PER_MINUTE` allows
- **THEN** sending stops at the cap and the remainder stays `pending` for the next run

### Requirement: Send job statistics
The system SHALL record `claimed`, `sent`, `retried`, `failedPermanent`, `failedExhausted`, `cancelled` and `recoveredStale` in the run's `JobRun.stats`.

#### Scenario: Counters reflect the run's outcomes
- **WHEN** a run claims 3 notifications, sends 2 and retries 1
- **THEN** `stats.claimed` is 3, `stats.sent` is 2 and `stats.retried` is 1

### Requirement: Recipient addresses are never logged in full
The system SHALL NOT include a complete recipient email address in any log line produced by this job.

#### Scenario: Send logs omit the full address
- **WHEN** a send succeeds or fails and the outcome is logged
- **THEN** the log line contains no complete email address
