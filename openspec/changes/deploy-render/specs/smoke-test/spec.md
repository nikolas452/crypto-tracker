## ADDED Requirements

### Requirement: Post-deploy smoke test script
The system SHALL provide `npm run smoke -- --url <api>` performing five checks against the deployed API: `GET /health` returns 200; `GET /health/ready` returns 200; `GET /api/v1/coins?limit=1` returns 200 with at most one item; `GET /api/v1/status` returns 200; and `GET /api/v1/me` without a token returns 401.

#### Scenario: A healthy deployment passes every check
- **WHEN** the smoke test runs against a correctly deployed API with data present
- **THEN** all five checks pass and the script exits with code 0

#### Scenario: Authentication is verified to be enforced
- **WHEN** the smoke test calls `/api/v1/me` with no token
- **THEN** it expects and receives 401, confirming the deployed API is not serving authenticated routes openly

### Requirement: Exit code contract
The system SHALL exit with code 1 when any check fails, except that the status check MAY degrade to a warning rather than a failure.

#### Scenario: A failed readiness check fails the script
- **WHEN** `GET /health/ready` returns anything other than 200
- **THEN** the script reports the failure and exits with code 1

### Requirement: Stale status is a warning, not a failure
The status check SHALL pass when `stale` is `false`, and SHALL emit a warning rather than failing when `stale` is `true`, because no scheduler runs continuously in this deployment shape.

#### Scenario: A stale status warns but does not fail the deploy check
- **WHEN** the deployed API reports `stale: true` because no worker has run recently
- **THEN** the smoke test emits a warning and still exits with code 0 provided every other check passed

### Requirement: Cold start is tolerated
The system SHALL allow for the free plan's cold start when contacting a sleeping service, so the first request's latency does not cause a spurious failure.

#### Scenario: A sleeping service is woken rather than reported as down
- **WHEN** the smoke test runs against an API that has spun down
- **THEN** it waits for the instance to wake and evaluates the checks against the woken service
