## 1. Config, dependencies and cleanup

- [x] 1.1 Add `firebase-admin` 14.x to dependencies.
- [x] 1.2 Extend `src/config/env.ts` with `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_WEB_API_KEY` (optional, scripts only), `FIREBASE_AUTH_EMULATOR_HOST` (optional), `USER_RATE_LIMIT_PER_MIN` (default 120) and `LAST_SEEN_THROTTLE_MIN` (default 5); make the three service-account variables required unless an emulator host is configured.
- [x] 1.3 Remove `ADMIN_API_KEY` from the config schema (done). Removal from `.env.example` is BLOCKED — see 1.4.
- [x] 1.4 Update `.env.example` with the new variables and a comment each, marking `FIREBASE_PRIVATE_KEY` as a secret. Done manually outside the sandbox (the sandbox's permission settings deny all Read/Write/Edit/Bash access to `.env.example` in this repo).

## 2. Firebase Admin initialization (firebase-admin-init)

- [x] 2.1 Implement `src/integrations/firebase/admin.ts` using the modular `firebase-admin/app` and `firebase-admin/auth` entry points, reusing the existing app when `getApps()` is non-empty.
- [x] 2.2 Implement the private-key normalization as a pure, unit-testable function replacing literal `\n` with real newlines.
- [x] 2.3 Implement the emulator branch: `warn` log when `FIREBASE_AUTH_EMULATOR_HOST` is set outside production.
- [x] 2.4 Implement the production guard: exit 1 when `FIREBASE_AUTH_EMULATOR_HOST` is set and `NODE_ENV=production` (**E3-13**).
- [x] 2.5 Unit tests: private-key normalization; single-initialization reuse; production-with-emulator exits 1.

## 3. Token verification (token-verification)

- [x] 3.1 Define the `TokenVerifier` interface and the `VerifiedIdentity` type.
- [x] 3.2 Implement the real verifier over `getAuth().verifyIdToken(token, checkRevoked)`, defaulting `checkRevoked` to `false`.
- [x] 3.3 Implement the Firebase-error translation table (`TOKEN_EXPIRED`, `TOKEN_REVOKED`, `USER_DISABLED`, `UNAUTHENTICATED`, `FIREBASE_UNAVAILABLE`).
- [x] 3.4 Implement `FakeTokenVerifier` for tests: fixed token-to-identity map plus configurable failures for every row of the table.
- [x] 3.5 Change `createApp(deps)` to accept and use the injected `TokenVerifier`, constructing the real one only in `src/server.ts`.
- [x] 3.6 Unit tests: every row of the translation table, driven by simulated errors carrying the matching Firebase `code`.

## 4. User model and provisioning (user-profile)

- [x] 4.1 Implement the `users` Mongoose model: `firebaseUid` (unique), `email` (lowercase, nullable), `emailVerified`, `displayName` (1-50, trimmed, nullable), `role` (enum, default `user`), `lastSeenAt`, timestamps.
- [x] 4.2 Add indexes `{ firebaseUid: 1 }` (unique) and `{ email: 1 }`.
- [x] 4.3 Implement `usersService.resolveFromIdentity(identity, now)`: `findOne` by `firebaseUid`, then the `findOneAndUpdate` upsert with `$setOnInsert` / `$set` split.
- [x] 4.4 Implement the `E11000` path: retry exactly once with `findOne` and return that document.
- [x] 4.5 Implement the synchronization decision: update `email`/`emailVerified` only when they differ, refresh `lastSeenAt` only when older than `LAST_SEEN_THROTTLE_MIN`, and combine both into a single `updateOne` issued only when needed.
- [x] 4.6 Log user creation at `info` with the `userId` and without the email; add the email-masking helper (`n***@example.com`) used by `info` logs.
- [x] 4.7 Unit tests with a fake clock: **E3-6** (recent `lastSeenAt` untouched, stale one refreshed) and **E3-7** (`emailVerified` synchronized), asserting no write happens when nothing changed; plus the masking helper.
- [x] 4.8 Integration test **E3-5**: 10 concurrent requests for a new uid via `Promise.all` create exactly 1 document and all respond 200 — exercised directly against `resolveFromIdentity` per the task's own fallback guidance (Phase B's `requireAuth`/`/me` don't exist yet); see the TODO in `tests/integration/usersProvisioning.test.ts` for the HTTP-level version.

## 5. Authentication middleware (auth-middleware)

- [x] 5.1 Implement `src/middlewares/requireAuth.ts`: parse the `Authorization` header, case-insensitive `Bearer` scheme, reject missing/empty tokens with 401.
- [x] 5.2 Reject tokens longer than 4096 characters with 401 before calling the verifier.
- [x] 5.3 Accept the `{ checkRevoked }` option and pass it through to the verifier.
- [x] 5.4 Populate `req.auth` and, via `resolveFromIdentity`, `req.user`.
- [x] 5.5 Ensure no code path reads a token from the query string or body.
- [x] 5.6 Extend the pino `redact` configuration to cover `req.headers.authorization`. Already covered by Phase A (`req.headers.authorization` is in `REDACT_PATHS`, `src/lib/logger.ts`) — verified, no change needed.
- [x] 5.7 Implement `src/types/express.d.ts` (augmenting `auth`, `user`, and `app.locals.tokenVerifier`) and the `getUser(req)` helper (`src/lib/getUser.ts`) that throws `UnauthenticatedError`. `id` deliberately NOT redeclared: it's already typed by `pino-http` on `http.IncomingMessage` (which `Request` inherits); redeclaring it with a narrower type on `Express.Request` would make `Request` extend two interfaces with an incompatible `id` field (TS2320). See the comment in `express.d.ts`.
- [x] 5.8 Unit tests with `FakeTokenVerifier`: **E3-1** (no header), **E3-2** (`Basic` scheme), **E3-3** (expired → `TOKEN_EXPIRED`), plus oversized token not reaching the verifier and a query-string token being ignored. See `tests/unit/requireAuth.test.ts`.

## 6. Role authorization and admin migration (role-authorization, admin-job-runs-api)

- [x] 6.1 Implement `src/middlewares/requireRole.ts` responding 403 `FORBIDDEN` when `req.user.role` is not accepted.
- [x] 6.2 Replace the admin-key guard on `/api/v1/admin/*` with `requireAuth({ checkRevoked: true })` + `requireRole('admin')`.
- [x] 6.3 Delete `src/middlewares/requireAdminKey.ts` and every reference to it.
- [x] 6.4 Unit tests for `requireRole` (accepted role, rejected role, missing `req.user`). See `tests/unit/requireRole.test.ts`.
- [x] 6.5 Integration tests **E3-9** (role `user` → 403, role `admin` → 200 on `GET /admin/job-runs`) and **E3-10** (old `X-Admin-Key` with no token → 401).

## 7. Me endpoints (me-endpoints)

- [x] 7.1 Implement `GET /api/v1/me` returning `{ data: { id, email, emailVerified, displayName, role, createdAt } }`.
- [x] 7.2 Implement `PATCH /api/v1/me` with a strict Zod body of `{ displayName?: string | null }` requiring at least one field.
- [x] 7.3 Implement `DELETE /api/v1/me` with `requireAuth({ checkRevoked: true })`, deleting the user document and responding 204.
- [x] 7.4 Integration tests **E3-4** (new uid provisions and returns the profile), **E3-8** (`displayName` accepted, `role` rejected with 400) and **E3-11** (204 and the document is gone). See `tests/integration/meApi.test.ts`.
- [x] 7.5 Document in the README that the Firebase account survives deletion and that a later request with a valid token re-provisions an empty profile. See the new "`GET`, `PATCH`, `DELETE /api/v1/me`" section in `README.md`.

## 8. Per-user rate limiting (user-rate-limiting)

- [x] 8.1 Implement the per-uid limiter of `USER_RATE_LIMIT_PER_MIN` requests per minute, registered after `requireAuth` and keeping the global per-IP limiter in place.
- [x] 8.2 Integration test **E3-12**: with `USER_RATE_LIMIT_PER_MIN=2`, the same user's third request from a different IP receives 429. See `tests/integration/userRateLimiting.test.ts` (the limiter keys on `req.auth.uid`, never the source IP, so source-IP diversity is irrelevant to the assertion — verified separately by inspecting `userRateLimiter.ts`'s `keyGenerator`).

