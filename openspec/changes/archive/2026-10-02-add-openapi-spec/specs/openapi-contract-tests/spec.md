## ADDED Requirements

### Requirement: Responses are validated against the specification

The system SHALL include automated tests that call every documented operation on the real application and validate the response status, body and documented headers against the specification generated from the annotations, covering at least one success case per operation.

#### Scenario: A response matches its documented schema

- **WHEN** the contract test calls a documented operation with valid input
- **THEN** the response status is one the operation documents and the body validates against that status's schema

#### Scenario: A response drifts from its documented schema

- **WHEN** a response field is renamed or removed in code without updating its annotation
- **THEN** the contract test fails and names the operation and the mismatching field

### Requirement: Error responses are validated

The system SHALL include contract tests for the error envelope covering a validation failure (`400`), a missing token (`401`), insufficient role (`403`) and an unknown resource (`404`), validating each body against the shared `Error` schema.

#### Scenario: Unauthenticated request

- **WHEN** an authenticated operation is called without a token
- **THEN** the response is `401` and its body validates against the `Error` schema

#### Scenario: Non-admin calls an admin route

- **WHEN** a user without the admin role calls an operation under `/api/v1/admin`
- **THEN** the response is `403` and its body validates against the `Error` schema

### Requirement: Route coverage is checked in both directions

The system SHALL fail its test suite when a route served by the application has no documented operation, and when a documented operation corresponds to no served route.

#### Scenario: A route is added without documentation

- **WHEN** a new route is registered and no `@openapi` annotation describes it
- **THEN** the route-coverage test fails and lists the undocumented method and path

#### Scenario: A documented operation has no route

- **WHEN** an annotation describes a method and path the application does not serve
- **THEN** the route-coverage test fails and lists the orphaned operation

### Requirement: Annotation errors fail generation

The system SHALL generate the specification with `swagger-jsdoc` error reporting enabled, so malformed annotation YAML or unresolved `$ref` values make generation and the contract tests fail instead of silently dropping documentation.

#### Scenario: Malformed annotation

- **WHEN** an `@openapi` block contains invalid YAML
- **THEN** specification generation throws and the test suite fails

### Requirement: The generated document is validated in CI

The system SHALL validate the generated document against the OpenAPI 3.0 schema as a step of the CI workflow, in addition to the contract tests.

#### Scenario: Structurally invalid document

- **WHEN** the generated document violates the OpenAPI 3.0 schema
- **THEN** the CI validation step fails

### Requirement: Contract tests are hermetic

The system SHALL run the contract tests with the fake token verifier and an in-memory database, without network access to Firebase, CoinGecko or any real database.

#### Scenario: Tests run offline

- **WHEN** the contract tests run on a machine with no network access
- **THEN** they complete without contacting any external service
