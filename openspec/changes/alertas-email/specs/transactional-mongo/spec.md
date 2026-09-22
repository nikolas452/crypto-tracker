## ADDED Requirements

### Requirement: Local MongoDB runs as a replica set
The system SHALL configure the local `mongo` service to run with `--replSet rs0 --bind_ip_all` and a healthcheck that performs `rs.initiate()` when the set has not yet been initialized, and SHALL document the local connection URI as `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`.

#### Scenario: A fresh local environment supports transactions
- **WHEN** a developer runs `docker compose up` on a fresh checkout
- **THEN** MongoDB becomes available as an initialized single-node replica set capable of running transactions

### Requirement: Tests run against a replica set
The system SHALL use `MongoMemoryReplSet` with a single node for integration tests, replacing the standalone in-memory server.

#### Scenario: Integration tests can run a transaction
- **WHEN** an integration test starts a session and runs `withTransaction`
- **THEN** the transaction commits, because the in-memory server is a replica set

### Requirement: Startup verification of transaction support
On startup, both the API and the worker SHALL verify that the connection supports transactions by checking that the `hello` command reports a `setName`, and SHALL exit with code 1 and an explanatory message when it does not.

#### Scenario: A standalone server fails startup with a clear message
- **WHEN** either process starts against a standalone `mongod`
- **THEN** it exits with code 1 and logs a message stating that a replica set is required for transactions

#### Scenario: A replica set connection passes verification
- **WHEN** either process starts against an initialized replica set
- **THEN** verification passes and startup continues
