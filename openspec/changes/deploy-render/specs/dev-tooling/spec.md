## MODIFIED Requirements

### Requirement: Project scripts and metadata
The system SHALL define `package.json` with `"type": "module"`, `"engines": { "node": ">=24 <25" }`, and the scripts `dev`, `dev:worker`, `build`, `start`, `start:worker`, `typecheck`, `lint`, `format`, `test`, `test:watch`, `test:coverage`, `db:setup` and `smoke`, and SHALL include a `.node-version` file with the exact Node version used.

#### Scenario: Documented scripts are runnable
- **WHEN** a developer runs any of `dev`, `build`, `typecheck`, `lint`, `format`, or `test`
- **THEN** the corresponding tool (tsx, tsc, ESLint, Prettier, or Vitest) runs without a missing-script error

#### Scenario: Deployment scripts are available
- **WHEN** an operator runs `npm run db:setup` or `npm run smoke`
- **THEN** the corresponding script runs without a missing-script error
