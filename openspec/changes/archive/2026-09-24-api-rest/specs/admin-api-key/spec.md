## ADDED Requirements

### Requirement: Provisional admin key middleware

The system SHALL implement a `requireAdminKey` middleware that guards every route under `/api/v1/admin`, reading the `X-Admin-Key` request header and comparing it against the `ADMIN_API_KEY` configuration value. This protection is explicitly provisional and is replaced by authenticated role-based authorization in a later stage.

#### Scenario: A valid key grants access

- **WHEN** a client calls an admin route with an `X-Admin-Key` header equal to `ADMIN_API_KEY`
- **THEN** the request proceeds to the route handler

### Requirement: Constant-time key comparison

The system SHALL compare the supplied key with `ADMIN_API_KEY` using `crypto.timingSafeEqual`. When the two values differ in length, the system SHALL treat them as different without calling `timingSafeEqual`.

#### Scenario: Keys of differing length are rejected without throwing

- **WHEN** the supplied `X-Admin-Key` has a different length from `ADMIN_API_KEY`
- **THEN** the request is rejected as unauthenticated and `timingSafeEqual` is not invoked

### Requirement: Missing or wrong key is unauthenticated

The system SHALL respond 401 with `error.code: "UNAUTHENTICATED"` when the `X-Admin-Key` header is absent or does not match the configured key.

#### Scenario: Admin route without the header is refused

- **WHEN** a client calls `GET /api/v1/admin/job-runs` with no `X-Admin-Key` header
- **THEN** the response is 401 with `error.code: "UNAUTHENTICATED"`

#### Scenario: Admin route with a wrong key is refused

- **WHEN** a client calls an admin route with an incorrect `X-Admin-Key`
- **THEN** the response is 401 with `error.code: "UNAUTHENTICATED"`

### Requirement: Unconfigured admin surface is invisible

When `ADMIN_API_KEY` is not configured, the system SHALL respond 404 `NOT_FOUND` to every `/api/v1/admin` route, as if those routes did not exist, rather than 401.

#### Scenario: Admin routes vanish without a configured key

- **WHEN** `ADMIN_API_KEY` is unset and a client calls `GET /api/v1/admin/job-runs`
- **THEN** the response is 404 with `error.code: "NOT_FOUND"`

### Requirement: Admin key configuration constraints

The system SHALL treat `ADMIN_API_KEY` as optional configuration, and SHALL require it to be at least 32 characters long when present.

#### Scenario: A short admin key fails configuration validation

- **WHEN** `ADMIN_API_KEY` is set to a value shorter than 32 characters
- **THEN** configuration validation fails at startup, naming the variable without printing its value
