## 1. Research and dependencies

- [ ] 1.1 Read BullMQ 6's changelog and migration guide before writing any code, and record every API name in this change that differs in the installed version.
- [ ] 1.2 Verify BullMQ 6's compatibility with Valkey 8 in its documentation or issue tracker, and record the finding.
- [ ] 1.3 Verify that `@bull-board/api` and `@bull-board/express` 9.x are compatible with BullMQ 6; if they are not, drop the dashboard and rely on the admin queue endpoints, documenting the decision.
- [ ] 1.4 Add `bullmq` 6.x and the Redis client its documentation recommends, applying its production guidance for worker connections; add the Bull Board packages and, optionally, `rate-limit-redis` 6.x.

## 2. Local infrastructure and configuration (redis-infrastructure, dev-tooling)

- [ ] 2.1 Add the `valkey` service to `docker-compose.yml` with `--maxmemory-policy noeviction --appendonly yes --appendfsync everysec` on port 6379.
- [ ] 2.2 Extend the config schema with `REDIS_URL` (required when `SCHEDULER=bullmq`), `WORKER_QUEUES` (default all four), `RELAY_INTERVAL_MS` (default 120000), `BULL_BOARD_ENABLED` (false in production, true in development), `BULL_BOARD_USER` / `BULL_BOARD_PASS` (required when the dashboard is enabled outside development) and `RATE_LIMIT_STORE` (default `memory`); add `bullmq` to `SCHEDULER`'s accepted values.
- [ ] 2.3 Implement the startup `PING` and eviction-policy check: `fatal` and exit 1 in production, `warn` in development, and an explicit "could not verify" log when the provider forbids the configuration read.
- [ ] 2.4 Update `.env.example` with the new variables and a comment each.
- [ ] 2.5 Add a Valkey service container to the CI workflow and set `REDIS_URL` so the queue tests run rather than skip.

## 3. Queue topology (queue-topology)

- [ ] 3.1 Define the queue and job name constants in one shared module.
- [ ] 3.2 Create the `prices`, `alerts`, `notifications` and `maintenance` queues with their per-job `attempts`, `backoff`, `removeOnComplete` and `removeOnFail` settings.
- [ ] 3.3 Implement the deterministic job id builders: `eval:<coinId>:<capturedAt epoch>`, `notif:<notificationId>` and `manual:<name>:<current minute>`.
- [ ] 3.4 Configure the worker options: concurrency 1, 5, 3 and 1 respectively, with the `notifications` limiter of `MAIL_MAX_PER_MINUTE` per 60 seconds.
- [ ] 3.5 Unit test the job id builders.
- [ ] 3.6 Document why the work is split across four queues.

## 4. Schedulers (bullmq-schedulers)

- [ ] 4.1 Implement the startup upsert of the `poll-prices`, `maintenance` and `relay-notifications` schedulers using BullMQ's job scheduler mechanism.
- [ ] 4.2 Implement removal of schedulers whose identifier is no longer configured.
- [ ] 4.3 Keep five-field cron expressions and document that the optional seconds field is unused.
- [ ] 4.4 Integration test **E8-1**: a fresh start creates exactly 3 schedulers, and 3 restarts still leave 3.

## 5. Price fan-out (price-poll-fanout, price-polling-job)

- [ ] 5.1 Remove the inline alert-evaluation step from `poll-prices` and extract the per-coin evaluation into a reusable function.
- [ ] 5.2 Enqueue one `evaluate-alerts` job per updated coin in a single bulk add, carrying `{ coinId, capturedAt, value }` with the deterministic job id.
- [ ] 5.3 Close the run as `partial` with `error.code: ENQUEUE_FAILED` when the bulk add fails, retaining the stored snapshots.
- [ ] 5.4 Throw on a `failed` price result so the queue retries, and throw `COINGECKO_AUTH` as unrecoverable.
- [ ] 5.5 Keep the lease lock around the processor; if the installed BullMQ version offers a suitable global queue concurrency control, evaluate it and document the decision.
- [ ] 5.6 Integration test **E8-2**: a run updating 4 coins enqueues 4 `evaluate-alerts` jobs with distinct ids, and re-enqueueing the same batch creates no duplicates.

