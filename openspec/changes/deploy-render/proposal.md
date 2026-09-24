## Why

Everything the project has built runs on one machine, against a Docker Compose stack, started by hand. This stage is where it meets the parts of the job that only appear once software leaves a laptop: compiling for production, describing infrastructure as a versioned file, keeping secrets out of the repository, creating indexes without blocking a live database, gating deploys on a green build, and knowing what to do when something breaks at three in the morning.

It is the stage with the most DevOps content, and it is worth doing even though — for this project — nothing needs to stay online.

## Scope adaptation: free tier only, and the worker stays local

The source requirement document offers two deployment shapes and asks the owner to choose. **Neither fits this project's actual constraints**, which are that it must cost **$0** and that the server is started only to test, never run continuously:

- **Option A** (a Render Background Worker running Agenda in the cloud) is rejected because background workers and cron jobs have no free instance on Render. It costs money.
- **Option B** (a free web service kept awake by a GitHub Actions workflow curling an internal endpoint every 10 minutes, forever) is rejected because its entire purpose is to keep something running 24/7, which is exactly what the owner does not want. It would also consume roughly 744 of the 750 free workspace hours per month, monopolizing the free allowance for a system nobody is watching.

This change therefore scopes deployment as a **learning exercise on the free tier**: the API is deployed as a free Render web service that sleeps when idle — which is an advantage here, not a problem — and **the worker is not deployed to the cloud at all**. It keeps running locally, against either the local database or the Atlas one, whenever the owner is actually testing.

**In scope:** production build, the `render.yaml` blueprint for a single free web service, MongoDB Atlas M0 setup, environment and secret management, the readiness-gated deploy, the `db:setup` index script with `--dry-run`, production HTTP hardening, the post-deploy smoke test, initial data loading, the runbook, and acceptance criteria **E7-1**, **E7-2**, **E7-3**, **E7-8**, **E7-9** and **E7-11**.

**Explicitly out of scope, with the criteria they carry:**

- The Render Background Worker and any paid plan — and with it **E7-4**, which asserts worker-produced job runs appearing in Atlas every 10 minutes.
- The internal `POST /api/v1/internal/jobs/run-cycle` endpoint, `INTERNAL_API_KEY`, `RUN_CYCLE_TIMEOUT_MS` and `WORKER_MODE` — and with them **E7-5** and **E7-6**.
- The scheduled GitHub Actions trigger workflow, together with its free-hours accounting and the 60-day public-repository inactivity rule.
- The external uptime monitor and its keyword check on `stale` — and with it **E7-10**.
- Real-inbox email delivery in production — and with it **E7-7** — because the previous stage already scoped mail to local Mailpit under the same zero-cost constraint.
- `RNF-7.3` (no lost or duplicated jobs across a worker deploy), which presupposes a deployed worker, and `RNF-7.4` (a monthly CoinGecko call budget), which stops being a binding constraint once the worker only runs during testing sessions.

A consequence worth recording: with no process connecting continuously, the Atlas M0 cluster can auto-pause after 30 days without connections. That is acceptable and is handled in the runbook rather than designed around.

## What Changes

- Add a production build path: `npm run build` compiles with `tsconfig.build.json` to `dist/`, production start runs the compiled JavaScript with no `tsx`, and the logger never attempts to load `pino-pretty` when `NODE_ENV=production`.
- Add `render.yaml` at the repository root defining a shared environment-variable group and **one** free web service, with `healthCheckPath: /health/ready`, `autoDeployTrigger: checksPass`, and every secret marked `sync: false` rather than carrying a value.
- Add the MongoDB Atlas M0 setup: a least-privilege database user scoped to the single application database, network access rules with their trade-off documented, a connection URI with `retryWrites=true&w=majority`, an explicit `maxPoolSize`, and verification that the free cluster actually supports time-series collections and transactions.
- Add production-specific configuration validation: extra variables required when `NODE_ENV=production`, development-only variables forbidden there, and `TRUST_PROXY` at least 1.
- Add `npm run db:setup`, an idempotent script running `ensureCollections()` and `syncIndexes()` per model, logging the index diff before applying it and, with `--dry-run`, only showing it.
- Add production HTTP hardening: `helmet` with HSTS, CORS still disabled, and an admin-only `GET /api/v1/admin/debug/ip` diagnostic that proves `trust proxy` is resolving the real client address.
- Add `npm run smoke -- --url <api>`, a post-deploy check over liveness, readiness, a coin read, the status endpoint and an unauthenticated `/me`, exiting non-zero on failure.
- Add `docs/runbook.md` covering deploying, rolling back, rotating every secret, and the recovery procedure for each realistic failure.
- Add the stage's new environment variable `MONGODB_MAX_POOL_SIZE`.

## Capabilities

### New Capabilities

- `production-build`: the compile-to-`dist` build, the Render build and start commands, the pinned Node version with an upper bound in both `.node-version` and `engines`, and the rule that no development-only tool — `tsx`, `pino-pretty` — is required to start in production.
- `render-blueprint`: `render.yaml` — the environment-variable group, the single free web service, the readiness health check path, CI-gated auto-deploy, the prohibition on literal secret values, and region selection relative to Atlas.
- `atlas-setup`: the M0 cluster, its documented limits, the least-privilege database user, network access options and their trade-off, the connection URI parameters, the storage estimate, and the required verification that time-series collections and transactions work on the free tier.
- `production-config`: the variables additionally required when `NODE_ENV=production`, the development-only variables forbidden there, `TRUST_PROXY >= 1`, and JSON logs at `info` to stdout.
- `db-setup-script`: `npm run db:setup` — `ensureCollections()`, per-model `syncIndexes()`, the logged diff, the `--dry-run` mode that changes nothing, and the rule that every index lives in a schema.
- `production-http-security`: HSTS through `helmet`, CORS remaining disabled, the retained rate limits, stack-free error responses, and the admin-only IP diagnostic endpoint.
- `smoke-test`: `npm run smoke -- --url <api>` — its five checks, its exit-code contract, and the tolerated warning for a recently deployed instance reporting stale.
- `deploy-runbook`: `docs/runbook.md` — deploy, rollback and per-secret rotation procedures, the failure playbooks that apply to this deployment shape, how to run `db:setup` and `seed:coins` against production, and useful diagnostic queries.

### Modified Capabilities

- `db-connection`: the Mongoose connection is now configured with an explicit `maxPoolSize` from `MONGODB_MAX_POOL_SIZE` (default 10), alongside the existing `strictQuery` and environment-dependent `autoIndex` settings.
- `dev-tooling`: `package.json` gains the `db:setup` and `smoke` scripts.

## Impact

- Adds `render.yaml` and `docs/runbook.md` at the repository root.
- Adds `src/scripts/dbSetup.ts` and `src/scripts/smoke.ts` with their npm scripts.
- Extends `src/config/env.ts` with the production-conditional validation branch and `MONGODB_MAX_POOL_SIZE`.
- Extends `src/db/connect.ts` with the pool size option.
- Adds the admin debug route under `/api/v1/admin/debug/ip`.
- Adjusts the logger so `pino-pretty` is never required in production.
- Extends `.env.example`, the README and the `.http` collection.
- Requires external, non-code setup: a Render account and blueprint, an Atlas M0 cluster, and the secrets loaded into Render's environment group.
- No change to any job, endpoint contract or data model; the worker's code is untouched and simply is not deployed.
