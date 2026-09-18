## ADDED Requirements

### Requirement: Ordered shutdown sequence
The system SHALL, on receiving `SIGTERM` or `SIGINT`, log "shutdown iniciado" with the signal received, call `server.close()` to stop accepting new connections and wait for in-flight requests to finish, then call `disconnectDb()`, then exit with code 0.

#### Scenario: In-flight request completes before shutdown finishes
- **WHEN** the server receives `SIGTERM` while handling a slow request
- **THEN** the in-flight request completes successfully, and only afterward does the process exit with code 0

### Requirement: Shutdown timeout enforcement
The system SHALL start a timer of `SHUTDOWN_TIMEOUT_MS` when shutdown begins; if the shutdown sequence has not completed by the time it fires, the system SHALL log at `error` and exit with code 1.

#### Scenario: Hung shutdown forces exit with failure code
- **WHEN** the shutdown sequence does not complete within `SHUTDOWN_TIMEOUT_MS`
- **THEN** the process logs an error and exits with code 1

### Requirement: Forced immediate exit on repeated interrupt
The system SHALL, if a second `SIGINT` is received while a shutdown is already in progress, exit immediately without waiting for the in-progress sequence to complete.

#### Scenario: Second Ctrl+C forces immediate exit
- **WHEN** `SIGINT` is received twice in quick succession
- **THEN** the process exits immediately on the second signal, without waiting for in-flight requests or the DB disconnect

### Requirement: Fatal handling of unhandled errors
The system SHALL register handlers for `unhandledRejection` and `uncaughtException` that log at `fatal` and trigger the same shutdown sequence with exit code 1.

#### Scenario: Unhandled promise rejection triggers fatal shutdown
- **WHEN** a promise rejection is not caught anywhere in the process
- **THEN** it is logged at `fatal` and the process shuts down with exit code 1
