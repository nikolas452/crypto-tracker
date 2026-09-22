## ADDED Requirements

### Requirement: Lease lock document and contract
The system SHALL define a `job_locks` collection whose `_id` is the resource name, with `lockedBy` (the owner's `workerId` plus `runId`), `lockedUntil` (Date) and `acquiredAt` (Date), and SHALL expose `acquire(name, owner, ttlMs)`, `renew(name, owner, ttlMs)` and `release(name, owner)` in `src/lib/lease-lock.ts`.

#### Scenario: A lock document identifies its owner and expiry
- **WHEN** a lease is acquired
- **THEN** a `job_locks` document exists whose `_id` is the resource name, with the owner in `lockedBy` and a future `lockedUntil`

### Requirement: Atomic acquisition
`acquire` SHALL perform a single `findOneAndUpdate` filtered on `{ _id: name, $or: [{ lockedUntil: { $lt: now } }, { lockedBy: owner }] }`, setting `lockedBy`, `lockedUntil` and `acquiredAt` with `upsert: true`, and SHALL return `false` when the operation fails with a duplicate-key error because another owner holds an unexpired lease.

#### Scenario: A free resource is acquired
- **WHEN** `acquire` is called for a resource with no existing lock
- **THEN** it returns `true` and the lock document is created

#### Scenario: A held resource is refused
- **WHEN** `acquire` is called for a resource whose lease is held by a different owner and has not expired
- **THEN** it returns `false` and the existing lock is unchanged

#### Scenario: An expired lease is taken over
- **WHEN** `acquire` is called for a resource whose `lockedUntil` is in the past
- **THEN** it returns `true` and the caller becomes the new owner

#### Scenario: The current owner can re-acquire
- **WHEN** `acquire` is called by the owner that already holds the lease
- **THEN** it returns `true` and the expiry is extended

### Requirement: Release only affects the caller's own lock
`release` SHALL perform `deleteOne({ _id: name, lockedBy: owner })`, so a caller can never release a lease held by another owner.

#### Scenario: Releasing another owner's lock does nothing
- **WHEN** `release` is called with an owner that does not match the stored `lockedBy`
- **THEN** no document is deleted and the existing lease remains held

### Requirement: Polling job guards itself with the lease
The `poll-prices` handler SHALL acquire the lease named `poll-prices` with a TTL of `POLL_LOCK_TTL_MS` (default 5 minutes) before doing any work, SHALL record a `JobRun` with `status: "skipped"` and `skipReason: "locked"` and finish **without error** when acquisition fails, and SHALL release the lease in a `finally` block.

#### Scenario: A held lease skips the run without calling CoinGecko
- **WHEN** the `poll-prices` lease is held by another owner and the job executes
- **THEN** a `JobRun` with `status: "skipped"` and `skipReason: "locked"` is recorded, no CoinGecko call is made, and the job does not fail

#### Scenario: An expired lease allows a normal run
- **WHEN** the `poll-prices` lease has expired and the job executes
- **THEN** the job acquires the lease and runs normally

#### Scenario: The lease is released even when the job throws
- **WHEN** the job's logic throws after acquiring the lease
- **THEN** the lease is still released

### Requirement: Send notifications needs no lease
The system SHALL NOT apply a lease to `send-notifications`, because its atomic per-notification claim already prevents duplicate sends, and SHALL document that reasoning.

#### Scenario: Concurrent send jobs remain safe without a lease
- **WHEN** two `send-notifications` executions run concurrently
- **THEN** each pending notification is still claimed and sent exactly once, without any lease being involved

### Requirement: Clock synchronization is a documented requirement
The system SHALL document that the lease compares timestamps produced by each worker's own clock, so workers are required to have synchronized clocks.

#### Scenario: The clock assumption is written down
- **WHEN** a developer reads the documentation for the lease lock
- **THEN** it states that worker clocks must be synchronized for the lease to be correct
