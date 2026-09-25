## ADDED Requirements

### Requirement: Bearer scheme parsing

The system SHALL read the `Authorization` request header and respond 401 `UNAUTHENTICATED` when it is absent, when its scheme is not `Bearer` (compared case-insensitively), or when the token portion is empty or whitespace only.

#### Scenario: Missing Authorization header is refused

- **WHEN** a client calls `GET /api/v1/me` with no `Authorization` header
- **THEN** the response is 401 with `error.code: "UNAUTHENTICATED"`

#### Scenario: Non-Bearer scheme is refused

- **WHEN** a client calls an authenticated route with `Authorization: Basic xxx`
- **THEN** the response is 401 with `error.code: "UNAUTHENTICATED"`

#### Scenario: Bearer with an empty token is refused

- **WHEN** a client sends `Authorization: Bearer` with no token or only whitespace after it
- **THEN** the response is 401 with `error.code: "UNAUTHENTICATED"`

### Requirement: Oversized tokens are rejected before verification

The system SHALL respond 401 to any token longer than 4096 characters without invoking the `TokenVerifier`.

#### Scenario: Oversized token never reaches the verifier

- **WHEN** a client sends a Bearer token longer than 4096 characters
- **THEN** the response is 401 and the `TokenVerifier` is not called

### Requirement: Verification and revocation option

The system SHALL verify the token through the injected `TokenVerifier`, passing the `checkRevoked` value supplied when the middleware was constructed, as in `requireAuth({ checkRevoked: true })`, and SHALL surface the verifier's translated error unchanged.

#### Scenario: Expired token surfaces its specific code

- **WHEN** an expired token is presented to an authenticated route
- **THEN** the response is 401 with `error.code: "TOKEN_EXPIRED"`

#### Scenario: Sensitive routes request revocation checking

- **WHEN** a route is guarded by `requireAuth({ checkRevoked: true })`
- **THEN** the verifier is invoked with revocation checking enabled

### Requirement: Request augmentation with identity and user

After successful verification the system SHALL set `req.auth` to `{ uid, email, emailVerified }`, resolve the application user profile, and set `req.user` to that document before calling the next handler.

#### Scenario: Handlers receive both identity and profile

- **WHEN** a request passes `requireAuth`
- **THEN** `req.auth.uid` holds the verified uid and `req.user` holds the corresponding user document

### Requirement: Tokens are accepted only from the Authorization header

The system SHALL NOT accept an ID token from a query string parameter or from the request body under any circumstance.

#### Scenario: Token in the query string is ignored

- **WHEN** a client supplies a valid token as a query string parameter and no `Authorization` header
- **THEN** the response is 401 with `error.code: "UNAUTHENTICATED"`

### Requirement: Tokens are never logged

The system SHALL configure pino's `redact` to cover `req.headers.authorization`, so no log line at any level contains an ID token.

#### Scenario: Authenticated request logs omit the token

- **WHEN** an authenticated request is logged
- **THEN** the log entry contains no part of the `Authorization` header value

### Requirement: Typed request augmentation and user accessor

The system SHALL declare `src/types/express.d.ts` extending `Express.Request` with `id: string`, `auth?: { uid: string; email: string | null; emailVerified: boolean }` and `user?: UserDoc`, and SHALL provide a `getUser(req)` helper that returns a `UserDoc` or throws `UnauthenticatedError`, so controllers never use a non-null assertion.

#### Scenario: getUser throws instead of returning undefined

- **WHEN** `getUser(req)` is called on a request that did not pass `requireAuth`
- **THEN** it throws `UnauthenticatedError` rather than returning `undefined`
