## ADDED Requirements

### Requirement: Job listing endpoint

The system SHALL expose `GET /api/v1/admin/jobs`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, listing the recurring jobs with `name`, `schedule`, `nextRunAt`, `lastRunAt`, `lastFinishedAt`, `failCount`, `failReason`, `failedAt`, `lockedAt` and `disabled`, together with the most recent `JobRun` for that name (its `status` and `finishedAt`). A `includeOneOff=true` query parameter SHALL additionally include one-off jobs from the last 24 hours.

#### Scenario: An admin sees the recurring schedule and last outcome

- **WHEN** an admin calls `GET /api/v1/admin/jobs`
- **THEN** the response lists each recurring job with its schedule, next run time, failure information and the status of its most recent `JobRun`

#### Scenario: One-off jobs are included on request

- **WHEN** an admin calls the endpoint with `includeOneOff=true`
- **THEN** one-off jobs from the last 24 hours also appear in the response

### Requirement: Trigger endpoint returns accepted

The system SHALL expose `POST /api/v1/admin/jobs/:name/run`, validating `name` against `JOB_NAMES` and responding 404 otherwise, enqueueing the job with `data` containing `trigger: "api"` and the requesting admin's `userId`, and responding **202 Accepted** with `{ data: { agendaJobId, name, queuedAt } }`. When the job is disabled the response SHALL be 409.

#### Scenario: Triggering a job is accepted rather than completed

- **WHEN** an admin calls `POST /api/v1/admin/jobs/poll-prices/run`
- **THEN** the response is 202 with the enqueued job's identifier, and a `JobRun` with `trigger: "api"` appears once a worker picks it up

#### Scenario: An unknown job name is not found

- **WHEN** an admin calls the trigger endpoint with a name that is not in `JOB_NAMES`
- **THEN** the response is 404

#### Scenario: A regular user cannot trigger a job

- **WHEN** a user whose role is `user` calls the trigger endpoint
- **THEN** the response is 403 with `error.code: "FORBIDDEN"`

#### Scenario: Triggering a disabled job conflicts

- **WHEN** an admin triggers a job that is currently disabled
- **THEN** the response is 409

### Requirement: Trigger endpoint rate limit

The system SHALL limit the trigger endpoint to one request per 30 seconds per job name, to protect the upstream quota.

#### Scenario: Rapid repeated triggers are limited

- **WHEN** an admin calls the trigger endpoint twice for the same job within 30 seconds
- **THEN** the second call is rejected by the rate limit

### Requirement: Disable and enable endpoints

The system SHALL expose `POST /api/v1/admin/jobs/:name/disable` and `POST /api/v1/admin/jobs/:name/enable`, each guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, responding 200 with the resulting state. A disabled job SHALL NOT execute even when its next run time passes.

#### Scenario: A disabled job stops running

- **WHEN** an admin disables `poll-prices` and its next run time passes
- **THEN** the job does not execute

#### Scenario: Enabling restores execution

- **WHEN** an admin enables a previously disabled job
- **THEN** the response is 200 and the job runs at its next scheduled time
