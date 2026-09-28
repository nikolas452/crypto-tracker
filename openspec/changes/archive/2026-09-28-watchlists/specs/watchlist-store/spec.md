## ADDED Requirements

### Requirement: Watchlist item document shape

The system SHALL define a `watchlist_items` collection with `_id` (ObjectId), `userId` (ObjectId, required, referencing `users._id`), `coinId` (ObjectId, required, referencing `coins._id`), `note` (string or null, at most 200 characters, trimmed, stored as plain text), `addedAt` (Date, required) and `updatedAt` (Date).

#### Scenario: Watchlist item matches the fixed shape

- **WHEN** a watchlist item is created
- **THEN** it has `userId`, `coinId`, `note`, `addedAt` and `updatedAt`

#### Scenario: A note longer than the limit is rejected

- **WHEN** a note longer than 200 characters is supplied
- **THEN** the write is rejected with a validation error

### Requirement: Unique pairing index

The system SHALL enforce a unique compound index on `{ userId: 1, coinId: 1 }`, so the same coin cannot appear twice in one user's watchlist even under concurrent writes.

#### Scenario: Duplicate pairing is rejected at the database level

- **WHEN** two documents are inserted with the same `userId` and `coinId`
- **THEN** the second insert fails with a duplicate-key error

#### Scenario: The same coin for two different users is allowed

- **WHEN** two different users each add the same coin
- **THEN** both inserts succeed

### Requirement: Supporting indexes

The system SHALL maintain an index on `{ userId: 1, addedAt: -1 }` to serve a user's watchlist listing, and an index on `{ coinId: 1 }` to count how many users follow a coin.

#### Scenario: A user's watchlist listing is served by an index

- **WHEN** the watchlist listing query for one user is explained
- **THEN** the winning plan uses an `IXSCAN` on the `{ userId: 1, addedAt: -1 }` index rather than a `COLLSCAN`

### Requirement: Per-user item cap

The system SHALL cap the number of watchlist items per user at `WATCHLIST_MAX_ITEMS` (default 50).

#### Scenario: The configured cap is exposed to the client

- **WHEN** a user reads their watchlist
- **THEN** the response's `meta.max` equals `WATCHLIST_MAX_ITEMS`
