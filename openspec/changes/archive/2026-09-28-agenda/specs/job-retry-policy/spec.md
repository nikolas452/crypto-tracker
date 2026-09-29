## ADDED Requirements

### Requirement: Retry on transient failures only

The system SHALL treat `COINGECKO_UNAVAILABLE`, `COINGECKO_RATE_LIMITED` and `ALERT_EVALUATION_FAILED` as transient and, in the `fail:poll-prices` listener, SHALL schedule one delayed run two minutes later with `data` containing `trigger: "retry"`, `attempt: attempt + 1` and the parent job's identifier, while `data.attempt` is below `POLL_MAX_JOB_RETRIES + 1` (default allowing 1 retry).

#### Scenario: A transient upstream outage schedules exactly one retry

- **WHEN** `poll-prices` fails with `COINGECKO_UNAVAILABLE` on its first attempt
- **THEN** one run is scheduled two minutes later with `trigger: "retry"` and `attempt: 2`, and no third run is scheduled when that one also fails

### Requirement: No retry for non-transient failures

The system SHALL NOT schedule a retry for `COINGECKO_AUTH`, `INTERNAL` or any other code outside the transient list.

#### Scenario: An authentication failure is not retried

- **WHEN** `poll-prices` fails with `COINGECKO_AUTH`
- **THEN** no retry is scheduled

### Requirement: No retry when the next scheduled run is imminent

The system SHALL NOT schedule a retry when fewer than 3 minutes remain before the recurring job's `nextRunAt`.

#### Scenario: An imminent scheduled run suppresses the retry

- **WHEN** a transient failure occurs less than 3 minutes before the recurring job's next run
- **THEN** no retry is scheduled and the recurring run proceeds as normal

### Requirement: Other jobs are not retried

The system SHALL NOT retry `send-notifications` or `maintenance`, relying on their next scheduled execution instead, and SHALL document that reasoning.

#### Scenario: A failed send job waits for its next schedule

- **WHEN** `send-notifications` fails
- **THEN** no retry is scheduled and the job runs again at its next scheduled time

### Requirement: Native retry support supersedes the listener

If the installed Agenda version provides native retry or backoff configuration, the system SHALL evaluate replacing the listener-based policy with it while preserving the behavior specified here, and SHALL document the decision.

#### Scenario: A substitution is recorded

- **WHEN** native retry support is adopted in place of the listener
- **THEN** the behavior above is preserved and the substitution is documented
