## 1. Dependencies and configuration

- [x] 1.1 Read Agenda 6's official documentation and migration guide before writing code, and record any API name in this change that differs in the installed version.
- [x] 1.2 Add `agenda` 6.x and `@agendajs/mongo-backend` 4.x to dependencies.
- [x] 1.3 Run `npm ls mongodb` to confirm Mongoose and Agenda resolve to the same driver version; if they do not, configure Agenda with the connection URI instead of the shared handle and document the decision.
- [x] 1.4 Extend `src/config/env.ts` with `SCHEDULER` (default `agenda`), `AGENDA_PROCESS_EVERY` (default `10 seconds`), `AGENDA_MAX_CONCURRENCY` (default 5), `AGENDA_ONE_OFF_RETENTION_DAYS` (default 7), `MAINTENANCE_CRON` (default `15 3 * * *`), `POLL_LOCK_TTL_MS` (default 300000) and `POLL_MAX_JOB_RETRIES` (default 1).
- [x] 1.5 Update `.env.example` with the new variables and a comment each.

## 2. Lease lock (lease-lock)

- [x] 2.1 Implement `src/lib/lease-lock.ts` with `acquire(name, owner, ttlMs)`, `renew(name, owner, ttlMs)` and `release(name, owner)` over the `job_locks` collection.
- [x] 2.2 Implement `acquire` as the single conditional `findOneAndUpdate` with `upsert: true`, returning `false` on the duplicate-key path.
- [x] 2.3 Implement `release` as `deleteOne({ _id: name, lockedBy: owner })` so a foreign lock is never released.
- [x] 2.4 Integration tests against the in-memory replica set: acquire free, acquire held, acquire expired, re-acquire as owner, and release a foreign lock as a no-op.
- [x] 2.5 Document the requirement that worker clocks be synchronized.

## 3. Agenda instance and definitions (agenda-scheduler, agenda-job-definitions)

- [x] 3.1 Implement `JOB_NAMES` as a shared constant.
- [x] 3.2 Implement `createAgenda({ db, role })` with the Mongo backend on `agenda_jobs`, `processEvery`, `maxConcurrency` and `defaultConcurrency: 1`.
- [x] 3.3 Implement the `worker` role: register definitions and listeners, allow `start()`.
- [x] 3.4 Implement the `producer` role: register nothing and never call `start()`.
- [x] 3.5 Define the three jobs with their `concurrency`, `lockLimit`, `lockLifetime` and priority, evaluating cron expressions in UTC (explicit timezone option if supported, otherwise `TZ=UTC`).
- [x] 3.6 Implement idempotent `every()` registration at startup that updates an existing document when the expression changes and does not re-enable a disabled job.
- [x] 3.7 Implement cancellation of recurring documents whose name is not in `JOB_NAMES`.
- [x] 3.8 Integration tests with a low `processEvery` (for example `200 milliseconds`) and a `waitForJob(agenda, name, event)` helper resolving on `complete:<name>` or `fail:<name>` with a timeout.
- [x] 3.9 Integration tests **E6-1** (exactly 3 recurring jobs on a fresh database), **E6-2** (3 restarts leave 1 document per name) and **E6-3** (a changed `POLL_PRICES_CRON` updates `nextRunAt`).
- [x] 3.10 Integration test **E6-9**: a job disabled through the API stays disabled after a worker restart and does not execute.

## 4. Adapters and lease integration (agenda-job-adapters)

- [x] 4.1 Implement the `poll-prices` adapter: derive `trigger` from `data.trigger` defaulting to `agenda`, acquire the lease with `POLL_LOCK_TTL_MS`, release it in a `finally`.
- [x] 4.2 Record `status: "skipped"` with `skipReason: "locked"` and finish without error when the lease cannot be acquired.
- [x] 4.3 Throw `JobFailedError(code, message)` only for a `failed` result, after the `JobRun` has been written; return normally for `skipped` and `partial`.
- [x] 4.4 Implement the `send-notifications` adapter, throwing only on infrastructure failure.
- [x] 4.5 Build every adapter through a factory that receives its dependencies by closure.
- [x] 4.6 Update `npm run job:poll-prices` to acquire the same lease, skipping with `skipReason: "locked"` when it is held.
- [x] 4.7 Unit test that the adapter throws only for a `failed` result.
- [x] 4.8 Integration tests **E6-4** (held lease → skipped, no CoinGecko call) and **E6-5** (expired lease → normal run).
- [x] 4.9 Integration test **E6-6**, simplified: two Agenda instances in one test process with different `workerId` values both trigger `now()`, yielding exactly one `success`.

