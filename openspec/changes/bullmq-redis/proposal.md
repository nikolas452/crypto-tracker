## Why

Agenda made the schedule durable, but every job is still a coarse unit of work: one `poll-prices` execution fetches prices, evaluates every affected alert and hands the whole batch of notifications to a once-a-minute job. A slow mail server therefore delays nothing visible, but a large alert set delays price collection, and a single failing notification is retried on the same cadence as everything else.

This stage decomposes that into queues. `poll-prices` fans out one `evaluate-alerts` job per updated coin, each alert trigger enqueues one `send-notification` job for one notification, and each queue gets its own concurrency, retry policy and rate limit. Along the way it introduces the last major job-processing concepts the project has not met: deterministic job identifiers for deduplication, queue-level rate limiting, stalled-job detection, dead-lettering, and the outbox-plus-relay pattern that lets a durable store in MongoDB recover work that a volatile queue in Redis lost.

This stage is **optional**, as the source requirement document states. Everything below is worth building for what it teaches, not because the system needs it.

## Scope adaptation: local only

The source requirement document makes this stage depend on Option A of the deploy stage — a continuously running cloud worker — because BullMQ needs consumer processes that are always active. **The deploy stage deployed no worker at all**, under the owner's constraints that the project cost $0 and that the server run only during testing. Render Key Value's free instances also do not persist to disk, so a cloud deployment of these queues would either cost money or silently lose delayed jobs.

This change is therefore scoped to **local development only**:

- In scope: Valkey running in Docker Compose (free), all four queues, the schedulers, the fan-out, per-notification dispatch, the relay, retries and backoff, dead-lettering, the admin queue endpoints, Bull Board, the migration away from Agenda, and acceptance criteria **E8-1** through **E8-12**, all of which are verifiable locally.
- Out of scope: provisioning Render Key Value, deploying the queues or their workers to any cloud environment, and the paid-versus-free persistence decision that only arises there.
- The consumer-always-running requirement is satisfied locally: during a testing session the worker runs continuously on the owner's machine, which is exactly the condition BullMQ needs.

The design keeps the deployment path open — nothing in the code assumes a local Redis — so this remains a configuration question if the constraints ever change.

## What Changes

- Add a `valkey` service to `docker-compose.yml` configured with `--maxmemory-policy noeviction --appendonly yes --appendfsync everysec`, plus a startup check that verifies the eviction policy and refuses to run in production when it is wrong.
- Add four queues with distinct characteristics: `prices` (serial, two attempts, fixed backoff), `alerts` (concurrency 5, three attempts, exponential backoff, deduplicated per coin and capture time), `notifications` (concurrency 3, one job per notification, exponential backoff, a queue-wide per-minute rate limit) and `maintenance` (serial, no retries).
- Add BullMQ job schedulers for `poll-prices`, `maintenance` and the new `relay-notifications`, upserted idempotently at startup with obsolete ones removed.
- Change `poll-prices` to stop evaluating alerts inline and instead enqueue one `evaluate-alerts` job per updated coin in bulk, with a deterministic job id, degrading to `partial` with `error.code: ENQUEUE_FAILED` when Redis is unreachable.
- Add `evaluate-alerts`, running the existing evaluation logic and the same transaction for a single coin, and enqueueing `send-notification` **after** the commit, never inside the transaction.
- Replace the batch `send-notifications` job with a per-notification `send-notification` job that claims by id in MongoDB, sends, and maps outcomes onto BullMQ's retry machinery, plus a `relay-notifications` job that re-enqueues anything MongoDB says is still pending.
- Add the admin queue endpoints (`GET /admin/queues`, pause, resume, retry-failed) and Bull Board at `/admin/queues-ui` behind HTTP Basic Auth, disabled by default outside development.
- Add an optional Redis-backed rate-limit store that fails open when Redis is unavailable.
- Add `npm run migrate:agenda-to-bullmq` and retire Agenda once the new path is stable.
- **BREAKING** The batch `send-notifications` job is removed, and the admin job enable/disable contract becomes queue pause/resume.
- Add the stage's new environment variables: `REDIS_URL`, `WORKER_QUEUES`, `RELAY_INTERVAL_MS`, `BULL_BOARD_ENABLED`, `BULL_BOARD_USER`, `BULL_BOARD_PASS` and `RATE_LIMIT_STORE`; `SCHEDULER` gains the value `bullmq`.
- No BullMQ Flows, no OpenTelemetry instrumentation and no Redis Cluster or Sentinel — out of scope here, as the source requirement document states.

## Capabilities

### New Capabilities

