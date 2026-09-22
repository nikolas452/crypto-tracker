## 1. Config, dependencies and cleanup

- [ ] 1.1 Add `firebase-admin` 14.x to dependencies.
- [ ] 1.2 Extend `src/config/env.ts` with `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_WEB_API_KEY` (optional, scripts only), `FIREBASE_AUTH_EMULATOR_HOST` (optional), `USER_RATE_LIMIT_PER_MIN` (default 120) and `LAST_SEEN_THROTTLE_MIN` (default 5); make the three service-account variables required unless an emulator host is configured.
- [ ] 1.3 Remove `ADMIN_API_KEY` from the config schema and from `.env.example`.
- [ ] 1.4 Update `.env.example` with the new variables and a comment each, marking `FIREBASE_PRIVATE_KEY` as a secret.

## 2. Firebase Admin initialization (firebase-admin-init)

- [ ] 2.1 Implement `src/integrations/firebase/admin.ts` using the modular `firebase-admin/app` and `firebase-admin/auth` entry points, reusing the existing app when `getApps()` is non-empty.
- [ ] 2.2 Implement the private-key normalization as a pure, unit-testable function replacing literal `\n` with real newlines.
- [ ] 2.3 Implement the emulator branch: `warn` log when `FIREBASE_AUTH_EMULATOR_HOST` is set outside production.
- [ ] 2.4 Implement the production guard: exit 1 when `FIREBASE_AUTH_EMULATOR_HOST` is set and `NODE_ENV=production` (**E3-13**).
- [ ] 2.5 Unit tests: private-key normalization; single-initialization reuse; production-with-emulator exits 1.

## 3. Token verification (token-verification)

- [ ] 3.1 Define the `TokenVerifier` interface and the `VerifiedIdentity` type.
- [ ] 3.2 Implement the real verifier over `getAuth().verifyIdToken(token, checkRevoked)`, defaulting `checkRevoked` to `false`.
- [ ] 3.3 Implement the Firebase-error translation table (`TOKEN_EXPIRED`, `TOKEN_REVOKED`, `USER_DISABLED`, `UNAUTHENTICATED`, `FIREBASE_UNAVAILABLE`).
- [ ] 3.4 Implement `FakeTokenVerifier` for tests: fixed token-to-identity map plus configurable failures for every row of the table.
- [ ] 3.5 Change `createApp(deps)` to accept and use the injected `TokenVerifier`, constructing the real one only in `src/server.ts`.
- [ ] 3.6 Unit tests: every row of the translation table, driven by simulated errors carrying the matching Firebase `code`.

## 4. User model and provisioning (user-profile)

- [ ] 4.1 Implement the `users` Mongoose model: `firebaseUid` (unique), `email` (lowercase, nullable), `emailVerified`, `displayName` (1-50, trimmed, nullable), `role` (enum, default `user`), `lastSeenAt`, timestamps.
- [ ] 4.2 Add indexes `{ firebaseUid: 1 }` (unique) and `{ email: 1 }`.
- [ ] 4.3 Implement `usersService.resolveFromIdentity(identity, now)`: `findOne` by `firebaseUid`, then the `findOneAndUpdate` upsert with `$setOnInsert` / `$set` split.
- [ ] 4.4 Implement the `E11000` path: retry exactly once with `findOne` and return that document.
- [ ] 4.5 Implement the synchronization decision: update `email`/`emailVerified` only when they differ, refresh `lastSeenAt` only when older than `LAST_SEEN_THROTTLE_MIN`, and combine both into a single `updateOne` issued only when needed.
- [ ] 4.6 Log user creation at `info` with the `userId` and without the email; add the email-masking helper (`n***@example.com`) used by `info` logs.
- [ ] 4.7 Unit tests with a fake clock: **E3-6** (recent `lastSeenAt` untouched, stale one refreshed) and **E3-7** (`emailVerified` synchronized), asserting no write happens when nothing changed; plus the masking helper.
- [ ] 4.8 Integration test **E3-5**: 10 concurrent requests for a new uid via `Promise.all` create exactly 1 document and all respond 200.

## 5. Authentication middleware (auth-middleware)

