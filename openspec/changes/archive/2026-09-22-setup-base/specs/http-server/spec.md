## ADDED Requirements

### Requirement: App and server separation
The system SHALL expose `createApp(deps)` in `src/app.ts`, returning a fully configured Express instance without calling `listen`. The system SHALL expose `src/server.ts` as the process entrypoint, which reads config, connects the database, calls `createApp`, calls `listen`, and registers the shutdown sequence.

#### Scenario: createApp usable without an open port
- **WHEN** a test calls `createApp(deps)` and exercises it with supertest
- **THEN** requests are handled correctly without any TCP port being opened

### Requirement: Fixed base middleware order
The system SHALL apply the following middleware chain, in this exact order, before any route: request id, request logging (`pino-http`), `helmet()`, JSON body parsing (`express.json({ limit: '100kb' })`), and disabling `x-powered-by`; followed by application routes, then the 404 handler, then the centralized error handler.

#### Scenario: Every response carries the middleware chain's effects
- **WHEN** any request reaches the app
- **THEN** the response has `X-Request-Id` set, does not include the `X-Powered-By` header, and was logged with method, route, status, and duration

### Requirement: Request id propagation
The system SHALL reuse the `X-Request-Id` header from an incoming request when present and no longer than 128 characters; otherwise it SHALL generate a new UUID v4 (`crypto.randomUUID()`). The resulting id SHALL be stored on `req.id` and returned in the `X-Request-Id` response header.

#### Scenario: Client-supplied request id is echoed back
- **WHEN** a request is sent with header `X-Request-Id: abc-123`
- **THEN** the response includes `X-Request-Id: abc-123`

#### Scenario: Oversized request id is replaced
- **WHEN** a request is sent with an `X-Request-Id` header longer than 128 characters
- **THEN** the value is ignored and a newly generated UUID is used instead

### Requirement: Malformed JSON body handling
The system SHALL limit JSON request bodies to 100kb and SHALL translate a malformed JSON body into a 400 response using the project's `VALIDATION_ERROR` error format, with the message "JSON inválido".

#### Scenario: Malformed JSON is rejected with the standard error format
- **WHEN** a request sends a body that is not valid JSON
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

#### Scenario: Oversized body is rejected
- **WHEN** a request body exceeds 100kb
- **THEN** the response is 413, translated by the error handler into `VALIDATION_ERROR`
