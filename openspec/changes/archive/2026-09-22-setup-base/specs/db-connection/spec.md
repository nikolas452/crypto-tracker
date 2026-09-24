## ADDED Requirements

### Requirement: Startup connection with retry and backoff

The system SHALL expose `connectDb(uri, dbName, logger)`, which attempts to connect to MongoDB up to 5 times with exponential backoff between attempts (1s, 2s, 4s, 8s). Each failed attempt SHALL be logged at `warn` with the attempt number, without revealing the connection URI. If all 5 attempts fail, the system SHALL log at `fatal` and exit the process with code 1.

#### Scenario: Mongo unavailable at boot exhausts retries and exits

- **WHEN** MongoDB is unreachable for all 5 connection attempts during startup
- **THEN** the process logs a fatal error and exits with code 1, and never starts listening for HTTP requests

#### Scenario: Connection failures never expose the URI

- **WHEN** a connection attempt fails
- **THEN** the warning log includes the attempt number but not the MongoDB URI

### Requirement: Connection lifecycle logging

The system SHALL log Mongoose connection lifecycle events: `connected` at `info`, `disconnected` at `warn`, `reconnected` at `info`, and `error` at `error`.

#### Scenario: Mongo drops after the server is already running

- **WHEN** an established Mongo connection is lost while the API process is running
- **THEN** a `disconnected` event is logged at `warn`, and if the connection is later restored a `reconnected` event is logged at `info`

### Requirement: Graceful disconnect

The system SHALL expose `disconnectDb()`, which closes the active Mongoose connection, and this function SHALL be invoked as part of the process shutdown sequence.

#### Scenario: Disconnect closes the active connection

- **WHEN** `disconnectDb()` is called while connected
- **THEN** the Mongoose connection is closed cleanly

### Requirement: No listening before the database is ready

The system SHALL NOT call `listen()` on the HTTP server until the initial MongoDB connection has been established successfully.

#### Scenario: Server never opens its port without a DB connection

- **WHEN** the initial connection attempts are still in progress or have all failed
- **THEN** the HTTP server has not started listening on its configured port

### Requirement: Mongoose connection configuration

The system SHALL configure Mongoose with `strictQuery: true`, with `autoIndex` enabled in `development` and `test` and disabled in `production`.

#### Scenario: autoIndex disabled in production

- **WHEN** `NODE_ENV` is `production` and the connection is established
- **THEN** Mongoose is configured with `autoIndex: false`
