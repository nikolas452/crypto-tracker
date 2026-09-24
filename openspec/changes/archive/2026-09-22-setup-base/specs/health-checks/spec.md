## ADDED Requirements

### Requirement: Liveness endpoint

The system SHALL expose `GET /health`, outside the `/api/v1` prefix, which SHALL NOT query the database or any external service, and SHALL respond 200 with `status: "ok"`, a numeric `uptimeSeconds`, and a `timestamp`.

#### Scenario: Liveness responds without checking dependencies

- **WHEN** a client calls `GET /health`
- **THEN** the response is 200 with `status: "ok"`, a numeric `uptimeSeconds`, and the `X-Request-Id` response header set

### Requirement: Readiness endpoint

The system SHALL expose `GET /health/ready`, which SHALL check that `mongoose.connection.readyState === 1` and execute a database ping with a 2-second timeout. On success it SHALL respond 200 with `status: "ready"` and `checks.mongo: "up"`. On failure it SHALL respond 503 with `status: "not_ready"` and `checks.mongo: "down"`. This endpoint is the one exception to the project's global error format, since deploy platforms read the status code and the body describes the checks.

#### Scenario: Ready when Mongo is connected

- **WHEN** Mongo is connected and the ping succeeds
- **THEN** `GET /health/ready` responds 200 with `checks.mongo: "up"`

#### Scenario: Not ready when Mongo is disconnected

- **WHEN** Mongo is disconnected
- **THEN** `GET /health/ready` responds 503 with `status: "not_ready"` and `checks.mongo: "down"`

### Requirement: Extensible readiness checks

The system SHALL implement readiness checks as an extensible list of `{ name, check(): Promise<void> }` entries, so later stages can add checks (e.g. Redis, SMTP) without rewriting the endpoint.

#### Scenario: Adding a new check requires no endpoint rewrite

- **WHEN** a new entry is appended to the readiness checks list
- **THEN** `GET /health/ready` includes that check's result under `checks.<name>` without changes to the route handler
