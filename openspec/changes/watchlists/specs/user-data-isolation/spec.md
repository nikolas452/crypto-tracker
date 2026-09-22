## ADDED Requirements

### Requirement: Every query is scoped to the authenticated user
The system SHALL include `userId: req.user._id` in every read, update and delete issued by the watchlist module, so no query can match another user's document.

#### Scenario: One user's action cannot reach another user's data
- **WHEN** user A adds `bitcoin` and user B lists their own watchlist
- **THEN** user B's watchlist is empty

#### Scenario: Deleting another user's item has no effect
- **WHEN** user B calls `DELETE /api/v1/me/watchlist/bitcoin` while only user A follows `bitcoin`
- **THEN** the response is 204 and user A's item is still present

### Requirement: User identity is never accepted from the client
The system SHALL NOT accept a `userId` value from a request body, query string or path parameter on any endpoint, and SHALL always derive it from the verified token's resolved user.

#### Scenario: A client-supplied user id is ignored or rejected
- **WHEN** a request includes a `userId` field in its body
- **THEN** the strict schema rejects it with 400 and no query is scoped to that value

### Requirement: Services take the user id as an explicit parameter
The system SHALL define watchlist service functions that receive `userId` as their first explicit parameter rather than reading it from ambient request state, so a caller cannot invoke them without choosing a scope.

#### Scenario: A service cannot be called without a scope
- **WHEN** a watchlist service function is invoked from a unit test
- **THEN** it requires an explicit `userId` argument and operates only on that user's documents
