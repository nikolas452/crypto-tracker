## Why

The API has 30 routes under `/api/v1` (plus `/health` and `/health/ready`) and no machine-readable contract. The only documentation is a 105 KB README, a Postman collection and an `.http` file, none of which a frontend can generate types or clients from, and none of which fails when the code changes. The frontend needs complete, accurate documentation of every endpoint: request parameters and bodies, response shapes, the shared error envelope, authentication, and the headers it can rely on.

## What Changes

- Add an OpenAPI 3.0.3 specification covering every route under `/api/v1` plus `/health` and `/health/ready`, authored with `swagger-jsdoc` as `@openapi` annotation blocks next to each route handler.
- Add one shared components file holding the security scheme, the `Error` envelope, pagination metadata, reusable error responses, reusable parameters and one schema per response DTO.
- Add a generator script that builds `openapi.json` with `failOnErrors` enabled, wired into `npm run build`.
- Add contract tests that call every route through the real app and validate status, body and headers against the generated spec, plus a coverage check that every registered route is documented and every documented route exists.
- Validate the generated spec itself in CI.
- Serve the built `openapi.json` at `GET /api/v1/openapi.json`, unauthenticated.
- Add a short README section pointing to the spec, and correct the error-code table in `requerimientos/00-indice-y-convenciones.md`, which omits `TOKEN_REVOKED`, `USER_DISABLED` and `FIREBASE_UNAVAILABLE`.

Non-goals:

- No refactor of the Zod request schemas or the response DTOs. The spec is hand-authored and verified by tests, not derived from them.
- No Swagger UI or Redoc page in this change. Serving one requires relaxing the `helmet` content security policy and is deferred.
- No documentation for routes introduced by the active `bullmq-redis` change (`admin-queue-api`); they are annotated when that change lands.

## Capabilities

### New Capabilities

- `openapi-spec`: the content of the specification: version, security scheme, error envelope, pagination, per-route request and response definitions, documented headers, and the rule that every route is described.
- `openapi-contract-tests`: tests that exercise every route against the generated spec, the route-coverage check in both directions, and the CI validation of the spec document.
- `openapi-serving`: the build-time generation of `openapi.json`, the unauthenticated `GET /api/v1/openapi.json` endpoint, and its position in the middleware chain.

### Modified Capabilities

None. No existing endpoint, schema or behavior changes.

## Impact

- Adds `@openapi` annotation comments to `src/modules/*/*.routes.ts`, `src/modules/*/*.admin.routes.ts`, `src/modules/status/status.routes.ts` and `src/routes/health.routes.ts`. Runtime behavior of those files is unchanged.
- Adds `src/docs/` (base definition and shared components), a generator script under `src/scripts/`, and a `tests/integration/openapiContract.test.ts` test.
- Adds one route, `GET /api/v1/openapi.json`, registered in `src/app.ts` before the global rate limiter and the not-found handler.
- Adds dependencies: `swagger-jsdoc` (CommonJS, to be imported from an ESM/NodeNext project), its type package if available, and a spec validator and response validator for the tests and CI.
- Extends `npm run build` and `.github/workflows/ci.yml`.
- Touches the build pipeline and HTTP hardening that the in-flight `deploy-render` change also edits (`production-build`, `production-http-security`); the two changes must be reconciled when either is applied.
