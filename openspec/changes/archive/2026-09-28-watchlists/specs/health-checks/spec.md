## MODIFIED Requirements

### Requirement: Extensible readiness checks

The system SHALL implement readiness checks as an extensible list of `{ name, check(): Promise<void> }` entries, so later stages can add checks (e.g. Redis, SMTP) without rewriting the endpoint. The list SHALL include an optional `coingecko` entry that is **disabled by default**, so an upstream CoinGecko outage cannot cause the API to be removed from rotation by a deploy platform.

#### Scenario: Adding a new check requires no endpoint rewrite

- **WHEN** a new entry is appended to the readiness checks list
- **THEN** `GET /health/ready` includes that check's result under `checks.<name>` without changes to the route handler

#### Scenario: CoinGecko readiness is off unless explicitly enabled

- **WHEN** the API starts with default configuration
- **THEN** `GET /health/ready` reports no `checks.coingecko` entry and an unreachable CoinGecko does not make the endpoint respond 503

#### Scenario: The CoinGecko check reports upstream state when enabled

- **WHEN** the `coingecko` readiness check is explicitly enabled and CoinGecko is unreachable
- **THEN** `GET /health/ready` includes `checks.coingecko: "down"`
