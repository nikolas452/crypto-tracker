## 1. Dependencies and configuration

- [ ] 1.1 Read Agenda 6's official documentation and migration guide before writing code, and record any API name in this change that differs in the installed version.
- [ ] 1.2 Add `agenda` 6.x and `@agendajs/mongo-backend` 4.x to dependencies.
- [ ] 1.3 Run `npm ls mongodb` to confirm Mongoose and Agenda resolve to the same driver version; if they do not, configure Agenda with the connection URI instead of the shared handle and document the decision.
- [ ] 1.4 Extend `src/config/env.ts` with `SCHEDULER` (default `agenda`), `AGENDA_PROCESS_EVERY` (default `10 seconds`), `AGENDA_MAX_CONCURRENCY` (default 5), `AGENDA_ONE_OFF_RETENTION_DAYS` (default 7), `MAINTENANCE_CRON` (default `15 3 * * *`), `POLL_LOCK_TTL_MS` (default 300000) and `POLL_MAX_JOB_RETRIES` (default 1).
- [ ] 1.5 Update `.env.example` with the new variables and a comment each.

## 2. Lease lock (lease-lock)

- [ ] 2.1 Implement `src/lib/lease-lock.ts` with `acquire(name, owner, ttlMs)`, `renew(name, owner, ttlMs)` and `release(name, owner)` over the `job_locks` collection.
- [ ] 2.2 Implement `acquire` as the single conditional `findOneAndUpdate` with `upsert: true`, returning `false` on the duplicate-key path.
- [ ] 2.3 Implement `release` as `deleteOne({ _id: name, lockedBy: owner })` so a foreign lock is never released.
- [ ] 2.4 Integration tests against the in-memory replica set: acquire free, acquire held, acquire expired, re-acquire as owner, and release a foreign lock as a no-op.
- [ ] 2.5 Document the requirement that worker clocks be synchronized.

## 3. Agenda instance and definitions (agenda-scheduler, agenda-job-definitions)

- [ ] 3.1 Implement `JOB_NAMES` as a shared constant.
- [ ] 3.2 Implement `createAgenda({ db, role })` with the Mongo backend on `agenda_jobs`, `processEvery`, `maxConcurrency` and `defaultConcurrency: 1`.
- [ ] 3.3 Implement the `worker` role: register definitions and listeners, allow `start()`.
- [ ] 3.4 Implement the `producer` role: register nothing and never call `start()`.
- [ ] 3.5 Define the three jobs with their `concurrency`, `lockLimit`, `lockLifetime` and priority, evaluating cron expressions in UTC (explicit timezone option if supported, otherwise `TZ=UTC`).
- [ ] 3.6 Implement idempotent `every()` registration at startup that updates an existing document when the expression changes and does not re-enable a disabled job.
- [ ] 3.7 Implement cancellation of recurring documents whose name is not in `JOB_NAMES`.
- [ ] 3.8 Integration tests with a low `processEvery` (for example `200 milliseconds`) and a `waitForJob(agenda, name, event)` helper resolving on `complete:<name>` or `fail:<name>` with a timeout.
- [ ] 3.9 Integration tests **E6-1** (exactly 3 recurring jobs on a fresh database), **E6-2** (3 restarts leave 1 document per name) and **E6-3** (a changed `POLL_PRICES_CRON` updates `nextRunAt`).
- [ ] 3.10 Integration test **E6-9**: a job disabled through the API stays disabled after a worker restart and does not execute.

## 4. Adapters and lease integration (agenda-job-adapters)

- [ ] 4.1 Implement the `poll-prices` adapter: derive `trigger` from `data.trigger` defaulting to `agenda`, acquire the lease with `POLL_LOCK_TTL_MS`, release it in a `finally`.
- [ ] 4.2 Record `status: "skipped"` with `skipReason: "locked"` and finish without error when the lease cannot be acquired.
- [ ] 4.3 Throw `JobFailedError(code, message)` only for a `failed` result, after the `JobRun` has been written; return normally for `skipped` and `partial`.
- [ ] 4.4 Implement the `send-notifications` adapter, throwing only on infrastructure failure.
- [ ] 4.5 Build every adapter through a factory that receives its dependencies by closure.
- [ ] 4.6 Update `npm run job:poll-prices` to acquire the same lease, skipping with `skipReason: "locked"` when it is held.
- [ ] 4.7 Unit test that the adapter throws only for a `failed` result.
- [ ] 4.8 Integration tests **E6-4** (held lease → skipped, no CoinGecko call) and **E6-5** (expired lease → normal run).
- [ ] 4.9 Integration test **E6-6**, simplified: two Agenda instances in one test process with different `workerId` values both trigger `now()`, yielding exactly one `success`.

## 5. Maintenance job (maintenance-job)

- [ ] 5.1 Implement `src/jobs/maintenance.ts` with independent steps that log and continue past a failure, recording its own `JobRun`.
- [ ] 5.2 Implement the stale `job_runs` recovery step using `STALE_RUN_THRESHOLD_MIN`.
- [ ] 5.3 Implement pruning of non-recurring `agenda_jobs` documents finished more than `AGENDA_ONE_OFF_RETENTION_DAYS` ago, leaving recurring ones untouched.
- [ ] 5.4 Implement the `warn` report for notifications that entered `failed` in the last 24 hours.
- [ ] 5.5 Implement the `warn` report when `poll-prices` is stale by the status endpoint's rule.
- [ ] 5.6 Integration test **E6-13**: one-off jobs finished 10 days ago are removed and recurring jobs are not.

