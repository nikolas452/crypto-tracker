## ADDED Requirements

### Requirement: Local Valkey service
The system SHALL add a `valkey` service to `docker-compose.yml` using the `valkey/valkey:8` image, exposing port 6379 and configured with `--maxmemory-policy noeviction --appendonly yes --appendfsync everysec`, and SHALL expose its address through `REDIS_URL`.

#### Scenario: A fresh clone gets a working queue backend
- **WHEN** a developer runs `docker compose up` on a fresh clone
- **THEN** Valkey is available on port 6379 with append-only persistence and the `noeviction` policy

### Requirement: Connectivity and eviction policy check at startup
On startup, the API and the worker SHALL issue a `PING` and read the configured eviction policy. When the policy is not `noeviction`, the system SHALL log at `fatal` and exit with code 1 in production, and log at `warn` in development. When the provider does not permit reading the configuration, the system SHALL log that it could not verify and continue.

#### Scenario: A wrong eviction policy is fatal in production
- **WHEN** the process starts in production against a Redis whose `maxmemory-policy` is not `noeviction`
- **THEN** it logs at `fatal` and exits with code 1

#### Scenario: A wrong eviction policy warns in development
- **WHEN** the process starts in development against a Redis whose policy is not `noeviction`
- **THEN** it logs a warning and continues

#### Scenario: An unreadable configuration is reported and tolerated
- **WHEN** the provider refuses the configuration read
- **THEN** the system logs that the policy could not be verified and continues starting

### Requirement: Eviction policy requirement is documented
The system SHALL document that BullMQ requires `noeviction`, because evicting keys corrupts queue state.

#### Scenario: The requirement is written down
- **WHEN** a developer reads the queue documentation
- **THEN** it states that `noeviction` is mandatory and why

### Requirement: Redis outage does not take down the API
The system SHALL keep serving endpoints that do not depend on the queues when Redis is unavailable.

#### Scenario: Read endpoints survive a Redis outage
- **WHEN** Redis is down and a client calls `GET /api/v1/coins`
- **THEN** the response is 200
