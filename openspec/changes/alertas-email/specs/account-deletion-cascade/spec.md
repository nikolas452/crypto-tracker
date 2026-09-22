## MODIFIED Requirements

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
