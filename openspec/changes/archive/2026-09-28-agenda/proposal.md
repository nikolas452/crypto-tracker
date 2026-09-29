## Why

The scheduler is the last part of this system that lives only in one process's memory. `node-cron` knows when the next run is due, and an `isRunning` boolean knows whether a run is in progress — both vanish when the worker restarts, neither is visible to the API, and neither coordinates with a second worker or with a manual `job:poll-prices` invocation. Three limitations were explicitly deferred to this stage: a manual run can collide with the worker's, two workers would each keep their own private schedule, and there is no way to trigger or pause a job from outside the worker process.

Moving the schedule into MongoDB with Agenda fixes all three and turns "what is the job doing" into a query rather than a log search.

## What Changes

- Add Agenda 6 (`agenda` + `@agendajs/mongo-backend`) reusing the existing Mongoose connection, with jobs persisted in an `agenda_jobs` collection.
- Add `createAgenda({ db, role })` with two roles: the worker is a **consumer** that registers definitions and calls `start()`, and the API is a **producer** that can enqueue jobs but never processes them.
- Migrate `poll-prices` and `send-notifications` from `node-cron` to Agenda definitions with explicit `concurrency`, `lockLimit`, `lockLifetime` and priority, registered idempotently so restarting the worker never duplicates a recurring job.
- Add a hand-built lease lock (`job_locks`) with `acquire`/`renew`/`release`, used by `poll-prices` and by the manual script, which closes the gap Agenda's per-instance `concurrency` leaves open between a recurring document and a one-off one.
- Add a new `maintenance` job that recovers stale `job_runs`, prunes finished one-off Agenda documents, and warns about failed notifications and a stale polling job.
- Add an explicit retry policy in the `fail:poll-prices` listener: transient error codes get one delayed retry, non-transient ones get none, and no retry is scheduled when the next recurring run is already close.
- Add admin job endpoints: list recurring jobs with their schedule and last outcome, trigger a job now (202 Accepted), and disable or enable a job.
- Extend `GET /api/v1/status` with the polling job's `nextRunAt` and `disabled` flag.
- Replace the per-job in-memory overlap guards with Agenda's locking plus the lease, and replace worker shutdown with `agenda.drain()` followed by `agenda.stop()` on timeout.
- Extend `job_runs` with `agendaJobId` and `attempt`, add `agenda`/`retry`/`api` to `trigger`, and add `locked` to `skipReason`.
- Add the stage's new environment variables: `SCHEDULER`, `AGENDA_PROCESS_EVERY`, `AGENDA_MAX_CONCURRENCY`, `AGENDA_ONE_OFF_RETENTION_DAYS`, `MAINTENANCE_CRON`, `POLL_LOCK_TTL_MS` and `POLL_MAX_JOB_RETRIES`.
- **BREAKING** `node-cron` is removed and `trigger: "schedule"` is no longer produced for new runs; existing `job_runs` documents keep their historical values.
- No cross-process pub/sub, no web dashboard (Agendash is deferred pending Agenda 6 compatibility) and no BullMQ — out of scope here, as the source requirement document states.

## Capabilities

### New Capabilities

- `agenda-scheduler`: `createAgenda({ db, role })` — the shared-connection backend, `processEvery`, `maxConcurrency`, `defaultConcurrency`, and the producer/consumer split that guarantees the API never processes a job.
- `agenda-job-definitions`: the three job definitions with their concurrency, lock and priority settings, UTC evaluation of cron expressions, idempotent `every()` registration, and removal of recurring documents whose names are no longer defined.
- `lease-lock`: `src/lib/lease-lock.ts` — `acquire`/`renew`/`release` over a `job_locks` document per resource, the atomic conditional upsert, the refusal to release another owner's lock, and the reason `send-notifications` deliberately does not need it.
- `agenda-job-adapters`: the thin handlers translating between Agenda and `src/jobs/*` — trigger derivation from `job.attrs.data`, the rule that only a `failed` result throws so Agenda records the failure, and the rule that `skipped` and `partial` do not.
- `maintenance-job`: the new daily job — independent steps that continue past a failing one, stale `job_runs` recovery, one-off Agenda document pruning, and `warn` reporting of failed notifications and a stale polling job.
- `job-retry-policy`: the transient-error list, the single delayed retry with `trigger: "retry"` and an incremented `attempt`, the suppression of a retry when the next recurring run is imminent, and the jobs that are deliberately not retried.
- `scheduler-observability`: Agenda event logging at the right levels, stacks kept out of `failReason`, and the periodic in-memory counter summary.
- `admin-jobs-api`: `GET /api/v1/admin/jobs`, `POST /api/v1/admin/jobs/:name/run` returning 202, `POST /api/v1/admin/jobs/:name/disable` and `/enable`, with the per-job trigger rate limit.

### Modified Capabilities

- `worker-process`: the entrypoint now creates Agenda as a consumer, registers definitions, cleans obsolete recurring jobs, calls `agenda.start()`, optionally enqueues a startup run through the lease, and shuts down with `agenda.drain(timeout)` falling back to `agenda.stop()`; the in-memory `isRunning` guards and the `node-cron` scheduling are removed.
- `job-run-tracking`: `trigger` gains `agenda`, `retry` and `api`; `skipReason` gains `locked`; and the document gains `agendaJobId` (string or null) and `attempt` (integer, default 1).
- `manual-job-run`: the manual script now acquires the same lease as the worker, so it skips instead of colliding — resolving the overlap limitation documented in stage 1.
- `system-status-api`: the `pollPrices` summary gains `nextRunAt` and `disabled`.
- `send-notifications-job`: scheduling moves from `node-cron` to an Agenda recurring definition and the in-memory overlap guard is removed; the job needs no lease because its atomic claim already prevents duplicate sends.

## Impact

- Adds `src/scheduler/` (`agenda.ts`, the job definitions, the adapters and the event listeners) and `src/lib/lease-lock.ts`.
- Adds `src/jobs/maintenance.ts`.
- Rewrites `src/worker.ts`'s scheduling and shutdown sections.
- Extends `src/modules/job-runs/` with the new fields, and `src/modules/coins/`-adjacent status service with `nextRunAt`/`disabled`.
- Adds the admin jobs router under `/api/v1/admin/jobs`, backed by the API's producer Agenda instance.
- Adds the `agenda_jobs` collection (managed by Agenda, never written directly by application code) and the `job_locks` collection.
- Adds `agenda` 6.x and `@agendajs/mongo-backend` 4.x, and removes `node-cron`.
- Extends `.env.example`, the config schema, the README and the `.http` collection.
- No change to the business logic in `src/jobs/pollPrices.ts` or `src/jobs/sendNotifications.ts`, which remain scheduler-agnostic — only how they are invoked changes.
