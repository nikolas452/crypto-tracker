## Purpose

This capability protects the public API from abuse and overload by applying a global per-IP rate limit across the `/api` prefix, while keeping health-check endpoints exempt and documenting the limitations of the in-memory limiter store.

## Requirements

### Requirement: Proxy trust configuration

The system SHALL configure Express with `app.set('trust proxy', config.TRUST_PROXY)`, where `TRUST_PROXY` is an integer defaulting to 0 in development and 1 in production, so that the client address used for rate limiting is the originating client and not the reverse proxy.

#### Scenario: Client address is resolved through the proxy

- **WHEN** `TRUST_PROXY` is 1 and a request arrives with an `X-Forwarded-For` header
- **THEN** the request's resolved IP is the originating client address rather than the proxy's

### Requirement: Global per-IP rate limit over the API prefix

The system SHALL apply a global rate limiter to `/api` allowing `RATE_LIMIT_MAX` requests (default 300) per `RATE_LIMIT_WINDOW_MIN` minutes (default 15) per client IP, using the standard `RateLimit-*` response headers and disabling the legacy `X-RateLimit-*` headers.

#### Scenario: Requests within the budget are served

- **WHEN** a client makes fewer requests than `RATE_LIMIT_MAX` within the window
- **THEN** every request is served normally and carries the standard `RateLimit-*` headers

### Requirement: Exceeding the limit uses the global error format

When a client exceeds the limit, the system SHALL respond 429 with the project's global error body and `error.code: "RATE_LIMITED"`, produced through the limiter's `handler` option rather than the library's default body.

#### Scenario: The fourth request over a limit of three is refused

- **WHEN** `RATE_LIMIT_MAX` is 3 and a client makes 4 consecutive requests to `GET /api/v1/coins`
- **THEN** the fourth response is 429 with `error.code: "RATE_LIMITED"` in the project's error format

### Requirement: Health endpoints are exempt from rate limiting

The system SHALL NOT apply the rate limiter to `GET /health` or `GET /health/ready`, since those endpoints sit outside the `/api` prefix and are polled by deployment platforms.

#### Scenario: Health stays available while the API is limited

- **WHEN** a client has exhausted its API rate limit budget
- **THEN** `GET /health` still responds 200

### Requirement: In-memory store limitation is documented

The system SHALL use an in-memory rate-limit store, and SHALL document that running more than one API instance would give each instance its own independent budget, requiring a shared store such as Redis to fix.

#### Scenario: The single-instance constraint is written down

- **WHEN** a developer reads the project documentation for rate limiting
- **THEN** it states that the in-memory store is per-instance and names a shared store as the multi-instance solution
