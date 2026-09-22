## MODIFIED Requirements

### Requirement: Public status endpoint
The system SHALL expose `GET /api/v1/status` without authentication, responding `{ data: { activeCoins, pollPrices: { lastSuccessAt, lastRunAt, lastRunStatus, stale, nextRunAt, disabled } } }`, where `activeCoins` is the count of coins with `isActive: true`, `nextRunAt` is the scheduled next execution time of the recurring `poll-prices` job, and `disabled` reports whether an administrator has disabled it.

#### Scenario: Status is readable without credentials
- **WHEN** an unauthenticated client calls `GET /api/v1/status`
- **THEN** the response is 200 with `activeCoins` and a `pollPrices` summary

#### Scenario: The next scheduled run is visible
- **WHEN** the recurring polling job is scheduled
- **THEN** the response's `pollPrices.nextRunAt` is that job's next execution time

#### Scenario: A disabled polling job is reported
- **WHEN** an administrator has disabled `poll-prices`
- **THEN** the response's `pollPrices.disabled` is `true`
