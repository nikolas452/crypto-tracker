## ADDED Requirements

### Requirement: Single Firebase Admin initialization

The system SHALL initialize the Firebase Admin app exactly once in `src/integrations/firebase/admin.ts`, reusing the existing app when `getApps()` already contains one, using the modular `firebase-admin/app` and `firebase-admin/auth` entry points.

#### Scenario: Repeated initialization reuses the existing app

- **WHEN** the Firebase Admin initialization function is called more than once in the same process
- **THEN** the same app instance is returned and no duplicate-app error is raised

### Requirement: Private key newline normalization

The system SHALL normalize `FIREBASE_PRIVATE_KEY` by replacing literal `\n` sequences with real newline characters before passing it to the credential factory, so the key can be supplied through a single-line environment variable.

#### Scenario: Escaped newlines become real newlines

- **WHEN** `FIREBASE_PRIVATE_KEY` is supplied with literal `\n` sequences instead of line breaks
- **THEN** the normalized key contains real newline characters and the credential is accepted

### Requirement: Emulator support outside production

When `FIREBASE_AUTH_EMULATOR_HOST` is defined and `NODE_ENV` is not `production`, the system SHALL log at `warn` that the Auth emulator is in use and SHALL direct both `firebase-admin` and the development scripts at that host.

#### Scenario: Emulator use is announced in development

- **WHEN** the API starts in development with `FIREBASE_AUTH_EMULATOR_HOST` set
- **THEN** a `warn` log states that the Auth emulator is being used

### Requirement: Emulator forbidden in production

When `FIREBASE_AUTH_EMULATOR_HOST` is defined and `NODE_ENV` is `production`, the system SHALL exit with code 1 before serving any request.

#### Scenario: Production refuses to start against an emulator

- **WHEN** the API starts with `NODE_ENV=production` and `FIREBASE_AUTH_EMULATOR_HOST` defined
- **THEN** the process exits with code 1 and never begins listening

### Requirement: Fail-fast on missing credentials

When no emulator is configured and any of `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` or `FIREBASE_PRIVATE_KEY` is missing, the system SHALL fail configuration validation at startup, logging the missing variable names at `fatal` without printing their values, and exit with code 1.

#### Scenario: Missing service account credentials fail fast

- **WHEN** the API starts without `FIREBASE_PRIVATE_KEY` and without an emulator host
- **THEN** the process exits with code 1 and the fatal log names the variable without showing its value