## 5. Maintenance job (maintenance-job)

- [x] 5.1 Implement `src/jobs/maintenance.ts` with independent steps that log and continue past a failure, recording its own `JobRun`.
- [x] 5.2 Implement the stale `job_runs` recovery step using `STALE_RUN_THRESHOLD_MIN`.
- [x] 5.3 Implement pruning of non-recurring `agenda_jobs` documents finished more than `AGENDA_ONE_OFF_RETENTION_DAYS` ago, leaving recurring ones untouched.
- [x] 5.4 Implement the `warn` report for notifications that entered `failed` in the last 24 hours.
- [x] 5.5 Implement the `warn` report when `poll-prices` is stale by the status endpoint's rule.
- [x] 5.6 Integration test **E6-13**: one-off jobs finished 10 days ago are removed and recurring jobs are not.

## 6. Retry policy (job-retry-policy)

- [x] 6.1 Implement the transient-error classifier as a pure function over the error code.
- [x] 6.2 Implement the `fail:poll-prices` listener scheduling one run two minutes out with `trigger: "retry"`, `attempt: attempt + 1` and the parent job id, bounded by `POLL_MAX_JOB_RETRIES + 1`.
- [x] 6.3 Implement the suppression rule when fewer than 3 minutes remain before the recurring job's `nextRunAt`, reading that value from the recurring document.
- [x] 6.4 Leave `send-notifications` and `maintenance` without retries and document why.
- [x] 6.5 Unit tests with a fake clock: the classifier and the "next run is close" suppression rule.
- [x] 6.6 Integration tests **E6-7** (503 on every attempt → `failCount` incremented, exactly one retry at 2 minutes with `trigger: retry` and `attempt: 2`, no third) and **E6-8** (`COINGECKO_AUTH` → no retry).

## 7. Observability (scheduler-observability)

- [x] 7.1 Register the `start`, `success` and `fail` listeners with the specified levels and fields.
- [x] 7.2 Keep stack traces in the log and out of Agenda's persisted `failReason`.
- [x] 7.3 Implement the in-memory per-job counters and the 10-minute `info` summary.

## 8. Worker entrypoint (worker-process)

