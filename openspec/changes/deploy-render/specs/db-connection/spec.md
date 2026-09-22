## MODIFIED Requirements

### Requirement: Mongoose connection configuration
The system SHALL configure Mongoose with `strictQuery: true`, with `autoIndex` enabled in `development` and `test` and disabled in `production`, and with an explicit `maxPoolSize` read from `MONGODB_MAX_POOL_SIZE` (default 10) so a deployment does not approach the database's connection limit.

#### Scenario: autoIndex disabled in production
- **WHEN** `NODE_ENV` is `production` and the connection is established
- **THEN** Mongoose is configured with `autoIndex: false`

#### Scenario: The connection pool is explicitly bounded
- **WHEN** the connection is established
- **THEN** Mongoose is configured with the `maxPoolSize` value from configuration rather than relying on the driver default
