## MODIFIED Requirements

### Requirement: COINGECKO_API_KEY required for this entrypoint

The system SHALL require `COINGECKO_API_KEY` to be present when `worker.ts` starts, failing fast (fatal log, exit 1) if it is missing, using the same config-validation mechanism as `setup-base`'s `app-config` capability. The API entrypoint SHALL also require this variable, because the admin coin management endpoints call CoinGecko to validate coin identifiers.

#### Scenario: Missing API key fails the worker fast

- **WHEN** the worker starts without `COINGECKO_API_KEY` set
- **THEN** it logs a fatal error naming the missing variable and exits with code 1, without scheduling any job

#### Scenario: Missing API key fails the API fast

- **WHEN** the API starts without `COINGECKO_API_KEY` set
- **THEN** it logs a fatal error naming the missing variable and exits with code 1, without listening for requests
