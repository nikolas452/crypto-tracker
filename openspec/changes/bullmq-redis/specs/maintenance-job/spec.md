## MODIFIED Requirements

### Requirement: One-off job pruning step
The system SHALL count the jobs in the `failed` state per queue over the last 24 hours and log at `warn` when that count is greater than zero, and SHALL clean up old jobs from each queue when the queues' own `removeOnComplete` and `removeOnFail` retention settings have not already removed them.

#### Scenario: Failed jobs per queue are surfaced
- **WHEN** any queue holds jobs that failed in the last 24 hours and maintenance executes
- **THEN** a `warn` log reports the count per queue

#### Scenario: Residual old jobs are cleaned up
- **WHEN** jobs older than the configured retention remain in a queue and maintenance executes
- **THEN** they are removed using the queue's cleanup mechanism
