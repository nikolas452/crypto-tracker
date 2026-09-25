## Why

Every endpoint `api-rest` added is public, and the admin surface is guarded by a single shared `X-Admin-Key` that has no identity, no rotation story and no per-caller accountability. Before the project can hold per-user data — watchlists in the next stage, price alerts two stages later — it needs to know _who_ is calling. This stage delegates identity to Firebase Auth (the backend only verifies ID tokens and never sees a password), creates the user's profile in Mongo the first time a valid token appears, and replaces the provisional admin key with an authenticated `admin` role.

## What Changes

- Add `firebase-admin` 14.x initialization that runs exactly once, normalizes the escaped newlines in `FIREBASE_PRIVATE_KEY`, and refuses to start in `production` when the Auth emulator is configured.
- Add a `TokenVerifier` abstraction with a real implementation over `getAuth().verifyIdToken` and a `FakeTokenVerifier` for tests, plus a fixed table translating Firebase error codes into the project's error hierarchy.
- Add the `users` collection (`firebaseUid` unique, `email`, `emailVerified`, `displayName`, `role`, `lastSeenAt`) with just-in-time provisioning: the first valid token for an unknown uid creates the profile, and the duplicate-key race between concurrent first requests is handled explicitly.
- Add `requireAuth` (Bearer only, never query string or body, oversized tokens rejected before verification, optional `checkRevoked`) and `requireRole(...roles)` middlewares, plus the Express `Request` type augmentation and a `getUser(req)` helper.
- Add `GET /api/v1/me`, `PATCH /api/v1/me` (only `displayName` is editable — the notification address is always the verified account email) and `DELETE /api/v1/me` (204, deletes app data only).
- Add a second rate limiter keyed by `req.auth.uid` on authenticated routes, coexisting with the global per-IP limiter.
- **BREAKING** Replace the `X-Admin-Key` protection on `/api/v1/admin/*` with `requireAuth({ checkRevoked: true })` + `requireRole('admin')`, and remove the `requireAdminKey` middleware and the `ADMIN_API_KEY` variable entirely.
- Add the development scripts `auth:create-test-user`, `auth:token` and `user:set-role`, all of which refuse to run with `NODE_ENV=production`, plus documented support for the local Firebase Auth emulator (there is no frontend, so these are the only way to obtain a token).
- Add the stage's new environment variables: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_EMULATOR_HOST`, `USER_RATE_LIMIT_PER_MIN` and `LAST_SEEN_THROTTLE_MIN`; remove `ADMIN_API_KEY`.
- No login, registration, password handling or social OAuth (Firebase owns all of it), no separate notification email, and no Firebase custom claims for roles — the role lives in Mongo, as the source requirement document states.

## Capabilities

### New Capabilities

- `firebase-admin-init`: single-initialization of the Firebase Admin app, private-key newline normalization, emulator detection with a `warn` log, the hard refusal to run the emulator in `production`, and fail-fast configuration when credentials are missing and no emulator is configured.
- `token-verification`: the `TokenVerifier` contract, its real `verifyIdToken`-based implementation, the fixed Firebase-error-to-`AppError` translation table, the `FakeTokenVerifier` used by tests, and the rule that the verifier is injected through `createApp(deps)`.
- `auth-middleware`: `requireAuth` — Bearer scheme parsing, the pre-verification length cap, the `checkRevoked` option, population of `req.auth` and `req.user`, the prohibition on accepting tokens from query strings or bodies, and the guarantee that tokens are never logged — together with the `Request` type augmentation and the `getUser(req)` helper.
- `user-profile`: the `users` collection and `resolveFromIdentity` — just-in-time creation, `E11000` race handling, email/`emailVerified` synchronization from the token, throttled `lastSeenAt` updates, and the at-most-one-read-and-one-write budget per authenticated request.
- `me-endpoints`: `GET /api/v1/me`, `PATCH /api/v1/me` (strict body, `displayName` only, email deliberately not editable) and `DELETE /api/v1/me` (204, app data only, Firebase account retained).
- `role-authorization`: `requireRole(...roles)`, its 403 `FORBIDDEN` response, and its application to every `/api/v1/admin/*` route together with `requireAuth({ checkRevoked: true })`.
- `user-rate-limiting`: the per-uid limiter of `USER_RATE_LIMIT_PER_MIN` requests per minute applied after `requireAuth`, coexisting with the global per-IP limiter from `api-rate-limiting`.
- `auth-dev-scripts`: `auth:create-test-user`, `auth:token` (printing only the ID token to stdout so it can be captured into a shell variable) and `user:set-role`, their production refusal, and the documented Firebase Auth emulator workflow.

### Modified Capabilities

- `admin-api-key`: **removed entirely** — the `requireAdminKey` middleware, the `X-Admin-Key` header contract and the `ADMIN_API_KEY` variable are deleted and replaced by authenticated role checks.
- `admin-job-runs-api`: the two job-run endpoints are now guarded by `requireAuth({ checkRevoked: true })` + `requireRole('admin')` instead of the admin key; a request with no token receives 401 and an authenticated non-admin receives 403.

## Impact

- Adds `src/integrations/firebase/` (admin app initialization, `TokenVerifier` implementation, error translation).
- Adds `src/modules/users/` (model, schemas, service, controller, routes) following the per-domain folder convention.
- Adds `src/middlewares/requireAuth.ts` and `src/middlewares/requireRole.ts`, and deletes `src/middlewares/requireAdminKey.ts`.
- Adds `src/types/express.d.ts` augmenting `Express.Request` with `id`, `auth` and `user`.
- Adds `src/scripts/createTestUser.ts`, `src/scripts/authToken.ts` and `src/scripts/setRole.ts`, plus the matching npm scripts.
- Changes `createApp(deps)` to accept the `TokenVerifier` so integration tests can inject `FakeTokenVerifier`.
- Extends `.env.example`, the config schema, the README (emulator setup, token workflow, the documented consequence of deleting a Mongo user while the Firebase account survives) and the `.http` collection.
- Adds `firebase-admin` 14.x as a dependency.
- Removes `ADMIN_API_KEY` from the config schema and `.env.example`.
- The `/api/v1/admin/*` route contract changes for any existing caller, which is why the change is marked breaking; no data migration is required, since the `users` collection starts empty and fills itself on first use.
