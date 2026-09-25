## Purpose

This capability provides `requireRole(...roles)`, the role-check middleware applied after `requireAuth`, and its application to every route under `/api/v1/admin`, replacing the provisional shared admin key with an authenticated, database-backed role check.

## Requirements

### Requirement: Role check middleware

The system SHALL implement `requireRole(...roles)`, always used after `requireAuth`, which responds 403 `FORBIDDEN` when `req.user.role` is not among the accepted roles and otherwise passes control to the next handler.

#### Scenario: A user without the required role is forbidden

- **WHEN** a user whose role is `user` calls a route guarded by `requireRole('admin')`
- **THEN** the response is 403 with `error.code: "FORBIDDEN"`

#### Scenario: A user with the required role proceeds

- **WHEN** a user whose role is `admin` calls a route guarded by `requireRole('admin')`
- **THEN** the request reaches the route handler

### Requirement: Role is read from the database on every request

The system SHALL evaluate authorization against the `role` stored on the user document resolved for the current request, never against a token claim, so a role change takes effect on the very next request.

#### Scenario: A demotion takes effect immediately

- **WHEN** a user's stored role is changed from `admin` to `user` while they still hold a previously issued token
- **THEN** their next request to an admin route receives 403

### Requirement: Admin routes require an authenticated admin

The system SHALL guard every route under `/api/v1/admin` with `requireAuth({ checkRevoked: true })` followed by `requireRole('admin')`.

#### Scenario: Admin route without a token is unauthenticated

- **WHEN** a client calls an admin route with no `Authorization` header
- **THEN** the response is 401 with `error.code: "UNAUTHENTICATED"`

#### Scenario: Admin route with the retired admin key is unauthenticated

- **WHEN** a client calls `GET /api/v1/admin/job-runs` supplying only the old `X-Admin-Key` header and no token
- **THEN** the response is 401 with `error.code: "UNAUTHENTICATED"`

#### Scenario: Admin routes check token revocation

- **WHEN** any admin route is called
- **THEN** the token is verified with revocation checking enabled
