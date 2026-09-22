## ADDED Requirements

### Requirement: Stats endpoint and range parameter
The system SHALL expose `GET /api/v1/coins/:coingeckoId/stats` with a strict Zod query schema accepting `range` (enum `24h`/`7d`/`30d`/`90d`, default `24h`), and SHALL derive `from` and `to` from that range ending at the current time.

#### Scenario: Default range is applied
- **WHEN** a client calls the stats endpoint with no `range`
- **THEN** the statistics are computed over the last 24 hours and `range` is echoed as `"24h"`

#### Scenario: Unknown range value is rejected
- **WHEN** a client passes a `range` outside the enum
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

### Requirement: Single-pipeline statistics
The system SHALL compute `open` (the first price in the range), `close` (the last), `min`, `max`, `avg`, `samples`, `firstAt` and `lastAt` within one aggregation pipeline over `price_snapshots`, without loading the range into Node.

#### Scenario: Statistics match hand-computed values
- **WHEN** a known set of snapshots exists within the requested range
- **THEN** `open`, `close`, `min`, `max`, `avg` and `samples` equal the values computed by hand from those snapshots

### Requirement: Change percentage calculation
The system SHALL compute `changePct` as `(close - open) / open × 100`, rounded to 4 decimal places in the response.

#### Scenario: Change percentage is rounded to four decimals
- **WHEN** the computed change has more than 4 decimal places
- **THEN** the response's `changePct` is rounded to 4 decimal places

### Requirement: Empty range response
When the range contains no snapshots, the system SHALL respond 200 with `samples: 0` and every other computed field set to `null`, rather than an error.

#### Scenario: A range without data is not an error
- **WHEN** an active coin has no snapshots in the requested range
- **THEN** the response is 200 with `samples: 0` and `open`, `close`, `changePct`, `min`, `max`, `avg`, `firstAt` and `lastAt` all `null`

### Requirement: Stats response shape and unknown coins
The system SHALL respond `{ data: { coingeckoId, range, from, to, open, close, changePct, min, max, avg, samples, firstAt, lastAt } }`. A coin that does not exist or is inactive SHALL produce 404 `NOT_FOUND`.

#### Scenario: Stats for an unknown coin returns not found
- **WHEN** a client calls `GET /api/v1/coins/no-existe/stats`
- **THEN** the response is 404 with `error.code: "NOT_FOUND"`
