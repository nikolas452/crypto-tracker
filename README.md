# Crypto Tracker API

Backend project (API + background processes, no frontend) that polls cryptocurrency
prices from CoinGecko, stores history in MongoDB, and exposes a REST API to query
coins, history and stats. See `requerimientos/00-indice-y-convenciones.md` for the
full project index and conventions, and `requerimientos/01-etapa-0-setup-base.md`
for this stage's detailed requirements.

This stage ("Stage 0 — base setup") only provides the base Express/TypeScript
service: startup, config validation, MongoDB connection, health checks, a single
error format, and graceful shutdown. No business domain, auth, jobs or deploy yet.

## Requirements

- Node.js **24.x** (see `.node-version`). `engines.node` in `package.json` enforces
  `>=24 <25`.
- Docker (for a local MongoDB instance) or a MongoDB 8 instance reachable via URI.

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example environment file and adjust as needed:

   ```bash
   cp .env.example .env
   ```

   See the variable table below (all validated by `src/config/env.ts`).

3. Start MongoDB locally with Docker Compose:

   ```bash
   docker compose up -d
   ```

   This starts a single-node MongoDB 8 instance on `localhost:27017`, with data
   persisted in a named volume (`mongo_data`). See the comment inside
   `docker-compose.yml` for how to switch it to a one-node replica set (required
   starting from stage 5, for transactions).

4. Run the API in development mode (auto-reload on file changes):

   ```bash
   npm run dev
   ```

   On success you should see an `API listening` log line. `GET http://localhost:3000/health`
   should respond with `{"status":"ok", ...}`.

## Environment variables

| Variable | Type | Required | Default | Rules |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production` | No | `development` | — |
| `PORT` | integer | No | `3000` | 1–65535 |
| `MONGODB_URI` | string | **Yes** | — | Must start with `mongodb://` or `mongodb+srv://` |
| `MONGODB_DB_NAME` | string | No | `crypto_tracker` | Non-empty |
| `LOG_LEVEL` | pino level | No | `info` | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent` |
| `SHUTDOWN_TIMEOUT_MS` | integer | No | `10000` | >= 1000 |

`src/config/env.ts` is the **only** module allowed to read `process.env` (enforced
by an ESLint `no-restricted-properties` rule). Every other module imports the
validated, frozen `config` object from there. If a required variable is missing or
invalid, the process logs the invalid variable **names** (never their values) at
`fatal` and exits with code 1.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | API with auto-reload (`tsx watch src/server.ts`) |
| `npm run build` | Compiles `src/` to `dist/` with `tsc` |
| `npm start` | Runs the compiled API (`node dist/server.js`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier (writes changes) |
| `npm test` | Runs the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with coverage report |

## Running tests

```bash
npm test
```

- **Unit tests** (`tests/unit`): pure functions and modules with fake dependencies,
  no network and no real database.
- **Integration tests** (`tests/integration`): the real Express app (`createApp`)
  exercised with `supertest`, against an in-memory MongoDB
  (`mongodb-memory-server`). No real Mongo, no open TCP port, and no external
  network calls are needed — the in-memory Mongo binary is downloaded once and
  cached locally by `mongodb-memory-server`.

## Endpoints (this stage)

- `GET /health` — liveness. Never touches the database. `200 { status: "ok", uptimeSeconds, timestamp }`.
- `GET /health/ready` — readiness. Checks Mongo connectivity (with a 2s ping timeout).
  `200 { status: "ready", checks: { mongo: "up" }, timestamp }` or
  `503 { status: "not_ready", checks: { mongo: "down" }, timestamp }`. This is the
  only endpoint that does **not** use the project's global error format.

Every other error response uses the single global shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Descripción legible",
    "details": [{ "path": "query.limit", "message": "Debe ser <= 100" }],
    "requestId": "b3f1..."
  }
}
```

See `requests.http` for ready-to-run sample requests.

## Manual verification steps

Some acceptance scenarios can't be reliably automated in a fast test suite and
are verified manually instead:

### E0-8 — missing `MONGODB_URI` exits with code 1

1. Ensure `.env` does **not** define `MONGODB_URI` (or run without a `.env` file
   and without the variable exported).
2. Run `npm run dev` (or `node --import tsx src/server.ts`).
3. **Expected:** the process logs a `fatal` line whose payload names
   `MONGODB_URI` among `invalidVariables` — and never logs any variable's
   value — then exits with status code `1` before attempting any DB connection
   or HTTP listen.
4. You can confirm the exit code from a shell with `echo $?` (bash) or
   `echo $LASTEXITCODE` (PowerShell) right after the process exits.

### E0-9 — in-flight request survives `SIGTERM`, then the process exits 0

1. Temporarily add (or use a debugger breakpoint on) a slow test route, e.g. a
   handler that awaits `setTimeout(resolve, 5000)` before responding — or reuse
   `createApp({ registerTestRoutes })` from a throwaway script.
2. Start the server: `npm run dev`.
3. Send a request to the slow route (e.g. `curl http://localhost:3000/__slow`).
4. While that request is still in flight, send `SIGTERM` to the process
   (`kill -TERM <pid>` on Linux/macOS, or `Stop-Process -Id <pid>` /
   Ctrl+C on the same terminal on Windows — Ctrl+C actually sends `SIGINT`,
   which follows the identical shutdown path).
5. **Expected:** the log shows `shutdown iniciado`, the in-flight request still
   completes successfully (the client receives its response), and only
   afterwards does the process exit with code `0`.

## No secrets

`.env` is git-ignored. `.env.example` only contains non-sensitive placeholder
values. Never commit real MongoDB URIs, credentials or API keys.
