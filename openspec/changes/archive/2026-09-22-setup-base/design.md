## Context

Greenfield repository. The stack, folder structure, and most technical decisions are already fixed by `requerimientos/00-indice-y-convenciones.md` (project-wide conventions) and detailed further by `requerimientos/01-etapa-0-setup-base.md` (this stage's functional requirements). This design translates those decisions into an implementation approach; it does not re-litigate them.

Everything built in later stages (worker, read API, auth, watchlists, alerts) runs on top of what this change produces, so correctness and clarity here matter more than speed of delivery.

## Goals / Non-Goals

**Goals:**

- A process that fails fast on bad configuration instead of misbehaving silently.
- A clean separation between "build the app" (`createApp`, testable, no socket) and "run the process" (`server.ts`, has a socket and a lifecycle).
- A single, predictable error response shape across the whole API, established here so every later stage inherits it for free.
- A DB connection lifecycle and shutdown sequence that behave correctly under real failure conditions (Mongo down at boot, Mongo dropping mid-flight, SIGTERM during an in-flight request).
- 100% of this stage buildable and testable without any external service (no real Mongo, no real network) except the in-memory Mongo used for integration tests.

**Non-Goals:**

- No domain models, business logic, authentication, or scheduled jobs — those belong to later stages that depend on this one.
- No deployment automation (Render config) — covered by the deploy stage, which can start once the read API stage exists.
- No CORS — there is no browser frontend, so the mechanism is irrelevant.

## Decisions

- **App/server split (`createApp` vs `server.ts`)**: `createApp(deps)` builds and returns the configured Express instance without calling `listen`. `server.ts` is the only place that reads config, connects the DB, calls `createApp`, opens the socket, and registers shutdown. _Rationale_: integration tests exercise `createApp` directly with supertest against an in-memory Mongo, with no open port and no process lifecycle to manage in the test suite.

- **Config as a single frozen object (`config/env.ts`)**: one Zod schema validates `process.env`, coercing numeric strings, applying defaults, and exporting `Object.freeze`d, fully-typed `config`. The parsing function accepts an input object as a parameter instead of reading `process.env` directly. _Rationale_: makes the parser pure and testable, and gives the codebase exactly one place that ever touches `process.env` — enforced by an ESLint rule so drift is caught in CI, not in review.

- **Dependency injection via factory functions, not a DI container**: services, jobs, and `createApp` receive their collaborators (Mongo client, mailer, clock, logger) as constructor/factory parameters. _Rationale_: this stage doesn't need a container to prove the pattern works, and it keeps the wiring visible instead of hidden behind reflection or decorators. Alternative considered: a DI library (e.g. `tsyringe`) — rejected as unnecessary ceremony for a project whose explicit goal is to learn the underlying mechanism.

- **Retry-with-backoff for the initial Mongo connection, not for steady-state**: on boot, up to 5 attempts with 1s/2s/4s/8s backoff before giving up and exiting 1. Once connected, Mongoose's own reconnection logic is trusted; the app does not implement custom reconnect logic, only reflects Mongoose's connection state in `/health/ready`. _Rationale_: a boot-time retry loop absorbs the common case of "the DB container isn't ready yet" (e.g. `docker compose up` race), while steady-state reconnection is a solved problem in the driver — reimplementing it would be redundant and error-prone.

- **Readiness check is a list, not a single hardcoded check**: `/health/ready` runs an array of `{ name, check(): Promise<void> }` entries (only `mongo` in this stage) instead of one hardcoded Mongo ping. _Rationale_: later stages (Redis in the BullMQ stage, SMTP) need to add checks without rewriting the endpoint — extensibility is nearly free here and expensive to retrofit later.

- **Error taxonomy as a small class hierarchy (`AppError` + derivatives) instead of throwing plain objects or strings**: every derivative maps 1:1 to an HTTP status and error `code` from the project's fixed error-code table. _Rationale_: the centralized error handler needs one place to decide "is this a known, well-shaped error, or an unexpected one" — `instanceof AppError` is that single decision point, and it's the same mechanism a controller, a service, or a job can all use to signal a specific failure.

- **Shutdown as an explicit sequence with a hard timeout, not `process.exit()` on signal**: on `SIGTERM`/`SIGINT`, stop accepting new connections (`server.close()`), let in-flight requests finish, disconnect Mongo, then exit 0; a `SHUTDOWN_TIMEOUT_MS` timer forces exit 1 if the sequence hangs; a second `SIGINT` forces immediate exit. _Rationale_: this is what makes zero-downtime redeploys on Render possible later — an abrupt exit would cut in-flight requests.

## Risks / Trade-offs

- **[Risk]** A misconfigured `MONGOMS_VERSION` for `mongodb-memory-server` causes integration tests to run against a Mongo version that doesn't match Atlas in production, hiding version-specific bugs. → **Mitigation**: pin `MONGOMS_VERSION` explicitly in test setup/CI, matching the Atlas major version noted in the conventions doc.
- **[Risk]** The boot-time retry loop (5 attempts, up to ~15s total) can make local `docker compose up` feel slow if Mongo is genuinely down, masking the real error behind repeated warnings. → **Mitigation**: log each failed attempt at `warn` with the attempt number, so the cause (not just "it's slow") is visible immediately in the console.
- **[Risk]** `noUncheckedIndexedAccess` and strict TS surface real gaps in defensive code (e.g. array indexing in the error-details mapping) that are easy to under-test at this stage. → **Mitigation**: the unit tests explicitly required in section 11 of the source doc (parseEnv edge cases, error-handler mapping) exist precisely to cover these paths.
- **[Trade-off]** No DI container means slightly more boilerplate threading dependencies through factory functions as the app grows. Accepted deliberately: the project's stated goal is understanding the mechanism, and a container would hide exactly the wiring this project wants to make visible.

## Migration Plan

Not applicable in the traditional sense — this is the first code in the repository, so there is no existing behavior to migrate away from and no rollback beyond reverting the commit(s). Rollout is simply: merge, deploy stage 7 (Render) once the read API stage exists, per the dependency table in the conventions doc.

## Open Questions

None for this stage. (The two open decisions recorded in the conventions doc — worker hosting on Render, and whether account deletion also removes the Firebase account — belong to later stages and are out of scope here.)
