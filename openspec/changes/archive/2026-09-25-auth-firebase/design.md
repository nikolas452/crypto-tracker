## Context

`api-rest` left the project with a fully public read API and a single shared admin key. This stage introduces identity. The decision to use Firebase Auth was made project-wide: the backend never handles passwords, never stores credentials, and only verifies signed ID tokens against Google's public keys. What this stage actually has to design is the seam between _Firebase's_ identity and _this application's_ user record — when the record is created, what is synchronized onto it, how much writing that costs per request, and where authorization decisions read from.

There is no frontend, so obtaining a token is itself a development problem this stage has to solve with scripts.

## Goals / Non-Goals

**Goals:**

- Authentication that is testable without network access: every test path uses an injected fake verifier, never a real Firebase project.
- A user record that appears automatically and correctly under concurrency, without a registration endpoint.
- Authorization decisions that take effect immediately, not whenever a client happens to refresh its token.
- A hard boundary against configuration mistakes: a production process must not be able to talk to an emulator.

**Non-Goals:**

- No login, registration, password reset or social providers — Firebase owns all of it, and adding any of it here would duplicate an external system.
- No custom claims. Roles live in Mongo only.
- No session store, refresh-token handling or token revocation list of our own.
- No separate notification email address. This is a deliberate security boundary, not an omission — see Decisions.

## Decisions

- **The role is stored in Mongo and read on every request, not carried in the token**: Firebase custom claims would embed the role in the ID token, which means a demotion only takes effect when the client next refreshes — up to an hour later. Reading `req.user.role` from the freshly-resolved user document makes a role change effective on the very next request. _Rationale_: the entire point of an authorization check is that it is current. _Trade-off accepted_: the role check costs the user lookup that `requireAuth` already performs, so it adds no extra read.

- **`checkRevoked` is off by default and on only for destructive or privileged operations**: `verifyIdToken` normally verifies a signature against cached public keys with no network round trip; `checkRevoked: true` adds a call to Firebase on every request. It is enabled for `DELETE /me` and for all `/admin` routes. _Rationale_: paying a network round trip on every read to shorten a worst-case one-hour revocation window is a bad trade for the endpoints that only read public-ish data, and a good trade for the ones that delete data or grant privileged access. The consequence — a disabled user keeps working on ordinary routes until their token expires — is a known, documented limitation rather than an oversight.

- **Just-in-time provisioning instead of a registration endpoint**: the first valid token for an unknown `firebaseUid` creates the profile through a single `findOneAndUpdate` with `upsert: true`, splitting fields between `$setOnInsert` (role, displayName) and `$set` (email, emailVerified, lastSeenAt). _Rationale_: a registration endpoint would be a second source of truth for "does this user exist", and it could be skipped by a client that already holds a token. Provisioning on first sight makes the two systems impossible to desynchronize. The unique index on `firebaseUid` is what makes it safe: under a concurrent burst, at most one insert wins and the loser retries once with a plain `findOne` (E3-5).

- **A request writes to `users` only when something actually changed**: the sync step compares the token's `email`/`emailVerified` against the stored values and compares `lastSeenAt` against `now - LAST_SEEN_THROTTLE_MIN`, then issues **one** `updateOne` if either check demands it and none otherwise. _Rationale_: without the throttle, every authenticated request would be a write, turning a read-heavy API into a write-heavy one for no benefit. RNF-3.5's budget of at most one read and one write per request is the concrete form of this decision.

- **The notification address is always the verified account email, and `PATCH /me` cannot change it**: `PATCH /me` accepts only `displayName`, and any other field — including `role` — is a 400 from the strict schema. _Rationale_: this is a security decision, not a simplification. If a user could set an arbitrary notification address, stage 5's alert emails would become a way to send mail to a third party from this application's domain. Tying delivery to an address Firebase has verified removes that entire class of abuse.

- **`requireAuth` rejects oversized tokens before verifying them**: anything over 4,096 characters is a 401 without calling the verifier. _Rationale_: signature verification on attacker-controlled input should not be reachable with unbounded input length. Tokens are also accepted _only_ from the `Authorization` header — never a query string, which would leak them into access logs and browser history, and never a body, which would make them invisible to the header redaction already configured in pino.

- **`TokenVerifier` is an interface injected through `createApp(deps)`**: the real implementation is constructed once in `server.ts`; tests pass `FakeTokenVerifier`, which resolves a fixed token-to-identity map and can be told to throw each error in the translation table. _Rationale_: this is the same dependency-injection-by-factory pattern the project already uses for the CoinGecko client and the clock, and it is what makes E3-1 through E3-3 plain unit tests. It also means the test suite never needs a Firebase project, honouring the project-wide ban on calling real external services from tests.

