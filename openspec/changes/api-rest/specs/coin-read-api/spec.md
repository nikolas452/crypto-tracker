## ADDED Requirements

### Requirement: Coin list query schema
The system SHALL validate `GET /api/v1/coins` query parameters with a strict Zod schema accepting `page` (integer ≥ 1, default 1), `limit` (integer 1-100, default 20), `sort` (enum `marketCap`/`name`/`symbol`/`change24h`, default `marketCap`), `order` (enum `asc`/`desc`, defaulting to `desc` for `marketCap` and `change24h` and to `asc` for `name` and `symbol`), and `q` (string, 1-50 characters). Any unknown query parameter SHALL produce a 400 `VALIDATION_ERROR`.

#### Scenario: Unknown query parameter is rejected
- **WHEN** a client calls `GET /api/v1/coins?foo=1`
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

#### Scenario: Invalid numeric parameters are rejected with details
- **WHEN** a client calls `GET /api/v1/coins` with `limit=0`, `limit=abc` or `page=-1`
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"` and a `details` array naming the offending parameter

#### Scenario: Defaults are applied when parameters are omitted
- **WHEN** a client calls `GET /api/v1/coins` with no query parameters
- **THEN** the request is served with `page: 1`, `limit: 20`, `sort: "marketCap"` and `order: "desc"`

### Requirement: Coin list pagination
The system SHALL return only coins with `isActive: true`, using offset pagination that skips `(page - 1) × limit` documents, and SHALL respond with the project's paginated shape `{ data, meta }` where `meta` contains `page`, `limit`, `total` and `totalPages`. The total SHALL be obtained with a `countDocuments` call using the same filter as the data query, and the endpoint SHALL NOT use `$lookup` against the time-series collection.

#### Scenario: Third page of a partially-filled result set
- **WHEN** 12 active coins exist and a client calls `GET /api/v1/coins?limit=5&page=3`
- **THEN** the response contains 2 items and `meta` equal to `{ page: 3, limit: 5, total: 12, totalPages: 3 }`

#### Scenario: Inactive coins are excluded from the list
- **WHEN** a coin has `isActive: false`
- **THEN** it does not appear in any page of `GET /api/v1/coins`

### Requirement: Coin list prefix search
When `q` is present, the system SHALL lowercase it, escape every regex metacharacter in it, and match it as an anchored prefix (`^` + escaped text) against `symbol` or `nameLower`. The regex SHALL NOT use the case-insensitive flag, since both stored fields are already lowercase.

#### Scenario: Search is case-insensitive through normalization
- **WHEN** a client calls `GET /api/v1/coins?q=BIT`
- **THEN** the response includes `bitcoin` and every other active coin whose `nameLower` or `symbol` starts with `bit`

#### Scenario: Regex metacharacters are matched literally
- **WHEN** a client calls `GET /api/v1/coins` with a `q` containing characters such as `.`, `*` or `[`
- **THEN** those characters are escaped before the regex is built and the search matches them literally, without a regex error or unbounded backtracking

### Requirement: Coin list ordering places unpolled coins last
The system SHALL sort results by the selected field and direction, and SHALL place coins whose `latest` is `null` after all coins that have a `latest`, regardless of the requested `sort` and `order`.

#### Scenario: Ascending sort by 24h change keeps unpolled coins last
- **WHEN** a client calls `GET /api/v1/coins?sort=change24h&order=asc`
- **THEN** coins are ordered by `latest.change24hPct` ascending and every coin with `latest: null` appears after them

### Requirement: Coin list response shape
Each list item SHALL expose `coingeckoId`, `symbol`, `name` and `latest` (with `priceUsd`, `marketCapUsd`, `volume24hUsd`, `change24hPct` and `capturedAt`), built by an explicit output DTO. The response SHALL NOT include the Mongo `_id` or `__v` of any document.

#### Scenario: Internal database fields are never exposed
- **WHEN** any coin is returned by `GET /api/v1/coins`
- **THEN** the serialized item contains no `_id` and no `__v` field

### Requirement: Coin detail endpoint
The system SHALL expose `GET /api/v1/coins/:coingeckoId`, validating `coingeckoId` against the same pattern the `coins` model enforces and responding 400 on a mismatch. A coin that does not exist or has `isActive: false` SHALL produce 404 `NOT_FOUND`. On success the response SHALL be `{ data: { coingeckoId, symbol, name, latest, trackedSince } }`, where `trackedSince` is the coin's `createdAt`.

#### Scenario: Unknown coin returns not found
- **WHEN** a client calls `GET /api/v1/coins/no-existe`
- **THEN** the response is 404 with `error.code: "NOT_FOUND"`

#### Scenario: Deactivated coin is hidden from the detail endpoint
- **WHEN** a coin exists with `isActive: false` and a client requests its detail
- **THEN** the response is 404, while its historical snapshots remain stored

#### Scenario: Malformed coin id is a validation error
- **WHEN** a client requests a coin id that does not match the model's pattern
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

### Requirement: Services receive typed values only
The system SHALL pass only validated, typed values from controllers to services for these endpoints; no service function SHALL receive the Express `req` or `res` object.

#### Scenario: Coin list service is callable without HTTP
- **WHEN** the coin list service is called directly from a unit test with a typed options object
- **THEN** it returns the same result set it would serve over HTTP, without any Express object being constructed
