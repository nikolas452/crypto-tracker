## ADDED Requirements

### Requirement: Additional variables required in production

When `NODE_ENV` is `production`, the system SHALL additionally require the Firebase credential variables and `TRUST_PROXY`, failing fast at startup with the same log-and-exit-1 behavior used for every other configuration failure.

#### Scenario: Missing proxy configuration fails startup in production

- **WHEN** the API starts with `NODE_ENV=production` and no `TRUST_PROXY`
- **THEN** it exits with code 1 and the fatal log names the missing variable without printing its value

#### Scenario: Missing Firebase credentials fail startup in production

- **WHEN** the API starts in production without the Firebase service-account variables
- **THEN** it exits with code 1 naming the missing variables

### Requirement: Trust proxy must be at least one in production

When `NODE_ENV` is `production`, the system SHALL require `TRUST_PROXY` to be at least 1, since the application runs behind the platform's reverse proxy.

#### Scenario: A zero proxy depth is rejected in production

- **WHEN** the API starts in production with `TRUST_PROXY` set to 0
- **THEN** configuration validation fails and the process exits with code 1

### Requirement: Development-only variables forbidden in production

When `NODE_ENV` is `production`, the system SHALL refuse to start if `FIREBASE_AUTH_EMULATOR_HOST` or `FIREBASE_WEB_API_KEY` is set, since the first would accept unsigned tokens and the second is used only by local scripts.

#### Scenario: An emulator host in production stops the process

- **WHEN** the API starts in production with `FIREBASE_AUTH_EMULATOR_HOST` defined
- **THEN** it exits with code 1 before serving any request

#### Scenario: A web API key in production stops the process

- **WHEN** the API starts in production with `FIREBASE_WEB_API_KEY` defined
- **THEN** it exits with code 1 naming the forbidden variable

### Requirement: Production logging

When `NODE_ENV` is `production`, the system SHALL log JSON to stdout at the `info` level by default, so the hosting platform's log viewer can ingest it.

#### Scenario: Production logs are machine-readable

- **WHEN** the API runs in production
- **THEN** each log line is JSON written to stdout at `info` or above
