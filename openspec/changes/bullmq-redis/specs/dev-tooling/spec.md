## MODIFIED Requirements

### Requirement: Local development environment
The system SHALL provide a `docker-compose.yml` with a `mongo` service (image `mongo:8`) running as a single-node replica set via `--replSet rs0 --bind_ip_all`, with a healthcheck that performs `rs.initiate()` when the set is not yet initialized, exposing port 27017 with a named volume; a `mailpit` service (image `axllent/mailpit`) exposing SMTP on port 1025 and its web interface on port 8025; a `valkey` service (image `valkey/valkey:8`) exposing port 6379 and configured with `--maxmemory-policy noeviction --appendonly yes --appendfsync everysec`; and a `.env.example` listing every variable from the config schema with a non-sensitive example value and a comment.

#### Scenario: Fresh clone can start a local Mongo
- **WHEN** a developer runs `docker compose up` on a fresh clone
- **THEN** a MongoDB 8 instance becomes available on port 27017 with persisted data in a named volume, initialized as a replica set that supports transactions

#### Scenario: Fresh clone can capture outgoing mail locally
- **WHEN** a developer runs `docker compose up` on a fresh clone
- **THEN** Mailpit accepts SMTP on port 1025 and shows captured messages at its web interface on port 8025

#### Scenario: Fresh clone can run the queues locally
- **WHEN** a developer runs `docker compose up` on a fresh clone
- **THEN** Valkey is available on port 6379 with the `noeviction` policy and append-only persistence, so the queues can run at no cost

### Requirement: Project scripts and metadata
The system SHALL define `package.json` with `"type": "module"`, `"engines": { "node": ">=24 <25" }`, and the scripts `dev`, `dev:worker`, `build`, `start`, `start:worker`, `typecheck`, `lint`, `format`, `test`, `test:watch`, `test:coverage`, `db:setup`, `smoke` and `migrate:agenda-to-bullmq`, and SHALL include a `.node-version` file with the exact Node version used.

#### Scenario: Documented scripts are runnable
- **WHEN** a developer runs any of `dev`, `build`, `typecheck`, `lint`, `format`, or `test`
- **THEN** the corresponding tool (tsx, tsc, ESLint, Prettier, or Vitest) runs without a missing-script error

#### Scenario: The migration script is available
- **WHEN** an operator runs `npm run migrate:agenda-to-bullmq`
- **THEN** the script runs without a missing-script error

### Requirement: Continuous integration pipeline
The system SHALL provide `.github/workflows/ci.yml` that, on every push and pull request, runs on Node 24: `npm ci`, then `npm run typecheck`, then `npm run lint`, then `npm test`, in that order, with a Valkey service container available so the queue integration tests can run against a real Redis.

#### Scenario: CI fails the build on a typecheck, lint, or test failure
- **WHEN** a pull request introduces a type error, a lint violation, or a failing test
- **THEN** the corresponding CI step fails and the pipeline does not report success

#### Scenario: Queue tests run against a real Redis in CI
- **WHEN** the CI pipeline runs the test suite
- **THEN** a Valkey service container is available and `REDIS_URL` points at it, so the queue integration tests execute rather than skipping
