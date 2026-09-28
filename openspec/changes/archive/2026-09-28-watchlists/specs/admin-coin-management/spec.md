## ADDED Requirements

### Requirement: Admin coin listing

The system SHALL expose `GET /api/v1/admin/coins`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, returning a paginated list that includes inactive coins, accepting an optional `isActive` filter, and including a `watchersCount` per coin computed with a `$group` over `watchlist_items` restricted to the coins on the requested page.

#### Scenario: Inactive coins appear in the admin listing

- **WHEN** an admin lists coins without filtering
- **THEN** coins with `isActive: false` are included

#### Scenario: Each listed coin reports how many users follow it

- **WHEN** three users follow `bitcoin` and an admin lists coins
- **THEN** `bitcoin`'s entry reports `watchersCount: 3`

### Requirement: Admin coin creation validates against CoinGecko

The system SHALL expose `POST /api/v1/admin/coins`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, accepting a strict body of `{ coingeckoId }` and validating it with `getMarkets([id])` before writing anything. When CoinGecko does not return the coin, the response SHALL be 422 with `details.reason: "UNKNOWN_COINGECKO_ID"`. When the CoinGecko call itself fails, the response SHALL be 502 `UPSTREAM_ERROR`.

#### Scenario: An unrecognized coin id is unprocessable

- **WHEN** an admin posts a `coingeckoId` CoinGecko does not recognize
- **THEN** the response is 422 with `details.reason: "UNKNOWN_COINGECKO_ID"` and no coin is created

#### Scenario: An upstream failure is reported as a bad gateway

- **WHEN** the CoinGecko call fails while validating a new coin
- **THEN** the response is 502 with `error.code: "UPSTREAM_ERROR"` and no coin is created

### Requirement: Creation, reactivation and conflict outcomes

When the coin does not exist, the system SHALL create it as active with the `name` and `symbol` returned by CoinGecko and respond 201. When it exists but is inactive, the system SHALL reactivate it, refresh its `name` and `symbol`, and respond 200. When it exists and is already active, the system SHALL respond 409 `CONFLICT`.

#### Scenario: A new coin is created active

- **WHEN** an admin posts a valid `coingeckoId` that is not yet in the catalog
- **THEN** the response is 201 and the coin exists with `isActive: true`

#### Scenario: An inactive coin is reactivated

- **WHEN** an admin posts the `coingeckoId` of an existing inactive coin
- **THEN** the response is 200 and that coin's `isActive` becomes `true`

#### Scenario: An already-active coin conflicts

- **WHEN** an admin posts the `coingeckoId` of an existing active coin
- **THEN** the response is 409 with `error.code: "CONFLICT"`

### Requirement: Admin coin writes are audit-logged

The system SHALL log every admin coin creation, reactivation and activation change at `info`, including the acting admin's `userId`.

#### Scenario: A coin creation names the acting admin

- **WHEN** an admin creates a coin
- **THEN** an `info` log line records the action together with that admin's `userId`

### Requirement: Admin activation toggle

The system SHALL expose `PATCH /api/v1/admin/coins/:coingeckoId`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, accepting a strict body of `{ isActive: boolean }` and responding 200 with the coin and its `watchersCount`. Deactivating a coin SHALL stop the polling job from requesting it from the next run onward, while preserving its snapshots and any watchlist items referencing it.

#### Scenario: Deactivation removes the coin from the next poll

- **WHEN** an admin sets `isActive: false` on `bitcoin`
- **THEN** the next `poll-prices` run does not request `bitcoin` from CoinGecko, and its stored snapshots remain

#### Scenario: The toggle response shows the affected user count

- **WHEN** an admin deactivates a coin followed by 3 users
- **THEN** the 200 response includes `watchersCount: 3`

### Requirement: Coins are never deleted

The system SHALL NOT provide any endpoint that deletes a coin document, and SHALL document that deactivation exists instead because deletion would discard price history and leave watchlist references dangling.

#### Scenario: No delete route exists for coins

- **WHEN** a client issues `DELETE` against an admin coin path
- **THEN** the response is 404, because no such route is registered

### Requirement: Non-admins cannot manage coins

The system SHALL reject admin coin requests from authenticated users whose role is not `admin` with 403 `FORBIDDEN`.

#### Scenario: A regular user cannot add a coin

- **WHEN** a user whose role is `user` calls `POST /api/v1/admin/coins`
- **THEN** the response is 403 with `error.code: "FORBIDDEN"`
