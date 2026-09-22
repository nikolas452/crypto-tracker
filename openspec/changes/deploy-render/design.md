## Context

Six stages have produced a system that runs correctly on one developer machine. This stage asks what changes when it runs somewhere else: a build step that must happen before start rather than during it, configuration that arrives from a platform instead of a file, indexes that must not be created while traffic is flowing, and a written procedure for the failures that will eventually happen.

The source requirement document was written assuming a system that stays online and a budget for the worker. **Neither holds here.** The owner's constraints are explicit: the project must cost nothing, and the server is started only to test. That does not remove the stage's value — everything genuinely educational about deployment survives — but it does change what gets deployed and why. This document records that reasoning, because it is the largest deliberate departure from the source documents in the whole project.

## Goals / Non-Goals

**Goals:**
- Learn deployment properly: infrastructure as a versioned file, secrets that never enter the repository, a deploy that cannot ship a red build, and a rollback that is one click.
- A production start path that depends on nothing from `devDependencies` at runtime.
- Index management that is explicit, reviewable and reversible, rather than a side effect of process startup.
- A post-deploy check that answers "did that work" in one command.
- A runbook that is useful to someone who has forgotten how any of this works.

**Non-Goals:**
- **No always-on system.** Nothing in this change exists to keep a process alive between testing sessions.
- No deployed worker, and therefore no cloud job execution.
- No internal machine-to-machine endpoint and no scheduled external trigger.
- No external uptime monitoring or alerting.
- No custom domain, no DNS, no Docker image, and no staging environment.

## Decisions

- **Neither Option A nor Option B is chosen, because both answer a question this project does not ask.** The source document frames the decision as "pay for a worker, or keep a free one awake with GitHub Actions". Option A costs money, which is disqualifying. Option B is subtler and worth spelling out: its purpose is to run the polling cycle every ten minutes forever, which means keeping a free web service continuously awake. That consumes about 744 hours of the 750-hour monthly free workspace allowance — meaning no other free service could coexist — to collect price data nobody is watching, for a project whose owner explicitly starts the server only to test. The mechanism is sound; the requirement it serves does not exist here. *Rationale*: deploying the API alone still teaches the entire DevOps surface of this stage. Running a scheduler in the cloud teaches nothing that running it locally does not, and stage 6 already taught the scheduling itself.

- **The free tier's sleep-when-idle behavior is treated as a feature, not a defect**: a free Render web service spins down after 15 minutes without traffic and takes roughly a minute to wake. For a system that is only visited deliberately, that is precisely the desired behavior — zero cost while idle, available when asked. *Rationale*: the source document treats spin-down as an obstacle because it assumes a scheduler needs a live host. Without that assumption, the cold start is a wait on the first request of a session and nothing more. It is documented so it is expected rather than alarming.

- **The worker runs locally against whichever database is being exercised**: during a testing session the owner starts the worker on their own machine, pointed at either the local replica set or the Atlas cluster. *Rationale*: this keeps `poll-prices`, `send-notifications` and `maintenance` fully exercisable — including against production data when that is the point of the session — without paying for an instance or fabricating traffic to keep one alive. It also keeps the mail path consistent with the previous stage's Mailpit-only scope, since the worker is the process that sends.

- **`autoIndex` stays off in production and indexes are applied by an explicit script**: `db:setup` runs `ensureCollections()` and `syncIndexes()` per model, logs the diff first, and supports `--dry-run`. *Rationale*: with `autoIndex` on, every process start attempts index creation, which on a non-trivial collection can load or block the database at exactly the wrong moment — during a deploy. Making it a deliberate, reviewable step separates "the code is live" from "the schema changed". The `--dry-run` mode exists because `syncIndexes()` **drops** indexes absent from the schema, which is destructive if anyone ever created one by hand; seeing the diff first is the guard, and the accompanying rule is that every index must live in a schema.

- **Every secret is `sync: false` or generated, never a literal in `render.yaml`**: the blueprint is committed, so any value written into it is a value in the repository's history forever. *Rationale*: the entire point of infrastructure-as-code is to version the *shape* of the infrastructure, not its credentials. E7-8 asserts the repository, history included, contains no Atlas URI, CoinGecko key or Firebase private key.

- **`autoDeployTrigger: checksPass` rather than deploy-on-push**: Render deploys only when GitHub's checks passed for that commit. *Rationale*: the CI pipeline from stage 0 already runs typecheck, lint and tests; without this setting, it would be advisory. With it, a red build physically cannot reach production, which is what E7-1 asserts.

- **`healthCheckPath` points at `/health/ready`, not `/health`**: readiness checks the database; liveness deliberately does not. *Rationale*: this is what makes a zero-downtime deploy real — the platform holds traffic on the old instance until the new one can actually serve, and stage 0's graceful shutdown drains the old one. E7-3 asserts no 5xx during a deploy under load, and it is this pairing that makes that true.

- **The Atlas user is scoped to one database with `readWrite`, never `atlasAdmin`**: *Rationale*: least privilege. A leaked credential should be able to damage exactly one database and nothing about the cluster. This matters more, not less, on a learning project, because learning projects are where credentials leak.

