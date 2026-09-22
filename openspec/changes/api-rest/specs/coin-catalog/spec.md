## MODIFIED Requirements

### Requirement: Coin document shape
The system SHALL define a `coins` collection with fields `coingeckoId` (string, required, unique, lowercase, matching `^[a-z0-9-]+$`), `symbol` (string, required, stored lowercase), `name` (string, required), `nameLower` (string, the lowercased `name`, maintained by a `pre('save')` hook and by the seed's upsert), `isActive` (boolean, default `true`), `latest` (sub-document or `null`, default `null`, containing `priceUsd` (number), `marketCapUsd` (number or null), `volume24hUsd` (number or null), `change24hPct` (number or null), `capturedAt` (Date) and `sourceUpdatedAt` (Date or null)), and `createdAt`/`updatedAt` timestamps.

#### Scenario: Coin document matches the fixed shape
- **WHEN** a coin document is created
- **THEN** it has `coingeckoId`, `symbol`, `name`, `nameLower`, `isActive`, `latest`, `createdAt`, and `updatedAt`

#### Scenario: A coin that has never been polled has a null latest
- **WHEN** a coin is created by the seed and no snapshot has been stored for it yet
- **THEN** its `latest` is `null`

#### Scenario: nameLower is derived on save and on seed upsert
- **WHEN** a coin is saved with `name: "Bitcoin"`, whether through a model save or the seed's upsert
- **THEN** its stored `nameLower` is `"bitcoin"`

### Requirement: Coin uniqueness and lookup indexes
The system SHALL enforce a unique index on `{ coingeckoId: 1 }` and maintain an index on `{ isActive: 1 }` to support the job's active-coin lookup, plus the read API's compound indexes `{ isActive: 1, "latest.marketCapUsd": -1 }`, `{ isActive: 1, nameLower: 1 }`, `{ isActive: 1, symbol: 1 }` and `{ isActive: 1, "latest.change24hPct": -1 }`.

#### Scenario: Duplicate coingeckoId is rejected at the database level
- **WHEN** two coin documents are inserted with the same `coingeckoId`
- **THEN** the second insert fails due to the unique index

#### Scenario: The coin list query is served by an index
- **WHEN** the coin list query filtering on `isActive` and sorting by `latest.marketCapUsd` is explained
- **THEN** the winning plan uses an `IXSCAN` and not a `COLLSCAN`
