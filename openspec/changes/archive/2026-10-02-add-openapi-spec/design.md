## Context

The API is Express 5 on Node 24 (ESM, `NodeNext`), with Zod 4 request validation and 30 routes under `/api/v1`, plus `/health` and `/health/ready` outside the prefix. Each module follows `*.routes.ts` (thin controller), `*.schemas.ts` (Zod input), `*.dto.ts` (hand-built output interfaces), `*.service.ts` and `*.model.ts`. Authentication is a Firebase ID token in `Authorization: Bearer`; roles come from the database. Every error uses one envelope: `{ error: { code, message, requestId, details? } }`.

There is no OpenAPI tooling today. Documentation is the README, a Postman collection and `requests.http`. The frontend cannot generate types from any of them, and nothing fails when the code and the docs diverge.

Two facts constrain the approach:

- Several query schemas use `.transform()` and `z.preprocess`, and `PATCH` bodies use `refine`. Zod cannot turn transformed schemas into JSON Schema directly.
- Responses have no Zod schemas. They are TypeScript interfaces built by hand in `*.dto.ts`.

## Goals / Non-Goals

**Goals:**

- A complete, accurate OpenAPI document for every route, usable by the frontend to generate types and clients.
- Drift between code and spec fails CI.
- Each endpoint's documentation lives next to its handler.
- No change to runtime behavior of any existing endpoint.

**Non-Goals:**

- Deriving the spec from Zod schemas or DTOs.
- Refactoring request schemas or response DTOs.
- A hosted documentation UI (Swagger UI, Redoc).
- Documenting routes from the in-flight `bullmq-redis` change.

## Decisions

### D1. Hand-authored annotations with `swagger-jsdoc`, verified by contract tests

The spec is written as `@openapi` YAML blocks in JSDoc comments above each handler and assembled by `swagger-jsdoc`. This tool extracts hand-written YAML; it does not infer anything from code, so it does not remove the possibility of drift. The contract tests (D5) are what make drift visible.

Alternatives considered:

- **Code-first from Zod** (for example `zod-to-openapi`): one source of truth, but it requires exporting the raw schemas behind each `.transform()`, replacing `preprocess` and `refine` patterns, and writing Zod schemas for every response DTO. That changes working code for a documentation goal.
- **A single hand-written `openapi.yaml`**: the same drift profile with better editor support, but the documentation sits far from the handlers it describes.
- **Hybrid** (Zod for requests, hand-written for responses): two mechanisms to maintain for a partial benefit.

### D2. OpenAPI 3.0.3, not 3.1

The `swagger-jsdoc` documentation reviewed confirms OpenAPI 3.0.x. 3.1 support was not confirmed. Everything this API needs exists in 3.0: `oneOf` with `discriminator` for the alert bodies, reusable parameters and responses, and the bearer security scheme. `openapi-typescript` consumes 3.0.

### D3. Paths carry the full prefix; shared definitions live in one components file

Documented paths include `/api/v1`, and `servers` is `/`, so `/health` and `/health/ready` sit naturally outside the prefix. Everything reusable lives in `src/docs/components.yaml`, included in the `apis` list: the `bearerAuth` scheme, the `Error` envelope, pagination metadata, shared 401/403/429/500 responses, parameters (`coingeckoId`, `page`, `limit`) and one schema per response DTO. Route annotations reference these with `$ref`, which keeps the comment blocks short. Public and admin notification DTOs are separate schemas because their fields differ.

### D4. Generate at build time; serve the generated file

A script under `src/scripts/` calls `swaggerJsdoc({ failOnErrors: true, definition, apis })` and writes `openapi.json`. `npm run build` runs it. The server reads the file and serves it at `GET /api/v1/openapi.json`.

The server does not run `swagger-jsdoc` at startup. Its `apis` globs point at source files, and the layout under `dist/` and the `tsx` development mode would make a runtime scan fragile.

