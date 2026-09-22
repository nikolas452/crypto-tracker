## ADDED Requirements

### Requirement: Account deletion orchestration
The system SHALL implement `usersService.deleteAccount(userId)` as the single entry point for removing a user's data, called by `DELETE /api/v1/me`.

#### Scenario: Account deletion runs through the orchestrator
- **WHEN** `DELETE /api/v1/me` is handled
- **THEN** it delegates to `usersService.deleteAccount(userId)` rather than deleting documents directly in the controller

### Requirement: Dependents are deleted before the owner
The system SHALL delete the user's `watchlist_items` before deleting the user document, so an interruption can never leave items whose owner no longer exists.

#### Scenario: A user's watchlist items are removed with the account
- **WHEN** a user with 3 watchlist items calls `DELETE /api/v1/me`
- **THEN** no `watchlist_items` document with that `userId` remains

### Requirement: Cascade is safe to repeat
The system SHALL make the cascade idempotent, so re-running it after a partial failure completes the deletion without error.

#### Scenario: Re-running the cascade after a partial failure completes cleanly
- **WHEN** `deleteAccount` is invoked again after failing partway through a previous attempt
- **THEN** it removes whatever remains and completes without error

### Requirement: Each module deletes its own data
The system SHALL have `deleteAccount` call each owning module's own deletion function rather than issuing queries against another module's collection, so later stages extend the cascade by adding a call.

#### Scenario: The users module does not query the watchlist collection directly
- **WHEN** `deleteAccount` removes a user's watchlist items
- **THEN** it does so by calling the watchlist module's deletion function, not by querying `watchlist_items` itself
