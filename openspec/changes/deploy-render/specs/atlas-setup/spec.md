## ADDED Requirements

### Requirement: Free-tier cluster with documented limits

The system SHALL use a MongoDB Atlas M0 cluster in a region close to the deployed API, and SHALL document its relevant limits: 0.5 GB of storage, 100 operations per second, 500 connections, at most 50 aggregation pipeline stages, `allowDiskUse` ignored with a 32 MB in-memory sort ceiling, and automatic pausing after 30 days without connections.

#### Scenario: Cluster limits are written down

- **WHEN** a developer reads the deployment documentation
- **THEN** it lists the M0 storage, throughput, connection, pipeline and sort limits, and the auto-pause behavior

### Requirement: Time-series and transaction support verified on the real cluster

The system SHALL verify against the actual M0 cluster that a time-series collection can be created and that a transaction commits, before relying on either. When time-series collections are unavailable, `ensureCollections()` SHALL fail with a clear message and the documented fallback SHALL be a normal collection with a `{ "meta.coingeckoId": 1, timestamp: -1 }` index.

#### Scenario: Support is confirmed before deployment

- **WHEN** the cluster is provisioned
- **THEN** creating a time-series collection and committing a transaction are both exercised against it and the results recorded

#### Scenario: Missing time-series support fails loudly

- **WHEN** `ensureCollections()` cannot create the time-series collection on the cluster
- **THEN** it fails with a message naming the problem rather than silently creating a normal collection

### Requirement: Least-privilege database user

The system SHALL use a dedicated database user with the `readWrite` role scoped to the single application database, never a cluster-wide administrative role, with a generated password of at least 32 characters.

#### Scenario: The application credential cannot administer the cluster

- **WHEN** the application user's roles are inspected
- **THEN** it holds `readWrite` on the application database only, with no cluster-level role

### Requirement: Network access with a documented trade-off

The system SHALL configure Atlas network access either by allowlisting the platform's outbound addresses when the plan exposes them, which is preferred, or by allowing `0.0.0.0/0`, in which case the documentation SHALL state that security then rests entirely on the credential and TLS.

#### Scenario: An open access rule carries its risk note

- **WHEN** network access is configured as `0.0.0.0/0`
- **THEN** the documentation records that choice and the risk it accepts

### Requirement: Connection string and pool settings

The system SHALL connect with `retryWrites=true&w=majority` and an explicit maximum pool size from `MONGODB_MAX_POOL_SIZE` (default 10), so the cluster's connection limit is not approached.

#### Scenario: Writes are acknowledged by a majority

- **WHEN** the application connects to Atlas
- **THEN** the connection uses `retryWrites=true` and `w=majority`

#### Scenario: The connection pool is bounded

- **WHEN** the application connects
- **THEN** the driver is configured with the maximum pool size from configuration rather than the default

### Requirement: Storage estimate and monitoring query

The system SHALL document the expected storage footprint for the project's data volume and SHALL provide a `db.stats()` query for checking actual usage against the M0 limit.

#### Scenario: Storage headroom is verifiable

- **WHEN** an operator follows the documentation
- **THEN** they can run the documented query and compare actual storage against the free-tier limit
