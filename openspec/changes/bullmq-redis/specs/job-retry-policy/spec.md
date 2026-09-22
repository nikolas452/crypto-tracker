## MODIFIED Requirements

### Requirement: Retry on transient failures only
The system SHALL let the queue schedule retries through each queue's configured `attempts` and `backoff`, and SHALL decide whether a failure is retryable by the kind of error it throws: an ordinary error for a transient failure, so the queue retries it, and an unrecoverable error for a permanent one, so it does not. `COINGECKO_UNAVAILABLE`, `COINGECKO_RATE_LIMITED` and infrastructure failures SHALL be thrown as ordinary errors.

#### Scenario: A transient upstream outage is retried by the queue
- **WHEN** `poll-prices` fails with `COINGECKO_UNAVAILABLE`
- **THEN** the processor throws an ordinary error and the queue retries it according to that queue's attempts and backoff

#### Scenario: Attempts are bounded by the queue configuration
- **WHEN** a job exhausts its configured attempts
- **THEN** it is left in the `failed` state for review rather than retried again

### Requirement: No retry for non-transient failures
The system SHALL throw an unrecoverable error for `COINGECKO_AUTH` and for a permanent SMTP rejection, so the queue performs no further attempt.

#### Scenario: An authentication failure is not retried
- **WHEN** `poll-prices` fails with `COINGECKO_AUTH`
- **THEN** the processor throws an unrecoverable error and the job is not retried

#### Scenario: A permanent mail rejection is not retried
- **WHEN** a send fails with a permanent SMTP rejection
- **THEN** the processor throws an unrecoverable error and the job is not retried

## REMOVED Requirements

### Requirement: No retry when the next scheduled run is imminent
**Reason**: The rule existed because the Agenda failure listener scheduled retries by hand and could otherwise duplicate an imminent recurring run. Retry scheduling is now owned by the queue, whose backoff is configured per queue, so there is no hand-scheduled retry to suppress.
**Migration**: Retry timing comes from the `prices` queue's fixed two-minute backoff and bounded attempts, specified by the `queue-topology` capability.

### Requirement: Other jobs are not retried
**Reason**: Superseded by per-queue configuration, which expresses the same intent declaratively — `maintenance` jobs are configured with a single attempt.
**Migration**: Retry behavior for every job is now read from its queue's `attempts` and `backoff` settings under `queue-topology`.

### Requirement: Native retry support supersedes the listener
**Reason**: The substitution this requirement anticipated has now happened; there is no listener left to supersede.
**Migration**: Retries are the queue's `attempts` and `backoff`, and the application decides only whether a given failure is retryable.
