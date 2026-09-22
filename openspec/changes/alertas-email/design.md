## Context

The previous four stages built a system that never initiates anything: prices go in, queries come out. This stage closes the loop by making the worker act on what it collected. That single change introduces every hard problem in job processing at once — a job that must not do the same work twice, a side effect (an email) that cannot be rolled back, a database write and an external call that must not be in the same transaction, and two processes that might touch the same row.

The design is entirely fixed by `requerimientos/06-etapa-5-alertas-email.md`. What this document records is why each mechanism is there, because most of them look like unnecessary ceremony until the failure they prevent is named.

**Project constraint applied here:** this is a zero-cost learning project whose server is started only for testing. The source document's production mail assumptions (an SMTP provider, an owned domain, SPF/DKIM) are therefore replaced by local Mailpit; everything else in the stage is unchanged, because the outbox, transactions and locking are the point. See "Decisions" and "Open Questions".

## Goals / Non-Goals

**Goals:**
- Exactly one notification per trigger, even if two runs overlap, the process dies mid-run, or the user edits the alert at the same instant.
- No notification is ever lost, including when SMTP is unavailable for hours.
- No notification is ever re-sent on every subsequent run just because the condition is still true.
- Every state transition is decidable by a pure function, so the interesting behavior is unit-testable without a database, a clock or a mail server.
- A failure anywhere in this stage cannot damage price collection.

**Non-Goals:**
- No exactly-once delivery. It is not achievable here and pretending otherwise would hide a real duplicate. At-least-once with deduplication where possible is the honest target.
- No channels other than email. The `channel` field exists so adding one later is not a migration, but nothing else is built for it.
- No unsubscribe link, since there is no frontend to land on; the email explains the API call that disables the alert instead.
- No digest or grouping of multiple alerts into one message.
- **No production mail delivery.** See the Mailpit decision below.

## Decisions

- **Mail is scoped to local Mailpit, and that is a scope decision, not a technical one**: the source document contemplates a production SMTP provider plus a domain with SPF and DKIM. This project must cost $0 and is never left running, so a production sender has nothing to send from and nothing to keep warm. Mailpit — a local SMTP sink with a web interface — receives everything instead, and `MAIL_FROM` stays a placeholder. *Rationale*: none of this stage's pedagogical content lives in the provider. The outbox, the transaction, the claim, the backoff and the dedupe key behave identically against a real provider and against Mailpit, because the boundary is plain SMTP either way. Deferring the provider costs nothing and removes the only part of the stage that requires money and a domain. *Consequence*: E5-18 is verified at `http://localhost:8025`, which is what the source document already specifies for it.

- **The outbox exists because an email cannot be rolled back**: the naive implementation sends the mail at the moment the condition is detected. If the send succeeds and the subsequent "mark as triggered" write fails, the user gets the same email every ten minutes forever. If the write succeeds and the send fails, the notification is silently lost. Writing a `pending` notification row *in the same transaction* that flips the alert makes those two facts atomic, and moves the unreliable part — the actual send — to a separate job that can retry it. *Rationale*: this is the core lesson of the stage. The database write and the external side effect are separated precisely because only one of them can be transactional.

- **The trigger is a transaction; the rearm is not**: flipping the alert to `triggered` and inserting its notification must be all-or-nothing, so they run inside `session.withTransaction()`. Rearming only changes the alert back to `armed` and creates nothing, so a plain conditional `updateOne` is sufficient. *Rationale*: transactions have a real cost and a replica-set requirement; paying it where there is nothing to make atomic would be cargo cult.

- **Optimistic concurrency via `version`, not a lock on the alert**: the trigger's update is filtered on `{ _id, version: <the value read>, status: 'armed' }` and `$inc`s `version`. If the user edited the alert between the read and the write, the filter matches nothing, the transaction aborts, `triggerConflicts` increments and the run moves on. *Rationale*: alerts are read in bulk and written rarely, so a pessimistic lock would serialize the common case to protect the rare one. The conflict is also genuinely benign — the next run re-evaluates with the user's new threshold, which is what the user wanted anyway.

