## ADDED Requirements

### Requirement: Client contract

The system SHALL expose a `CoinGeckoClient` interface in `src/integrations/coingecko/` with `getSimplePrices(ids: string[]): Promise<{ prices: Map<string, SimplePrice>; attempts: number }>`, `getMarkets(ids: string[]): Promise<MarketCoin[]>`, and `ping(): Promise<void>`, using Node's native `fetch` (no axios) with `AbortSignal.timeout(ms)` for per-attempt timeouts.

#### Scenario: getSimplePrices returns a map and an attempt count

- **WHEN** `getSimplePrices` is called with a list of coin ids
- **THEN** it resolves with a `Map` keyed by coin id and a numeric `attempts` count including retries

### Requirement: Request batching

The system SHALL split `ids` into batches of at most `COINGECKO_MAX_IDS_PER_CALL` (default 50) and request batches sequentially, never in parallel.

#### Scenario: Large id list is split into sequential batches

- **WHEN** `getSimplePrices` is called with 120 ids and the batch limit is 50
- **THEN** 3 HTTP calls are made in sequence, not concurrently

### Requirement: Response validation and field mapping

The system SHALL validate every response with Zod. A missing or `null` field other than `usd` SHALL map to `null`. If `usd` is missing or not a positive number, that coin SHALL be discarded and logged at `warn`. If the response as a whole does not match the expected shape, the system SHALL throw an `UpstreamError` with internal code `COINGECKO_BAD_RESPONSE`.

#### Scenario: Invalid usd price discards only that coin

- **WHEN** a response includes a coin whose `usd` field is missing or non-positive
- **THEN** that coin is excluded from the result and a `warn` log is emitted, without failing the whole call

#### Scenario: Malformed response shape throws a bad-response error

- **WHEN** the response body does not match the expected schema at all
- **THEN** an `UpstreamError` with code `COINGECKO_BAD_RESPONSE` is thrown

### Requirement: Error mapping table

The system SHALL map upstream failures according to this table: timeout or network error → `UpstreamError` (`COINGECKO_UNAVAILABLE`), retryable; any 5xx → `UpstreamError` (`COINGECKO_UNAVAILABLE`), retryable; 429 → `UpstreamError` (`COINGECKO_RATE_LIMITED`), retried once respecting `Retry-After` if present and ≤ 60s (otherwise 30s); 401/403 → `UpstreamError` (`COINGECKO_AUTH`), logged at `error`, never retried; any other 4xx → `UpstreamError` (`COINGECKO_CLIENT_ERROR`), never retried.

#### Scenario: 401 response is not retried

- **WHEN** CoinGecko responds 401
- **THEN** an `UpstreamError` with code `COINGECKO_AUTH` is thrown immediately, without a retry, and logged at `error`

#### Scenario: 429 response respects Retry-After up to a cap

- **WHEN** CoinGecko responds 429 with a `Retry-After` header of 45 seconds
- **THEN** the client waits 45 seconds before its single retry

#### Scenario: 429 without a usable Retry-After falls back to a fixed wait

- **WHEN** CoinGecko responds 429 with no `Retry-After` header, or one exceeding 60 seconds
- **THEN** the client waits 30 seconds before its single retry

### Requirement: Retry with backoff and jitter

The system SHALL retry retryable failures up to `COINGECKO_MAX_RETRIES` times (default 2), waiting 1s then 3s, each with ±20% random jitter. The wait function SHALL be injectable so tests can run without real delays.

#### Scenario: Transient failures succeed after retries

- **WHEN** CoinGecko responds with a 503 twice and then 200
- **THEN** the call succeeds after 2 retries, and `attempts` reflects all 3 HTTP calls

#### Scenario: Exhausted retries surface the last error

- **WHEN** CoinGecko responds 503 on every attempt up to the retry limit
- **THEN** the client throws `UpstreamError` (`COINGECKO_UNAVAILABLE`) after the last attempt

### Requirement: No credential leakage

The system SHALL never include the CoinGecko API key in logs or in any error message. Each call SHALL log at `debug` the request path (without the key), the response status, and the duration.

#### Scenario: API key never appears in logs or errors

- **WHEN** any CoinGecko call is made, succeeds, or fails
- **THEN** no log line or thrown error message contains the API key value
