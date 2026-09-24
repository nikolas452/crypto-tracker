## ADDED Requirements

### Requirement: Latest projection refresh after insertion

After inserting new snapshots, the system SHALL refresh `coins.latest` for every coin that received a new snapshot in this run, using a single `bulkWrite` containing one `updateOne` per such coin that `$set`s `latest` from the values just stored.

#### Scenario: Latest matches the newest snapshot after a run

- **WHEN** a run inserts snapshots for every active coin
- **THEN** each coin's `latest` equals the values of its most recent snapshot

#### Scenario: Coins without a new snapshot are not written

- **WHEN** a coin is skipped as unchanged during deduplication
- **THEN** the `bulkWrite` contains no operation for that coin

### Requirement: Latest refresh never overwrites newer data

Each `updateOne` in the refresh SHALL be conditional on the coin's stored `latest.capturedAt` being absent or strictly earlier than the new `capturedAt`, so a slower older run that finishes after a newer one cannot replace newer values.

#### Scenario: A late-finishing older run does not overwrite newer values

- **WHEN** the latest refresh for an older run is applied after a newer run has already written its values
- **THEN** the older run's update matches no document and the newer values remain stored

### Requirement: Latest refresh failure degrades the run

If the `bulkWrite` fails, the system SHALL close the run as `partial` with `error.code: "LATEST_UPDATE_FAILED"`, SHALL retain the snapshots already inserted, and SHALL rely on the next run to bring `latest` up to date.

#### Scenario: A failed refresh keeps the inserted snapshots

- **WHEN** the `bulkWrite` refreshing `latest` throws
- **THEN** the run's `status` is `"partial"` with `error.code: "LATEST_UPDATE_FAILED"`, and the snapshots inserted earlier in the run are still present

## MODIFIED Requirements

### Requirement: Missing coins are tracked and reflected in status

Coins requested but not returned by CoinGecko SHALL be recorded in `stats.missingCoins` and logged at `warn`. The run's final `status` SHALL be `"success"` if `missingCoins` is empty, `"partial"` if some but not all coins are missing, and `"failed"` if none came back. A run that would otherwise be `"success"` SHALL be downgraded to `"partial"` when the `coins.latest` refresh fails.

#### Scenario: Partial response yields a partial run

- **WHEN** CoinGecko returns 2 of 3 requested coins
- **THEN** the run's `status` is `"partial"` and the missing coin appears in `stats.missingCoins`

#### Scenario: A complete fetch with a failed latest refresh is partial

- **WHEN** every requested coin is returned and inserted but the `coins.latest` refresh fails
- **THEN** the run's `status` is `"partial"` rather than `"success"`