- [ ] 5.1 Implement `src/middlewares/requireAuth.ts`: parse the `Authorization` header, case-insensitive `Bearer` scheme, reject missing/empty tokens with 401.
- [ ] 5.2 Reject tokens longer than 4096 characters with 401 before calling the verifier.
- [ ] 5.3 Accept the `{ checkRevoked }` option and pass it through to the verifier.
- [ ] 5.4 Populate `req.auth` and, via `resolveFromIdentity`, `req.user`.
- [ ] 5.5 Ensure no code path reads a token from the query string or body.
- [ ] 5.6 Extend the pino `redact` configuration to cover `req.headers.authorization`.
- [ ] 5.7 Implement `src/types/express.d.ts` (augmenting `id`, `auth`, `user`) and the `getUser(req)` helper that throws `UnauthenticatedError`.
- [ ] 5.8 Unit tests with `FakeTokenVerifier`: **E3-1** (no header), **E3-2** (`Basic` scheme), **E3-3** (expired → `TOKEN_EXPIRED`), plus oversized token not reaching the verifier and a query-string token being ignored.

## 6. Role authorization and admin migration (role-authorization, admin-job-runs-api)

- [ ] 6.1 Implement `src/middlewares/requireRole.ts` responding 403 `FORBIDDEN` when `req.user.role` is not accepted.
- [ ] 6.2 Replace the admin-key guard on `/api/v1/admin/*` with `requireAuth({ checkRevoked: true })` + `requireRole('admin')`.
- [ ] 6.3 Delete `src/middlewares/requireAdminKey.ts` and every reference to it.
- [ ] 6.4 Unit tests for `requireRole` (accepted role, rejected role, missing `req.user`).
- [ ] 6.5 Integration tests **E3-9** (role `user` → 403, role `admin` → 200 on `GET /admin/job-runs`) and **E3-10** (old `X-Admin-Key` with no token → 401).

## 7. Me endpoints (me-endpoints)

- [ ] 7.1 Implement `GET /api/v1/me` returning `{ data: { id, email, emailVerified, displayName, role, createdAt } }`.
- [ ] 7.2 Implement `PATCH /api/v1/me` with a strict Zod body of `{ displayName?: string | null }` requiring at least one field.
- [ ] 7.3 Implement `DELETE /api/v1/me` with `requireAuth({ checkRevoked: true })`, deleting the user document and responding 204.
- [ ] 7.4 Integration tests **E3-4** (new uid provisions and returns the profile), **E3-8** (`displayName` accepted, `role` rejected with 400) and **E3-11** (204 and the document is gone).
- [ ] 7.5 Document in the README that the Firebase account survives deletion and that a later request with a valid token re-provisions an empty profile.

## 8. Per-user rate limiting (user-rate-limiting)

- [ ] 8.1 Implement the per-uid limiter of `USER_RATE_LIMIT_PER_MIN` requests per minute, registered after `requireAuth` and keeping the global per-IP limiter in place.
- [ ] 8.2 Integration test **E3-12**: with `USER_RATE_LIMIT_PER_MIN=2`, the same user's third request from a different IP receives 429.

## 9. Development scripts (auth-dev-scripts)

- [ ] 9.1 Implement `npm run auth:create-test-user -- --email --password [--admin]` using `getAuth().createUser({ emailVerified: true })`, creating an `admin` Mongo profile when `--admin` is passed.
- [ ] 9.2 Implement `npm run auth:token -- --email --password` calling `accounts:signInWithPassword`, switching to the emulator URL when `FIREBASE_AUTH_EMULATOR_HOST` is set, printing only the ID token to stdout.
- [ ] 9.3 Implement `npm run user:set-role -- --email --role` with the previous→new output and the actionable message when the user has no Mongo profile.
- [ ] 9.4 Make `auth:create-test-user` and `auth:token` refuse to run when `NODE_ENV=production`.
- [ ] 9.5 Add the three npm scripts to `package.json`.
- [ ] 9.6 Document the emulator workflow in the README (`firebase emulators:start --only auth`, the Java prerequisite verified against Firebase's documentation, and `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`), including manual verification **E3-14**.

## 10. Optional emulator suite and Definition of Done

- [ ] 10.1 (Optional) Add an integration suite against the real Auth emulator guarded by `describe.skipIf(!process.env.FIREBASE_AUTH_EMULATOR_HOST)` that creates a user, obtains a token and calls `/api/v1/me`.
- [ ] 10.2 Update the `.http` collection: `/me` requests with a Bearer token and admin requests using a token instead of `X-Admin-Key`.
- [ ] 10.3 Update the README with the new endpoints, the new variables, the removal of `ADMIN_API_KEY`, and the documented limitation that without `checkRevoked` a disabled user keeps ordinary access until their token expires.
- [ ] 10.4 Verify **RNF-3.2**: no log at any level contains a token, the private key or a full email address.
- [ ] 10.5 Confirm `typecheck`, `lint` and `test` all pass locally and in CI, and that no secret appears in the repo or its history.
