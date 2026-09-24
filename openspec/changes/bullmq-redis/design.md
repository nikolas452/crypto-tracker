## Context

Agenda gave the project a durable schedule and distributed locking, and that is genuinely enough for what this system does. This stage is not a fix for a problem Agenda caused; it is the last teaching stage, and the thing it teaches is what changes when work becomes _messages_ rather than _scheduled functions_. Decomposing one ten-minute job into a tree of small jobs makes several previously invisible concerns concrete: how to avoid processing the same message twice, how to limit a rate globally across workers, what happens to in-flight work when a consumer dies, and what to do when the message broker itself loses data.

That last question drives the most important decision here. MongoDB stays the source of truth and Redis becomes transport, which is the only arrangement in which losing the queue is a recoverable inconvenience rather than lost notifications.

**Project constraint applied here:** the source document makes this stage depend on a continuously running cloud worker, which the deploy stage deliberately did not create. This change is therefore local-only; see the first decision below.

## Goals / Non-Goals

**Goals:**

- Separate workloads so a backlog of one kind cannot delay another.
- Retry each unit of work on a policy appropriate to that unit, rather than on one shared cadence.
- Survive total loss of the queue's data without losing a single notification.
- Make queue state visible and controllable, both through the API and through a dashboard.
- Retire Agenda cleanly, with a period in which reverting is still possible.

**Non-Goals:**

- No cloud deployment of the queues.
- No BullMQ Flows. The parent-child relationship between `poll-prices` and its `evaluate-alerts` children is real, but expressing it as an explicit Flow buys nothing the deterministic job ids do not already provide.
- No distributed tracing, no Redis Cluster, no Sentinel.
- No change to any alert's semantics. `decide` and the trigger transaction are reused verbatim.

## Decisions

