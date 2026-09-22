## 1. Infrastructure migration (transactional-mongo, dev-tooling)

- [ ] 1.1 Change the `mongo` service in `docker-compose.yml` to run with `--replSet rs0 --bind_ip_all` plus a healthcheck that calls `rs.initiate()` when the set is not yet initialized.
- [ ] 1.2 Add the `mailpit` service (image `axllent/mailpit`) with SMTP on 1025 and the web interface on 8025.
- [ ] 1.3 Update the documented local `MONGODB_URI` to `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`.
- [ ] 1.4 Switch the integration test helper from `MongoMemoryServer` to `MongoMemoryReplSet` with a single node, keeping the pinned `MONGOMS_VERSION`.
- [ ] 1.5 Implement the startup check that the `hello` command reports a `setName`, exiting 1 with an explanatory message otherwise, and wire it into both `src/server.ts` and `src/worker.ts`.
- [ ] 1.6 Integration test: `withTransaction` commits against the in-memory replica set, and the startup check rejects a non-replica-set connection.

## 2. Config and dependencies

- [ ] 2.1 Add `nodemailer` 10.x to dependencies.
- [ ] 2.2 Extend `src/config/env.ts` with `SMTP_HOST` (required in the worker), `SMTP_PORT` (default 587, 1025 locally), `SMTP_USER`/`SMTP_PASS` (optional, secret), `MAIL_FROM`, `MAIL_DISPLAY_TIMEZONE` (default `America/Argentina/Buenos_Aires`), `MAIL_MAX_PER_MINUTE` (default 30), `ALERTS_MAX_ACTIVE` (default 20), `SEND_NOTIFICATIONS_CRON` (default `* * * * *`), `NOTIFY_BATCH_SIZE` (default 20), `NOTIFY_MAX_ATTEMPTS` (default 5), `NOTIFY_LOCK_TIMEOUT_MIN` (default 10) and `NOTIFICATIONS_RETENTION_DAYS` (default 90).
- [ ] 2.3 Update `.env.example` with the new variables, pointing `SMTP_HOST`/`SMTP_PORT` at Mailpit and documenting `MAIL_FROM` as a placeholder because production mail delivery is out of scope.

## 3. Alert model and decision logic (alert-store)

- [ ] 3.1 Implement the `alerts` Mongoose model with every field, enum and range from the spec, making `type` immutable after creation.
- [ ] 3.2 Add the indexes `{ coinId: 1, status: 1 }`, `{ userId: 1, createdAt: -1 }` and `{ userId: 1, status: 1 }`.
- [ ] 3.3 Implement the trigger conditions for the three alert types, including the `null` `change24hPct` case.
- [ ] 3.4 Implement the rearm conditions with `rearmPct` hysteresis for the three types.
- [ ] 3.5 Implement the cooldown rule against `cooldownMinutes` and `lastTriggeredAt`.
- [ ] 3.6 Implement `decide(alert, value, now)` as a pure function returning `TRIGGER`, `REARM`, `COOLDOWN` or `NOOP`.
- [ ] 3.7 Unit test `decide` with a full table: 3 types × trigger, rearm, cooldown, `null` value and exact-boundary (`==` threshold) cases.
- [ ] 3.8 Integration test: the active-alert cap counts only `armed` and `triggered`, so disabling one frees capacity.

## 4. Notification outbox model (notification-outbox)

- [ ] 4.1 Implement the `notifications` Mongoose model with every field, enum and default from the spec.
- [ ] 4.2 Add the five indexes plus the TTL index on `createdAt` using `NOTIFICATIONS_RETENTION_DAYS`.
- [ ] 4.3 Implement the `dedupeKey` construction as `${alertId}:${triggerCount}` with its unique index.
- [ ] 4.4 Implement `GET /api/v1/me/notifications` with the strict query schema, the masked `to`, and the suppression of `lockedBy`, `dedupeKey` and the full `lastError`.
- [ ] 4.5 Integration test: the TTL index exists with the expected `expireAfterSeconds`, and the user-facing response exposes only `lastError.code`.

## 5. Alert endpoints (alert-api)

