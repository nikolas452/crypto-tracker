## Purpose

This capability exposes read-only administrative endpoints for inspecting price-polling job run history — a paginated, filterable list and a per-run detail view — to support operational monitoring and debugging.

## Requirements

### Requirement: Job run list endpoint

The system SHALL expose `GET /api/v1/admin/job-runs`, guarded by the admin key middleware, with a strict Zod query schema accepting `jobName`, `status` (one or more values separated by commas), `from`, `to`, `page` and `limit` (maximum 100). Results SHALL be ordered by `startedAt` descending and returned in the project's paginated `{ data, meta }` shape.

#### Scenario: Authenticated admin receives a paginated list

- **WHEN** a client calls `GET /api/v1/admin/job-runs` with the correct `X-Admin-Key`
- **THEN** the response is 200 with a `data` array of job runs ordered by `startedAt` descending and a `meta` object containing `page`, `limit`, `total` and `totalPages`

#### Scenario: Multiple statuses can be requested at once

- **WHEN** a client passes `status=failed,partial`
- **THEN** the result contains only runs whose status is `failed` or `partial`

#### Scenario: Limit above the maximum is rejected

- **WHEN** a client passes a `limit` greater than 100
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

### Requirement: Job run detail endpoint

The system SHALL expose `GET /api/v1/admin/job-runs/:id`, responding 400 when `id` is not a valid Mongo ObjectId, 404 when no run has that id, and 200 with the complete run document — excluding `__v` — otherwise.

#### Scenario: Malformed run id is a validation error

- **WHEN** a client requests a job run with an id that is not a valid ObjectId
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

#### Scenario: Unknown run id returns not found

- **WHEN** a client requests a job run id that does not exist
- **THEN** the response is 404 with `error.code: "NOT_FOUND"`

#### Scenario: Detail response omits the version key

- **WHEN** a job run is returned by the detail endpoint
- **THEN** the serialized document contains no `__v` field