## 9. Development scripts (auth-dev-scripts)

- [x] 9.1 Implement `npm run auth:create-test-user -- --email --password [--admin]` using `getAuth().createUser({ emailVerified: true })`, creating an `admin` Mongo profile when `--admin` is passed.
- [x] 9.2 Implement `npm run auth:token -- --email --password` calling `accounts:signInWithPassword`, switching to the emulator URL when `FIREBASE_AUTH_EMULATOR_HOST` is set, printing only the ID token to stdout.
- [x] 9.3 Implement `npm run user:set-role -- --email --role` with the previous→new output and the actionable message when the user has no Mongo profile.
- [x] 9.4 Make `auth:create-test-user` and `auth:token` refuse to run when `NODE_ENV=production`.
- [x] 9.5 Add the three npm scripts to `package.json`.
- [x] 9.6 Document the emulator workflow in the README (`firebase emulators:start --only auth`, the Java prerequisite verified against Firebase's documentation, and `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`), including manual verification **E3-14**.

## 10. Optional emulator suite and Definition of Done

- [x] 10.1 (Optional) Add an integration suite against the real Auth emulator guarded by `describe.skipIf(!process.env.FIREBASE_AUTH_EMULATOR_HOST)` that creates a user, obtains a token and calls `/api/v1/me`.
- [x] 10.2 Update the `.http` collection: `/me` requests with a Bearer token and admin requests using a token instead of `X-Admin-Key`.
- [x] 10.3 Update the README with the new endpoints, the new variables, the removal of `ADMIN_API_KEY`, and the documented limitation that without `checkRevoked` a disabled user keeps ordinary access until their token expires.
- [x] 10.4 Verify **RNF-3.2**: no log at any level contains a token, the private key or a full email address. Grepped every `logger.*(...)` call site in `src/` (see below) — none embed a token, `FIREBASE_PRIVATE_KEY`, or a full email; `pino-http`'s request serializer (`src/middlewares/requestLogger.ts`) is limited to `{ method, url }`/`{ statusCode }` (never bodies or headers), `translateFirebaseAuthError` never carries the token in its message, and `provisionNewUser`'s `info` log already uses `maskEmail`. No change needed.
- [x] 10.5 Confirm `typecheck`, `lint` and `test` all pass locally and in CI, and that no secret appears in the repo or its history. All three pass locally: `npm run typecheck` (clean), `npm run lint` (clean), `npm test` (338 passed, 1 cleanly skipped — the optional emulator suite, since `FIREBASE_AUTH_EMULATOR_HOST` is unset). Grepped for real-looking key material (`BEGIN PRIVATE KEY`, `firebase-adminsdk`, `AIza...`); the only matches are the pre-existing obviously-fake fixtures in `tests/unit/config-env.test.ts` and `tests/unit/firebase-admin.test.ts` (`abc` as the key body, `demo-project` as the project id).
