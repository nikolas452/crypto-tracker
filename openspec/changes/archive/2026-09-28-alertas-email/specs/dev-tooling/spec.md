## MODIFIED Requirements

### Requirement: Local development environment

The system SHALL provide a `docker-compose.yml` with a `mongo` service (image `mongo:8`) running as a single-node replica set via `--replSet rs0 --bind_ip_all`, with a healthcheck that performs `rs.initiate()` when the set is not yet initialized, exposing port 27017 with a named volume; a `mailpit` service (image `axllent/mailpit`) exposing SMTP on port 1025 and its web interface on port 8025; and a `.env.example` listing every variable from the config schema with a non-sensitive example value and a comment.

#### Scenario: Fresh clone can start a local Mongo

- **WHEN** a developer runs `docker compose up` on a fresh clone
- **THEN** a MongoDB 8 instance becomes available on port 27017 with persisted data in a named volume, initialized as a replica set that supports transactions

#### Scenario: Fresh clone can capture outgoing mail locally

- **WHEN** a developer runs `docker compose up` on a fresh clone
- **THEN** Mailpit accepts SMTP on port 1025 and shows captured messages at its web interface on port 8025

#### Scenario: Local mail never leaves the machine

- **WHEN** the application sends a notification with the documented local configuration
- **THEN** the message is captured by Mailpit and no external mail provider is contacted
