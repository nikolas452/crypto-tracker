## 1. Setup and spikes

- [x] 1.1 Add `swagger-jsdoc` and its type package (if one exists) as dependencies; add a spec validator and a response validator as dev dependencies, confirming current package names and OpenAPI 3.0 support with the library docs before choosing.
- [x] 1.2 Spike: import `swagger-jsdoc` (CommonJS) from the ESM/NodeNext project and from a Vitest test; record the working import form (default import or `createRequire`) in a code comment in the generator.
- [x] 1.3 Spike: find a reliable way to enumerate the routes registered in an Express 5 app, including nested router prefixes. Record the chosen method (router stack walk or explicit table) in `design.md` Open Questions.

## 2. Definition, components and generator (openapi-serving, openapi-spec)

- [x] 2.1 Create `src/docs/openapi.definition.ts`: OpenAPI `3.0.3`, `info`, `servers: [{ url: / }]`, module tags, and the `apis` globs. Header comment in Spanish.
- [x] 2.2 Create `src/docs/components.yaml` with the `bearerAuth` scheme, the `Error` schema with every error code enumerated, shared `400/401/403/404/429/500` responses, and the pagination `meta` schemas (paginated and watchlist `count/max`).
- [x] 2.3 Add reusable parameters to the components file: `coingeckoId` (pattern `^[a-z0-9-]+$`), `page`, `limit`, and the `Location`, `X-Request-Id`, `RateLimit-*` and `Cache-Control` headers.
- [x] 2.4 Create the generator script under `src/scripts/` calling `swaggerJsdoc` with `failOnErrors: true`, writing `openapi.json` only on success.
- [x] 2.5 Add the `openapi:generate` npm script and run it from `npm run build`; add the output file to `.gitignore` unless the Open Question on committing it is resolved otherwise.

## 3. Annotate public routes (openapi-spec)

- [x] 3.1 Add response schemas to the components file from `coins.dto.ts` and `snapshots.dto.ts` (coin list item, coin detail, raw point, OHLC bucket, stats).
- [x] 3.2 Annotate `src/modules/coins/coins.routes.ts`: list (sort, order, `q`, pagination), detail, history (`from`, `to`, `interval`, `sma` rules, default window) and stats (`range`), with `security: []` and the `Cache-Control` header.
- [x] 3.3 Annotate `src/modules/status/status.routes.ts` from `status.dto.ts`.
- [x] 3.4 Annotate `src/routes/health.routes.ts`: `/health` and `/health/ready`, including the `503` readiness body that does not use the `Error` envelope.

## 4. Annotate authenticated user routes (openapi-spec)

- [x] 4.1 Annotate `src/modules/users/users.routes.ts` (`GET`, `PATCH`, `DELETE /me`), noting revocation checking on `DELETE`.
- [x] 4.2 Annotate `src/modules/watchlist/watchlist.routes.ts` including `Location` on `201` and the reasons the code really returns: `LIMIT_REACHED` (422), `NOT_FOUND` for an unknown or inactive coin (404) and `CONFLICT` for a duplicate (409). (`EMAIL_NOT_VERIFIED` belongs to `POST /me/alerts` and `UNKNOWN_COINGECKO_ID` to `POST /admin/coins`.)
- [x] 4.3 Annotate `src/modules/alerts/alerts.routes.ts`: the three-variant `oneOf` body discriminated by `type`, the `meta` of the create response, the update body without `type`, and the `status` comma-separated filter.
- [x] 4.4 Annotate `src/modules/notifications/notifications.routes.ts` using the user-facing notification schema.

## 5. Annotate admin routes (openapi-spec)

- [x] 5.1 Annotate `src/modules/coins/coins.admin.routes.ts`, including the `201` versus `200` reactivation response.
- [x] 5.2 Annotate `src/modules/job-runs/job-runs.routes.ts`.
- [x] 5.3 Annotate `src/modules/jobs/jobs.admin.routes.ts`, including the `404` unknown job, `409` disabled job and `429` per-job trigger limit.
- [x] 5.4 Annotate `src/modules/notifications/notifications.admin.routes.ts` using the administrative notification schema, including `retry` and `test-email`.
- [x] 5.5 For every admin operation state the admin role and revocation-check requirements in the description.

## 6. Serving endpoint (openapi-serving)

- [x] 6.1 Add a small module that reads `openapi.json` once, computes an ETag, and returns a handler serving it as `application/json` with a cache header; when the file is missing, log a warning and answer `404` with the `NOT_FOUND` error envelope.
- [x] 6.2 Register `GET /api/v1/openapi.json` in `src/app.ts` before the global rate limiter and before `notFoundHandler`, unauthenticated.
- [x] 6.3 Annotate the endpoint so the document describes itself as a public operation.
- [x] 6.4 Integration tests in the existing supertest style: `200` with the `openapi` field `3.0.3`, `304` on a matching `If-None-Match`, and the missing-file case returning `404 NOT_FOUND` without failing startup.

## 7. Contract tests (openapi-contract-tests)

- [x] 7.1 Create `tests/integration/openapiContract.test.ts` building the spec in memory with `failOnErrors` and the app with `createApp`, `createFakeTokenVerifier` and the in-memory Mongo helper. Header comment in Spanish.
- [x] 7.2 Validate one success case per public operation (coins, history, stats, status, health) against the spec.
- [x] 7.3 Validate one success case per authenticated user operation, seeding the data each needs.
- [x] 7.4 Validate one success case per admin operation, including both `201` and `200` for `POST /admin/coins`.
- [x] 7.5 Validate the error envelope: `400` validation with `details`, `401` without a token, `403` as non-admin, `404` unknown resource.
- [x] 7.6 Implement the route-coverage check in both directions using the method chosen in task 1.3.
- [x] 7.7 Boundary examples for request constraints that the response validator cannot see: `limit` bounds, `sma` with `interval=raw` rejected, `range` values, unknown query key rejected with `400`.
- [x] 7.8 Prove the checks bite: temporarily remove one annotation and rename one response field, confirm each fails with a clear message, then restore. (Done as an in-test `describe('el contrato detecta deriva')` that mutates a deep clone of the in-memory document, so no source file is edited.)

## 8. CI and documentation

- [x] 8.1 Add a step to `.github/workflows/ci.yml` that generates the document and validates it against the OpenAPI 3.0 schema.
- [x] 8.2 Add a README section on the spec: where it is served, how to regenerate it, how to generate frontend types with `openapi-typescript`, and how to annotate a new route.
- [x] 8.3 Correct the error-code table in `requerimientos/00-indice-y-convenciones.md` to include `TOKEN_REVOKED`, `USER_DISABLED` and `FIREBASE_UNAVAILABLE`.
- [x] 8.4 Run `openapi-typescript` against the generated document to confirm the frontend can consume it, and note the result.
- [x] 8.5 Run typecheck, lint and the full test suite; reconcile with the `deploy-render` change if its build or middleware edits have landed.