- **Local only, because the consumer-always-running requirement is met locally and nowhere else**: BullMQ needs processes that are actively consuming, which the source document satisfies with a paid cloud worker. The deploy stage deployed no worker, because the project must cost nothing and is not meant to run continuously. Running Valkey in Docker Compose alongside the existing MongoDB and Mailpit costs nothing and satisfies the requirement exactly during a testing session, which is the only time this system is meant to be doing anything. _Rationale_: the pedagogical content — fan-out, deduplication, queue rate limiting, stalled jobs, dead-letter handling, outbox-plus-relay — is entirely exercised locally. The deployment adds cost and a persistence problem (Render Key Value's free tier does not persist to disk, so a restart would drop delayed retry jobs) without adding anything to learn that the local setup does not already teach.

- **MongoDB is the source of truth; Redis is transport**: every notification exists as a durable MongoDB row before any queue job references it, and the relay reconstructs the queue from those rows. _Rationale_: this is the single decision that makes everything else safe. It means `FLUSHALL` on Redis is survivable (E8-8), it means a failed post-commit enqueue is recoverable, and it means the free-tier persistence question that blocks deployment is a performance concern rather than a correctness one.

- **The notification is enqueued strictly _after_ the transaction commits, never inside it**: putting `queue.add` inside `withTransaction` would enqueue a job for a notification that might roll back, producing a consumer that finds nothing — or worse, a committed queue entry for an aborted trigger. Enqueueing after the commit introduces the opposite risk, a committed notification with no queue job, which is exactly what the relay exists to repair. _Rationale_: of the two failure modes, only one is recoverable by a periodic sweep, so the design chooses that one deliberately.

- **Deterministic job ids do the deduplication**: `eval:<coinId>:<capturedAt epoch>` and `notif:<notificationId>`. BullMQ ignores an add whose id already exists, so re-enqueueing the same logical work is a no-op. _Rationale_: this replaces a whole class of application-level "have I already queued this" bookkeeping with an identifier derived from the event itself. The `capturedAt` component is what makes it correct rather than merely convenient — a genuinely new price for the same coin produces a genuinely new id.

- **Four queues instead of one, because the workloads are not alike**: prices are serial and infrequent, alert evaluation is parallelizable and bursty, notification sending is rate-limited by an external system, and maintenance is a daily singleton. Sharing one queue would let a hundred queued emails delay the next price poll. _Rationale_: this is the concrete answer to "why not one queue", and it is the reason the stage exists at all — the separation is only expressible once work is decomposed.

- **The queue-level limiter, not a per-worker counter, enforces the mail rate**: `limiter: { max: MAIL_MAX_PER_MINUTE, duration: 60000 }` on the `notifications` queue. _Rationale_: the previous stage's per-batch cap was per-process, so two workers would have doubled the real rate. A queue limiter is global across consumers, which is what a provider's rate limit actually requires (E8-7 asserts it holds with two workers).

- **The lease lock is kept**: BullMQ's `concurrency: 1` bounds one worker, so two workers, or a scheduled job and a manually triggered one, could still overlap. The lease from the previous stage already solves exactly this and is not coupled to Agenda. _Rationale_: reusing it is both correct and cheaper than adopting a queue-level global concurrency feature whose availability in the installed version is unverified. If that feature exists and is suitable, substituting it is a documented decision rather than a silent one.

- **Retries move from a hand-written listener to BullMQ's `attempts` and `backoff`, but the classification stays ours**: the queue decides _when_ to retry; the code decides _whether_ by throwing either an ordinary error or an unrecoverable one. `COINGECKO_AUTH` and a permanent SMTP rejection are thrown as unrecoverable so no attempts are wasted. _Rationale_: this is a straight improvement over the Agenda listener — the scheduling is the broker's job and it does it better — while keeping the domain knowledge about which failures are worth retrying where that knowledge lives.

- **`send-notification` claims in MongoDB by id, and a non-matching claim is success, not failure**: `findOneAndUpdate({ _id, status: 'pending' }, ...)`. If it matches nothing, the notification was already sent, cancelled or claimed elsewhere, so the job returns without error. _Rationale_: with a relay re-enqueueing and BullMQ re-delivering stalled jobs, duplicate deliveries of the same _message_ are expected and normal. Treating a harmless duplicate as a failure would generate noise and burn retry attempts for no reason.

- **The last attempt marks MongoDB `failed` before throwing**: when `attemptsMade + 1 >= attempts`, the row is set to `failed` first, then the error is thrown so BullMQ dead-letters the job. _Rationale_: without this ordering, the queue and the database would disagree about the outcome — the job would be `failed` in Redis while the row still claimed to be `pending`, and the relay would helpfully re-enqueue it forever.

- **`nextAttemptAt` becomes informational**: BullMQ owns retry timing now. The field is kept because the relay still uses `updatedAt`/`createdAt` age to decide what to sweep, and removing a column to save nothing would be churn. _Rationale_: documented explicitly so nobody later "fixes" code that appears to ignore it.

- **Bull Board uses HTTP Basic Auth, not the Firebase token**: the dashboard is opened in a browser, which cannot attach a Bearer token. _Rationale_: rather than weaken the API's auth to accommodate a browser, the dashboard gets its own credentials, compared in constant time, disabled by default outside development, and served only over HTTPS. This keeps the two authentication systems separate and each appropriate to its client.

- **Tests run against a real Redis**: BullMQ's semantics live in Lua scripts executed inside Redis, so an in-memory mock reproduces the API but not the behavior — exactly the behavior this stage is about. Suites skip when `REDIS_URL` is absent. _Rationale_: a passing test against a mock would be actively misleading here.

- **`relay-notifications` sweeps on an age threshold, not on everything pending**: it looks for rows pending for more than about two minutes. _Rationale_: a notification created seconds ago almost certainly has a queue job already; sweeping it would be a redundant add that the deterministic id would reject anyway. The age threshold keeps the relay's normal-case cost near zero.

## Risks / Trade-offs

- **[Risk]** A relay re-enqueue can be ignored when a `failed` job with the same id is still retained in the queue, leaving a notification that MongoDB considers pending with no live job. → **Mitigation**: the admin retry path removes the failed job before re-enqueueing, or uses the queue's own retry mechanism, and that rule is specified rather than left to discovery.
- **[Risk]** Decomposition multiplies the number of jobs, and Redis memory is finite under `noeviction`, where a full instance rejects writes rather than dropping data. → **Mitigation**: `removeOnComplete` and `removeOnFail` are configured per queue, maintenance cleans up what those miss, and a full Redis degrades to `ENQUEUE_FAILED` runs and pending notifications that the relay recovers — not to lost work.
- **[Risk]** `noeviction` is mandatory for BullMQ, and a provider that silently uses a different policy would corrupt queues in ways that look like random job loss. → **Mitigation**: checked at startup — fatal in production, a warning in development, and an explicit "could not verify" log when the provider forbids `CONFIG GET`.
- **[Risk]** BullMQ 6 is recent, most published examples target v5, and its optional peer dependencies suggest the connection setup changed. → **Mitigation**: requirements are stated as behavior; the changelog and migration guide are read before implementation and any API substitution is documented.
- **[Risk]** Running the Agenda worker and the BullMQ worker simultaneously would double every job. → **Mitigation**: specified as an absolute rule in the migration, with the old worker stopped before the new one starts.
- **[Risk]** A worker that dies mid-send leaves a stalled job that BullMQ re-delivers; the claim sees `sending` and declines, and only after the lock timeout does the relay re-send — possibly duplicating a message that was in fact delivered. → **Mitigation**: unchanged from the previous stage, at-least-once remains the documented guarantee, and duplicates are exact copies rather than new events.
- **[Trade-off]** No `JobRun` per `evaluate-alerts` job. Writing one per coin per cycle would flood the collection to record mostly-nothing. Statistics go to logs and stay aggregated on the parent `poll-prices` run instead, which loses per-coin queryability and is accepted.
- **[Trade-off]** The optional Redis rate-limit store fails **open** when Redis is down, choosing availability over protection. Documented explicitly, because the opposite choice is equally defensible and the reader should know which one was made.
- **[Trade-off]** Keeping both the lease lock and BullMQ's own concurrency controls is belt-and-braces. Accepted because they cover different scopes and the lease is already built and tested.

## Migration Plan

1. Add the `valkey` service to Docker Compose and set `REDIS_URL`. Confirm the eviction policy check passes.
2. Implement the queues, schedulers and processors alongside the existing Agenda path, selected by `SCHEDULER`.
3. **Stop the Agenda worker.** Never run both against the same jobs.
4. Start the BullMQ worker with `SCHEDULER=bullmq`. Its startup upserts the three schedulers.
5. Run `npm run migrate:agenda-to-bullmq`: cancel the jobs in `agenda_jobs` and enqueue every notification MongoDB still lists as pending, reporting what it did.
6. Verify: three schedulers exist, a `poll-prices` cycle fans out correctly, and pending notifications drain.
7. After a stable period, drop the `agenda_jobs` collection and remove the `agenda` and `@agendajs/mongo-backend` dependencies.

Rollback before step 7 is stopping the BullMQ worker and restarting the Agenda one; the notifications outbox is the shared, authoritative state either way, so nothing is lost in either direction.

## Open Questions

- **Cloud deployment of the queues is deferred, not decided.** The source document's question — Render Key Value paid with persistence, or free without it and trusting the relay — only becomes live if the project ever deploys a worker, which the deploy stage declined to do. No code decision here depends on the answer, since the relay makes the system correct under either.
- Should the lease lock be replaced by a queue-level global concurrency control if the installed BullMQ version provides one? This change keeps the lease. Substituting it later would be contained within the `poll-prices` processor.
- Is exploring BullMQ Flows worthwhile as an extra exercise, modelling `poll-prices` as the parent of its `evaluate-alerts` children? Deliberately out of scope here; the deterministic ids already provide the deduplication that matters, and Flows would add a dependency on a feature this system does not otherwise need.
- Whether `@bull-board` and BullMQ 6 are mutually compatible in their current versions needs verifying before the dashboard is wired up; if they are not, the admin queue endpoints already cover the operations the dashboard would provide.
