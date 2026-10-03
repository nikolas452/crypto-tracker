## ADDED Requirements

### Requirement: OpenAPI document identity

The system SHALL describe its HTTP API in an OpenAPI 3.0.3 document with `info` (title, version, description) and a `servers` entry of `/`, and SHALL document paths with their full prefix, so `/api/v1/...` routes and the unprefixed `/health` and `/health/ready` routes appear in the same document.

#### Scenario: The document declares its version

- **WHEN** the generated document is read
- **THEN** its `openapi` field is `3.0.3` and `info.title` and `info.version` are present

#### Scenario: Health routes are documented outside the API prefix

- **WHEN** the paths of the document are listed
- **THEN** `/health` and `/health/ready` appear without the `/api/v1` prefix

### Requirement: Every route is documented

The system SHALL document every HTTP route the application serves, each with its method, path, a summary, a tag identifying its module, its parameters, its request body when it has one, and every status code it can return.

#### Scenario: A route exists in the application

- **WHEN** a route is registered in the application
- **THEN** the document contains an operation for the same method and path

#### Scenario: A route is removed from the application

- **WHEN** a route is no longer registered
- **THEN** the document does not contain an operation for it

#### Scenario: A route with several success statuses

- **WHEN** `POST /api/v1/admin/coins` is documented
- **THEN** both `201` (a coin created) and `200` (an inactive coin reactivated) are listed with the shared coin response body

### Requirement: Authentication is documented

The system SHALL declare a `bearerAuth` security scheme (HTTP bearer, JWT format) for the Firebase ID token, SHALL apply it to every authenticated operation, and SHALL mark public operations (`/api/v1/coins*`, `/api/v1/status`, `/health*`, `/api/v1/openapi.json`) with an empty security requirement.

#### Scenario: An authenticated operation requires the token

- **WHEN** `GET /api/v1/me/watchlist` is read from the document
- **THEN** it references `bearerAuth` and lists the `401` response

#### Scenario: A public operation requires no token

- **WHEN** `GET /api/v1/coins` is read from the document
- **THEN** it declares no security requirement

#### Scenario: Admin operations state their extra requirements

- **WHEN** an operation under `/api/v1/admin` is read from the document
- **THEN** it lists the `403` response, and its description states that the caller must hold the admin role and that the token revocation status is checked

#### Scenario: Account deletion states revocation checking

- **WHEN** `DELETE /api/v1/me` is read from the document
- **THEN** its description states that the token revocation status is checked

### Requirement: Error envelope is documented once and reused

The system SHALL define a reusable `Error` schema matching `{ error: { code, message, requestId, details? } }`, SHALL enumerate every error `code` the API can emit (`VALIDATION_ERROR`, `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `FORBIDDEN`, `USER_DISABLED`, `NOT_FOUND`, `CONFLICT`, `UNPROCESSABLE`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `FIREBASE_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`), and SHALL provide shared responses for the statuses common to many operations.

#### Scenario: Validation failures document their details

- **WHEN** a `400` response is read from the document
- **THEN** its `details` is described as an array of `{ path, message }` where `path` is prefixed with `body.`, `query.` or `params.`

#### Scenario: Business errors document their reason

- **WHEN** an operation that can return a business error is read from the document
- **THEN** its error `details` is described as an object with a `reason` string, and the known reasons for that operation are listed

#### Scenario: Readiness is the documented exception

- **WHEN** `GET /health/ready` is read from the document
- **THEN** its `503` response uses its own `{ status, checks, timestamp }` body and not the `Error` envelope

### Requirement: Success envelopes and pagination are documented

The system SHALL document single-resource responses as `{ data }`, paginated list responses as `{ data, meta: { page, limit, total, totalPages } }`, and the watchlist list response as `{ data, meta: { count, max } }`, and SHALL document `204` responses as having no body.

#### Scenario: A paginated list

- **WHEN** `GET /api/v1/coins` is read from the document
- **THEN** its `200` response has a `data` array and a `meta` object with `page`, `limit`, `total` and `totalPages`

#### Scenario: The watchlist is not paginated

- **WHEN** `GET /api/v1/me/watchlist` is read from the document
- **THEN** its `meta` has `count` and `max` and no pagination fields

### Requirement: Request constraints match validation

The system SHALL document each path, query and body parameter with the same type, allowed values, bounds, defaults and patterns enforced by the corresponding Zod schema, and SHALL state that unknown query and body keys are rejected with `400`.

#### Scenario: Coin identifier pattern

- **WHEN** any operation with a `coingeckoId` path parameter is read from the document
- **THEN** the parameter declares the pattern `^[a-z0-9-]+$`

#### Scenario: Price history parameters

- **WHEN** `GET /api/v1/coins/{coingeckoId}/history` is read from the document
- **THEN** `interval` is `raw`, `1h` or `1d`, `sma` is an integer from 2 to 200 and is documented as not allowed with `interval=raw`, and `from`, `to` are date-time values with the default window described as the last 7 days

#### Scenario: Price statistics range

- **WHEN** `GET /api/v1/coins/{coingeckoId}/stats` is read from the document
- **THEN** `range` is `24h`, `7d`, `30d` or `90d` with default `24h`

#### Scenario: List pagination parameters

- **WHEN** a paginated list operation is read from the document
- **THEN** `page` defaults to 1 and `limit` is bounded with its default stated

### Requirement: Alert creation is a discriminated union

The system SHALL document the body of `POST /api/v1/me/alerts` as a `oneOf` discriminated by `type`, with one variant each for `PRICE_ABOVE`, `PRICE_BELOW` and `CHANGE_24H_ABS_GTE`, each declaring its own `threshold` range, and the shared optional fields `mode`, `cooldownMinutes`, `rearmPct` and `note`.

#### Scenario: Each alert type has its own schema

- **WHEN** the body schema of `POST /api/v1/me/alerts` is read from the document
- **THEN** it contains three variants selected by the `type` discriminator

#### Scenario: Alert updates cannot change the type

- **WHEN** the body schema of `PATCH /api/v1/me/alerts/{id}` is read from the document
- **THEN** it does not declare `type`, and it states that at least one updatable field is required

### Requirement: Response headers are documented

The system SHALL document the `Location` header on every `201` response from the watchlist and alert creation operations, the `X-Request-Id` header on responses, the `RateLimit-*` headers where rate limiting applies, and the `Cache-Control` policy of each route group (`public, max-age=60` for coins, `no-store` for status and admin, `private, no-cache` for the user watchlist, alerts and notifications).

#### Scenario: Created resources point to their location

- **WHEN** the `201` response of `POST /api/v1/me/watchlist` is read from the document
- **THEN** it declares a `Location` header

#### Scenario: Cache policy is visible to the client

- **WHEN** `GET /api/v1/coins` is read from the document
- **THEN** its `200` response declares `Cache-Control` as `public, max-age=60`

### Requirement: Public and administrative notification views are distinct

The system SHALL document the user-facing notification view and the administrative notification view as separate schemas, where the user view masks the recipient address and exposes only the error code, and the administrative view exposes the full error and lock owner.

#### Scenario: A user lists their notifications

- **WHEN** `GET /api/v1/me/notifications` is read from the document
- **THEN** its items reference the user-facing notification schema

#### Scenario: An administrator lists notifications

- **WHEN** `GET /api/v1/admin/notifications` is read from the document
- **THEN** its items reference the administrative notification schema
