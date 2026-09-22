## Context

Five stages of job logic have accumulated behind a scheduler that is deliberately the simplest thing that could work: `node-cron` plus a boolean. That was the right choice for stage 1, and every limitation it imposed was written down at the time rather than hidden — a manual run can overlap the worker's, two workers would run independent schedules, and nothing outside the worker can see or control a job. This stage pays those debts by moving the schedule itself into the database.

The business logic in `src/jobs/*` does not change at all. That is the payoff of stage 1's decision to keep the job a plain function of its injected dependencies: swapping the scheduler is a change to who calls it, not to what it does.

Agenda 6 is a complete TypeScript rewrite, ESM-only, with breaking changes from v5 that most published tutorials predate. This design treats the installed version's own documentation as authoritative and states requirements in terms of behavior wherever an API name might have moved.

## Goals / Non-Goals

**Goals:**
- The schedule survives a restart, and a restarted worker resumes rather than starting over.
- Two workers can run without duplicating work, and a manual run coordinates with them instead of racing.
- Job state — next run, last outcome, failure count, disabled flag — is queryable and controllable through the API.
- Shutdown loses no work: in-flight jobs either finish or have their locks released for another worker.

**Non-Goals:**
- No pub/sub between processes. The API enqueues by writing a document; the worker finds it by polling. That is the whole coordination mechanism.
- No web dashboard. Agendash's compatibility with Agenda 6 is unverified, so it stays out.
- No change to any job's business logic.
- No queues. BullMQ is the next stage's subject.

## Decisions

- **The API is a producer that never calls `start()`**: both processes construct Agenda against the same collection, but only the worker registers definitions and starts processing. *Rationale*: this is what makes `POST /admin/jobs/:name/run` correct — the endpoint writes a job document and returns immediately, and the work happens in the process that owns the CoinGecko key, the mailer and the worker's lifecycle. An API that processed jobs would execute them inside a request, which is exactly the coupling the worker exists to avoid. It also means a job enqueued while no worker is running simply waits, which is the correct behavior and is asserted by E6-14.

- **202 Accepted, not 200**: the trigger endpoint returns the enqueued job's identifier and the time it was queued. *Rationale*: 200 would imply the work is done. It is not — it will happen within `processEvery` plus execution time. 202 is the status that exists for precisely this, and using it makes the asynchrony visible in the contract rather than in a comment.

- **A hand-built lease lock exists *in addition to* Agenda's own locking, because they solve different problems**: Agenda's `concurrency` and `lockLimit` bound how many jobs **of the same name** one Agenda instance processes. They do not coordinate across instances when there are multiple job *documents* with that name — which is exactly what happens when a recurring `poll-prices` and a one-off `poll-prices` created by `agenda.now()` both come due. The lease is a single `job_locks` document per resource, acquired with one atomic conditional upsert, so only one holder can exist regardless of how many documents, instances or processes are involved. *Rationale*: this gap is subtle and would produce duplicate CoinGecko calls under exactly the conditions this stage is meant to make safe. Building the lease by hand is also the pedagogical point — it is a distributed mutex in about thirty lines, with a TTL so a dead holder cannot deadlock the system forever.

- **`release` only deletes a lock the caller owns**: `deleteOne({ _id: name, lockedBy: owner })`. *Rationale*: without the `lockedBy` condition, a slow process finishing after its lease expired would delete the lock a *different* worker now legitimately holds, and the two would proceed in parallel — turning the safety mechanism into the bug it exists to prevent. This is the same reasoning as the `lockedBy` filter on post-send updates in the previous stage.

- **`send-notifications` gets no lease, and that is a deliberate asymmetry**: its atomic claim (`pending` → `sending` in one `findOneAndUpdate`) already guarantees each notification is processed once, regardless of how many copies of the job run. Adding a lease would serialize a job that is already safe to parallelize. *Rationale*: the two jobs need different protection because they have different failure modes — `poll-prices` wastes upstream quota and inserts redundant work if duplicated, while `send-notifications` is idempotent per row by construction. Documenting *why* one has a lease and the other does not is more valuable than applying the same mechanism everywhere.

- **The adapter throws only on `failed`**: `skipped` and `partial` return normally. *Rationale*: Agenda records a thrown error as a job failure with a `failCount` and `failReason`, which is the signal the retry listener keys on. A `partial` run succeeded at its main purpose, and a `skipped` run correctly declined to do anything — treating either as a failure would trigger pointless retries and make the failure count meaningless as a health signal. The `JobRun` document is always written *before* the throw, so the detailed record exists even for a run Agenda considers failed.

- **Retries are implemented in a `fail` listener, not by an Agenda option**: Agenda 6.2.6 documents no automatic retry, so the policy is explicit: a transient code (`COINGECKO_UNAVAILABLE`, `COINGECKO_RATE_LIMITED`, `ALERT_EVALUATION_FAILED`) schedules one run two minutes out with `trigger: "retry"` and an incremented `attempt`; `COINGECKO_AUTH` and `INTERNAL` schedule nothing. *Rationale*: retrying an authentication failure is guaranteed to fail again and wastes a run; retrying a transient upstream outage is likely to succeed. The rule that no retry is scheduled when the next recurring run is under three minutes away exists because a retry that lands just before the regular run is pure duplication.

- **Recurring registration is idempotent by calling `every()` on every startup**: Agenda's `every()` maintains a single document per job name and updates it when the expression changes. *Rationale*: this makes the schedule declarative — the code is the source of truth, and restarting reconciles rather than accumulating. E6-2 and E6-3 assert both halves. The corollary is that a job disabled through the API must **not** be re-enabled by `every()` on the next restart, which E6-9 asserts separately because it is the non-obvious case.

