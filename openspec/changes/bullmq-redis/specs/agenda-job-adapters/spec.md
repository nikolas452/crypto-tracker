## REMOVED Requirements

### Requirement: Adapters are thin and receive dependencies by closure
**Reason**: Agenda is retired; its handlers are replaced by BullMQ processors. The practice itself is unchanged and carries over.
**Migration**: Queue processors remain thin, receive their dependencies through a factory closure, and leave the business logic in `src/jobs/*` untouched.

### Requirement: Trigger derivation
**Reason**: Retired with the Agenda handler.
**Migration**: The processor derives the run's trigger from the job's data, defaulting to the scheduler-driven value, as part of the `price-poll-fanout` capability.

### Requirement: Only a failed result throws
**Reason**: Retired with the Agenda handler, and superseded by a rule that distinguishes two kinds of throw rather than one.
**Migration**: A processor throws an ordinary error for a retryable failure and an unrecoverable error for a permanent one, so the queue's `attempts` and `backoff` apply correctly; `skipped` and `partial` results still do not throw. Specified under `price-poll-fanout` and `job-retry-policy`.

### Requirement: Send notifications adapter throws only on infrastructure failure
**Reason**: The batch send job no longer exists.
**Migration**: The per-notification processor's throw behavior is specified under `notification-dispatch`: a claim that matches nothing completes successfully, a transient failure throws so the queue retries, and a permanent failure throws unrecoverably.
