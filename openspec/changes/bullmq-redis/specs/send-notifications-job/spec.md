## REMOVED Requirements

### Requirement: Job scheduling and run tracking

**Reason**: The batch job is replaced by one `send-notification` queue job per notification, so each message retries on its own schedule instead of sharing a once-a-minute batch cadence.
**Migration**: Dispatch is now handled by the `notification-dispatch` capability. Delivery is driven by the `notifications` queue and its scheduler-driven `relay-notifications` sweep rather than by a `SEND_NOTIFICATIONS_CRON` job, and per-message outcomes are logged rather than aggregated into a single `JobRun`.

### Requirement: Stale lock recovery

**Reason**: Recovery moves into the `relay-notifications` job, which performs the same lock-timeout sweep alongside re-enqueueing pending notifications.
**Migration**: The same rule — notifications in `sending` past `NOTIFY_LOCK_TIMEOUT_MIN` return to `pending` — is applied by the relay, specified under `notification-dispatch`.

### Requirement: Atomic claim loop

**Reason**: There is no batch to claim any more; each job handles exactly one notification.
**Migration**: The claim is now a single `findOneAndUpdate` by notification id at the start of each `send-notification` job, and a non-matching claim completes the job successfully as a harmless duplicate.

### Requirement: Cancelled when the user is gone

**Reason**: Superseded by the per-notification claim, which does not match a cancelled row.
**Migration**: A notification cancelled because its user was deleted simply fails the claim, and the job finishes without sending.

### Requirement: Successful send outcome

**Reason**: Moved to the per-notification job unchanged.
**Migration**: Specified under `notification-dispatch`, with the same `lockedBy`-filtered update.

### Requirement: Permanent failure outcome

**Reason**: Moved to the per-notification job, where it additionally throws an unrecoverable error so the queue makes no further attempt.
**Migration**: Specified under `notification-dispatch`.

### Requirement: Transient failure retry with backoff

**Reason**: Retry timing moves from an application-computed `nextAttemptAt` to the `notifications` queue's exponential backoff.
**Migration**: Specified under `notification-dispatch`; `nextAttemptAt` is retained as an informational field only.

### Requirement: Post-send updates are owner-scoped

**Reason**: Moved to the per-notification job unchanged.
**Migration**: Every post-send update still carries the `{ _id, status: 'sending', lockedBy: workerId }` filter, specified under `notification-dispatch`.

### Requirement: Sequential sending under a per-minute cap

**Reason**: A per-process sequential cap could be exceeded by running two workers. It is replaced by a queue-level limiter that is global across all consumers.
**Migration**: The `notifications` queue is configured with `limiter: { max: MAIL_MAX_PER_MINUTE, duration: 60000 }`, specified under `queue-topology`.

### Requirement: Send job statistics

**Reason**: There is no batch run to aggregate statistics over.
**Migration**: Per-message outcomes are logged by the worker's `completed` and `failed` event handlers, and aggregate queue state is available through `GET /api/v1/admin/queues`.

### Requirement: Recipient addresses are never logged in full

**Reason**: Restated as a property of the new dispatch path rather than of the removed batch job.
**Migration**: The `notification-dispatch` capability keeps the rule, reinforced by the job data carrying only a notification identifier so no address travels through the queue at all.
