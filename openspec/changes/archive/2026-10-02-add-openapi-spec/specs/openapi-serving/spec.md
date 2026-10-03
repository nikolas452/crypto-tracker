## ADDED Requirements

### Requirement: Specification is generated at build time

The system SHALL provide `npm run openapi:generate`, which assembles the base definition, the shared components file and the `@openapi` annotations from the route files into `openapi.json`, and SHALL run it as part of `npm run build`.

#### Scenario: Generation succeeds

- **WHEN** `npm run openapi:generate` runs on a tree with valid annotations
- **THEN** it writes `openapi.json` and exits with code 0

#### Scenario: Generation fails on invalid annotations

- **WHEN** an annotation is malformed or a `$ref` does not resolve
- **THEN** the command exits with a non-zero code and writes no partial file

#### Scenario: The build produces the specification

- **WHEN** `npm run build` completes
- **THEN** the generated `openapi.json` is present alongside the compiled output

### Requirement: Specification endpoint

The system SHALL serve the generated document at `GET /api/v1/openapi.json` as `application/json`, without authentication.

#### Scenario: Anonymous request

- **WHEN** a client calls `GET /api/v1/openapi.json` without a token
- **THEN** the response is `200` with `Content-Type: application/json` and a body whose `openapi` field is `3.0.3`

#### Scenario: Conditional request

- **WHEN** a client repeats the request with the `ETag` it received in `If-None-Match`
- **THEN** the response is `304` with no body

### Requirement: Endpoint position in the middleware chain

The system SHALL register the specification endpoint before the global IP rate limiter and before the not-found handler, so it is neither throttled by the limiter nor answered with `NOT_FOUND`.

#### Scenario: Not caught by the not-found handler

- **WHEN** `GET /api/v1/openapi.json` is requested on an application with the generated file present
- **THEN** the response is the specification and not a `NOT_FOUND` error

### Requirement: The specification describes its own endpoint

The system SHALL document `GET /api/v1/openapi.json` in the generated document as a public operation.

#### Scenario: Self-description

- **WHEN** the generated document is read
- **THEN** it contains an operation for `GET /api/v1/openapi.json` with an empty security requirement

### Requirement: Missing specification file degrades gracefully

The system SHALL start normally when the generated file does not exist, SHALL log a warning, and SHALL answer `GET /api/v1/openapi.json` with `404` in the standard error envelope instead of failing the process.

#### Scenario: Development without a prior generation

- **WHEN** the server starts and `openapi.json` has not been generated
- **THEN** the server starts, a warning is logged, and `GET /api/v1/openapi.json` returns `404` with code `NOT_FOUND`
