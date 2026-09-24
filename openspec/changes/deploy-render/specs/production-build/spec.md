## ADDED Requirements

### Requirement: Compiled production build

The system SHALL compile to `dist/` with `tsc -p tsconfig.build.json`, excluding tests, through `npm run build`, and SHALL start in production by executing the compiled JavaScript directly (`node dist/server.js`) rather than through a TypeScript runner.

#### Scenario: Production starts from compiled output

- **WHEN** the production start command runs
- **THEN** it executes `dist/server.js` with no TypeScript compilation and no `tsx` involved

#### Scenario: Tests are excluded from the build output

- **WHEN** `npm run build` completes
- **THEN** `dist/` contains the application modules and no test files

### Requirement: Platform build and start commands

The system SHALL use `npm ci && npm run build` as its build command and `node dist/server.js` as the API's start command, and SHALL document that `npm ci` installs `devDependencies` because they are required to compile.

#### Scenario: A clean build produces a runnable artifact

- **WHEN** the build command runs on a fresh checkout
- **THEN** dependencies are installed, the project compiles, and the start command runs the result

### Requirement: Node version pinned with an upper bound

The system SHALL pin the Node version in `.node-version` and SHALL declare `"engines": { "node": ">=24 <25" }` in `package.json`, so an open-ended range cannot silently resolve to a newer major version.

#### Scenario: The engine range has an upper bound

- **WHEN** `package.json` is inspected
- **THEN** its `engines.node` range names both a lower and an upper bound

### Requirement: No development-only tooling at runtime

The system SHALL NOT require `tsx`, `pino-pretty` or any other development dependency in order to start when `NODE_ENV` is `production`, and the logger SHALL NOT attempt to load a pretty-printing transport in that environment.

#### Scenario: The logger does not load pino-pretty in production

- **WHEN** the process starts with `NODE_ENV=production`
- **THEN** the logger emits JSON without attempting to load `pino-pretty`

#### Scenario: Production start succeeds without development dependencies

- **WHEN** the compiled application is started in an environment where `devDependencies` have been pruned
- **THEN** the process starts and serves requests normally
