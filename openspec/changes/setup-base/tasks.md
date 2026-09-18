## 1. Project scaffolding

- [x] 1.1 Replace placeholder `package.json` with `"type": "module"`, `"engines": { "node": ">=24 <25" }`, and dependencies (Express 5.2.x, Mongoose 9.x, Zod 4.x, pino 10.x, pino-http, helmet) plus dev dependencies (TypeScript, tsx, Vitest 5, supertest 7, mongodb-memory-server 11, ESLint, Prettier).
- [x] 1.2 Add `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `module`/`moduleResolution: NodeNext`, `target` ES2023+.
- [x] 1.3 Add ESLint + Prettier config, including a `no-restricted-properties` (or equivalent) rule that forbids reading `process.env` outside `src/config/env.ts`.
- [x] 1.4 Add `.node-version`, `.gitignore` (`node_modules`, `dist`, `.env`, `coverage`).
- [x] 1.5 Add `docker-compose.yml` with the `mongo` service (image `mongo:8`, port 27017, named volume).
- [x] 1.6 Create the `src/` and `tests/` directory skeletons per the project's folder conventions (`src/{app.ts,server.ts,config,db,lib,middlewares}`, `tests/{unit,integration,helpers}`).

## 2. Configuration (app-config)

- [x] 2.1 Implement `src/config/env.ts`: Zod schema for `NODE_ENV`, `PORT`, `MONGODB_URI`, `MONGODB_DB_NAME`, `LOG_LEVEL`, `SHUTDOWN_TIMEOUT_MS`, with coercion and defaults.
- [x] 2.2 Implement `parseEnv(source)` as a pure function taking the environment source as a parameter.
- [x] 2.3 Implement fail-fast behavior: on validation failure, log at `fatal` the invalid variable names (never their values) and exit with code 1.
- [x] 2.4 Export the validated `config` as a frozen (`Object.freeze`), fully-typed object.
- [x] 2.5 Add `.env.example` listing every variable from the schema with a non-sensitive example value and a comment.
- [x] 2.6 Unit tests for `parseEnv`: valid config, missing `MONGODB_URI`, non-numeric `PORT`, invalid `NODE_ENV`, defaults applied.

## 3. Core libraries

- [x] 3.1 Implement `src/lib/errors.ts`: `AppError` base class and derivatives (`ValidationError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `UnprocessableError`, `UpstreamError`, `ServiceUnavailableError`).
- [x] 3.2 Implement the `validate(schema, data, source)` helper that throws `ValidationError` with `details` built from Zod issues, prefixed by `source`.
- [x] 3.3 Implement `src/lib/logger.ts`: pino instance, JSON output in `production`, `pino-pretty` in `development`, level from `LOG_LEVEL`, with `redact` configured for tokens, API keys, passwords, `Authorization` header, and the Mongo URI.
- [x] 3.4 Implement `src/lib/clock.ts`: a small abstraction over "now" so time-dependent code is testable.
- [x] 3.5 Unit tests for the error class hierarchy and for `validate()`'s detail-path prefixing.

## 4. Database connection (db-connection)

- [x] 4.1 Implement `src/db/connect.ts`: `connectDb(uri, dbName, logger)` with up to 5 attempts and exponential backoff (1s/2s/4s/8s), logging each failed attempt at `warn` without the URI, and exiting 1 with a `fatal` log after exhausting retries.
- [x] 4.2 Wire Mongoose connection lifecycle logging: `connected`/`reconnected` at `info`, `disconnected` at `warn`, `error` at `error`.
- [x] 4.3 Configure Mongoose with `strictQuery: true` and `autoIndex` enabled in `development`/`test`, disabled in `production`.
- [x] 4.4 Implement `disconnectDb()`.

## 5. HTTP server and middleware chain (http-server)

