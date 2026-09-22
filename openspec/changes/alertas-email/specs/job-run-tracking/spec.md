## MODIFIED Requirements

### Requirement: JobRun document shape
The system SHALL define a `job_runs` collection with `jobName` (string, one of `"poll-prices"` or `"send-notifications"`), `trigger` (enum `schedule`/`manual`/`startup`), `status` (enum `running`/`success`/`partial`/`failed`/`skipped`), `skipReason` (enum `overlap`/`no_active_coins`/null), `startedAt` (Date, required), `finishedAt` (Date or null), `durationMs` (number or null), a `stats` object, `error` (`{ code, message }` or null, never a full stack or secrets), and `workerId` (string, `hostname-pid`). For `poll-prices` the `stats` object SHALL contain `coinsRequested`, `coinsReturned`, `snapshotsInserted`, `skippedUnchanged`, `missingCoins`, `upstreamAttempts`, `latestUpdated`, `alertsEvaluated`, `alertsTriggered`, `alertsRearmed`, `alertsInCooldown` and `triggerConflicts`. For `send-notifications` it SHALL contain `claimed`, `sent`, `retried`, `failedPermanent`, `failedExhausted`, `cancelled` and `recoveredStale`.

#### Scenario: JobRun document matches the fixed shape
- **WHEN** a job run completes
- **THEN** its document has `jobName`, `trigger`, `status`, `startedAt`, `finishedAt`, `durationMs`, `stats`, and `workerId`

#### Scenario: Stats report how many coins had their latest projection refreshed
- **WHEN** a `poll-prices` run refreshes the `latest` projection for 4 coins
- **THEN** its `stats.latestUpdated` is 4

#### Scenario: Alert evaluation counters are recorded on the polling run
- **WHEN** a `poll-prices` run evaluates 5 alerts of which 1 triggers
- **THEN** its `stats.alertsEvaluated` is 5 and its `stats.alertsTriggered` is 1

#### Scenario: Send counters are recorded on the send run
- **WHEN** a `send-notifications` run claims 3 notifications and sends 2
- **THEN** its `stats.claimed` is 3 and its `stats.sent` is 2
