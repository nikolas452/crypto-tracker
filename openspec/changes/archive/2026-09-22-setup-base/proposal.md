## Why

The repository is currently empty (only a placeholder `package.json`). Every later stage (worker, read API, auth, watchlists, alerts) depends on a running Express/TypeScript service that can start up, validate its configuration, connect to MongoDB, report its health, handle errors consistently, and shut down cleanly. This stage has no dependencies on any other stage, so it is the correct starting point.

## What Changes

- Add the base project skeleton: Node 24, TypeScript strict, ESM, with `src/app.ts` (Express app factory, no `listen`) and `src/server.ts` (API process entrypoint).
- Add environment variable validation with Zod producing a single, frozen, typed `config` object; fail fast with exit code 1 on invalid/missing config.
- Add MongoDB connection lifecycle with bounded exponential-backoff retries on startup, connection event logging, and a disconnect function used on shutdown.
- Add the base middleware chain: request id (reuse or generate UUID), structured request logging (pino), `helmet`, JSON body parsing with a size limit, and disabling `x-powered-by`.
- Add `GET /health` (liveness) and `GET /health/ready` (readiness, checks Mongo).
- Add the app's error classes (`AppError` and derivatives), a 404 handler, and a centralized error-handling middleware that always responds with the project's single global error format.
- Add ordered shutdown on `SIGTERM`/`SIGINT` (stop accepting connections, drain in-flight requests, disconnect Mongo, exit) and fatal handling of `unhandledRejection`/`uncaughtException`.
- Add the local dev environment and CI scaffolding: `docker-compose.yml` (Mongo 8), `.env.example`, README instructions, `.gitignore`, npm scripts (`dev`, `build`, `start`, `typecheck`, `lint`, `format`, `test`, `test:watch`, `test:coverage`), and a GitHub Actions workflow running `typecheck` → `lint` → `test` on push/PR.
- No business domain, no authentication, no jobs, no deploy — those are out of scope for this stage.

## Capabilities

### New Capabilities

- `app-config`: reads and validates environment variables with Zod into a single frozen, typed `config` object; fails fast (log + exit 1) on invalid or missing required variables, never logging the offending values.
- `db-connection`: establishes and tears down the MongoDB connection, with retry-with-backoff on startup and logging of connection lifecycle events (`connected`, `disconnected`, `reconnected`, `error`).
- `http-server`: separates the Express app factory (`createApp`, no `listen`) from the process entrypoint (`server.ts`), and wires the fixed base middleware chain (request id, request logging, security headers, body parsing) in front of the app's routes.
- `health-checks`: exposes `GET /health` (liveness, no external dependency) and `GET /health/ready` (readiness, checks Mongo connectivity with a timeout) with the extensible check-list design.
- `error-handling`: defines the app's error class hierarchy, a 404 handler for unmatched routes, and a centralized error-handling middleware that maps any thrown error to the project's single global error response format, hiding stack traces and internal messages in `production`.
- `graceful-shutdown`: handles `SIGTERM`/`SIGINT` with an ordered shutdown sequence (stop listening, drain requests, disconnect DB, exit) with a timeout fallback, plus fatal handling of unhandled rejections/exceptions.
- `dev-tooling`: provides the local development environment (Docker Compose Mongo), `.env.example`, README run instructions, npm scripts, and the CI pipeline that runs typecheck/lint/test on every push and PR.

### Modified Capabilities

None — this is a greenfield change; no existing specs are being modified.

## Impact

- Creates the entire `src/` tree for the first time: `app.ts`, `server.ts`, `config/env.ts`, `db/connect.ts`, `lib/errors.ts`, `lib/logger.ts`, `lib/clock.ts`, `middlewares/`.
- Creates the `tests/` tree (`unit/`, `integration/`, `helpers/`) and the base test tooling (Vitest, supertest, mongodb-memory-server).
- Adds root-level project files: `docker-compose.yml`, `.env.example`, `.gitignore`, `.node-version`, README updates, and `.github/workflows/ci.yml`.
- Replaces the placeholder `package.json` with the real scripts, `"type": "module"`, and an `engines` constraint (`node >=24 <25`).
- No impact on existing application code, since none exists yet; this change is purely additive.
