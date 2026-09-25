## ADDED Requirements

### Requirement: Profile read endpoint

The system SHALL expose `GET /api/v1/me`, guarded by `requireAuth`, responding 200 with `{ data: { id, email, emailVerified, displayName, role, createdAt } }`, where `id` is the string form of the user's `_id`.

#### Scenario: Authenticated user reads their own profile

- **WHEN** a client calls `GET /api/v1/me` with a valid token
- **THEN** the response is 200 with that user's `id`, `email`, `emailVerified`, `displayName`, `role` and `createdAt`

### Requirement: Profile update endpoint

The system SHALL expose `PATCH /api/v1/me`, guarded by `requireAuth`, accepting a strict body of `{ displayName?: string | null }` with at least one field present, and responding 200 with the same shape as `GET /api/v1/me`. Any field outside the schema SHALL produce 400 `VALIDATION_ERROR`.

#### Scenario: Display name is updated

- **WHEN** a client sends `PATCH /api/v1/me` with `{ "displayName": "Nico" }`
- **THEN** the response is 200 and the stored `displayName` is `"Nico"`

#### Scenario: Attempting to set the role is rejected

- **WHEN** a client sends `PATCH /api/v1/me` with `{ "role": "admin" }`
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"` and the stored role is unchanged

#### Scenario: An empty body is rejected

- **WHEN** a client sends `PATCH /api/v1/me` with no fields
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

### Requirement: Email is not editable through the API

The system SHALL NOT allow the user's email to be changed through any endpoint. Notifications SHALL always be sent to the verified email of the Firebase account.

#### Scenario: Email cannot be supplied to the profile update

- **WHEN** a client sends `PATCH /api/v1/me` with an `email` field
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

### Requirement: Account deletion endpoint

The system SHALL expose `DELETE /api/v1/me`, guarded by `requireAuth({ checkRevoked: true })`, which deletes the user's application data and responds 204 with no body.

#### Scenario: Account deletion removes the profile

- **WHEN** an authenticated user calls `DELETE /api/v1/me`
- **THEN** the response is 204 and the user document no longer exists

#### Scenario: Deletion requires a non-revoked token

- **WHEN** `DELETE /api/v1/me` is called
- **THEN** the token is verified with revocation checking enabled

### Requirement: Deletion does not remove the Firebase account

The system SHALL NOT delete the user's Firebase account. It SHALL be documented that a subsequent request with a still-valid token re-provisions a new, empty profile.

#### Scenario: A deleted user returning with a valid token is re-provisioned

- **WHEN** a user calls `DELETE /api/v1/me` and then calls `GET /api/v1/me` with a still-valid token
- **THEN** a new empty profile is created with `role: "user"`, as documented
