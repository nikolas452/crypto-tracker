## 1. Production build (production-build)

- [ ] 1.1 Confirm `npm run build` compiles with `tsc -p tsconfig.build.json` to `dist/` excluding tests, and that `node dist/server.js` starts without `tsx`.
- [ ] 1.2 Make the logger skip `pino-pretty` entirely when `NODE_ENV=production`, so a pruned `devDependencies` tree still starts.
- [ ] 1.3 Confirm `.node-version` pins an exact version and that `engines.node` is `>=24 <25`.
- [ ] 1.4 Verify the production start path against a build with `devDependencies` pruned.

## 2. Configuration (production-config, db-connection)

- [ ] 2.1 Add `MONGODB_MAX_POOL_SIZE` (default 10) to the config schema and pass it to Mongoose as `maxPoolSize`.
- [ ] 2.2 Add the production branch to config validation: require the Firebase credential variables and `TRUST_PROXY`, and require `TRUST_PROXY >= 1`.
- [ ] 2.3 Forbid `FIREBASE_AUTH_EMULATOR_HOST` and `FIREBASE_WEB_API_KEY` when `NODE_ENV=production`, exiting 1 when either is present.
- [ ] 2.4 Confirm production logging is JSON at `info` to stdout.
- [ ] 2.5 Unit tests for `parseEnv` in production mode: each additionally required variable, each forbidden variable, and `TRUST_PROXY` of 0 rejected (**E7-11**).
- [ ] 2.6 Update `.env.example` with `MONGODB_MAX_POOL_SIZE` and a note on which variables become required in production.

## 3. MongoDB Atlas (atlas-setup)

- [ ] 3.1 Create the M0 cluster in a region close to the chosen Render region.
- [ ] 3.2 **Verify on the real cluster** that a time-series collection can be created and that a transaction commits; record both results, and apply the documented normal-collection fallback if time-series is unavailable.
- [ ] 3.3 Create the dedicated database user with `readWrite` scoped to the application database only, with a generated password of at least 32 characters.
- [ ] 3.4 Configure network access, preferring an allowlist of the platform's outbound addresses and otherwise documenting the risk accepted by `0.0.0.0/0`.
- [ ] 3.5 Build the connection URI with `retryWrites=true&w=majority`.
- [ ] 3.6 Document the M0 limits, the storage estimate for this project's data volume, and the `db.stats()` monitoring query.

## 4. Blueprint (render-blueprint)

- [ ] 4.1 Write `render.yaml` with an `envVarGroups` entry holding the shared configuration, every secret marked `sync: false`.
- [ ] 4.2 Define exactly one `type: web` service on the free plan with `runtime: node`, the build and start commands, and `fromGroup` for shared variables. Define **no** worker and **no** cron service.
- [ ] 4.3 Set `healthCheckPath: /health/ready` and `autoDeployTrigger: checksPass`.
- [ ] 4.4 Set the region close to the Atlas region and document the pairing.
- [ ] 4.5 Validate the file against Render's current Blueprint specification before applying it.
- [ ] 4.6 Verify **E7-1**: a commit with failing CI does not deploy, and one with passing CI does.
- [ ] 4.7 Verify **E7-3**: redeploy while a script issues 5 requests per second to `GET /api/v1/coins` and confirm no 5xx responses.

## 5. Database setup script (db-setup-script)

- [ ] 5.1 Implement `src/scripts/dbSetup.ts` running `ensureCollections()` then `syncIndexes()` per model, idempotently.
- [ ] 5.2 Log the index diff (to create, to drop) before applying anything.
- [ ] 5.3 Implement `--dry-run`, which prints the diff and exits without modifying the database.
- [ ] 5.4 Add the `db:setup` npm script.
- [ ] 5.5 Integration test: `db:setup --dry-run` leaves indexes unchanged, and a normal run creates a missing index and is a no-op when repeated.
- [ ] 5.6 Document that `syncIndexes()` drops undeclared indexes and the rule that every index lives in a schema.
- [ ] 5.7 Check Render's current documentation for whether a free web service supports a `preDeployCommand`; if not, document the manual pre-deploy run as the path.

