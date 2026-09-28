## MODIFIED Requirements

### Requirement: Account deletion endpoint

The system SHALL expose `DELETE /api/v1/me`, guarded by `requireAuth({ checkRevoked: true })`, which delegates to `usersService.deleteAccount(userId)` to remove the user's dependent data — starting with their watchlist items — before deleting the user document, and responds 204 with no body.

#### Scenario: Account deletion removes the profile

- **WHEN** an authenticated user calls `DELETE /api/v1/me`
- **THEN** the response is 204 and the user document no longer exists

#### Scenario: Account deletion removes the user's watchlist

- **WHEN** a user with watchlist items calls `DELETE /api/v1/me`
- **THEN** no `watchlist_items` document with that `userId` remains

#### Scenario: Deletion requires a non-revoked token

- **WHEN** `DELETE /api/v1/me` is called
- **THEN** the token is verified with revocation checking enabled
