## REMOVED Requirements

### Requirement: Provisional admin key middleware

**Reason**: The `X-Admin-Key` guard was always specified as a placeholder for the admin surface until real identity existed. Keeping it alongside role-based authorization would leave the weaker of the two mechanisms defining the security of `/api/v1/admin`.
**Migration**: Admin routes are now guarded by `requireAuth({ checkRevoked: true })` + `requireRole('admin')` from the `role-authorization` capability. Obtain an ID token with `npm run auth:token`, promote the account once with `npm run user:set-role -- --email <email> --role admin`, and send `Authorization: Bearer <token>` instead of `X-Admin-Key`.

### Requirement: Constant-time key comparison

**Reason**: Removed together with the middleware that performed the comparison.
**Migration**: No replacement is needed; token signature verification is performed by `firebase-admin` through the `token-verification` capability.

### Requirement: Missing or wrong key is unauthenticated

**Reason**: Removed together with the middleware. The 401 response for admin routes is now produced by `requireAuth` when no valid Bearer token is presented.
**Migration**: Callers that previously sent `X-Admin-Key` now receive 401 and must authenticate with a Firebase ID token belonging to an account whose role is `admin`.

### Requirement: Unconfigured admin surface is invisible

**Reason**: The 404-when-unconfigured behavior existed because the admin surface depended on an optional shared secret. Admin routes now always exist and are gated by role instead.
**Migration**: An authenticated non-admin receives 403 `FORBIDDEN`; an unauthenticated caller receives 401 `UNAUTHENTICATED`.

### Requirement: Admin key configuration constraints

**Reason**: `ADMIN_API_KEY` is deleted from the configuration schema.
**Migration**: Remove `ADMIN_API_KEY` from every environment and from `.env.example`.
