## REMOVED Requirements

### Requirement: Three recurring job definitions

**Reason**: Agenda is retired. Recurring work is now driven by BullMQ job schedulers, and the set changes: `send-notifications` is replaced by per-notification dispatch, and `relay-notifications` is added.
**Migration**: See the `bullmq-schedulers` capability, which upserts `poll-prices`, `maintenance` and `relay-notifications`, and `queue-topology`, which holds the per-queue concurrency, attempt and retention settings that Agenda expressed as definition options.

### Requirement: Cron expressions are evaluated in UTC

**Reason**: Restated for the queue's scheduler rather than removed as a behavior.
**Migration**: Scheduler patterns remain five-field cron expressions evaluated in UTC, specified under `bullmq-schedulers`.

### Requirement: Idempotent recurring registration

**Reason**: Retired with Agenda's `every()`.
**Migration**: Schedulers are upserted at startup so repeated restarts leave one scheduler per identifier, specified under `bullmq-schedulers`.

### Requirement: Registration does not re-enable a disabled job

**Reason**: Disabling a job was an Agenda recurring-document concept; the equivalent control is pausing a queue, which is not affected by scheduler upserts.
**Migration**: Use queue pause and resume from the `admin-queue-api` capability. A paused queue stays paused across worker restarts.

### Requirement: Obsolete recurring jobs are removed

**Reason**: Restated for schedulers rather than removed as a behavior.
**Migration**: Schedulers whose identifier is no longer configured are removed at startup, specified under `bullmq-schedulers`.
