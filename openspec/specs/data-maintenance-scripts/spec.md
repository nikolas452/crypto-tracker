## Purpose

This capability provides operator-run maintenance scripts for repairing and backfilling coin market data: rebuilding the `latest` projection from stored snapshots, and optionally importing historical price points from CoinGecko.

## Requirements

### Requirement: Rebuild latest script

The system SHALL provide `npm run coins:rebuild-latest`, which recomputes `coins.latest` for every coin from that coin's most recent `price_snapshots` document, so the field can be initialized on pre-existing data or repaired after a failed update. The script SHALL be idempotent and SHALL print a summary of how many coins were updated and how many had no snapshots.

#### Scenario: Latest is rebuilt from the newest snapshot

- **WHEN** a coin has snapshots but a `latest` of `null` and the script runs
- **THEN** that coin's `latest` is populated from its most recent snapshot's values and `capturedAt`

#### Scenario: Running the script twice changes nothing the second time

- **WHEN** the script is run twice in a row with no new snapshots in between
- **THEN** the second run leaves every `latest` value identical to the first run's result

#### Scenario: A coin with no snapshots is reported, not failed

- **WHEN** a coin has no snapshots at all
- **THEN** its `latest` remains `null`, it is counted in the summary as having no snapshots, and the script does not fail

### Requirement: Optional history backfill script

The system SHALL provide `npm run backfill:history -- <coingeckoId> --days <n>` as an optional utility that imports historical points from CoinGecko's market chart endpoint into `price_snapshots`, setting each point's `timestamp` and `sourceUpdatedAt` to that point's own upstream timestamp.

#### Scenario: Imported points carry their own upstream timestamp

- **WHEN** the backfill script imports a historical point
- **THEN** the stored snapshot's `timestamp` and `sourceUpdatedAt` both equal that point's upstream timestamp, not the time of import

### Requirement: Backfill overlap handling is explicit

The system SHALL apply one documented rule for points in the requested range that already exist for that coin — either skipping them or deleting them before insert — and SHALL state the chosen rule in the project documentation.

#### Scenario: Existing points are handled by the documented rule

- **WHEN** the requested range overlaps snapshots that already exist for the coin
- **THEN** the script applies its documented overlap rule and reports how many points it skipped or replaced

### Requirement: Backfill confirms quota consumption before running

The system SHALL show how many CoinGecko calls the requested backfill will consume from the monthly quota and require confirmation before making any upstream request.

#### Scenario: Backfill waits for confirmation

- **WHEN** the backfill script is invoked
- **THEN** it prints the number of upstream calls it will make and performs none of them until the operator confirms
