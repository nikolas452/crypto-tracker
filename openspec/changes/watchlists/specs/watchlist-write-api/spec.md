## ADDED Requirements

### Requirement: Add item validation order

The system SHALL expose `POST /api/v1/me/watchlist`, guarded by `requireAuth`, accepting a strict body of `{ coingeckoId: string, note?: string | null }`, and SHALL apply its validations in this fixed order: body shape (400 on failure), coin exists and is active (404 `NOT_FOUND` otherwise), current item count below `WATCHLIST_MAX_ITEMS` (422 `UNPROCESSABLE` with `details.reason: "LIMIT_REACHED"` otherwise), then insertion.

#### Scenario: A malformed body fails before any lookup

- **WHEN** a client posts a body missing `coingeckoId` or containing an unknown field
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"` and no coin lookup is performed

#### Scenario: An unknown or inactive coin cannot be added

- **WHEN** a user posts a `coingeckoId` that does not exist, or one whose coin has `isActive: false`
- **THEN** the response is 404 with `error.code: "NOT_FOUND"`

#### Scenario: Reaching the cap is reported as unprocessable

- **WHEN** `WATCHLIST_MAX_ITEMS` is 2, the user already has 2 items, and they add a third
- **THEN** the response is 422 with `error.code: "UNPROCESSABLE"` and `details.reason: "LIMIT_REACHED"`

### Requirement: Duplicate addition is a conflict

The system SHALL translate a duplicate-key error (`E11000`) from the unique `{ userId, coinId }` index into a 409 `CONFLICT` response.

#### Scenario: Adding the same coin twice conflicts

- **WHEN** a user posts a coin already present in their watchlist
- **THEN** the response is 409 with `error.code: "CONFLICT"`

#### Scenario: Two simultaneous identical additions produce one success

- **WHEN** a user sends two concurrent `POST` requests for the same coin
- **THEN** exactly one responds 201 and the other responds 409, and exactly one item exists

### Requirement: Successful addition response

On success the system SHALL respond 201 with the item in the same shape the listing endpoint uses, and SHALL set a `Location` header of `/api/v1/me/watchlist/<coingeckoId>`.

#### Scenario: A created item is returned with its location

- **WHEN** a user successfully adds a coin
- **THEN** the response is 201 with the item and a `Location` header naming that coin's watchlist path

### Requirement: Non-atomic cap check is documented

The system SHALL document that counting items and then inserting is not atomic, so concurrent requests may leave a user with one more item than `WATCHLIST_MAX_ITEMS`, and that this is an accepted limitation.

#### Scenario: The limitation is written down

- **WHEN** a developer reads the project documentation for the watchlist cap
- **THEN** it states that the count-then-insert sequence is not atomic and that a small overshoot is accepted

### Requirement: Note update endpoint

The system SHALL expose `PATCH /api/v1/me/watchlist/:coingeckoId`, guarded by `requireAuth`, accepting a strict body of `{ note: string | null }`, resolving the coin by `coingeckoId` whether it is active or not, and then the item by `{ userId, coinId }`. When no such item exists for the caller, the response SHALL be 404. On success it SHALL respond 200 with the updated item.

#### Scenario: A note is updated

- **WHEN** a user patches the note of a coin in their watchlist
- **THEN** the response is 200 and the stored note is the new value

#### Scenario: Patching a coin the user does not follow is not found

- **WHEN** a user patches `ethereum` without having it in their watchlist
- **THEN** the response is 404 with `error.code: "NOT_FOUND"`

#### Scenario: A deactivated coin's note can still be edited

- **WHEN** a user patches the note of an item whose coin has `isActive: false`
- **THEN** the response is 200 and the note is updated

### Requirement: Idempotent removal endpoint

The system SHALL expose `DELETE /api/v1/me/watchlist/:coingeckoId`, guarded by `requireAuth`, performing `deleteOne({ userId, coinId })` and responding 204 regardless of whether anything was deleted, including when the `coingeckoId` matches no coin at all. A `coingeckoId` that fails pattern validation SHALL produce 400.

#### Scenario: Repeated deletion always succeeds

- **WHEN** a user calls `DELETE /api/v1/me/watchlist/bitcoin` twice
- **THEN** both responses are 204

#### Scenario: Deleting an unknown coin id still succeeds

- **WHEN** a user deletes a `coingeckoId` that matches no coin
- **THEN** the response is 204

#### Scenario: A malformed coin id is a validation error

- **WHEN** the `coingeckoId` in the path does not match the model's pattern
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

### Requirement: Coin id normalization in paths

The system SHALL lowercase the `coingeckoId` path parameter before validating and resolving it.

#### Scenario: A mixed-case coin id resolves correctly

- **WHEN** a user calls a watchlist route with `/Bitcoin` in the path
- **THEN** it is normalized to `bitcoin` and resolves to the same coin
