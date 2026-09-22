## ADDED Requirements

### Requirement: User document shape
The system SHALL define a `users` collection with `_id` (ObjectId, used as `userId` by other collections), `firebaseUid` (string, required, unique), `email` (string or null, stored lowercase, synchronized from the token), `emailVerified` (boolean, synchronized from the token), `displayName` (string or null, 1-50 characters, trimmed), `role` (enum `user`/`admin`, default `user`), `lastSeenAt` (Date), and `createdAt`/`updatedAt` timestamps.

#### Scenario: User document matches the fixed shape
- **WHEN** a user profile is provisioned
- **THEN** it has `firebaseUid`, `email`, `emailVerified`, `displayName`, `role`, `lastSeenAt`, `createdAt` and `updatedAt`

#### Scenario: A user without an email claim stores null
- **WHEN** an identity carries no email claim
- **THEN** the stored `email` is `null` and `emailVerified` is `false`

### Requirement: User indexes
The system SHALL enforce a unique index on `{ firebaseUid: 1 }` and maintain a non-unique index on `{ email: 1 }` to support lookup from the development scripts.

#### Scenario: Duplicate firebaseUid is rejected at the database level
- **WHEN** two user documents are inserted with the same `firebaseUid`
- **THEN** the second insert fails due to the unique index

### Requirement: Just-in-time provisioning
The system SHALL implement `usersService.resolveFromIdentity(identity, now)`, which looks the user up by `firebaseUid` and, when absent, creates it with a `findOneAndUpdate` using `upsert: true`, `$setOnInsert` for `role` and `displayName`, and `$set` for `email`, `emailVerified` and `lastSeenAt`. Creation SHALL be logged at `info` with the `userId` and without the email.

#### Scenario: First valid token creates the profile
- **WHEN** a valid token for a previously unknown uid reaches `GET /api/v1/me`
- **THEN** a user document is created with `role: "user"` and returned in the response

#### Scenario: Creation log omits the email
- **WHEN** a user is created
- **THEN** the `info` log line contains the `userId` and does not contain the user's email address

### Requirement: Concurrent first requests create exactly one user
When the upsert fails with a duplicate-key error (`E11000`) because a concurrent request created the same user, the system SHALL retry exactly once with a `findOne` and return that document.

#### Scenario: A burst of concurrent first requests creates one document
- **WHEN** 10 concurrent requests arrive for the same previously unknown uid
- **THEN** exactly 1 document exists in `users` for that uid and all 10 requests respond 200

### Requirement: Token-driven field synchronization
For an existing user, the system SHALL update `email` and `emailVerified` when they differ from the token's claims.

#### Scenario: Verified status is synchronized from the token
- **WHEN** a token carries `email_verified: true` and the stored user has `emailVerified: false`
- **THEN** the stored `emailVerified` becomes `true`

### Requirement: Throttled last-seen updates
The system SHALL update `lastSeenAt` only when the stored value is older than `now - LAST_SEEN_THROTTLE_MIN` (default 5 minutes).

#### Scenario: A recent last-seen value is left untouched
- **WHEN** an existing user whose `lastSeenAt` is 1 minute old makes a request and the throttle is 5 minutes
- **THEN** `lastSeenAt` is not modified

#### Scenario: A stale last-seen value is refreshed
- **WHEN** an existing user whose `lastSeenAt` is 10 minutes old makes a request and the throttle is 5 minutes
- **THEN** `lastSeenAt` is updated to the current time

### Requirement: At most one write per authenticated request
The system SHALL combine any needed field synchronization and last-seen refresh into a single `updateOne`, and SHALL issue no write at all when neither is needed, so an authenticated request for an existing user performs at most one read and one write against `users`.

#### Scenario: An unchanged user triggers no write
- **WHEN** an existing user whose email, verified status and recent `lastSeenAt` all already match makes a request
- **THEN** no write is issued against `users`

#### Scenario: Email change and last-seen refresh share one update
- **WHEN** both the email and a stale `lastSeenAt` need updating for the same request
- **THEN** exactly one `updateOne` is issued