- [ ] 5.1 Implement the type-dependent body schema with a Zod `discriminatedUnion` or `superRefine` so `threshold` ranges differ per `type`.
- [ ] 5.2 Implement `POST /api/v1/me/alerts` with the fixed validation order: body (400) → verified email (422 `EMAIL_NOT_VERIFIED`) → coin exists and active (404) → active cap (422 `LIMIT_REACHED`).
- [ ] 5.3 Return 201 with the alert plus `meta.currentValue` and `meta.conditionCurrentlyMet`, without evaluating the alert during the request.
- [ ] 5.4 Implement `GET /api/v1/me/alerts` with the paginated, coin-joined listing ordered by `createdAt` descending.
- [ ] 5.5 Implement `GET /api/v1/me/alerts/:id` returning 400 for a malformed id and 404 for a missing alert or one owned by another user.
- [ ] 5.6 Implement `PATCH /api/v1/me/alerts/:id`: reject `type`, handle `enabled` in both directions with the cap check on re-enable, rearm a `triggered` alert on threshold change without resetting counters, and `$inc` `version` on every modification.
- [ ] 5.7 Implement `DELETE /api/v1/me/alerts/:id`: delete the alert, cancel its `pending` notifications, leave `sending` ones alone, and always respond 204.
- [ ] 5.8 Unit tests: threshold range validation per type; the creation validation order with fake repositories.
- [ ] 5.9 Integration tests **E5-1** (unverified email → 422), **E5-16** (another user's alert → 404) and **E5-6** (a `once` alert completes and stops being evaluated).

## 6. Alert evaluation in the polling job (alert-evaluation, price-polling-job, job-run-tracking)

- [ ] 6.1 Add the new `stats` fields to the `job_runs` schema for both job names.
- [ ] 6.2 Implement the evaluation step as the final step of `createPollPricesJob`, taking the map of coins updated in this run.
- [ ] 6.3 Implement the cursor over alerts matching `coinId ∈ input` and `status ∈ { armed, triggered }`.
- [ ] 6.4 Implement the `TRIGGER` path inside `session.withTransaction()`: the conditional alert update filtered on `{ _id, version, status: 'armed' }` with `$inc` of `version` and `triggerCount`, the user load, and the notification insert.
- [ ] 6.5 Handle `matchedCount === 0` by aborting the transaction and incrementing `stats.triggerConflicts`.
- [ ] 6.6 Handle a missing or unverified user by aborting the transaction and logging at `warn`.
- [ ] 6.7 Treat a duplicate-key error on `dedupeKey` as idempotent success.
- [ ] 6.8 Implement the non-transactional `REARM` update, and make `COOLDOWN`/`NOOP` write nothing at all.
- [ ] 6.9 Degrade the run to `partial` with `error.code: ALERT_EVALUATION_FAILED` when the whole step fails, keeping stored prices intact.
- [ ] 6.10 Invoke `send-notifications` at the end of a run that produced at least one trigger, respecting its overlap guard, without letting a failure there reject `run()`.
- [ ] 6.11 Integration tests **E5-2** (trigger creates one pending notification with `dedupeKey` `<id>:1`), **E5-3** (still triggered, no second notification), **E5-4** (hysteresis: 50400 stays triggered, 50600 rearms) and **E5-5** (cooldown blocks at 20 minutes, allows at 61).
- [ ] 6.12 Integration test **E5-7**: change `version` between read and write and assert no trigger, no notification and `triggerConflicts` of 1.
- [ ] 6.13 Integration test **E5-8**: a notifications repository that throws on insert leaves the alert `armed` (rollback).
- [ ] 6.14 Document that `lastEvaluatedAt` reflects the last state change, not the last evaluation.

## 7. Mailer (mailer)

- [ ] 7.1 Define the `Mailer` interface and implement `SmtpMailer` with `secure: port === 465` and 10-second connection and socket timeouts.
- [ ] 7.2 Implement the error classification: `responseCode` 500-599 → `permanent: true` / `SMTP_REJECTED`; connection, timeout and 4xx → `permanent: false` / `SMTP_UNAVAILABLE`.
- [ ] 7.3 Implement `FakeMailer` recording messages in memory with configurable transient and permanent failures.
- [ ] 7.4 Call `mailer.verify()` at worker startup, logging at `error` on failure without stopping the worker.
- [ ] 7.5 Unit test the error classification by `responseCode` and by network error code, and confirm no credential appears in any logged error.

## 8. Email template (email-templates)

- [ ] 8.1 Implement `render(payload) → { subject, text, html }` as a pure function.
- [ ] 8.2 Implement the three subject variants with `Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD' })` formatting.
- [ ] 8.3 Implement the shared body content: coin, condition, threshold, triggering value, 24h change, UTC timestamp plus the `MAIL_DISPLAY_TIMEZONE` reference time, the user note, and the `PATCH` call that disables the alert.
- [ ] 8.4 Implement HTML escaping of `&`, `<`, `>`, `"` and `'` for every user- or third-party-supplied value.
- [ ] 8.5 Strip `\r` and `\n` from the subject.
- [ ] 8.6 Use inline styles only, with no external images, stylesheets or tracking pixels, and up to 8 decimals for values below 1.
- [ ] 8.7 Unit tests: subject per type, number formatting, **E5-14** (`<b>hola</b>` → `&lt;b&gt;hola&lt;/b&gt;`) and subject newline stripping.

## 9. Send notifications job (send-notifications-job, worker-process)

- [ ] 9.1 Implement `src/jobs/sendNotifications.ts` with injected `notificationsRepo`, `usersRepo`, `mailer`, `clock`, `logger` and `workerId`.
- [ ] 9.2 Implement stale-lock recovery: `sending` with `lockedAt < now − NOTIFY_LOCK_TIMEOUT_MIN` back to `pending` with `attempts + 1`, or to `failed` when that reaches `maxAttempts`, counting `stats.recoveredStale`.
- [ ] 9.3 Implement the atomic claim loop up to `NOTIFY_BATCH_SIZE`, ending when `findOneAndUpdate` returns `null`.
- [ ] 9.4 Implement the per-notification flow: cancel when the user is gone, render, send, then the success, permanent-failure and transient-failure outcomes.
- [ ] 9.5 Implement the backoff schedule `[1, 5, 15, 60]` minutes with ±10% jitter and the `maxAttempts` exhaustion path.
- [ ] 9.6 Apply the `{ _id, status: 'sending', lockedBy: workerId }` filter to every post-send update.
- [ ] 9.7 Implement sequential sending with the `MAIL_MAX_PER_MINUTE` cap truncating the batch.
- [ ] 9.8 Record the send statistics and guarantee no full recipient address appears in any log line.
- [ ] 9.9 Add the per-job overlap guard and cron scheduling for `send-notifications` in `src/worker.ts`, keeping each job's guard independent.
- [ ] 9.10 Unit test the backoff calculation and its jitter bounds.
- [ ] 9.11 Integration tests **E5-9** (sent with `providerMessageId` and the expected subject captured by `FakeMailer`), **E5-10** (transient failure → `pending`, `attempts: 1`, ~1 minute; five failures → `failed`), **E5-11** (550 → `failed` on the first attempt with `permanent: true`) and **E5-13** (a 15-minute-old `sending` lock is recovered and sent in the same run).
- [ ] 9.12 Integration test **E5-12**: two job instances with different `workerId` values run via `Promise.all` against 10 pending notifications, and `FakeMailer` receives exactly 10 messages, one per notification.

## 10. Admin notification endpoints (admin-notifications-api)

- [ ] 10.1 Implement `GET /api/v1/admin/notifications` with filters `status`, `userId`, `from`, `to` plus pagination, including the full `lastError` and `lockedBy`.
- [ ] 10.2 Implement `POST /api/v1/admin/notifications/:id/retry`: `failed` → `pending` with `attempts: 0`, `nextAttemptAt: now`, `lastError: null`; any other status → 409.
- [ ] 10.3 Implement `POST /api/v1/admin/notifications/test-email` sending immediately to the authenticated admin's email, 200 with `messageId` or 502 with the mailer's code.
- [ ] 10.4 Integration test **E5-17**: retrying a `failed` notification requeues it with `attempts: 0`; retrying a `sent` one returns 409.

## 11. Cascade deletion (account-deletion-cascade)

- [ ] 11.1 Extend `usersService.deleteAccount(userId)` with the new order: cancel pending notifications → delete alerts → delete watchlist items → delete the user, calling each module's own deletion function.
- [ ] 11.2 Delete the user's notification history except entries currently in `sending`, which are left for TTL retention.
- [ ] 11.3 Integration test **E5-15**: a user with 2 alerts and 1 pending notification calls `DELETE /me`, leaving no alerts, the notification cancelled or deleted, and nothing ever sent.

## 12. Documentation and Definition of Done

- [ ] 12.1 Update the README: the replica-set requirement and how to start it, the Mailpit workflow, the new endpoints and variables, and the explicit note that production SMTP, a custom domain and SPF/DKIM are out of scope so `MAIL_FROM` is a placeholder.
- [ ] 12.2 Document the accepted limitations: at-least-once delivery can duplicate an email if the process dies between a successful send and the `sent` write; a threshold crossed and recovered inside one polling window is never detected; `lastEvaluatedAt` means last state change.
- [ ] 12.3 Note in the README that, because the worker only runs during testing sessions, the CoinGecko monthly quota is no longer the binding constraint on polling frequency, while the batching and retry limits stay unchanged.
- [ ] 12.4 Update the `.http` collection with the alert, notification and admin notification endpoints.
- [ ] 12.5 Perform manual verification **E5-18**: with Mailpit running, create an alert that is already satisfied, run `job:poll-prices`, and confirm the message appears at `http://localhost:8025` within a minute.
- [ ] 12.6 Measure **RNF-5.1**: 1,000 active alerts across 10 coins evaluate in under 2 seconds locally when nothing triggers, and document the result.
- [ ] 12.7 Confirm `typecheck`, `lint` and `test` all pass locally and in CI, and that no secret appears in the repo or its history.
