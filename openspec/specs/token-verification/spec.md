## Purpose

This capability defines the `TokenVerifier` contract used to verify Firebase ID tokens, its real `verifyIdToken`-based implementation, the fixed Firebase-error-to-`AppError` translation table, the `FakeTokenVerifier` used by tests, and the rule that the verifier is injected through `createApp(deps)` rather than constructed inside route handlers.

## Requirements

### Requirement: TokenVerifier contract

The system SHALL define a `TokenVerifier` interface with `verify(idToken: string, opts?: { checkRevoked?: boolean }): Promise<VerifiedIdentity>`, where `VerifiedIdentity` is `{ uid: string; email: string | null; emailVerified: boolean; name: string | null }`.

#### Scenario: Verification returns a normalized identity

- **WHEN** a valid ID token is verified
- **THEN** the result contains `uid`, `email`, `emailVerified` and `name`, with `email` and `name` set to `null` when the token carries no such claim

### Requirement: Real verifier implementation

The real implementation SHALL call `getAuth().verifyIdToken(token, checkRevoked)`, passing the `checkRevoked` flag supplied by the caller and defaulting it to `false`.

#### Scenario: Revocation checking is opt-in

- **WHEN** `verify` is called without options
- **THEN** `verifyIdToken` is invoked with revocation checking disabled

### Requirement: Firebase error translation table

The system SHALL translate Firebase verification failures into the project's error hierarchy as follows: `auth/id-token-expired` → `UnauthenticatedError` with code `TOKEN_EXPIRED`; `auth/id-token-revoked` → `UnauthenticatedError` with code `TOKEN_REVOKED`; `auth/user-disabled` → `ForbiddenError` with code `USER_DISABLED`; `auth/argument-error` and any other malformed-token or signature error → `UnauthenticatedError` with code `UNAUTHENTICATED`; a network failure while checking revocation → `UpstreamError` with code `FIREBASE_UNAVAILABLE`.

#### Scenario: Expired token maps to its own code

- **WHEN** Firebase rejects a token with `auth/id-token-expired`
- **THEN** an `UnauthenticatedError` with code `TOKEN_EXPIRED` is thrown

#### Scenario: Disabled user maps to forbidden

- **WHEN** Firebase rejects a token with `auth/user-disabled`
- **THEN** a `ForbiddenError` with code `USER_DISABLED` is thrown

#### Scenario: Network failure during revocation check maps to upstream

- **WHEN** the revocation check fails because Firebase is unreachable
- **THEN** an `UpstreamError` with code `FIREBASE_UNAVAILABLE` is thrown

#### Scenario: Token issued for another project is unauthenticated

- **WHEN** a token whose audience belongs to a different Firebase project is verified
- **THEN** an `UnauthenticatedError` with code `UNAUTHENTICATED` is thrown

### Requirement: Fake verifier for tests

The system SHALL provide a `FakeTokenVerifier`, used only by tests, that resolves tokens against a fixed map of token strings to identities and can be configured to throw each error in the translation table.

#### Scenario: Tests verify tokens without network access

- **WHEN** a test verifies a token through `FakeTokenVerifier`
- **THEN** the configured identity is returned without any call to Firebase

### Requirement: Verifier injection

The system SHALL inject the `TokenVerifier` into the application through `createApp(deps)`, constructing the real implementation only in the process entrypoint.

#### Scenario: Integration tests inject the fake verifier

- **WHEN** an integration test builds the app with `createApp({ tokenVerifier: fake })`
- **THEN** every authenticated route uses the injected fake verifier