- **`dedupeKey = ${alertId}:${triggerCount}` with a unique index**: even with the version guard, a retried transaction or an overlapping manual run could attempt the same insert. The unique index makes the second attempt an `E11000`, which is treated as **idempotent success**, not an error. *Rationale*: this is the belt to the version guard's braces, and it is what makes the guarantee survive scenarios the version alone does not cover. Keying on `triggerCount` rather than a timestamp means the key is derived from the event's identity, not from when it happened to be processed.

- **`payload` and `to` are frozen copies, not references**: the notification stores the coin name, the threshold, the triggering value and the recipient address as they were at the moment of the trigger. *Rationale*: the notification is a record of an event in the past. If the user edits the alert's threshold or the price moves before the mail is sent, an email that reads the current values would describe something that never happened. The snapshot is what makes the email truthful.

- **Cooldown and no-op write nothing at all, not even `lastEvaluatedAt`**: with a thousand alerts evaluated every ten minutes, updating a timestamp per alert per run would be the system's dominant write load, purely to record that nothing happened. `lastEvaluatedAt` therefore means "last state change", and that meaning is documented. *Rationale*: an honest field with a documented meaning beats a misleading field that is expensive to maintain.

- **Hysteresis and cooldown solve two different problems and both are needed**: hysteresis (`rearmPct`) stops an alert oscillating around its threshold from firing every run — with a 1% margin on a 50,000 threshold, the price must recover past 50,500 before the alert can fire again. Cooldown stops a legitimately re-armed alert from firing too often in absolute time. *Rationale*: neither subsumes the other. Hysteresis alone would allow rapid repeat fires on a genuinely volatile coin; cooldown alone would still let a price hovering exactly at the threshold fire once per cooldown period forever.

- **The claim is one atomic `findOneAndUpdate` from `pending` to `sending`**: two workers racing for the same notification both issue the same conditional update; the second matches nothing and gets `null`. *Rationale*: this is a distributed mutex built from a single atomic document operation, with no lock table and no coordination. It is the same shape as the lease lock the next stage generalizes.

- **Every post-send update is filtered by `{ _id, status: 'sending', lockedBy: workerId }`**: if a send took longer than `NOTIFY_LOCK_TIMEOUT_MIN` and another worker already recovered and re-sent the notification, the slow worker's late "mark as sent" must not overwrite the new owner's state. *Rationale*: without this filter, stale-lock recovery would introduce the very corruption it exists to prevent.

- **Transient and permanent SMTP failures take opposite paths**: a `responseCode` in the 500 range means the recipient or message was rejected — retrying will fail identically, so the notification goes straight to `failed`. Connection errors, timeouts and 4xx responses (including the 421/451 that providers use for rate limiting) mean "not now", so the notification returns to `pending` with `nextAttemptAt = now + backoff[attempts - 1]` over `[1, 5, 15, 60]` minutes with ±10% jitter. *Rationale*: retrying a permanent rejection burns attempts and delays the inevitable `failed` state; not retrying a transient one loses a deliverable message. The jitter prevents a batch that failed together from retrying together.

- **Sends within a batch are sequential, not parallel**: the batch stops early when `MAIL_MAX_PER_MINUTE` is reached, leaving the remainder for the next minute. *Rationale*: parallel sends would make the per-minute cap unenforceable and would be the first thing a real provider throttled. Sequential sending also makes the job's behavior deterministic enough to test.

- **A failed evaluation degrades the run to `partial`, never `failed`**: prices are already stored by the time evaluation runs. `error.code: ALERT_EVALUATION_FAILED` records it, and the next run evaluates with fresh values. *Rationale*: same principle as the `latest` refresh in `api-rest` — a downstream step failing must not misreport the upstream step that succeeded. RNF-5.6's requirement that SMTP problems never affect price collection is the same idea one layer further out, and the outbox is what guarantees it: the polling job never talks to SMTP at all.

- **`mailer.verify()` at worker startup logs an error but does not stop the worker**: *Rationale*: if SMTP is down at boot, the correct behavior is to keep collecting prices and keep queueing notifications, which the outbox makes safe. Refusing to start would turn a mail outage into a total outage.

- **The recipient is always the account's verified email, never a user-supplied address**: enforced at alert creation with 422 `EMAIL_NOT_VERIFIED`. *Rationale*: carried forward from `auth-firebase` — an application that emails arbitrary addresses on demand is an open relay for phishing. This is the stage where that decision earns its keep.