The endpoint is registered before the global IP rate limiter and before `notFoundHandler`, is unauthenticated, and responds with a cache header and an ETag. The `bearerAuth` description in the spec explains how to obtain a token.

### D5. Contract tests build the spec in memory and exercise the real app

`tests/integration/openapiContract.test.ts` generates the spec in memory (never from a committed file, so it cannot be stale), builds the app with `createApp` and `createFakeTokenVerifier`, uses `mongodb-memory-server` and supertest like the existing integration tests, calls every documented operation, and validates status, body and headers against the spec. It also checks route coverage in both directions. A separate CI step validates the generated document against the OpenAPI schema.

### D6. No documentation UI in this change

`helmet()` ships a restrictive content security policy that would block Swagger UI or Redoc served from the same origin. Relaxing it is a security decision tied to the in-flight `deploy-render` change (`production-http-security`). The frontend consumes `openapi.json` directly. A UI can be added later without changing the spec.

### D7. Description language follows the code-comment convention

The annotations are comments in `src/`, so the project convention applies: neutral Spanish, with a header comment in each file that gains annotations. Machine-facing strings (schema names, error codes, enum values) are unchanged. See Open Questions.

## Risks / Trade-offs

- [Annotations make `*.routes.ts` files noticeably longer] → Shared `$ref` components keep each block short; routes stay thin controllers because logic is untouched.
- [YAML inside comments has no editor validation and fails silently if malformed] → `failOnErrors: true` at generation, plus spec validation in CI.
- [Spec and code drift when someone changes a Zod schema or DTO without touching the annotation] → Response validation in the contract tests catches shape drift; the route-coverage check catches added or removed routes. Request-schema drift (a new optional query parameter, a changed range) is only caught if the contract tests exercise that case, so request constraints are covered by boundary examples in tests, not by the validator alone.
- [`swagger-jsdoc` is CommonJS and the project is ESM/NodeNext] → Verify default-import interop and the availability of types before relying on it; fall back to `createRequire` if needed.
- [Enumerating real Express 5 routes for the coverage check is not straightforward, because nested router prefixes are not stored as plain strings] → Resolve during implementation with a short spike; see Open Questions.
- [`deploy-render` edits the same build pipeline and security middleware] → Keep this change's build and middleware edits minimal and reconcile on whichever applies second.
- [A committed or stale `openapi.json` misleads the frontend] → The file is a build artifact generated from annotations, not hand-edited, and is not committed unless the team decides otherwise.

## Open Questions

- Resolved: route enumeration for the coverage check. A plain walk of `app.router.stack` is not enough: in Express 5 (`router` 2.x) a `Layer` keeps only compiled `matchers` (`path-to-regexp` v8), so the string prefix a router was mounted with is not stored anywhere. Leaf routes do keep their string (`layer.route.path`). The chosen method, implemented in `tests/helpers/listRoutes.ts`, is a recursive stack walk plus prefix capture at registration time: while the app is being built, `Router.prototype.use` is wrapped (and always restored in a `finally`) to tag each new layer with its original mount path, then the walk joins mount prefixes with leaf paths and converts `:param` to `{param}`. It is proven on the real `createApp` by `tests/unit/listRoutes.test.ts`, which asserts the exact set of routes (the 30 original ones under `/api/v1`, the self-describing `GET /api/v1/openapi.json`, plus `/health` and `/health/ready`). The explicit-table alternative was rejected because it would not catch a newly added undocumented route.
- Should descriptions be Spanish (code-comment convention) or English (frontend-facing)? Default in this change is Spanish; a one-line switch of that default is cheap before many annotations exist.
- What should `GET /api/v1/openapi.json` do in development when `npm run openapi:generate` has not been run? The spec's default is a 404 in the standard error envelope with a warning logged and no startup failure.
- Should `openapi.json` be committed for frontend consumption without a build, or only produced by the build and served by the API?
