## ADDED Requirements

### Requirement: Queue state listing
The system SHALL expose `GET /api/v1/admin/queues`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, reporting per queue the counts of jobs in `waiting`, `active`, `delayed`, `completed`, `failed` and `paused`, plus each scheduler's next execution time.

#### Scenario: An admin sees per-queue counts
- **WHEN** an admin calls `GET /api/v1/admin/queues`
- **THEN** the response reports each queue's job counts by state and the schedulers' next run times

### Requirement: Pause and resume endpoints
The system SHALL expose `POST /api/v1/admin/queues/:queue/pause` and `POST /api/v1/admin/queues/:queue/resume`, guarded the same way. A paused queue SHALL stop processing, and resuming it SHALL process the accumulated jobs.

#### Scenario: Pausing the notification queue stops delivery
- **WHEN** an admin pauses the `notifications` queue
- **THEN** no further messages are sent while it is paused

#### Scenario: Resuming delivers what accumulated
- **WHEN** the admin resumes that queue
- **THEN** the notifications queued while it was paused are sent

### Requirement: Failed job retry for notifications
The system SHALL expose `POST /api/v1/admin/queues/notifications/retry-failed`, which retries that queue's `failed` jobs and returns the corresponding MongoDB notifications to `pending`.

#### Scenario: Retrying failed jobs resets both stores
- **WHEN** an admin retries the `notifications` queue's failed jobs
- **THEN** those jobs become live again and their MongoDB rows return to `pending`

### Requirement: Queue endpoints report unavailability
When Redis is unavailable, the queue administration endpoints SHALL respond 503 rather than failing the whole API.

#### Scenario: Queue admin is unavailable while Redis is down
- **WHEN** Redis is down and an admin calls `GET /api/v1/admin/queues`
- **THEN** the response is 503

### Requirement: Dashboard behind its own credentials
The system SHALL mount Bull Board at `/admin/queues-ui` protected by HTTP Basic Auth using `BULL_BOARD_USER` and `BULL_BOARD_PASS` compared in constant time, because a browser cannot attach the API's Bearer token.

#### Scenario: The dashboard requires credentials
- **WHEN** a client opens the dashboard without Basic Auth credentials while it is enabled
- **THEN** the response is 401

### Requirement: Dashboard disabled by default outside development
The system SHALL default `BULL_BOARD_ENABLED` to `false` outside development, SHALL respond 404 at the dashboard path when it is disabled, SHALL require the Basic Auth credentials when it is enabled outside development, and SHALL serve it only over HTTPS.

#### Scenario: A disabled dashboard does not exist
- **WHEN** `BULL_BOARD_ENABLED` is `false` and a client opens `/admin/queues-ui`
- **THEN** the response is 404

#### Scenario: Enabling outside development requires credentials
- **WHEN** the dashboard is enabled outside development without `BULL_BOARD_USER` and `BULL_BOARD_PASS`
- **THEN** configuration validation fails at startup