- **Obsolete recurring jobs are cancelled at startup**: any recurring document whose name is not in `JOB_NAMES` is removed. *Rationale*: without this, renaming or deleting a job leaves an orphaned document that Agenda will keep trying to run and failing to find a handler for, forever.

- **`maintenance` runs its steps independently**: a failing step logs and the next one still runs. *Rationale*: it is a housekeeping job with four unrelated responsibilities. Letting a failure in "prune old job documents" prevent "warn about failed notifications" would be an arbitrary coupling. It also moves stale-`job_runs` recovery from startup-only (stage 1) to daily, which matters now that a long-running worker may not restart for weeks.

- **`drain()` on shutdown, `stop()` only as the timeout fallback**: `drain()` waits for in-flight jobs; `stop()` abandons them and releases their locks so another worker can pick them up. *Rationale*: finishing is better than releasing, but hanging forever is worse than either. The fallback ordering means a job interrupted by a platform-enforced kill is recoverable through `lockLifetime` and the lease TTL rather than lost.

- **`node-cron` is removed rather than kept behind a `SCHEDULER=cron` switch**: this follows the source document's own stated default. The `SCHEDULER` variable is still introduced, defaulting to `agenda`, because it is the documented extension point the next stage builds on. *Rationale*: maintaining a second scheduler path means every future job change has to be implemented and tested twice, for a comparison that is better made by reading stage 1's archived specification. Recorded as an open question in case the owner wants the side-by-side comparison for learning purposes.

- **Application code never writes to `agenda_jobs`**: it is read for the admin endpoints through Agenda's own API, or with read-only queries when that is insufficient. *Rationale*: it is Agenda's internal schema, and its shape is a version detail, not a contract.

## Risks / Trade-offs

- **[Risk]** `@agendajs/mongo-backend` declares a peer dependency on the MongoDB driver, and sharing `mongoose.connection.db` requires Mongoose and Agenda to resolve to the **same** driver version. A mismatch produces confusing runtime type errors. → **Mitigation**: verify with `npm ls mongodb` before wiring the shared connection; if the versions differ, fall back to configuring Agenda with the URI and accept a second connection, documenting the decision.
- **[Risk]** Agenda 6's API names differ from the widely-published v5 examples, so a name cited in the requirements may not exist in the installed build. → **Mitigation**: requirements are written in terms of behavior; the implementation uses whatever the installed version's documentation names for that behavior and records any substitution in the README.
- **[Risk]** `processEvery` introduces scheduling latency — a job due at 21:30:00 may start up to `processEvery` later. → **Mitigation**: accepted and documented; with a ten-minute polling interval a ten-second delay is irrelevant, and lowering `processEvery` trades database load for precision.
- **[Risk]** `lockLifetime` shorter than a job's real duration would let a second worker take a job still running elsewhere. → **Mitigation**: five minutes against an expected runtime of a few seconds leaves a wide margin, and the lease independently prevents two `poll-prices` executions regardless of what Agenda's lock does.
- **[Risk]** The lease compares timestamps taken from each worker's own clock, so badly skewed clocks could let two holders believe they own it. → **Mitigation**: documented as a requirement that worker clocks be synchronized; managed platforms do this, and a local two-worker test runs on one machine.
- **[Risk]** During a rolling restart, the last worker to call `every()` defines the schedule, so there can be a window running the previous expression. → **Mitigation**: documented; the window is bounded by the deploy, and a wrong interval for one cycle has no lasting effect.
- **[Trade-off]** One-off job documents accumulate after they finish, since only recurring jobs reschedule themselves. The `maintenance` job prunes them after `AGENDA_ONE_OFF_RETENTION_DAYS`, which means unbounded growth is prevented by a job rather than by a TTL index — a deliberate choice, since Agenda owns that collection's schema and adding an index to it would be reaching into another library's storage.
- **[Trade-off]** Removing `node-cron` loses the ability to A/B the two schedulers at runtime. Accepted; stage 1's specification remains the written record of how the simpler version behaved.

## Migration Plan

1. Verify driver alignment with `npm ls mongodb` and decide between the shared connection and a separate one, recording the outcome.
2. Deploy the worker with Agenda. On first start it creates the three recurring documents in `agenda_jobs`; there is nothing to migrate, because the old schedule lived only in memory.
3. Start the API, which constructs its producer instance against the same collection.
4. Verify `GET /api/v1/admin/jobs` lists exactly three recurring jobs and that `GET /api/v1/status` reports a `nextRunAt`.
5. Remove `node-cron` from dependencies.

Rollback is reverting the worker to the previous release and deleting the `agenda_jobs` and `job_locks` collections; no business data lives in either. Because both schedulers would otherwise run the same jobs independently, the old and new workers must never be active at the same time.

## Open Questions

- Should the `SCHEDULER=cron` comparison mode be implemented so the two schedulers can be run side by side for learning, or is removing `node-cron` (the source document's stated default, adopted here) the right call? Implementing it later is additive and touches only `src/worker.ts`.
- Is Agendash compatible with Agenda 6? If it is, it would give a read-only dashboard for free; if not, the admin endpoints already cover the necessary operations. Deferred rather than guessed at.
- If the installed Agenda version turns out to provide native retry or backoff options, the hand-written `fail` listener should be reconsidered in its favour, and the decision documented. The behavioral requirements would be unchanged either way.
