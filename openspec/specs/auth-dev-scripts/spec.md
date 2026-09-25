## Purpose

This capability provides the development-only scripts that stand in for a frontend when obtaining and using Firebase ID tokens: creating a test user, retrieving an ID token, and assigning a role, together with their production refusal and the documented local emulator workflow.

## Requirements

### Requirement: Test user creation script

The system SHALL provide `npm run auth:create-test-user -- --email <email> --password <password> [--admin]`, which creates the user through `getAuth().createUser({ email, password, emailVerified: true })` against the emulator or the development project, and with `--admin` also creates the corresponding Mongo profile with `role: "admin"`.

#### Scenario: A test user is created with a verified email

- **WHEN** the script is run with an email and password
- **THEN** a Firebase user exists with that email and `emailVerified: true`

#### Scenario: The admin flag provisions an admin profile

- **WHEN** the script is run with `--admin`
- **THEN** a Mongo user document is created for that uid with `role: "admin"`

### Requirement: Token retrieval script

The system SHALL provide `npm run auth:token -- --email <email> --password <password>`, which signs in through the Firebase Auth REST endpoint `accounts:signInWithPassword` — using `FIREBASE_WEB_API_KEY` against the real project, or the emulator host when one is configured — and prints **only** the resulting ID token to stdout.

#### Scenario: Only the token reaches stdout

- **WHEN** the script succeeds
- **THEN** stdout contains the ID token and nothing else, so it can be captured directly into a shell variable

#### Scenario: The emulator is used when configured

- **WHEN** `FIREBASE_AUTH_EMULATOR_HOST` is set
- **THEN** the sign-in request is sent to the emulator's identity toolkit URL instead of the Google endpoint

### Requirement: Role assignment script

The system SHALL provide `npm run user:set-role -- --email <email> --role <role>`, which finds the user in Mongo by email, updates the role, and prints the transition from the previous role to the new one. When no such user exists, it SHALL report that the user must have called the API at least once or been created with `auth:create-test-user`.

#### Scenario: Role change is reported

- **WHEN** the script promotes an existing user to `admin`
- **THEN** the stored role becomes `admin` and the output shows the previous and new role

#### Scenario: Unknown user produces an actionable message

- **WHEN** the script is run for an email with no Mongo profile
- **THEN** it reports that the user must first call the API or be created with `auth:create-test-user`, and changes nothing

### Requirement: Development scripts refuse to run in production

The system SHALL make `auth:create-test-user` and `auth:token` exit without performing any action when `NODE_ENV` is `production`.

#### Scenario: Production invocation is refused

- **WHEN** either script is run with `NODE_ENV=production`
- **THEN** it exits without creating a user or requesting a token

### Requirement: Documented emulator workflow

The system SHALL document how to start the Firebase Auth emulator with `firebase-tools` (`firebase emulators:start --only auth`), including its Java prerequisite, and how setting `FIREBASE_AUTH_EMULATOR_HOST` points both `firebase-admin` and the scripts at it.

#### Scenario: A developer can obtain a token from a fresh clone

- **WHEN** a developer follows the documented emulator workflow
- **THEN** they can create a test user, obtain an ID token, and call an authenticated endpoint with it
