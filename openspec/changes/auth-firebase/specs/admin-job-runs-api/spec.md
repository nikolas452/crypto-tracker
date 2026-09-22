## MODIFIED Requirements

### Requirement: Job run list endpoint
The system SHALL expose `GET /api/v1/admin/job-runs`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, with a strict Zod query schema accepting `jobName`, `status` (one or more values separated by commas), `from`, `to`, `page` and `limit` (maximum 100). Results SHALL be ordered by `startedAt` descending and returned in the project's paginated `{ data, meta }` shape.

#### Scenario: Authenticated admin receives a paginated list
- **WHEN** a client calls `GET /api/v1/admin/job-runs` with a valid token belonging to an account whose role is `admin`
- **THEN** the response is 200 with a `data` array of job runs ordered by `startedAt` descending and a `meta` object containing `page`, `limit`, `total` and `totalPages`

#### Scenario: Authenticated non-admin is forbidden
- **WHEN** a client with a valid token whose role is `user` calls `GET /api/v1/admin/job-runs`
- **THEN** the response is 403 with `error.code: "FORBIDDEN"`

#### Scenario: Unauthenticated caller is refused
- **WHEN** a client calls `GET /api/v1/admin/job-runs` with no `Authorization` header
- **THEN** the response is 401 with `error.code: "UNAUTHENTICATED"`

#### Scenario: Multiple statuses can be requested at once
- **WHEN** an admin passes `status=failed,partial`
- **THEN** the result contains only runs whose status is `failed` or `partial`

#### Scenario: Limit above the maximum is rejected
- **WHEN** an admin passes a `limit` greater than 100
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

### Requirement: Job run detail endpoint
The system SHALL expose `GET /api/v1/admin/job-runs/:id`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, responding 400 when `id` is not a valid Mongo ObjectId, 404 when no run has that id, and 200 with the complete run document — excluding `__v` — otherwise.

#### Scenario: Malformed run id is a validation error
- **WHEN** an admin requests a job run with an id that is not a valid ObjectId
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

#### Scenario: Unknown run id returns not found
- **WHEN** an admin requests a job run id that does not exist
- **THEN** the response is 404 with `error.code: "NOT_FOUND"`

#### Scenario: Detail response omits the version key
- **WHEN** a job run is returned by the detail endpoint
- **THEN** the serialized document contains no `__v` field