## 6. Alert evaluation jobs (alert-evaluation-jobs, alert-evaluation)

- [ ] 6.1 Implement the `evaluate-alerts` processor for a single coin, reusing `decide` and the existing trigger transaction unchanged.
- [ ] 6.2 Enqueue `send-notification` with `jobId: notif:<notificationId>` strictly after the transaction commits, never inside it.
- [ ] 6.3 Leave the notification `pending` when that enqueue fails, relying on the relay.
- [ ] 6.4 Report per-evaluation counters through the job's logs rather than a per-coin `JobRun`, and document that choice.
- [ ] 6.5 Throw on infrastructure failures so the queue retries with exponential backoff.
- [ ] 6.6 Integration test **E8-3**: a triggered alert creates the notification in MongoDB and, after the commit, enqueues `send-notification` with the expected job id.

## 7. Notification dispatch and relay (notification-dispatch, send-notifications-job)

- [ ] 7.1 Implement the `send-notification` processor: claim by id with `findOneAndUpdate({ _id, status: 'pending' }, ...)`, finishing without error when it matches nothing.
- [ ] 7.2 Implement the success path with the `lockedBy`-filtered update setting `sent`, `sentAt` and `providerMessageId`.
- [ ] 7.3 Implement the permanent-failure path: mark `failed` with `lastError.permanent: true`, then throw an unrecoverable error.
- [ ] 7.4 Implement the transient-failure path: increment `attempts`, return to `pending`, then throw so the queue retries with backoff.
- [ ] 7.5 Implement the last-attempt rule: when `attemptsMade + 1 >= attempts`, mark `failed` in MongoDB **before** throwing.
- [ ] 7.6 Keep the job data limited to the notification id so no recipient address travels through the queue (**RNF-8.5**).
- [ ] 7.7 Implement `relay-notifications`: enqueue notifications `pending` for more than about two minutes with `jobId: notif:<id>`, and recover `sending` notifications past the lock timeout.
- [ ] 7.8 Implement the rule that re-enqueueing over a retained `failed` job removes it first or uses the queue's retry mechanism.
- [ ] 7.9 Delete the batch `send-notifications` job and its scheduling.
- [ ] 7.10 Document that `nextAttemptAt` is now informational and that MongoDB is the source of truth.
- [ ] 7.11 Unit tests: the last-attempt rule and the error classification into retryable versus unrecoverable.
- [ ] 7.12 Integration tests **E8-4** (a failed post-commit add leaves the notification pending and the relay enqueues it), **E8-5** (transient SMTP error retried with exponential backoff, then `failed` in both stores) and **E8-6** (550 fails with no retry and `permanent: true`).
- [ ] 7.13 Integration test **E8-7**: 100 pending notifications with `MAIL_MAX_PER_MINUTE` of 30 and two workers send at most 30 in the first minute, using a short limiter duration in the test.
- [ ] 7.14 Integration test **E8-8**: `FLUSHALL` on Redis with notifications pending, then restart the worker and wait one relay interval — all are sent and the 3 schedulers exist again.

## 8. Maintenance changes (maintenance-job)

- [ ] 8.1 Replace the Agenda one-off pruning step with per-queue `failed` counting over the last 24 hours, logging at `warn` when non-zero.
- [ ] 8.2 Add queue cleanup for jobs the retention settings did not remove.
- [ ] 8.3 Keep the stale `job_runs`, failed-notification and stale-polling steps unchanged.

## 9. Worker lifecycle (queue-worker-lifecycle, worker-process)

