## ADDED Requirements

### Requirement: Watchlist listing endpoint

The system SHALL expose `GET /api/v1/me/watchlist`, guarded by `requireAuth`, with a strict Zod query schema accepting `sort` (enum `addedAt`/`name`/`change24h`/`marketCap`, default `addedAt`) and `order` (enum `asc`/`desc`).

#### Scenario: Authenticated user reads their own watchlist

- **WHEN** a user with items calls `GET /api/v1/me/watchlist`
- **THEN** the response is 200 with one entry per item they have added

#### Scenario: Sorting by 24h change is applied

- **WHEN** a user calls `GET /api/v1/me/watchlist?sort=change24h&order=desc`
- **THEN** the items are ordered by the joined coin's `latest.change24hPct` descending

### Requirement: Listing is built by aggregation with a coin join

The system SHALL build the listing with an aggregation over `watchlist_items` that matches the caller's `userId`, `$lookup`s the matching `coins` document projecting `coingeckoId`, `symbol`, `name`, `isActive` and `latest`, `$unwind`s the result, and `$sort`s by the requested field and direction.

#### Scenario: Each item carries its coin's current projection

- **WHEN** a watchlist item is returned
- **THEN** it includes the joined coin's `coingeckoId`, `symbol`, `name`, `isActive` and `latest`

### Requirement: Listing is deliberately unpaginated

The system SHALL return every item in a single response without pagination, relying on the `WATCHLIST_MAX_ITEMS` cap to bound the result, and SHALL document that decision together with its dependence on the cap.

#### Scenario: All items are returned in one response

- **WHEN** a user holds the maximum number of allowed items
- **THEN** all of them are returned in a single response with no pagination parameters accepted

### Requirement: Deactivated coins remain listed

The system SHALL continue to list an item whose coin has `isActive: false`, showing `isActive: false` and the last known `latest` values for that coin.

#### Scenario: A deactivated coin stays visible with frozen values

- **WHEN** an admin deactivates a coin that a user follows
- **THEN** the user's listing still contains it with `isActive: false` and the `latest` values captured before deactivation

### Requirement: Listing response envelope and caching

The system SHALL respond `{ data: [...], meta: { count, max } }`, where `count` is the number of returned items and `max` is `WATCHLIST_MAX_ITEMS`, and SHALL send `Cache-Control: private, no-cache` so the per-user response is never stored in a shared cache.

#### Scenario: Watchlist responses are not shared-cacheable

- **WHEN** a user reads their watchlist
- **THEN** the response carries `Cache-Control: private, no-cache`

### Requirement: Internal identifiers are never exposed

The system SHALL NOT include `userId`, the item's `_id`, or the coin's `_id` in any watchlist response; an item is identified by its `coingeckoId` within the caller's own watchlist.

#### Scenario: Watchlist items expose no internal ids

- **WHEN** any watchlist item is serialized
- **THEN** it contains no `userId`, no `_id` and no `__v`
