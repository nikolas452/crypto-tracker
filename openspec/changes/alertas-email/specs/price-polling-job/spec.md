## MODIFIED Requirements

### Requirement: Missing coins are tracked and reflected in status
Coins requested but not returned by CoinGecko SHALL be recorded in `stats.missingCoins` and logged at `warn`. The run's final `status` SHALL be `"success"` if `missingCoins` is empty, `"partial"` if some but not all coins are missing, and `"failed"` if none came back. A run that would otherwise be `"success"` SHALL be downgraded to `"partial"` when the `coins.latest` refresh fails, and likewise when the alert-evaluation step fails.

#### Scenario: Partial response yields a partial run
- **WHEN** CoinGecko returns 2 of 3 requested coins
- **THEN** the run's `status` is `"partial"` and the missing coin appears in `stats.missingCoins`

#### Scenario: A complete fetch with a failed latest refresh is partial
- **WHEN** every requested coin is returned and inserted but the `coins.latest` refresh fails
- **THEN** the run's `status` is `"partial"` rather than `"success"`

#### Scenario: A complete fetch with a failed alert evaluation is partial
- **WHEN** every requested coin is returned and inserted but the alert-evaluation step fails
- **THEN** the run's `status` is `"partial"` with `error.code: "ALERT_EVALUATION_FAILED"` and the inserted snapshots remain

### Requirement: The job function never throws
Any exception during a run SHALL be caught, close the `JobRun` as `failed` with `error.code` (the upstream error's code, or `"INTERNAL"`) and `error.message`, and be logged at `error` with its stack. `run()` SHALL always resolve, never reject. This guarantee SHALL extend to the alert-evaluation step and to the immediate dispatch of `send-notifications` that follows it, neither of which may cause `run()` to reject.

#### Scenario: An unexpected error still resolves with a failed result
- **WHEN** an unexpected exception occurs during a run
- **THEN** `run()` resolves (does not throw) with a result whose `status` is `"failed"` and whose `error` field is populated

#### Scenario: A failure while dispatching notifications does not reject the run
- **WHEN** invoking `send-notifications` at the end of a run throws
- **THEN** `run()` still resolves and the price portion of the run keeps its own outcome

## ADDED Requirements

### Requirement: Alert evaluation is the final step of the run
After refreshing `coins.latest`, the system SHALL run the alert-evaluation step over the coins that received a new snapshot in this run, and SHALL do so as the last step, so no failure in it can prevent prices from being stored.

#### Scenario: Evaluation runs after prices are durable
- **WHEN** a run completes its snapshot insertion and latest refresh
- **THEN** alert evaluation runs afterwards, against the values just stored

#### Scenario: A run with no new snapshots evaluates nothing
- **WHEN** every coin is skipped as unchanged
- **THEN** the evaluation step has no input coins and performs no alert reads
