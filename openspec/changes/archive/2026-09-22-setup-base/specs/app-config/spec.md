## ADDED Requirements

### Requirement: Environment schema validation
The system SHALL define a single Zod schema in `src/config/env.ts` that validates `NODE_ENV` (enum `development`/`test`/`production`, default `development`), `PORT` (integer 1-65535, default `3000`), `MONGODB_URI` (required, must start with `mongodb://` or `mongodb+srv://`), `MONGODB_DB_NAME` (non-empty string, default `crypto_tracker`), `LOG_LEVEL` (pino level enum, default `info`), and `SHUTDOWN_TIMEOUT_MS` (integer >= 1000, default `10000`). Numeric values SHALL be coerced from string using `z.coerce.number()`.

#### Scenario: Valid environment produces typed config
- **WHEN** the process is started with a valid `MONGODB_URI` and all other variables omitted
- **THEN** the exported `config` object has the documented defaults applied and is fully typed

#### Scenario: Invalid MONGODB_URI format is rejected
- **WHEN** `MONGODB_URI` does not start with `mongodb://` or `mongodb+srv://`
- **THEN** the schema validation fails for that variable

### Requirement: Fail-fast startup on invalid configuration
The system SHALL, when environment validation fails, log at `fatal` level the list of invalid or missing variable names and the reason for each, without ever logging the offending values, and SHALL exit the process with code 1 before any server or database connection is attempted.

#### Scenario: Missing required variable fails fast without leaking values
- **WHEN** `MONGODB_URI` is not set and the process starts
- **THEN** the process exits with code 1 and the fatal log mentions `MONGODB_URI` by name without showing any variable's value

### Requirement: Single source of truth for environment access
The system SHALL expose the validated configuration as a single frozen (`Object.freeze`), typed `config` object, and no module other than `src/config/env.ts` SHALL read `process.env` directly.

#### Scenario: Config object is immutable
- **WHEN** code attempts to mutate a property on the exported `config` object
- **THEN** the mutation has no effect (or throws in strict mode), because the object is frozen

### Requirement: Testable environment parser
The system SHALL implement the parsing logic as a pure function `parseEnv(source)` that receives the environment source as a parameter, so it can be unit tested without mutating or depending on the real `process.env`.

#### Scenario: parseEnv validated with an injected source object
- **WHEN** `parseEnv` is called with a plain object containing a valid `MONGODB_URI` and no other keys
- **THEN** it returns a config object with all documented defaults applied, without reading `process.env`
