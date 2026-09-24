## Purpose

This capability exposes historical price data for a coin over a requested time range, with automatic or explicit interval selection, bucketed OHLC aggregation, and optional simple moving average computation.

## Requirements

### Requirement: History query schema

The system SHALL expose `GET /api/v1/coins/:coingeckoId/history` and validate its query with a strict Zod schema accepting `from` (ISO 8601 datetime with `Z` or an explicit offset, default `to - 7 days`), `to` (ISO 8601 datetime, default now, and never more than 5 minutes in the future), `interval` (enum `raw`/`1h`/`1d`, defaulting to the automatic selection), and `sma` (integer 2-200, accepted only together with `1h` or `1d`). `from` SHALL be strictly earlier than `to`.

#### Scenario: Datetime without timezone is rejected

- **WHEN** a client passes `from=2026-09-10T10:00` with no `Z` and no offset
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

#### Scenario: Equal from and to is rejected

- **WHEN** a client passes the same value for `from` and `to`
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

#### Scenario: A to far in the future is rejected

- **WHEN** a client passes a `to` more than 5 minutes ahead of the current time
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

#### Scenario: sma is rejected with the raw interval

- **WHEN** a client passes `interval=raw` together with `sma`
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

### Requirement: Automatic interval selection

When `interval` is omitted, the system SHALL select it from the requested range with a pure function: `raw` for a range of 2 days or less, `1h` for a range of 30 days or less, and `1d` for anything larger. The selected interval SHALL be echoed in the response.

#### Scenario: A twenty-day range selects the hourly interval

- **WHEN** a client requests history over a 20-day range without specifying `interval`
- **THEN** the response's `interval` is `"1h"`

### Requirement: Maximum range per interval

The system SHALL reject a range longer than the interval's maximum — 7 days for `raw`, 90 days for `1h`, 365 days for `1d` — with a 400 `VALIDATION_ERROR` whose message names a coarser interval to use instead.

#### Scenario: Raw interval over a ten-day range suggests the hourly interval

- **WHEN** a client calls history with `interval=raw` over a 10-day range
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"` and a message suggesting `1h`

### Requirement: Raw interval retrieval and point cap

For `interval=raw` the system SHALL query `price_snapshots` by `meta.coingeckoId` and the `timestamp` range, sorted ascending, projecting only the needed fields, and SHALL return each point as `{ t, priceUsd, marketCapUsd, volume24hUsd, change24hPct }`. If the range contains more than 2000 points, the system SHALL respond 400 suggesting `1h` instead of truncating the result.

#### Scenario: Raw result over the point cap is refused rather than truncated

- **WHEN** a raw query would return more than 2000 points
- **THEN** the response is 400 suggesting the `1h` interval, and no partial point list is returned

### Requirement: Bucketed OHLC aggregation

For `interval=1h` or `1d` the system SHALL compute buckets in a single aggregation pipeline that matches the coin and range, sorts by `timestamp` ascending, groups by `$dateTrunc` on `timestamp` with unit `hour` or `day` and `timezone: "UTC"`, and produces `open` (`$first`), `high` (`$max`), `low` (`$min`), `close` (`$last`), `avg` (`$avg`) and `samples` (`$sum: 1`), then sorts by bucket ascending.

#### Scenario: Three hours of known snapshots produce three exact buckets

- **WHEN** snapshots spanning 3 distinct hours are stored and a client requests `interval=1h` over that range
- **THEN** the response contains 3 points whose `open`, `high`, `low`, `close`, `avg` and `samples` equal the values computed by hand from those snapshots

#### Scenario: A bucket with a single sample collapses to one price

- **WHEN** a bucket contains exactly one snapshot
- **THEN** that point's `open`, `high`, `low` and `close` are all equal to that snapshot's price

### Requirement: Simple moving average window

When `sma` is supplied with a bucketed interval, the system SHALL compute it with `$setWindowFields` sorted by bucket ascending, averaging `close` over a window of `[-(sma - 1), 0]` documents. For the first `sma - 1` buckets the value SHALL be `null` rather than an average over a shorter window.

#### Scenario: The moving average warm-up returns nulls

- **WHEN** a client requests `interval=1h&sma=3` over a range producing at least 3 buckets
- **THEN** the first 2 points have `sma: null` and the third point's `sma` equals the average of the first three `close` values

#### Scenario: A window larger than the series yields only nulls

- **WHEN** `sma` is greater than the number of buckets in the range
- **THEN** every point has `sma: null` and no error is returned

### Requirement: Empty buckets are not filled

The system SHALL omit buckets that contain no snapshots rather than emitting a placeholder point for them.

#### Scenario: A gap in the data produces no point

- **WHEN** an hour within the requested range contains no snapshots
- **THEN** no point exists for that hour in the response

### Requirement: History response shape and empty ranges

The system SHALL respond `{ data: { coingeckoId, interval, from, to, points } }`. A coin that exists and is active but has no snapshots in the range SHALL produce 200 with `points: []`. A coin that does not exist or is inactive SHALL produce 404.

#### Scenario: Existing coin with no data in the range

- **WHEN** an active coin has no snapshots between `from` and `to`
- **THEN** the response is 200 with `points: []`

#### Scenario: Unknown coin returns not found

- **WHEN** history is requested for a coin id that does not exist
- **THEN** the response is 404 with `error.code: "NOT_FOUND"`
