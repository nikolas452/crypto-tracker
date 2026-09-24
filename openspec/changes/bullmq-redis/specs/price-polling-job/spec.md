## MODIFIED Requirements

### Requirement: Missing coins are tracked and reflected in status

Coins requested but not returned by CoinGecko SHALL be recorded in `stats.missingCoins` and logged at `warn`. The run's final `status` SHALL be `"success"` if `missingCoins` is empty, `"partial"` if some but not all coins are missing, and `"failed"` if none came back. A run that would otherwise be `"success"` SHALL be downgraded to `"partial"` when the `coins.latest` refresh fails, and likewise when enqueueing the per-coin alert-evaluation jobs fails, in which case `error.code` SHALL be `"ENQUEUE_FAILED"`.

#### Scenario: Partial response yields a partial run

- **WHEN** CoinGecko returns 2 of 3 requested coins
- **THEN** the run's `status` is `"partial"` and the missing coin appears in `stats.missingCoins`

#### Scenario: A complete fetch with a failed latest refresh is partial

- **WHEN** every requested coin is returned and inserted but the `coins.latest` refresh fails
- **THEN** the run's `status` is `"partial"` rather than `"success"`

#### Scenario: A complete fetch with a failed fan-out is partial

- **WHEN** every requested coin is returned and inserted but enqueueing the evaluation jobs fails
- **THEN** the run's `status` is `"partial"` with `error.code: "ENQUEUE_FAILED"` and the inserted snapshots remain

## REMOVED Requirements

### Requirement: Alert evaluation is the final step of the run

**Reason**: Alert evaluation is decomposed into one `evaluate-alerts` queue job per updated coin, so a large alert set can no longer delay price collection and each coin's evaluation retries independently.
**Migration**: The polling run now ends by enqueueing one `evaluate-alerts` job per updated coin, as specified by the `price-poll-fanout` capability. The evaluation logic itself — `decide`, the version guard, the transaction and the dedupe key — is unchanged and now runs inside those jobs, as specified by `alert-evaluation-jobs`.