- **Firebase errors are translated through a fixed table, not passed through**: `auth/id-token-expired` becomes `UnauthenticatedError` with code `TOKEN_EXPIRED`, `auth/id-token-revoked` becomes `TOKEN_REVOKED`, `auth/user-disabled` becomes `ForbiddenError` with `USER_DISABLED`, argument and signature errors collapse to `UNAUTHENTICATED`, and a network failure during revocation checking becomes `UpstreamError`/`FIREBASE_UNAVAILABLE`. _Rationale_: the project has exactly one error format with a fixed code table; letting a vendor's error shape reach the client would break it. Distinguishing `TOKEN_EXPIRED` from generic `UNAUTHENTICATED` matters because it is the one case where the correct client action is "refresh and retry" rather than "log in again".

- **The emulator is a startup-time fatal error in production, not a runtime check**: if `FIREBASE_AUTH_EMULATOR_HOST` is set while `NODE_ENV=production`, the process exits 1. _Rationale_: an emulator accepts unsigned tokens. A production process pointed at one authenticates anybody. This is the kind of misconfiguration that must be impossible to deploy rather than something to notice in logs.

- **The admin key is deleted, not deprecated**: `requireAdminKey`, the `X-Admin-Key` contract and `ADMIN_API_KEY` are removed in the same change that adds role checks. _Rationale_: leaving both paths active would mean the weaker one defines the security of the admin surface. E3-10 asserts the old header no longer works.

## Risks / Trade-offs

- **[Risk]** A user deleted from Mongo but still present in Firebase is silently re-provisioned as an empty profile on their next request, quietly resurrecting an account the operator believed was gone. → **Mitigation**: this is inherent to just-in-time provisioning and is documented explicitly in the README as the consequence of `DELETE /me` not touching Firebase; the alternative (deleting the Firebase account too) introduces a two-system partial-failure problem and is recorded as an open question below.
- **[Risk]** Without `checkRevoked`, a user disabled in Firebase keeps access to ordinary routes for up to the remaining lifetime of their token (at most one hour). → **Mitigation**: the sensitive operations that could do real damage (`DELETE /me`, everything under `/admin`) do check revocation, so the exposure is bounded to read and watchlist-shaped operations.
- **[Risk]** `FIREBASE_PRIVATE_KEY` is a multi-line secret passed through a single-line environment variable; a mishandled newline produces a signature failure that looks like "all tokens are invalid" rather than "the key is malformed". → **Mitigation**: the normalization step is a unit-tested pure function, and configuration failure is fail-fast at startup with the variable named but never printed.
- **[Risk]** A user authenticated through a provider with no email (anonymous or phone) gets `email: null`, which stage 5 will have to refuse when creating alerts. → **Mitigation**: the field is explicitly nullable now rather than being discovered later; the alert stage returns 422 for such a user, and that behavior is already specified as part of its contract.
- **[Trade-off]** Throttling `lastSeenAt` means the field can be up to `LAST_SEEN_THROTTLE_MIN` minutes behind reality. Accepted: it exists for coarse "is this account in use" questions, not for auditing.
- **[Trade-off]** Returning 401 rather than 403 when the admin key is gone and no token is present slightly blurs "not authenticated" and "route removed"; the project's error table makes 401 correct for a missing token, and the admin routes now genuinely exist for authenticated admins.

## Migration Plan

1. Create a dedicated Firebase project for this application (separate from any other project the owner runs) with the Email/Password provider enabled, and load its service-account credentials as environment variables.
2. Deploy the change. `users` starts empty; no backfill exists or is needed, because the collection populates itself on first authenticated request.
3. Call any authenticated endpoint once with the owner's token to provision the owner's profile, then promote it with `npm run user:set-role -- --email <owner> --role admin`. Until this runs, no one can reach `/admin` — which is the intended failure mode, not a regression.
4. Remove `ADMIN_API_KEY` from every environment.

Rollback means restoring the admin-key middleware and re-adding the variable; the `users` collection can be left in place, since nothing else reads it yet.

## Open Questions

- Should `DELETE /me` also delete the Firebase account (`getAuth().deleteUser(uid)`)? The default specified here is no — app data only. Deleting both introduces a partial-failure case (Mongo succeeds, Firebase fails) that needs its own defined behavior before it can be adopted, so it is deliberately deferred rather than guessed at.
- Should `emailVerified: true` be required to use the watchlist, or only to create alerts? The default specified here is only for alerts, which keeps the next stage unconstrained; if the answer changes, it becomes a validation step in the watchlist service rather than a change to anything in this stage.
