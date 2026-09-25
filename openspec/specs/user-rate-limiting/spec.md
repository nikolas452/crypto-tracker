## Purpose

This capability adds a second, per-user rate limiter that applies to authenticated routes in addition to the existing global per-IP limiter, keyed by the verified Firebase uid rather than the caller's address.

## Requirements

### Requirement: Per-user rate limit on authenticated routes

The system SHALL apply an additional rate limiter to routes behind `requireAuth`, keyed by `req.auth.uid`, allowing `USER_RATE_LIMIT_PER_MIN` requests (default 120) per minute per user.

#### Scenario: A user exceeding their per-minute budget is limited

- **WHEN** `USER_RATE_LIMIT_PER_MIN` is 2 and the same user makes 3 requests within a minute
- **THEN** the third response is 429 with `error.code: "RATE_LIMITED"`

#### Scenario: The limit follows the user, not the address

- **WHEN** the same user makes requests from different IP addresses
- **THEN** those requests share one per-user budget and the limit still applies

### Requirement: Registration order relative to authentication

The system SHALL register the per-user limiter after `requireAuth`, so that `req.auth.uid` is available as the key, and SHALL keep it alongside — not in place of — the global per-IP limiter.

#### Scenario: Both limiters apply to an authenticated route

- **WHEN** an authenticated request reaches a route under `/api`
- **THEN** it is counted against both the global per-IP budget and the per-user budget

#### Scenario: An unauthenticated request never reaches the per-user limiter

- **WHEN** a request fails authentication
- **THEN** it is rejected with 401 without being counted against any per-user budget
