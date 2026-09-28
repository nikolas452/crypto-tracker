## Purpose

This capability defines how a user's dependent data is removed when their account is deleted: a single orchestration entry point that deletes owned data module-by-module, before the user document itself, safely and idempotently.

## Requirements

### Requirement: Account deletion orchestration

The system SHALL implement `usersService.deleteAccount(userId)` as the single entry point for removing a user's data, called by `DELETE /api/v1/me`.

#### Scenario: Account deletion runs through the orchestrator

- **WHEN** `DELETE /api/v1/me` is handled
- **THEN** it delegates to `usersService.deleteAccount(userId)` rather than deleting documents directly in the controller

### Requirement: Dependents are deleted before the owner

The system SHALL perform account deletion in this order: move the user's `pending` notifications to `cancelled`, delete the user's alerts, delete the user's `watchlist_items`, then delete the user document. Notification history for that user SHALL also be deleted, except for notifications currently in `sending`, which are left to finish and are afterwards removed by TTL retention.

#### Scenario: A user's watchlist items are removed with the account

- **WHEN** a user with 3 watchlist items calls `DELETE /api/v1/me`
- **THEN** no `watchlist_items` document with that `userId` remains

#### Scenario: Alerts and queued notifications are removed with the account

- **WHEN** a user with 2 alerts and 1 pending notification calls `DELETE /api/v1/me`
- **THEN** no alert with that `userId` remains, the pending notification is cancelled or deleted, and it is never sent

#### Scenario: A notification already being sent is left to finish

- **WHEN** a user is deleted while one of their notifications is in `sending`
- **THEN** that notification is not deleted during the cascade and is removed later by TTL retention

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
