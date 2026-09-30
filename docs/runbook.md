# Deployment runbook

Operating procedures for the deployed system: one free Render web service
(the API) backed by a MongoDB Atlas M0 cluster. Written to be usable by
someone who has not touched this project in months — see `render.yaml` for
the versioned infrastructure and `openspec/changes/deploy-render/design.md`
for the reasoning behind the scope adaptation this document assumes:
**the worker never runs in the cloud**, only locally, whenever a testing
session needs it. Every command below is a `bash`/POSIX example; adapt to
PowerShell as needed on Windows.

## Deploying

1. Push to the branch Render's blueprint watches (its default branch,
   unless configured otherwise). `autoDeployTrigger: checksPass`
   (`render.yaml`) means Render only deploys a commit once GitHub reports
   its checks (typecheck/lint/test) as passing — a red build never reaches
   production.
2. If the change touches a Mongoose schema's indexes, run `db:setup`
   against production **before** the deploy that relies on the new/removed
   index reaches traffic — see "Running `db:setup` and `seed:coins` against
   production" below. Index changes are never automatic in production
   (`autoIndex` is off, see `src/db/connect.ts`).
3. Render builds with `npm ci && npm run build` and starts the new
   instance with `node dist/server.js`. Traffic only moves to the new
   instance once `GET /health/ready` returns `200` (`healthCheckPath` in
   `render.yaml`) — the old instance keeps serving until then, and the
   in-flight-request-safe graceful shutdown (stage 0) drains it afterwards.
   This is what keeps a deploy free of `5xx` responses (**E7-3**).
4. After the deploy finishes, run the smoke test:

   ```bash
   npm run smoke -- --url https://<your-service>.onrender.com
   ```

   All five checks should `PASS`, except `GET /api/v1/status` may `WARN`
   with `stale: true` — that is the expected resting state of this
   deployment shape (see "A stale status" below), not a failure.

## Rolling back

Render keeps a history of previous successful deploys. From the service's
dashboard: **Deploys** tab → find the last known-good deploy → **Redeploy**.
This redeploys that exact build without needing a new commit or a revert in
Git. If the bad deploy also changed indexes, review whether the schema
change needs reverting too — `db:setup` never rolls back automatically;
revert the schema and run `db:setup` again (see "Index synchronization
drops undeclared indexes" below).

## Rotating secrets

Every secret lives only in Render's environment group (`crypto-tracker-shared`
service overrides, `sync: false` in `render.yaml`) or in the operator's own
shell — never in the repository. Rotating any of them is: generate the new
value, set it in the Render dashboard (**Environment** tab on the service),
save (Render redeploys automatically on an environment change), then revoke
the old value at its source once the new deploy is confirmed healthy
(`npm run smoke`).

- **Atlas connection credential (`MONGODB_URI`)**: in Atlas, **Database
  Access** → edit the application's database user → **Edit Password** →
  generate a new one (≥ 32 characters, same rule as initial provisioning).
  Update `MONGODB_URI` in Render with the new password, save, confirm the
  smoke test passes, then the old password is already invalidated by the
  edit itself.
- **CoinGecko API key (`COINGECKO_API_KEY`)**: generate a new Demo plan key
  from the CoinGecko developer dashboard, update it in Render, confirm
  `POST /api/v1/admin/coins` (or the smoke test's coin read) still works,
  then revoke the old key from the CoinGecko dashboard.
- **Firebase service account (`FIREBASE_PROJECT_ID` /
  `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`)**: Firebase console →
  **Project settings** → **Service accounts** → **Generate new private
  key**. This creates an *additional* key; it does not invalidate the old
  one automatically. Update all three variables in Render together (they
  come from the same JSON key file), confirm an authenticated request still
  works, then delete the old key from the same **Service accounts** page.
- **SMTP credentials (`SMTP_USER`/`SMTP_PASS`)**: only used by the worker,
  which never runs in the cloud — rotate them in your local `.env` (or
  wherever you export them when running the worker against production) and
  at the SMTP provider itself. Nothing to change in Render.

## Failure playbooks

### A stale status (`GET /api/v1/status` reports `pollPrices.stale: true`)

**This is the normal resting state of this deployment**, not a fault: no
worker runs in the cloud (see "Scope adaptation" in `proposal.md`), so
nothing advances `pollPrices.lastSuccessAt` between testing sessions. The
smoke test treats it as a warning, never a failure, for exactly this reason.

To make it `false` — i.e. to get fresh data — start the worker locally
against the production database for the duration of a testing session:

```bash
MONGODB_URI="<production URI>" \
COINGECKO_API_KEY="<production key>" \
SMTP_HOST=localhost SMTP_PORT=1025 MAIL_FROM=alerts@crypto-tracker.local \
npm run dev:worker
```

(Point `SMTP_HOST` at a real provider if you want alert emails to actually
send during that session instead of going to a local Mailpit you may not
have running.) Stop it with `Ctrl+C` when the session is done — nothing
needs to keep running.

### Notifications stuck in `failed`

Query them (see "Diagnostic queries" below). Common causes: SMTP
credentials rotated without updating the worker's environment, or the
`send-notifications` job simply hasn't run recently because the worker
isn't currently running locally (see above). Once the underlying cause is
fixed, requeue a specific notification with
`POST /api/v1/admin/notifications/:id/retry`, or start the worker locally —
its next `send-notifications` tick claims and retries any still-eligible
`failed` notification on its own schedule.

### CoinGecko quota exhausted

The Demo plan allows 10,000 calls/month (README, "CoinGecko quota"). Because
the worker only ever runs locally during testing sessions in this
deployment shape, this is unlikely to bind, but if it does: CoinGecko
returns a rate-limit response, which `poll-prices` records as a `failed`
or `partial` `job_runs` document with an upstream error, not a crash. Wait
for the plan's window to reset, or reduce `POLL_PRICES_CRON`'s frequency /
the tracked coin list before running the worker again. No action needed on
the deployed API — it never calls CoinGecko itself except through the admin
coin endpoints (`POST`/`PATCH /api/v1/admin/coins`), which consume one call
each.

### Atlas cluster auto-paused

An M0 cluster with no connections for 30 days pauses itself automatically
(a direct, accepted consequence of nothing connecting continuously — see
design.md "Risks"). **Recognizing it**: the deployed API's
`GET /health/ready` starts returning `503`, and `db:setup`/`seed:coins`/the
worker all fail to connect. **Resuming it**: Atlas dashboard → the cluster
→ it shows a "paused" badge → **Resume**. Resuming takes a few minutes; the
API keeps returning `503` until it can reach Mongo again — no code change or
redeploy needed, it recovers on its own once the cluster is back.

## Running `db:setup` and `seed:coins` against production

Render's free web service plan does not support a `preDeployCommand` (it
requires the platform's one-off job infrastructure, which is a paid-plan
feature — checked against Render's current Blueprint documentation and
community reports as of writing this, task 5.7). So both commands run **by
hand, from an operator's machine**, with production credentials exported
into the shell for that command only — **never** written into a committed
file:

```bash
# Review the index diff first — this changes nothing.
MONGODB_URI="<production URI>" npm run db:setup -- --dry-run

# Apply it for real, before the deploy that depends on the new index goes out.
MONGODB_URI="<production URI>" npm run db:setup

# Seed or refresh the coin catalog.
MONGODB_URI="<production URI>" COINGECKO_API_KEY="<production key>" npm run seed:coins
```

The alternative to `seed:coins` is adding coins one at a time through
`POST /api/v1/admin/coins` once an admin account exists (see below) — useful
when you only want one or two coins rather than the whole default list.

### Provisioning the owner's admin account

There is no registration/promotion endpoint (by design — see README,
"`GET /api/v1/admin/job-runs`"). Against production:

1. Call any authenticated endpoint once against the deployed API with a
   real Firebase ID token (e.g. `GET /api/v1/me`) — this just-in-time
   provisions the user's Mongo profile with `role: "user"`.
2. Promote it from an operator's machine:

   ```bash
   MONGODB_URI="<production URI>" npm run user:set-role -- --email <owner-email> --role admin
   ```

## Diagnostic queries

Run these with `mongosh "<production URI>"` or MongoDB Compass pointed at
the same URI.

**Most recent job runs** (poll-prices/send-notifications/maintenance):

```js
db.job_runs.find().sort({ startedAt: -1 }).limit(10);
```

**Notifications currently in `failed`**:

```js
db.notifications.find({ status: 'failed' }).sort({ createdAt: -1 });
```

**Collection sizes** (compare against the M0 storage limit — see
"MongoDB Atlas (M0 free tier)" below):

```js
db.stats();
// or, per collection:
db.getCollectionNames().forEach((name) => {
  const stats = db.runCommand({ collStats: name });
  print(name, Math.round(stats.size / 1024 / 1024) + ' MB');
});
```

## MongoDB Atlas (M0 free tier)

Documented limits (verify current numbers against Atlas's own limitations
page before relying on them long-term): **0.5 GB** storage, **100**
operations/second, **500** connections, at most **50** aggregation pipeline
stages, `allowDiskUse` ignored with a **32 MB** in-memory sort ceiling, and
automatic pausing after **30 days** without any connection.

**Region pairing**: the Render web service is deployed in `virginia` (US
East) — see the comment at the top of `render.yaml` for why. Create the
Atlas M0 cluster in a nearby AWS region (e.g. `us-east-1`, N. Virginia) to
minimize latency between the API and the database; confirm and adjust this
once the real cluster exists, since Render does not publish an exact
region-to-region latency mapping.

**Verifying real-cluster support** (task 3.2 — do this once, right after
creating the cluster, before anything else depends on it): confirm a
time-series collection can actually be created and a transaction actually
commits against the real M0 cluster. `ensureCollections()` already fails
loudly (fatal + exit 1) if the time-series collection can't be created in
the documented shape, and `verifyReplicaSet()` already fails loudly at
startup if the connection doesn't support transactions — so simply
connecting the deployed API once against the real cluster and watching it
start (or fail with a clear log line, in which case see design.md's
documented fallback: a normal collection with an equivalent
`{ "meta.coingeckoId": 1, timestamp: -1 }` compound index) **is** the
verification.

## Security checklist

- [ ] No credential is a literal value in `render.yaml` — every secret is
      `sync: false` (verified by reading the file: `MONGODB_URI`,
      `COINGECKO_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
      `FIREBASE_PRIVATE_KEY`).
- [ ] The Atlas database user holds `readWrite` on the application database
      only — never `atlasAdmin` or any cluster-wide role.
- [ ] The Firebase service account used in production is dedicated to this
      project (not reused from another one).
- [ ] `.env` is git-ignored and was never committed (`git log --all --full-history -- .env` returns nothing).
- [ ] **E7-8**: searching the repository, including its full history, for
      the Atlas URI, the CoinGecko key or the Firebase private key finds
      nothing:

  ```bash
  git log --all -p | grep -iE 'mongodb(\+srv)?://[^ ]*:[^ ]*@|BEGIN PRIVATE KEY'
  ```

  An empty result is the pass condition. Consider adding a secret scanner
  (e.g. [gitleaks](https://github.com/gitleaks/gitleaks)) to CI so this is
  checked automatically on every push rather than only manually.