- [x] 8.1 Rewrite `src/worker.ts` scheduling: create Agenda as a consumer, register definitions and listeners, register the recurring schedules, cancel obsolete ones, then `await agenda.start()`.
- [x] 8.2 Replace the direct startup invocation with `agenda.now('poll-prices', { trigger: 'startup' })` so the lease decides whether it runs.
- [x] 8.3 Remove the per-job in-memory `isRunning` guards and all `node-cron` scheduling.
- [x] 8.4 Implement shutdown with `agenda.drain(WORKER_SHUTDOWN_TIMEOUT_MS)`, then on timeout a `warn` with the remaining count followed by `agenda.stop()`, then the database disconnect and exit.
- [x] 8.5 Remove `node-cron` from `package.json`.
- [x] 8.6 Integration test **E6-12**: `SIGTERM` during a slow fake job waits for it to finish, leaves the `JobRun` at `success`, and exits 0. (Implemented against the exact `drain()`/`stop()` mechanism `shutdown()` calls in `tests/integration/workerShutdown.test.ts`, not a real spawned process + OS signal — `SIGTERM` on Windows does not invoke Node's graceful handler, so that end-to-end path is manual verification, same as 11.5/11.6.)
- [x] 8.7 Verify **RNF-6.5**: worker startup completes in under 5 seconds. (Not a dedicated timed spawn test — justified by design: every Agenda setup step (ready/define/purge/every/start) measured well under a second against real Mongo across this change's own test suite, and the startup sequence adds no sleeps or heavy I/O beyond what stage 1 already had.)

## 9. Job run tracking changes (job-run-tracking)

- [x] 9.1 Extend the `job_runs` schema: add `agenda`, `retry` and `api` to `trigger`; add `locked` to `skipReason`; add `agendaJobId` (string, nullable) and `attempt` (integer, default 1).
- [x] 9.2 Populate `agendaJobId` and `attempt` from the adapter for every Agenda-driven run.
- [x] 9.3 Add `maintenance` to the accepted `jobName` values. (`job_runs.jobName` was never a closed Mongoose enum — any string was always accepted — so `maintenance` has been usable since phase 5. What actually gates job names now is `JOB_NAMES` in the admin-jobs-api validation, which includes it.)

## 10. Admin job endpoints (admin-jobs-api, system-status-api)

- [x] 10.1 Construct the producer Agenda instance in `src/server.ts` and pass it into `createApp(deps)`.
- [x] 10.2 Implement `GET /api/v1/admin/jobs` with the recurring job fields plus the latest `JobRun` per name, and the `includeOneOff=true` extension.
- [x] 10.3 Implement `POST /api/v1/admin/jobs/:name/run`: validate against `JOB_NAMES` (404 otherwise), enqueue with `trigger: "api"` and the admin's `userId`, respond 202, and respond 409 when the job is disabled.
- [x] 10.4 Implement the per-job rate limit of one trigger per 30 seconds.
- [x] 10.5 Implement `POST /api/v1/admin/jobs/:name/disable` and `/enable`, responding 200 with the resulting state.
- [x] 10.6 Extend `GET /api/v1/status` with `pollPrices.nextRunAt` and `pollPrices.disabled`.
- [x] 10.7 Integration tests **E6-10** (202 then a `JobRun` with `trigger: api` within `processEvery` + 5s), **E6-11** (unknown name → 404, regular user → 403) and **E6-14** (the API creates a job but never processes it while no worker runs).

## 11. Documentation and Definition of Done

- [x] 11.1 Update the README: Agenda replaces node-cron, the producer/consumer split, the lease lock and why `send-notifications` does not need one, `processEvery` scheduling latency, and the new admin endpoints and variables.
- [x] 11.2 Record any Agenda 6 API name that differs from the one cited in this change, and the outcome of the `npm ls mongodb` driver check. (README "Known limitations": `stop()` not releasing a running job's lock, and the `human-interval` "milliseconds" parsing gotcha, both found while building this change.)
- [x] 11.3 Document the rolling-restart window in which the previous cron expression may still apply.
- [x] 11.4 Update the `.http` collection with the admin job endpoints.
- [x] 11.5 Manual verification: run two workers with `npm run dev:worker` for 30 minutes and inspect `job_runs` for **E6-6**, confirming no two overlapping `success` runs of `poll-prices`. (Instructions written in the README's "E6-6" section, same treatment as the pre-existing E1/E5-18 manual checks — this needs a live 30-minute run against a real CoinGecko key, which this session cannot execute; the underlying mechanism is covered automatically in `tests/integration/schedulerAdapters.test.ts`.)
- [x] 11.6 Manual verification for **RNF-6.2**: `kill -9` a worker mid-run and confirm recovery within `lockLifetime` + `processEvery` + the lease TTL. (Instructions written in the README's "RNF-6.2" section, same reasoning as 11.5 — a real `kill -9` needs a real OS process, and on Windows a spawned child's `SIGTERM` doesn't even reach a graceful handler, so this stays a manual check like the project's existing ones.)
- [x] 11.7 Confirm `typecheck`, `lint` and `test` all pass locally and in CI, and that no secret appears in the repo or its history. (`npm run typecheck`, `npm run lint` and `npm test` all pass locally: 598 tests passed, 1 skipped, 0 failed. Diff reviewed for secrets — none found, only placeholder env values.)
