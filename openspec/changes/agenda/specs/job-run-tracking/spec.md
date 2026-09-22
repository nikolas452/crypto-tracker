## MODIFIED Requirements

### Requirement: JobRun document shape
The system SHALL define a `job_runs` collection with `jobName` (string, one of `"poll-prices"`, `"send-notifications"` or `"maintenance"`), `trigger` (enum `schedule`/`manual`/`startup`/`agenda`/`retry`/`api`, where `schedule` is retained only for runs recorded before the move to Agenda), `status` (enum `running`/`success`/`partial`/`failed`/`skipped`), `skipReason` (enum `overlap`/`no_active_coins`/`locked`/null), `startedAt` (Date, required), `finishedAt` (Date or null), `durationMs` (number or null), `agendaJobId` (string or null), `attempt` (integer, default 1), a `stats` object, `error` (`{ code, message }` or null, never a full stack or secrets), and `workerId` (string, `hostname-pid`). For `poll-prices` the `stats` object SHALL contain `coinsRequested`, `coinsReturned`, `snapshotsInserted`, `skippedUnchanged`, `missingCoins`, `upstreamAttempts`, `latestUpdated`, `alertsEvaluated`, `alertsTriggered`, `alertsRearmed`, `alertsInCooldown` and `triggerConflicts`. For `send-notifications` it SHALL contain `claimed`, `sent`, `retried`, `failedPermanent`, `failedExhausted`, `cancelled` and `recoveredStale`.

#### Scenario: JobRun document matches the fixed shape
- **WHEN** a job run completes
- **THEN** its document has `jobName`, `trigger`, `status`, `startedAt`, `finishedAt`, `durationMs`, `agendaJobId`, `attempt`, `stats`, and `workerId`

#### Scenario: A scheduler-driven run is attributed to Agenda
- **WHEN** the recurring `poll-prices` job runs
- **THEN** its `trigger` is `"agenda"` and its `agendaJobId` identifies the Agenda document that produced it

#### Scenario: A retry run carries its attempt number
- **WHEN** the retry policy schedules a second attempt
- **THEN** that run's `trigger` is `"retry"` and its `attempt` is 2

#### Scenario: A lease-blocked run records why it was skipped
- **WHEN** the polling job cannot acquire its lease
- **THEN** the run's `status` is `"skipped"` with `skipReason: "locked"`

#### Scenario: Alert evaluation counters are recorded on the polling run
- **WHEN** a `poll-prices` run evaluates 5 alerts of which 1 triggers
- **THEN** its `stats.alertsEvaluated` is 5 and its `stats.alertsTriggered` is 1
