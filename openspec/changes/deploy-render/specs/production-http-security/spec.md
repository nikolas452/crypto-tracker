## ADDED Requirements

### Requirement: HSTS in production
The system SHALL configure `helmet` with HTTP Strict Transport Security in production, since the platform terminates TLS and the application is served only over HTTPS.

#### Scenario: Production responses carry the HSTS header
- **WHEN** the API responds in production
- **THEN** the response includes a `Strict-Transport-Security` header

### Requirement: CORS remains disabled
The system SHALL NOT enable cross-origin resource sharing.

#### Scenario: No CORS headers are emitted
- **WHEN** a cross-origin request reaches the API
- **THEN** the response carries no `Access-Control-Allow-Origin` header

### Requirement: Rate limits remain active in production
The system SHALL keep both the global per-IP limiter and the per-user limiter active in production.

#### Scenario: Limits apply to the deployed API
- **WHEN** a client exceeds the configured budget against the deployed API
- **THEN** the response is 429 with `error.code: "RATE_LIMITED"`

### Requirement: No stack traces in production responses
The system SHALL continue to exclude stack traces and internal error messages from responses when `NODE_ENV` is `production`.

#### Scenario: An unexpected error reveals nothing internal
- **WHEN** an unhandled error occurs in production
- **THEN** the response is the project's standard 500 error body with no stack trace and no internal message

### Requirement: Admin IP diagnostic endpoint
The system SHALL expose `GET /api/v1/admin/debug/ip`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, returning `req.ip` and `req.ips`, so that `trust proxy` configuration can be verified against a real request.

#### Scenario: An admin sees their own public address
- **WHEN** an admin calls the diagnostic endpoint through the platform's proxy with `TRUST_PROXY` correctly set
- **THEN** the returned `req.ip` is the admin's public address rather than the proxy's

#### Scenario: A non-admin cannot reach the diagnostic
- **WHEN** a user whose role is `user` calls the diagnostic endpoint
- **THEN** the response is 403 with `error.code: "FORBIDDEN"`
