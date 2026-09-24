## ADDED Requirements

### Requirement: Global error response format

The system SHALL respond to every error condition (except `GET /health/ready`) with a single JSON shape: `{ "error": { "code", "message", "details"?, "requestId" } }`, where `requestId` is always present and `details` is optional.

#### Scenario: Any error response follows the global shape

- **WHEN** any endpoint produces an error response
- **THEN** the body matches `{ "error": { "code", "message", "requestId", ... } }`

### Requirement: App error class hierarchy

The system SHALL define `AppError` (base, with `code`, `httpStatus`, `message`, optional `details` and `cause`) in `src/lib/errors.ts`, with derivatives `ValidationError` (400/`VALIDATION_ERROR`), `UnauthenticatedError` (401/`UNAUTHENTICATED`), `ForbiddenError` (403/`FORBIDDEN`), `NotFoundError` (404/`NOT_FOUND`), `ConflictError` (409/`CONFLICT`), `UnprocessableError` (422/`UNPROCESSABLE`), `UpstreamError` (502/`UPSTREAM_ERROR`), and `ServiceUnavailableError` (503/`SERVICE_UNAVAILABLE`).

#### Scenario: Each AppError derivative maps to its fixed status and code

- **WHEN** a handler throws any derivative of `AppError`
- **THEN** the response uses that derivative's fixed HTTP status and error `code`

### Requirement: Validation helper

The system SHALL provide a `validate(schema, data, source)` helper that runs a Zod schema against `data` and, on failure, throws a `ValidationError` whose `details` are built from the Zod issues, each `path` prefixed with its `source` (`body.`, `query.`, or `params.`).

#### Scenario: Validation failure produces prefixed detail paths

- **WHEN** `validate` is called with `source: "query"` and the schema rejects a field named `limit`
- **THEN** the thrown `ValidationError`'s `details` include an entry with `path: "query.limit"`

### Requirement: 404 handler for unmatched routes

The system SHALL respond to any request that matches no route with 404, `code: "NOT_FOUND"`, and message `Ruta no encontrada: <MÉTODO> <path>`.

#### Scenario: Unknown route returns the standard 404

- **WHEN** a client requests a path with no matching route
- **THEN** the response is 404 with `error.code: "NOT_FOUND"`

### Requirement: Centralized error-handling middleware

The system SHALL implement a single 4-argument error-handling middleware, registered last, that: responds using an `AppError`'s own status/code when the error is an `AppError`; maps malformed-JSON body-parser errors and Mongoose `CastError` to 400 `VALIDATION_ERROR`; and responds 500 `INTERNAL_ERROR` with a generic message for any other error. In `development`, unexpected 500s SHALL include `details.stack`; in `production` they SHALL never include the stack or the original internal message. All 5xx responses SHALL be logged at `error` with `requestId`, stack, and `cause`; 4xx responses SHALL be logged at `info` or `warn`. If `res.headersSent` is true, the handler SHALL delegate to `next(err)` instead of sending a response.

#### Scenario: Unexpected error hides internals in production

- **WHEN** an endpoint throws a plain, unrecognized `Error` and `NODE_ENV` is `production`
- **THEN** the response is 500 `INTERNAL_ERROR` with a generic message and no stack trace, while the full error with stack is logged at `error`

#### Scenario: Unexpected error exposes the stack in development

- **WHEN** an endpoint throws a plain, unrecognized `Error` and `NODE_ENV` is `development`
- **THEN** the response is 500 `INTERNAL_ERROR` and includes `details.stack`

#### Scenario: Invalid Mongo ObjectId format is treated as validation error

- **WHEN** a request causes Mongoose to raise a `CastError` for an invalid id format
- **THEN** the response is 400 `VALIDATION_ERROR`
