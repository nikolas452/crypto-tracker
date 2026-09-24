## MODIFIED Requirements

### Requirement: Evaluation input is limited to this run's updated coins

The system SHALL evaluate alerts one coin at a time, in a dedicated `evaluate-alerts` job enqueued for each coin that received a new snapshot, selecting alerts whose `coinId` is that coin and whose `status` is `armed` or `triggered`, and iterating with a cursor rather than loading the alert set into memory.

#### Scenario: Alerts on unchanged coins are not evaluated

- **WHEN** a run updates 2 of 10 coins
- **THEN** only 2 evaluation jobs are enqueued, and only alerts referencing those coins are evaluated

#### Scenario: Evaluation streams rather than buffering

- **WHEN** an evaluation job runs
- **THEN** it iterates the matching alerts with a cursor and does not materialize the full result set

### Requirement: Immediate dispatch after a trigger

The system SHALL enqueue a `send-notification` job for the created notification **after** its transaction commits, never within it, so the message is dispatched without waiting for a periodic sweep. When that enqueue fails, the notification SHALL remain `pending` for the relay to recover.

#### Scenario: A trigger dispatches without waiting for a sweep

- **WHEN** an evaluation job triggers an alert and its transaction commits
- **THEN** a `send-notification` job for that notification is enqueued immediately afterwards

#### Scenario: A run with no triggers dispatches nothing

- **WHEN** an evaluation job produces no triggered alert
- **THEN** no `send-notification` job is enqueued

#### Scenario: A failed dispatch leaves recoverable state

- **WHEN** the post-commit enqueue fails
- **THEN** the notification stays `pending` and the relay enqueues it on its next execution

### Requirement: Evaluation failure degrades the run only

When an evaluation job fails, the system SHALL throw so the queue retries it with the `alerts` queue's backoff, and SHALL leave stored prices untouched. A failure to enqueue the evaluation jobs in the first place SHALL close the polling run as `partial` with `error.code: "ENQUEUE_FAILED"`.

#### Scenario: A database failure during evaluation preserves prices

- **WHEN** an evaluation job throws after snapshots were inserted by the polling run
- **THEN** the stored snapshots remain and the evaluation job is retried by the queue

#### Scenario: A failed fan-out is reported on the polling run

- **WHEN** the polling run cannot enqueue its evaluation jobs
- **THEN** that run's status is `"partial"` with `error.code: "ENQUEUE_FAILED"`

### Requirement: Evaluation statistics

The system SHALL record the evaluation counters — evaluated, triggered, rearmed, in cooldown and trigger conflicts — in each evaluation job's log output rather than in a per-coin `JobRun` document, to avoid creating one run document per coin per cycle.

#### Scenario: Evaluation counters are logged

- **WHEN** an evaluation job evaluates 5 alerts of which 1 triggers and 1 rearms
- **THEN** its log output reports those counts and no `JobRun` document is created for the job