## 6. Production HTTP security (production-http-security)

- [ ] 6.1 Enable HSTS through `helmet` in production.
- [ ] 6.2 Confirm CORS remains disabled and that both rate limiters stay active.
- [ ] 6.3 Confirm error responses carry no stack trace in production.
- [ ] 6.4 Implement `GET /api/v1/admin/debug/ip` returning `req.ip` and `req.ips`, guarded by `requireAuth({ checkRevoked: true })` + `requireRole('admin')`.
- [ ] 6.5 Verify **E7-9**: calling the diagnostic through the platform proxy returns the caller's public address, not the proxy's.

## 7. Smoke test (smoke-test)

- [ ] 7.1 Implement `src/scripts/smoke.ts` with the five checks and the `--url` argument.
- [ ] 7.2 Implement the exit-code contract, with the status check degrading to a warning when `stale` is `true`.
- [ ] 7.3 Tolerate the free plan's cold start when contacting a sleeping service.
- [ ] 7.4 Add the `smoke` npm script.
- [ ] 7.5 Verify **E7-2**: after a completed deploy, `npm run smoke -- --url <api>` passes.

## 8. Initial data and admin provisioning

- [ ] 8.1 Run `seed:coins` from a local machine with the production `MONGODB_URI` and `COINGECKO_API_KEY` exported into the shell only, never written to a committed file.
- [ ] 8.2 Provision the owner's admin account: call an authenticated endpoint once against production, then run `user:set-role` against the production database.
- [ ] 8.3 Confirm the alternative path — adding coins through `POST /api/v1/admin/coins` — works against the deployed API.

## 9. Runbook (deploy-runbook)

- [ ] 9.1 Write `docs/runbook.md` with the deploy and rollback procedures.
- [ ] 9.2 Document rotation for each secret: Atlas credential, CoinGecko key, Firebase service account, SMTP credentials.
- [ ] 9.3 Document the failure playbooks: stale status, notifications in `failed`, exhausted CoinGecko quota, and an auto-paused Atlas cluster with how to resume it.
- [ ] 9.4 Document that `stale: true` is the normal resting state for this deployment because no worker runs in the cloud, and how to change it by running the worker locally against the production URI.
- [ ] 9.5 Document how to run `db:setup` and `seed:coins` against production without persisting credentials.
- [ ] 9.6 Add the diagnostic queries: latest `job_runs`, notifications in `failed`, and collection sizes.
- [ ] 9.7 Add the security checklist and verify **E7-8**: searching the repository and its full history finds no Atlas URI, CoinGecko key or Firebase private key. Optionally add a secret scanner such as gitleaks to CI.

## 10. Documentation and Definition of Done

- [ ] 10.1 Add the `db:setup` and `smoke` scripts to `package.json` and document them in the README.
- [ ] 10.2 Document the scope adaptation in the README: the API deploys to the free tier and sleeps when idle, the worker runs locally only, and the internal run-cycle endpoint, the scheduled GitHub Actions trigger and the external uptime monitor are deliberately out of scope with the reasons.
- [ ] 10.3 Record that **E7-4**, **E7-5**, **E7-6**, **E7-7** and **E7-10**, plus **RNF-7.3** and **RNF-7.4**, are out of scope for this deployment shape, so a later reader does not read them as unmet obligations.
- [ ] 10.4 Measure **RNF-7.5**: p95 of `GET /api/v1/coins` from the owner's location with the API awake, documenting the result and the chosen region.
- [ ] 10.5 Confirm **RNF-7.6**: the Atlas user is limited to one database and the Firebase service account is dedicated to this project.
- [ ] 10.6 Confirm `typecheck`, `lint` and `test` all pass locally and in CI.
