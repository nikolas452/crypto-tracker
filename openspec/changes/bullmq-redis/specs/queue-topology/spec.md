## ADDED Requirements

### Requirement: Four queues with distinct characteristics
The system SHALL define four queues: `prices` carrying `poll-prices`, `alerts` carrying `evaluate-alerts`, `notifications` carrying `send-notification`, and `maintenance` carrying `maintenance` and `relay-notifications`.

#### Scenario: Each job type has its own queue
- **WHEN** the queues are created
- **THEN** exactly these four queues exist, each carrying the jobs assigned to it

### Requirement: Per-queue job options
The system SHALL configure `poll-prices` with 2 attempts and a fixed 2-minute backoff; `evaluate-alerts` with a deterministic `jobId` of `eval:<coinId>:<capturedAt epoch>`, 3 attempts and exponential backoff starting at 5 seconds; `send-notification` with a deterministic `jobId` of `notif:<notificationId>`, `NOTIFY_MAX_ATTEMPTS` attempts and exponential backoff starting at 60 seconds; and `maintenance` jobs with a single attempt.

#### Scenario: Notification jobs are deduplicated by notification id
- **WHEN** the same notification is enqueued twice
- **THEN** the second add is ignored because the job id already exists

#### Scenario: Alert evaluation jobs are deduplicated per coin and capture time
- **WHEN** the same coin and `capturedAt` pair is enqueued twice
- **THEN** only one job exists for that pair

### Requirement: Per-queue worker options
The system SHALL run the `prices` worker with concurrency 1, the `alerts` worker with concurrency 5, and the `notifications` worker with concurrency 3 and a limiter of `MAIL_MAX_PER_MINUTE` per 60 seconds, and the `maintenance` worker with concurrency 1.

#### Scenario: The mail rate limit is global across workers
- **WHEN** 100 notifications are pending with `MAIL_MAX_PER_MINUTE` of 30 and two workers are consuming the `notifications` queue
- **THEN** at most 30 are sent in the first minute across both workers combined

### Requirement: Bounded job retention
The system SHALL configure `removeOnComplete` and `removeOnFail` per queue so finished jobs do not accumulate without limit, retaining `poll-prices` completions for 24 hours or 500 jobs and its failures for 7 days.

#### Scenario: Completed jobs are pruned automatically
- **WHEN** a queue accumulates completions beyond its retention setting
- **THEN** the oldest completed jobs are removed automatically

### Requirement: Centralized queue and job names
The system SHALL define the queue and job names once as shared constants used by every producer, consumer and admin endpoint.

#### Scenario: Names come from the shared constants
- **WHEN** a job is enqueued, processed or referenced by an admin endpoint
- **THEN** its queue and job name come from the shared constants rather than a repeated string literal

### Requirement: Workload separation is documented
The system SHALL document why the work is split across queues rather than sharing one, namely that differing concurrency, retry and rate-limit needs mean a burst of one kind of work would otherwise delay another.

#### Scenario: The rationale is written down
- **WHEN** a developer reads the queue documentation
- **THEN** it explains that separate queues prevent a backlog of one workload from delaying another
