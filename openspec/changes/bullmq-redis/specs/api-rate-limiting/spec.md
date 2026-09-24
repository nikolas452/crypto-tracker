## MODIFIED Requirements

### Requirement: In-memory store limitation is documented

The system SHALL select its rate-limit store with `RATE_LIMIT_STORE` (default `memory`). With `memory`, the store is per-instance, and the system SHALL document that running more than one API instance gives each its own independent budget. With `redis`, the limiters SHALL use a Redis-backed store so the budget is shared across instances; when Redis is unavailable in that mode the limiters SHALL **fail open**, allowing requests through and logging at `error`, and that choice of availability over protection SHALL be documented.

#### Scenario: The single-instance constraint is written down

- **WHEN** a developer reads the project documentation for rate limiting
- **THEN** it states that the in-memory store is per-instance and that the Redis store shares the budget across instances

#### Scenario: The shared store enforces one budget across instances

- **WHEN** `RATE_LIMIT_STORE` is `redis` and two API instances serve the same client
- **THEN** the client's requests count against a single shared budget

#### Scenario: A Redis outage lets requests through

- **WHEN** `RATE_LIMIT_STORE` is `redis` and Redis becomes unavailable
- **THEN** requests are allowed through and an `error` is logged, rather than being rejected

#### Scenario: The fail-open trade-off is documented

- **WHEN** a developer reads the rate-limiting documentation
- **THEN** it states that the Redis-backed limiter fails open, prioritizing availability over protection