- **Network access: `0.0.0.0/0` is permitted but its risk is documented**: the preferred option is allowlisting Render's outbound addresses if the plan exposes them. *Rationale*: a free web service may not have stable egress addresses, in which case open network access with a strong credential and TLS is the realistic choice. Writing down that the security then rests entirely on the credential is more honest than pretending an allowlist is always available.

- **Time-series support and transactions on M0 are verified, not assumed**: Atlas's free-tier limitations page does not state whether either is available, and both are load-bearing — `price_snapshots` is a time-series collection and the alert trigger needs a transaction. *Rationale*: discovering this after deploying would be a rewrite, not a fix. The documented fallback for time-series is a normal collection with an equivalent compound index; there is no fallback for transactions, which is why it is checked first.

- **`GET /api/v1/admin/debug/ip` exists solely to prove `trust proxy` is right**: it returns `req.ip` and `req.ips` to an authenticated admin. *Rationale*: a misconfigured `trust proxy` silently makes the rate limiter treat every request as coming from one client, which is invisible until someone abuses it. One admin-only endpoint turns an invisible misconfiguration into a one-request check (E7-9).

- **The smoke test is a script, not a test suite**: five checks, non-zero exit on failure, run against a URL. *Rationale*: it answers a different question from the test suite — not "is the code correct" but "is this deployment serving". Allowing check four (`stale: false`) to degrade to a warning for a recent deploy is deliberate: right after a deploy, and on this project generally, the worker may simply not have run recently, and failing the smoke test for that would make it noise.

## Risks / Trade-offs

- **[Risk]** With nothing connecting continuously, the Atlas M0 cluster auto-pauses after 30 days without connections, and the first request after that fails until it is resumed. → **Mitigation**: accepted as a direct consequence of the zero-cost, not-always-on constraint; the runbook documents how to recognize and resume a paused cluster. This is the failure mode Option B existed to prevent, and it is cheaper to handle by hand twice a year than to prevent by keeping a service awake all month.
- **[Risk]** `syncIndexes()` drops any index not present in a schema, so an index created manually in Atlas disappears on the next run. → **Mitigation**: `--dry-run` shows the diff before anything is applied, and the runbook states the rule that every index must be declared in its schema.
- **[Risk]** `npm ci` installs `devDependencies`, which are needed to compile but not to run, so anything that accidentally requires one at runtime will work in the build and fail at start. → **Mitigation**: the production start path is asserted to need no `tsx` and no `pino-pretty`, and the smoke test would catch a start failure immediately.
- **[Risk]** A free web service's cold start can exceed a client's timeout on the first request of a session. → **Mitigation**: documented as expected behavior; the smoke test's own first request absorbs it.
- **[Risk]** Because the worker never runs in the cloud, `GET /api/v1/status` on the deployed API will usually report `stale: true`. → **Mitigation**: this is correct — no worker *is* running — and the smoke test treats it as a warning rather than a failure. The runbook explains that stale is the normal resting state for this deployment shape, so it is not mistaken for a fault.
- **[Trade-off]** Deploying only the API means the deployed system is a read API over whatever data a local worker has pushed into Atlas. Accepted: the deployment exercise is about deploying, and the job execution was the previous stage's subject.
- **[Trade-off]** No staging environment, so the first place a configuration change is exercised is production. Acceptable at this scale, where production has no users and rollback is one click.

## Migration Plan

1. Create the Atlas M0 cluster in a region close to the chosen Render region. Create the scoped `readWrite` user with a generated password of at least 32 characters, and configure network access.
2. **Verify on the real cluster** that a time-series collection can be created and that a transaction commits. If time-series is unavailable, apply the documented fallback before going further.
3. Commit `render.yaml`. Create the Render blueprint and load every `sync: false` value into the environment group through the dashboard.
4. Run `npm run db:setup -- --dry-run` from a local machine against the production URI, review the diff, then run it for real.
5. Load initial data: run `seed:coins` locally with the production `MONGODB_URI` and `COINGECKO_API_KEY` exported into the shell only — never written to a committed file. Alternatively add coins through `POST /api/v1/admin/coins` once an admin exists.
6. Provision the owner's admin account by calling an authenticated endpoint once against production, then running `user:set-role` against the production database.
7. Deploy, then run `npm run smoke -- --url <api>`.
8. Whenever a testing session needs fresh data, run the worker locally against the production URI.

Rollback is Render's redeploy of a previous successful deploy. An index change is rolled back by reverting the schema and re-running `db:setup`.

## Open Questions

- The Atlas M0 cluster's auto-pause after 30 days of inactivity is accepted rather than prevented. If the owner later wants the deployed API to be reliably up on demand without paying, the only mechanisms are the ones this change rejected, so the decision would need revisiting on its own terms rather than being reopened here.
- Whether the repository is public or private is unresolved and, with the GitHub Actions trigger out of scope, no longer affects the 60-day workflow-inactivity rule. It still affects available Actions minutes for the CI pipeline, which is worth confirming before relying on CI-gated deploys.
- The source document raises a custom domain as being needed in practice for stage 5's `MAIL_FROM`. That remains unresolved and out of scope under the same zero-cost constraint that scoped mail to Mailpit; it is recorded here so the two decisions stay linked.
- The source document specifies `db:setup` as a `preDeployCommand` when the plan allows it. Whether a free web service supports pre-deploy commands needs checking against Render's current documentation; if it does not, the manual pre-deploy run documented in the runbook is the path, which is what this change assumes.
