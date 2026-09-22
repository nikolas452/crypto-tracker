## ADDED Requirements

### Requirement: Time-series collection shape
The system SHALL define `price_snapshots` as a MongoDB time-series collection with `timeField: "timestamp"`, `metaField: "meta"`, `granularity: "minutes"`, and `expireAfterSeconds` computed from `SNAPSHOT_RETENTION_DAYS × 86400` (or no expiration if the variable is unset). Documents SHALL have `timestamp` (Date, required), `meta.coinId` (ObjectId, required), `meta.coingeckoId` (string, required), `priceUsd` (number, required, > 0), `marketCapUsd`/`volume24hUsd`/`change24hPct` (number or null), and `sourceUpdatedAt` (Date or null).

#### Scenario: Snapshot document matches the fixed shape
- **WHEN** a price snapshot is inserted
- **THEN** it has `timestamp`, `meta.coinId`, `meta.coingeckoId`, `priceUsd`, and the optional numeric fields as `number` or `null`

### Requirement: Only identity fields live in meta
The system SHALL only ever store `coinId` and `coingeckoId` inside `meta`, and SHALL never place a per-point value (such as price) inside `meta`, since MongoDB buckets time-series documents by the `meta` value.

#### Scenario: meta stays limited to identity fields
- **WHEN** a new field is proposed for `price_snapshots`
- **THEN** it is added at the document's top level (like `priceUsd`), never nested under `meta`, unless it identifies the series rather than a single point

### Requirement: Secondary index for time-range queries by coin
The system SHALL maintain an index on `{ "meta.coingeckoId": 1, timestamp: -1 }`.

#### Scenario: Query by coin and time range uses the index
- **WHEN** snapshots are queried for a specific `coingeckoId` ordered by `timestamp` descending
- **THEN** the query is served by the `{ "meta.coingeckoId": 1, timestamp: -1 }` index

### Requirement: Explicit collection creation before first use
The system SHALL provide `ensureCollections()`, invoked at startup by every entrypoint that may touch Mongo first (API, worker, scripts). If `price_snapshots` does not exist, it SHALL be created with the time-series options above via `createCollection`, before any insert can implicitly create it as a normal collection.

#### Scenario: First-ever startup creates the time-series collection
- **WHEN** the worker starts and `price_snapshots` does not exist yet
- **THEN** `price_snapshots` is created as a time-series collection with `timeField: "timestamp"` and `metaField: "meta"`

### Requirement: Validation of an existing collection's shape
If `price_snapshots` already exists, the system SHALL verify via `listCollections` that it is a time-series collection with the expected `timeField` and `metaField`. If it is not, the system SHALL log at `fatal` an explanatory message (including how to correct it) and exit with code 1.

#### Scenario: Existing normal collection with the same name fails fast
- **WHEN** `price_snapshots` already exists as a normal (non-time-series) collection
- **THEN** the process logs a fatal error explaining the mismatch and exits with code 1

### Requirement: Retention updates via collMod
If `SNAPSHOT_RETENTION_DAYS` differs from the collection's current `expireAfterSeconds` value, the system SHALL update it using `collMod` and log the change at `info`.

#### Scenario: Changed retention setting is applied without recreating the collection
- **WHEN** `SNAPSHOT_RETENTION_DAYS` changes between deploys
- **THEN** `ensureCollections()` updates the existing collection's expiration via `collMod` and logs the change
