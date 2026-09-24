## MODIFIED Requirements

### Requirement: JobRun document shape

The system SHALL define a `job_runs` collection with `jobName` (string, e.g. `"poll-prices"`), `trigger` (enum `schedule`/`manual`/`startup`), `status` (enum `running`/`success`/`partial`/`failed`/`skipped`), `skipReason` (enum `overlap`/`no_active_coins`/null), `startedAt` (Date, required), `finishedAt` (Date or null), `durationMs` (number or null), a `stats` object (`coinsRequested`, `coinsReturned`, `snapshotsInserted`, `skippedUnchanged`, `missingCoins`, `upstreamAttempts`, `latestUpdated`), `error` (`{ code, message }` or null, never a full stack or secrets), and `workerId` (string, `hostname-pid`).

#### Scenario: JobRun document matches the fixed shape

- **WHEN** a job run completes
- **THEN** its document has `jobName`, `trigger`, `status`, `startedAt`, `finishedAt`, `durationMs`, `stats`, and `workerId`

#### Scenario: Stats report how many coins had their latest projection refreshed

- **WHEN** a `poll-prices` run refreshes the `latest` projection for 4 coins
- **THEN** its `stats.latestUpdated` is 4
