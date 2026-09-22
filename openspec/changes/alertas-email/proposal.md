## Why

Everything the project has built so far is passive: the worker collects prices and the API answers questions. This stage makes the system act on its own. A user defines a condition ("tell me if BTC drops below 50,000"), the worker evaluates it after every price update, and an email goes out — exactly once per trigger, never again on the next run, and never lost if the send fails.

This is the stage the whole project exists to teach. It is where the outbox pattern, MongoDB transactions, optimistic concurrency control, atomic work claiming, retry with backoff and at-least-once delivery all appear at once, in the smallest system that genuinely needs them.

## What Changes

- Add the `alerts` collection with an explicit state machine (`armed` → `triggered` → `armed`, plus `completed` and `disabled`), hysteresis-based rearming, per-alert cooldown, and an optimistic-concurrency `version` counter.
- Add a pure `decide(alert, value, now)` function returning `TRIGGER`, `REARM`, `COOLDOWN` or `NOOP`, so every state transition is a unit test over a table rather than an integration run.
- Add the `notifications` outbox collection with a unique `dedupeKey` of `${alertId}:${triggerCount}`, a frozen `payload` and `to` snapshot of the moment of the trigger, attempt tracking, lock fields and TTL retention.
- Add the authenticated alert endpoints (`GET`, `POST`, `GET /:id`, `PATCH /:id`, `DELETE /:id` under `/api/v1/me/alerts`) and the notification history endpoint `GET /api/v1/me/notifications`.
- Add alert evaluation as a final step of the `poll-prices` job: a cursor over the affected alerts, a pure decision per alert, and — for a trigger — a transaction that flips the alert and inserts its notification together, guarded by the alert's `version` so a concurrent edit cannot be overwritten.
- Add the `send-notifications` job: stale-lock recovery, an atomic claim loop (`pending` → `sending` in one `findOneAndUpdate`), sequential sending under a per-minute cap, and retry with backoff on transient failures versus immediate failure on permanent ones.
- Add a `Mailer` abstraction over Nodemailer/SMTP with a fixed transient-versus-permanent error classification, plus a `FakeMailer` for tests.
- Add a pure email template renderer producing subject, text and HTML, with HTML escaping of all user- and third-party-supplied values and newline stripping in the subject to prevent header injection.
- Add the admin notification endpoints: listing with full error detail, retry of a `failed` notification, and an immediate test email that bypasses the outbox.
- **BREAKING** Require MongoDB to run as a replica set, locally and in tests, because transactions demand one. Both the API and the worker verify this at startup and exit 1 with a clear message if it is not satisfied.
- Extend the `DELETE /api/v1/me` cascade to cancel pending notifications and delete alerts before the watchlist and the user.
- Add the stage's new environment variables (`SMTP_*`, `MAIL_FROM`, `MAIL_DISPLAY_TIMEZONE`, `MAIL_MAX_PER_MINUTE`, `ALERTS_MAX_ACTIVE`, `SEND_NOTIFICATIONS_CRON`, `NOTIFY_BATCH_SIZE`, `NOTIFY_MAX_ATTEMPTS`, `NOTIFY_LOCK_TIMEOUT_MIN`, `NOTIFICATIONS_RETENTION_DAYS`) and a `mailpit` service to `docker-compose.yml`.
- No other notification channels, no one-click unsubscribe link and no digest grouping — out of scope here, as the source requirement document states.

### Scope adaptation: local mail only

The source requirement document assumes a production SMTP provider and an owned domain with SPF and DKIM records. **This project must cost nothing and its server is only started to test, never run continuously**, so that assumption does not hold here. This change is therefore scoped to **Mailpit running locally in Docker** as the only mail destination:

