## ADDED Requirements

### Requirement: Coin document shape

The system SHALL define a `coins` collection with fields `coingeckoId` (string, required, unique, lowercase, matching `^[a-z0-9-]+$`), `symbol` (string, required, stored lowercase), `name` (string, required), `isActive` (boolean, default `true`), and `createdAt`/`updatedAt` timestamps.

#### Scenario: Coin document matches the fixed shape

- **WHEN** a coin document is created
- **THEN** it has `coingeckoId`, `symbol`, `name`, `isActive`, `createdAt`, and `updatedAt`

### Requirement: Coin uniqueness and lookup indexes

The system SHALL enforce a unique index on `{ coingeckoId: 1 }` and maintain an index on `{ isActive: 1 }` to support the job's active-coin lookup.

#### Scenario: Duplicate coingeckoId is rejected at the database level

- **WHEN** two coin documents are inserted with the same `coingeckoId`
- **THEN** the second insert fails due to the unique index

### Requirement: Active-coin flag drives job scope

The system SHALL only include coins with `isActive: true` when the polling job loads coins to fetch prices for.

#### Scenario: Inactive coins are excluded from polling

- **WHEN** a coin has `isActive: false`
- **THEN** the polling job does not request its price from CoinGecko