- [x] 5.1 Implement `src/middlewares/requestId.ts`: reuse `X-Request-Id` if present and <= 128 chars, otherwise generate a UUID v4; store on `req.id`; set the response header.
- [x] 5.2 Wire `pino-http` request logging using the request id, logging method, route, status, and duration (no bodies, no sensitive headers).
- [x] 5.3 Implement `src/app.ts` exporting `createApp(deps)`: wires `requestId` → request logger → `helmet()` → `express.json({ limit: '100kb' })` → `app.disable('x-powered-by')` → routes → 404 handler → centralized error handler, in that exact order, without calling `listen`.
- [x] 5.4 Implement the centralized error-handling middleware in `src/middlewares/errorHandler.ts`: maps `AppError` instances to their status/code, malformed-JSON and Mongoose `CastError` to 400 `VALIDATION_ERROR`, everything else to 500 `INTERNAL_ERROR`; includes `details.stack` only in `development`; logs 5xx at `error` and 4xx at `info`/`warn`; delegates to `next(err)` if `res.headersSent`.
- [x] 5.5 Implement the 404 handler with message `Ruta no encontrada: <MÉTODO> <path>`.

## 6. Health checks (health-checks)

- [x] 6.1 Implement `GET /health` (liveness): no external dependency, responds `{ status: "ok", uptimeSeconds, timestamp }`.
- [x] 6.2 Implement the extensible readiness check list (`{ name, check(): Promise<void> }`) with a `mongo` entry that checks `readyState === 1` and pings with a 2s timeout.
- [x] 6.3 Implement `GET /health/ready`: 200 `{ status: "ready", checks }` on success, 503 `{ status: "not_ready", checks }` on failure.

## 7. Server entrypoint and graceful shutdown (graceful-shutdown)

- [x] 7.1 Implement `src/server.ts`: read `config`, call `connectDb`, call `createApp`, `listen` only after the DB connection succeeds.
- [x] 7.2 Implement the ordered shutdown sequence on `SIGTERM`/`SIGINT`: log "shutdown iniciado", `server.close()`, `disconnectDb()`, exit 0.
- [x] 7.3 Implement the `SHUTDOWN_TIMEOUT_MS` timeout that forces exit 1 if shutdown hangs.
- [x] 7.4 Implement forced immediate exit on a second `SIGINT` during shutdown.
- [x] 7.5 Register `unhandledRejection`/`uncaughtException` handlers that log at `fatal` and trigger the same shutdown sequence with exit code 1.

## 8. CI pipeline (dev-tooling)

- [x] 8.1 Add `.github/workflows/ci.yml`: on push/PR, Node 24, run `npm ci` → `npm run typecheck` → `npm run lint` → `npm test`.

## 9. Integration tests

- [x] 9.1 Set up `mongodb-memory-server` test helper with `MONGOMS_VERSION` pinned to match the Atlas major version; ensure each test leaves the database clean.
- [x] 9.2 Integration test **E0-1**: `GET /health` returns 200 with `status: "ok"` and `X-Request-Id`.
- [x] 9.3 Integration test **E0-2**: `GET /health/ready` returns 200 with `checks.mongo: "up"` when connected.
- [x] 9.4 Integration test **E0-3**: disconnect Mongoose within the test and assert `GET /health/ready` returns 503 with `status: "not_ready"`.
- [x] 9.5 Integration test **E0-4**: sending `X-Request-Id: abc-123` returns the same value in the response header.
- [x] 9.6 Integration test **E0-5**: `GET /no-existe` returns 404 with `code: "NOT_FOUND"`.
- [x] 9.7 Integration test **E0-6**: register a test-only route (via `deps` to `createApp`) that throws, assert 500 `INTERNAL_ERROR` with no stack in `production` and that the error is logged with stack.
- [x] 9.8 Integration test **E0-7**: malformed JSON body returns 400 `VALIDATION_ERROR`.

## 10. Documentation and Definition of Done

- [x] 10.1 Write the README: requirements, how to start Mongo via Docker Compose, how to run in development, how to run tests.
- [x] 10.2 Document manual verification steps for **E0-8** (missing `MONGODB_URI` exits with code 1, log names the variable without its value) and **E0-9** (in-flight request survives `SIGTERM`, process exits 0).
- [x] 10.3 Add or update a Postman/Insomnia collection or `.http` file covering `/health` and `/health/ready`.
- [x] 10.4 Confirm `typecheck`, `lint`, and `test` all pass locally and in CI, and that no secrets are present in the repo or git history.