- `redis-infrastructure`: the local Valkey service and its required configuration, `REDIS_URL`, and the startup `PING` plus eviction-policy check with its production-fatal, development-warning and cannot-verify behaviors.
- `queue-topology`: the four queues, their job options (attempts, backoff, retention, deterministic ids) and worker options (concurrency, limiter), the centralized name constants, and the reasoning that separate queues stop one workload starving another.
- `bullmq-schedulers`: idempotent upsert of the `poll-prices`, `maintenance` and `relay-notifications` schedulers, removal of schedulers no longer configured, and the five-field cron format note.
- `price-poll-fanout`: `poll-prices` enqueueing one `evaluate-alerts` job per updated coin in bulk with a deterministic id, the `ENQUEUE_FAILED` degradation, the unrecoverable-error rule for authentication failures, and retention of the lease lock for cross-worker exclusion.
- `alert-evaluation-jobs`: per-coin evaluation reusing the existing `decide` function and transaction, the strictly post-commit enqueue of `send-notification`, the fallback to the relay when that enqueue fails, and the decision to report per-coin statistics through logs rather than a `JobRun` per coin.
- `notification-dispatch`: the `send-notification` job — claim by id, send, the success, permanent-failure, transient-failure and last-attempt paths — together with `relay-notifications` and the rule that MongoDB, not Redis, is the source of truth.
- `queue-worker-lifecycle`: one worker process creating the configured workers, mandatory `error` listeners on every queue and worker, event logging, the ordered shutdown across workers, queues, Redis and MongoDB, and the `WORKER_QUEUES` selector.
- `admin-queue-api`: `GET /api/v1/admin/queues` with per-state counts and scheduler state, pause and resume, failed-job retry that also resets MongoDB state, the 503 behavior when Redis is down, and Bull Board behind Basic Auth and disabled by default in production.
- `agenda-to-bullmq-migration`: the never-both-at-once rule, `npm run migrate:agenda-to-bullmq`, and the staged retirement of the `agenda_jobs` collection and the Agenda dependencies.

### Modified Capabilities

- `price-polling-job`: the run no longer evaluates alerts inline; it enqueues one `evaluate-alerts` job per updated coin and degrades to `partial` with `error.code: ENQUEUE_FAILED` when enqueueing fails.
- `alert-evaluation`: evaluation now runs per coin inside its own job rather than as a step of the polling run, and the notification is enqueued after the transaction commits.
- `send-notifications-job`: **removed** — replaced by the per-notification `send-notification` job and the relay.
- `worker-process`: the worker now creates BullMQ workers for the configured queues instead of starting Agenda, and its shutdown closes workers, queues, Redis and MongoDB in that order.
- `job-retry-policy`: retries are now BullMQ's per-queue `attempts` and `backoff` rather than an Agenda failure listener, with authentication failures thrown as unrecoverable so they are not retried.
- `maintenance-job`: the Agenda one-off pruning step is replaced by per-queue failed-job counting and queue cleanup.
- `admin-jobs-api`: `POST /admin/jobs/:name/run` keeps its 202 contract but now enqueues with a per-minute deterministic id, and the enable/disable endpoints are superseded by queue pause and resume, with the contract change documented.
- `api-rate-limiting`: an optional Redis-backed store selected by `RATE_LIMIT_STORE`, which fails open and logs at `error` when Redis is unavailable.
- `agenda-scheduler`, `agenda-job-definitions`, `agenda-job-adapters`: **removed** once the migration is complete and the Agenda dependencies are dropped.
- `dev-tooling`: `docker-compose.yml` gains the `valkey` service and `package.json` gains the migration script.

## Impact

- Adds `src/queues/` (connection, queue and worker definitions, processors, the shared name constants) and `src/jobs/relayNotifications.ts`.
- Rewrites `src/worker.ts` around BullMQ workers and removes the Agenda wiring.
- Changes `src/jobs/pollPrices.ts` to enqueue instead of evaluating inline, and extracts the per-coin evaluation into a reusable function.
- Replaces `src/jobs/sendNotifications.ts` with a single-notification processor.
- Adds the admin queue router and mounts Bull Board.
- Adds `src/scripts/migrateAgendaToBullmq.ts`.
- Adds `bullmq` 6.x, its Redis client, `@bull-board/api` and `@bull-board/express`, and optionally `rate-limit-redis`; removes `agenda` and `@agendajs/mongo-backend` after the stable period.
- Requires a real Redis or Valkey instance for tests, since BullMQ's Lua scripts make mocks unreliable; suites skip when `REDIS_URL` is absent.
- Extends `.env.example`, the config schema, the README and the `.http` collection.
- `notifications.nextAttemptAt` stops controlling retry timing and becomes informational; no data migration is required for that.
