## Purpose

This capability defines HTTP caching behavior for the public API, applying appropriate `Cache-Control` directives per endpoint class and relying on ETag revalidation for cacheable read endpoints.

## Requirements

### Requirement: Cache-Control per endpoint class

The system SHALL send `Cache-Control: public, max-age=60` on `GET /api/v1/coins`, `GET /api/v1/coins/:coingeckoId`, `GET /api/v1/coins/:coingeckoId/history` and `GET /api/v1/coins/:coingeckoId/stats`, and `Cache-Control: no-store` on `GET /api/v1/status` and on every route under `/api/v1/admin`.

#### Scenario: Coin reads are cacheable for a minute

- **WHEN** a client calls `GET /api/v1/coins`
- **THEN** the response carries `Cache-Control: public, max-age=60`

#### Scenario: Status is never stored by caches

- **WHEN** a client calls `GET /api/v1/status`
- **THEN** the response carries `Cache-Control: no-store`

#### Scenario: Admin responses are never stored by caches

- **WHEN** a client calls any route under `/api/v1/admin`
- **THEN** the response carries `Cache-Control: no-store`

### Requirement: ETag revalidation

The system SHALL keep Express's default weak `ETag` generation enabled for the cacheable read endpoints, so that a request repeating the received value in `If-None-Match` receives 304 with no body.

#### Scenario: Unchanged resource revalidates to 304

- **WHEN** a client repeats `GET /api/v1/coins` sending the previously received `ETag` in `If-None-Match` and the underlying data has not changed
- **THEN** the response is 304 with an empty body

#### Scenario: Changed resource returns a fresh body

- **WHEN** the underlying coin data changes and the client repeats the request with the old `If-None-Match`
- **THEN** the response is 200 with a new `ETag` and the full body