## 6. Retry policy (job-retry-policy)

- [ ] 6.1 Implement the transient-error classifier as a pure function over the error code.
- [ ] 6.2 Implement the `fail:poll-prices` listener scheduling one run two minutes out with `trigger: "retry"`, `attempt: attempt + 1` and the parent job id, bounded by `POLL_MAX_JOB_RETRIES + 1`.
- [ ] 6.3 Implement the suppression rule when fewer than 3 minutes remain before the recurring job's `nextRunAt`, reading that value from the recurring document.
- [ ] 6.4 Leave `send-notifications` and `maintenance` without retries and document why.
- [ ] 6.5 Unit tests with a fake clock: the classifier and the "next run is close" suppression rule.
- [ ] 6.6 Integration tests **E6-7** (503 on every attempt → `failCount` incremented, exactly one retry at 2 minutes with `trigger: retry` and `attempt: 2`, no third) and **E6-8** (`COINGECKO_AUTH` → no retry).

## 7. Observability (scheduler-observability)

- [ ] 7.1 Register the `start`, `success` and `fail` listeners with the specified levels and fields.
- [ ] 7.2 Keep stack traces in the log and out of Agenda's persisted `failReason`.
- [ ] 7.3 Implement the in-memory per-job counters and the 10-minute `info` summary.

## 8. Worker entrypoint (worker-process)

- [ ] 8.1 Rewrite `src/worker.ts` scheduling: create Agenda as a consumer, register definitions and listeners, register the recurring schedules, cancel obsolete ones, then `await agenda.start()`.
- [ ] 8.2 Replace the direct startup invocation with `agenda.now('poll-prices', { trigger: 'startup' })` so the lease decides whether it runs.
- [ ] 8.3 Remove the per-job in-memory `isRunning` guards and all `node-cron` scheduling.
- [ ] 8.4 Implement shutdown with `agenda.drain(WORKER_SHUTDOWN_TIMEOUT_MS)`, then on timeout a `warn` with the remaining count followed by `agenda.stop()`, then the database disconnect and exit.
- [ ] 8.5 Remove `node-cron` from `package.json`.
- [ ] 8.6 Integration test **E6-12**: `SIGTERM` during a slow fake job waits for it to finish, leaves the `JobRun` at `success`, and exits 0.
- [ ] 8.7 Verify **RNF-6.5**: worker startup completes in under 5 seconds.

## 9. Job run tracking changes (job-run-tracking)

- [ ] 9.1 Extend the `job_runs` schema: add `agenda`, `retry` and `api` to `trigger`; add `locked` to `skipReason`; add `agendaJobId` (string, nullable) and `attempt` (integer, default 1).
- [ ] 9.2 Populate `agendaJobId` and `attempt` from the adapter for every Agenda-driven run.
- [ ] 9.3 Add `maintenance` to the accepted `jobName` values.

## 10. Admin job endpoints (admin-jobs-api, system-status-api)

- [ ] 10.1 Construct the producer Agenda instance in `src/server.ts` and pass it into `createApp(deps)`.
- [ ] 10.2 Implement `GET /api/v1/admin/jobs` with the recurring job fields plus the latest `JobRun` per name, and the `includeOneOff=true` extension.
- [ ] 10.3 Implement `POST /api/v1/admin/jobs/:name/run`: validate against `JOB_NAMES` (404 otherwise), enqueue with `trigger: "api"` and the admin's `userId`, respond 202, and respond 409 when the job is disabled.
- [ ] 10.4 Implement the per-job rate limit of one trigger per 30 seconds.
- [ ] 10.5 Implement `POST /api/v1/admin/jobs/:name/disable` and `/enable`, responding 200 with the resulting state.
- [ ] 10.6 Extend `GET /api/v1/status` with `pollPrices.nextRunAt` and `pollPrices.disabled`.
- [ ] 10.7 Integration tests **E6-10** (202 then a `JobRun` with `trigger: api` within `processEvery` + 5s), **E6-11** (unknown name → 404, regular user → 403) and **E6-14** (the API creates a job but never processes it while no worker runs).

## 11. Documentation and Definition of Done

- [ ] 11.1 Update the README: Agenda replaces node-cron, the producer/consumer split, the lease lock and why `send-notifications` does not need one, `processEvery` scheduling latency, and the new admin endpoints and variables.
- [ ] 11.2 Record any Agenda 6 API name that differs from the one cited in this change, and the outcome of the `npm ls mongodb` driver check.
- [ ] 11.3 Document the rolling-restart window in which the previous cron expression may still apply.
- [ ] 11.4 Update the `.http` collection with the admin job endpoints.
- [ ] 11.5 Manual verification: run two workers with `npm run dev:worker` for 30 minutes and inspect `job_runs` for **E6-6**, confirming no two overlapping `success` runs of `poll-prices`.
- [ ] 11.6 Manual verification for **RNF-6.2**: `kill -9` a worker mid-run and confirm recovery within `lockLifetime` + `processEvery` + the lease TTL.
- [ ] 11.7 Confirm `typecheck`, `lint` and `test` all pass locally and in CI, and that no secret appears in the repo or its history.