- [ ] 9.1 Rewrite `src/worker.ts` to create BullMQ workers for the queues named in `WORKER_QUEUES`, replacing the Agenda wiring.
- [ ] 9.2 Attach an `error` listener to every `Queue` and every `Worker`, logging at `error`.
- [ ] 9.3 Log `failed` at `warn` and `completed` at `debug`, including `queue`, `jobId`, `attemptsMade` and the error code.
- [ ] 9.4 Implement the ordered shutdown: workers (waiting up to `WORKER_SHUTDOWN_TIMEOUT_MS`), then queues, then Redis, then MongoDB.
- [ ] 9.5 Integration test **E8-12**: `SIGTERM` during a `send-notification` job lets the message send, marks the notification `sent`, and exits 0.
- [ ] 9.6 Manual verification: `kill -9` a worker during a send and observe stalled-job detection returning it to the queue; restart Valkey locally and observe recovery.

## 10. Admin endpoints and dashboard (admin-queue-api, admin-jobs-api, api-rate-limiting)

- [ ] 10.1 Implement `GET /api/v1/admin/queues` with per-state counts per queue and each scheduler's next run time.
- [ ] 10.2 Implement `POST /api/v1/admin/queues/:queue/pause` and `/resume`.
- [ ] 10.3 Implement `POST /api/v1/admin/queues/notifications/retry-failed`, which also returns the corresponding MongoDB rows to `pending`.
- [ ] 10.4 Make the queue admin endpoints respond 503 when Redis is unavailable, without affecting other endpoints.
- [ ] 10.5 Change `POST /api/v1/admin/jobs/:name/run` to `queue.add` with `jobId: manual:<name>:<current minute>`, keeping the 202 contract, and remove the enable/disable endpoints and the 30-second trigger rate limit.
- [ ] 10.6 Mount Bull Board at `/admin/queues-ui` behind HTTP Basic Auth compared in constant time, 404 when `BULL_BOARD_ENABLED` is false, and served only over HTTPS.
- [ ] 10.7 Implement the optional `RATE_LIMIT_STORE=redis` path with fail-open behavior and an `error` log when Redis is unavailable.
- [ ] 10.8 Integration tests **E8-9** (pausing `notifications` stops delivery and resuming sends the backlog), **E8-10** (dashboard without Basic Auth → 401; disabled → 404) and **E8-11** (Redis down: `GET /api/v1/coins` → 200, `GET /admin/queues` → 503).

## 11. Migration from Agenda (agenda-to-bullmq-migration)

- [ ] 11.1 Implement `npm run migrate:agenda-to-bullmq`: cancel the jobs in `agenda_jobs`, enqueue every notification still `pending`, and report the result.
- [ ] 11.2 Perform the cutover: stop the Agenda worker, start the BullMQ worker with `SCHEDULER=bullmq`, run the migration script, and verify the schedulers, a fan-out cycle and the notification drain.
- [ ] 11.3 After a stable period, drop the `agenda_jobs` collection and remove `agenda` and `@agendajs/mongo-backend` from `package.json`.
- [ ] 11.4 Document the never-both-at-once rule, the rollback path available before retirement, and the admin endpoints whose contract changed.

## 12. Testing setup and Definition of Done

- [ ] 12.1 Set up the test harness against a real Redis — `@testcontainers/redis` or the Docker Compose Valkey — skipping the suites with `describe.skipIf` when `REDIS_URL` is absent, and document why mocks are unsuitable for BullMQ.
- [ ] 12.2 Update the README: the local-only scope and why cloud deployment of the queues is out of scope, the queue topology and its rationale, MongoDB as the source of truth with Redis as transport, the at-least-once duplicate case, and the fail-open rate-limiter trade-off.
- [ ] 12.3 Record any BullMQ 6 API name that differs from the one cited in this change, and the outcomes of the Valkey and Bull Board compatibility checks.
- [ ] 12.4 Update the `.http` collection with the admin queue endpoints.
- [ ] 12.5 Verify **RNF-8.1** (schedulers and pending notifications recover within the relay interval plus one minute after a Redis wipe), **RNF-8.3** (the send rate never exceeds `MAIL_MAX_PER_MINUTE` across workers), **RNF-8.4** (Redis memory stays bounded — add the `INFO memory` query to the runbook) and **RNF-8.6** (a Redis outage does not take down the API).
- [ ] 12.6 Confirm `typecheck`, `lint` and `test` all pass locally and in CI, and that no secret appears in the repo or its history.
