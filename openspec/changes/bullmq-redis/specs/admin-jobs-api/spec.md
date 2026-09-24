## MODIFIED Requirements

### Requirement: Trigger endpoint returns accepted

The system SHALL keep `POST /api/v1/admin/jobs/:name/run`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, validating `name` against the shared job-name constants and responding 404 otherwise, enqueueing the job onto its queue with the deterministic job id `manual:<name>:<current minute>` so two clicks within the same minute do not produce two jobs, and responding **202 Accepted** with `{ data: { jobId, name, queuedAt } }`.

#### Scenario: Triggering a job is accepted rather than completed

- **WHEN** an admin calls `POST /api/v1/admin/jobs/poll-prices/run`
- **THEN** the response is 202 with the enqueued job's identifier, and the job is processed by a worker consuming that queue

#### Scenario: Two clicks in the same minute produce one job

- **WHEN** an admin triggers the same job twice within the same minute
- **THEN** the deterministic job id causes the second add to be ignored

#### Scenario: An unknown job name is not found

- **WHEN** an admin calls the trigger endpoint with an unrecognized name
- **THEN** the response is 404

#### Scenario: A regular user cannot trigger a job

- **WHEN** a user whose role is `user` calls the trigger endpoint
- **THEN** the response is 403 with `error.code: "FORBIDDEN"`

## REMOVED Requirements

### Requirement: Disable and enable endpoints

**Reason**: Enabling and disabling a scheduled job was an Agenda concept operating on a single recurring document. With queues, the equivalent control is pausing and resuming the queue that carries the job, which also stops work already waiting rather than only preventing new scheduling.
**Migration**: Use `POST /api/v1/admin/queues/:queue/pause` and `POST /api/v1/admin/queues/:queue/resume` from the `admin-queue-api` capability. This is a deliberate contract change and is documented as part of the migration.

### Requirement: Job listing endpoint

**Reason**: The listing reported Agenda recurring-document fields — `nextRunAt`, `failCount`, `failReason`, `lockedAt`, `disabled` — that no longer exist once jobs live in queues.
**Migration**: Use `GET /api/v1/admin/queues` from the `admin-queue-api` capability, which reports per-queue job counts by state together with each scheduler's next execution time.

### Requirement: Trigger endpoint rate limit

**Reason**: The 30-second per-job rate limit existed to stop repeated manual triggers from consuming upstream quota. The deterministic per-minute job id now provides that protection by construction, and the lease lock still prevents concurrent execution.
**Migration**: Duplicate triggers within the same minute are collapsed by the `manual:<name>:<current minute>` job id, and cross-worker exclusion remains the lease lock's responsibility.