- In scope, unchanged: the alert state machine, the outbox pattern, transactions, optimistic locking, dedupe keys, atomic claiming, retry and backoff, at-least-once semantics, the replica-set migration, and every acceptance criterion from **E5-1** to **E5-18** (E5-18 is verified against Mailpit's local web interface, which is exactly what the source document already specifies for it).
- Out of scope: choosing a production SMTP provider, registering a domain, configuring SPF/DKIM, and delivery to a real external inbox. `MAIL_FROM` remains a documented placeholder value.
- The SMTP-facing code is provider-agnostic by construction — Mailpit speaks plain SMTP — so adopting a provider later is a configuration change, not a redesign.

Relatedly, because the worker only runs during testing sessions rather than continuously, CoinGecko's 10,000-call monthly quota stops being a binding constraint for this project. Quota-driven guidance is therefore treated as relaxed rather than removed: the batching, retry caps and interval defaults stay exactly as specified, but they are no longer the limiting factor on polling frequency during development.

## Capabilities

### New Capabilities
- `transactional-mongo`: the replica-set requirement — the local `docker-compose` topology, `MongoMemoryReplSet` in tests, the startup verification that the connection supports transactions, and the fail-fast exit when it does not.
- `alert-store`: the `alerts` collection, its indexes, the `ALERTS_MAX_ACTIVE` cap, the state machine and its permitted transitions, the trigger and rearm conditions per alert type, the cooldown rule, and the pure `decide(alert, value, now)` contract.
- `alert-api`: the five `/api/v1/me/alerts` endpoints — the type-dependent threshold validation, the fixed validation order (400, 422 `EMAIL_NOT_VERIFIED`, 404, 422 `LIMIT_REACHED`), the `meta.conditionCurrentlyMet` hint, the immutability of `type`, the `version` increment on every modification, the 404-not-403 rule for another user's alert, and the cancellation of pending notifications on delete.
- `notification-outbox`: the `notifications` collection — statuses, the unique `dedupeKey`, the frozen `payload`/`to` snapshot and why it is frozen, attempt and lock fields, the five indexes, TTL retention, and `GET /api/v1/me/notifications` with its masked recipient and suppressed internals.
- `alert-evaluation`: the evaluation step inside `poll-prices` — the cursor over affected alerts, the transactional trigger with its `version` guard and `dedupeKey` idempotence, the non-transactional rearm, the deliberate absence of writes for cooldown and no-op, the new `JobRun` stats, and the `ALERT_EVALUATION_FAILED` degradation.
- `mailer`: the `Mailer` interface, `SmtpMailer` over Nodemailer with connection and socket timeouts, the transient-versus-permanent error classification, `FakeMailer`, and the non-fatal startup `verify()`.
- `email-templates`: the pure `render(payload)` function — subject per alert type, currency and date formatting, HTML escaping of user- and third-party-supplied values, subject newline stripping, and the no-external-assets rule.
- `send-notifications-job`: stale-lock recovery, the atomic claim loop, per-notification send handling, the permanent-versus-transient outcome paths, the backoff schedule with jitter, the owner-scoped update filter, the per-minute send cap, and the job's stats.
- `admin-notifications-api`: `GET /api/v1/admin/notifications` with full `lastError` and `lockedBy`, `POST /api/v1/admin/notifications/:id/retry` (409 unless `failed`), and `POST /api/v1/admin/notifications/test-email` sending immediately outside the outbox.

### Modified Capabilities
- `price-polling-job`: the run gains a final alert-evaluation step over the coins updated in this run, degrades to `partial` with `error.code: ALERT_EVALUATION_FAILED` when that step fails without affecting stored prices, and triggers `send-notifications` immediately when at least one alert fired.
- `job-run-tracking`: `jobName` now also takes `send-notifications`, and `stats` gains the alert-evaluation counters (`alertsEvaluated`, `alertsTriggered`, `alertsRearmed`, `alertsInCooldown`, `triggerConflicts`) and the send counters (`claimed`, `sent`, `retried`, `failedPermanent`, `failedExhausted`, `cancelled`, `recoveredStale`).
- `worker-process`: startup now also verifies replica-set support and calls `mailer.verify()` without aborting on failure, and the worker schedules `send-notifications` alongside `poll-prices`, each with its own overlap guard and its own `JobRun`.
- `account-deletion-cascade`: the cascade now cancels the user's pending notifications and deletes their alerts before the watchlist and the user document.
- `dev-tooling`: `docker-compose.yml` now runs MongoDB as a single-node replica set and adds a `mailpit` service exposing SMTP on 1025 and its web interface on 8025.

## Impact

- Adds `src/modules/alerts/` and `src/modules/notifications/` (models, schemas, services, controllers, routes) plus `src/modules/notifications/templates/alert-triggered.ts`.
- Adds `src/integrations/mailer/` with the `Mailer` interface, `SmtpMailer` and `FakeMailer`.
- Adds `src/jobs/sendNotifications.ts` and extends `src/jobs/pollPrices.ts` with the evaluation step.
- Extends `src/modules/users/` `deleteAccount` with two more module calls.
- Changes `docker-compose.yml` (replica set plus Mailpit) and the test helpers to `MongoMemoryReplSet`, which affects every existing integration test's setup.
- Extends `.env.example`, the config schema, the README and the `.http` collection.
- Adds `nodemailer` 10.x as a dependency.
- The replica-set requirement is breaking for any existing local or test environment running a standalone `mongod`; a fresh `docker compose up` after the compose change resolves it.