- **HTML escaping happens at render time, not at storage time**: `note` and `coinName` are escaped when the email HTML is built, and the subject has `\r` and `\n` stripped. *Rationale*: escaping on the way into the database corrupts the stored value and breaks any consumer that is not HTML. Escaping at each output boundary is correct for every consumer. The subject stripping specifically prevents SMTP header injection, which is a different attack from HTML injection and needs its own defence.

## Risks / Trade-offs

- **[Risk]** At-least-once delivery means a user can receive the same email twice if the process dies between a successful SMTP handoff and the `sent` write. → **Mitigation**: accepted, documented, and bounded — the stale-lock recovery window is `NOTIFY_LOCK_TIMEOUT_MIN`, and the duplicate is an exact copy rather than a new event. Exactly-once would require coordination with the mail provider that no SMTP server offers.
- **[Risk]** A price that crosses the threshold and returns within one ten-minute polling window is never detected. → **Mitigation**: inherent to sampling, not fixable by any amount of correctness in this stage; documented plainly so it is a known property rather than a surprise. Shortening the interval narrows it at the cost of upstream calls.
- **[Risk]** The replica-set requirement breaks every existing local and CI environment at once. → **Mitigation**: `docker-compose.yml` initializes the single-node set automatically via a healthcheck, tests switch to `MongoMemoryReplSet`, and both processes verify support at startup and exit with an explanatory message rather than failing obscurely on the first transaction.
- **[Risk]** A user who loses their verified email after creating alerts will have triggers that produce no notification, and the alert stays `armed` and retries every run. → **Mitigation**: logged at `warn` with the transaction aborted so no half-state is written; whether the alert should auto-disable is recorded as an open question rather than decided unilaterally.
- **[Risk]** Evaluating with a cursor keeps memory flat, but a very large alert set still costs one decision per alert per run. → **Mitigation**: the `{ coinId: 1, status: 1 }` index restricts the cursor to alerts on coins that actually changed in this run, so the cost scales with updated coins rather than total alerts; RNF-5.1 bounds it at under 2 seconds for 1,000 alerts.
- **[Trade-off]** `lastEvaluatedAt` does not mean what its name suggests. Accepted deliberately to avoid a write per alert per run, and documented at the field.
- **[Trade-off]** Scoping to Mailpit means SPF/DKIM, deliverability and spam behavior are never exercised. Accepted: they are properties of a domain and a provider, not of this codebase, and they cost money to obtain.

## Migration Plan

This is the only stage with a genuine infrastructure migration.

1. Update `docker-compose.yml` so `mongo` runs with `--replSet rs0 --bind_ip_all` and a healthcheck that calls `rs.initiate()` when the set is not yet initialized, and add the `mailpit` service (SMTP 1025, UI 8025).
2. Recreate the local database container and point `MONGODB_URI` at `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`. Existing local data is development-only and can be re-seeded with `seed:coins`.
3. Switch the integration test helper from `MongoMemoryServer` to `MongoMemoryReplSet` with a single node. Every existing integration test keeps working unchanged.
4. Deploy the application change. `alerts` and `notifications` start empty; no backfill exists or is needed.
5. Both processes verify replica-set support at startup, so a missed step fails immediately and legibly instead of at the first trigger.

Rollback requires reverting the compose topology as well as the code, since transactions cannot run against a standalone server.

## Open Questions

- **Production mail is deferred, not decided.** Choosing an SMTP provider, registering a domain and configuring SPF and DKIM are out of scope under the zero-cost constraint, and `MAIL_FROM` stays a placeholder. If the project ever acquires a domain, the open question the source document raises — which provider, and what `MAIL_FROM` becomes — reopens unchanged; no code decision in this stage depends on the answer.
- Should an alert whose user lost email verification be automatically moved to `disabled` instead of staying `armed`? The default specified here is to stay `armed`, which preserves the user's intent if they re-verify, at the cost of a `warn` log on every run while the condition holds.
- The source document specifies `Intl.NumberFormat('es-AR', ...)` for currency and a configurable display timezone, which are presentation choices for a Spanish-speaking reader. They are kept exactly as specified; if the project's audience changes, the locale becomes a configuration value alongside `MAIL_DISPLAY_TIMEZONE` rather than a code change.
