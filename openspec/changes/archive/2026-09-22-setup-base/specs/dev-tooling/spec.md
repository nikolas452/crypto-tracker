## ADDED Requirements

### Requirement: Local development environment

The system SHALL provide a `docker-compose.yml` with a `mongo` service (image `mongo:8`), exposing port 27017 with a named volume, and a `.env.example` listing every variable from the config schema with a non-sensitive example value and a comment.

#### Scenario: Fresh clone can start a local Mongo

- **WHEN** a developer runs `docker compose up` on a fresh clone
- **THEN** a MongoDB 8 instance becomes available on port 27017 with persisted data in a named volume

### Requirement: Project scripts and metadata

The system SHALL define `package.json` with `"type": "module"`, `"engines": { "node": ">=24 <25" }`, and the scripts `dev`, `dev:worker`, `build`, `start`, `start:worker`, `typecheck`, `lint`, `format`, `test`, `test:watch`, and `test:coverage`, and SHALL include a `.node-version` file with the exact Node version used.

#### Scenario: Documented scripts are runnable

- **WHEN** a developer runs any of `dev`, `build`, `typecheck`, `lint`, `format`, or `test`
- **THEN** the corresponding tool (tsx, tsc, ESLint, Prettier, or Vitest) runs without a missing-script error

### Requirement: Documentation and ignored files

The system SHALL provide a README describing requirements, how to start Mongo, how to run the app in development, and how to run tests, and a `.gitignore` covering `node_modules`, `dist`, `.env`, and `coverage`.

#### Scenario: README covers the golden path

- **WHEN** a new developer follows the README from a fresh clone
- **THEN** they can start Mongo, run the API in development mode, and run the test suite

### Requirement: Continuous integration pipeline

The system SHALL provide `.github/workflows/ci.yml` that, on every push and pull request, runs on Node 24: `npm ci`, then `npm run typecheck`, then `npm run lint`, then `npm test`, in that order.

#### Scenario: CI fails the build on a typecheck, lint, or test failure

- **WHEN** a pull request introduces a type error, a lint violation, or a failing test
- **THEN** the corresponding CI step fails and the pipeline does not report success
