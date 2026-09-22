## Why

`auth-firebase` established who is calling, but there is still nothing in the system that belongs to a particular user. This stage adds the first one: a per-user watchlist of coins to follow. It is also the first place where "user A must not be able to read or delete user B's data" is a requirement rather than an observation, so it is where the project's isolation rule gets written down and tested. Alongside it, the admin surface gains real write power — adding and deactivating the coins the whole system tracks — which until now only the seed script could do.

## What Changes

- Add the `watchlist_items` collection, one document per user-and-coin pair, with a unique compound index on `{ userId, coinId }` that makes duplicates impossible at the database level rather than through application logic.
- Add the authenticated watchlist endpoints: `GET /api/v1/me/watchlist` (unpaginated by design, sortable by added date, name, 24h change or market cap, joined to `coins` with `$lookup`), `POST`, `PATCH /:coingeckoId` and `DELETE /:coingeckoId`.
- Enforce a per-user cap of `WATCHLIST_MAX_ITEMS` (default 50), with the count-then-insert race accepted and documented as a known limitation.
- Add the project-wide isolation rule: every query in this module filters by the authenticated user's id, no endpoint accepts a `userId` from the client in any position, and services take `userId` as an explicit first parameter.
- Add the admin coin management endpoints: `GET /api/v1/admin/coins` (including inactive coins, each with a `watchersCount`), `POST /api/v1/admin/coins` (validated against CoinGecko, creating or reactivating) and `PATCH /api/v1/admin/coins/:coingeckoId` (activate/deactivate). Coins are never deleted — deactivation is the only removal, so history survives and references never dangle.
- Add `usersService.deleteAccount(userId)` so `DELETE /api/v1/me` deletes the user's watchlist items before the user document, in a repeatable order that is safe to re-run after a partial failure.
- Make `COINGECKO_API_KEY` required for the API process as well as the worker, since the admin coin endpoints now call CoinGecko, and add an **optional, disabled-by-default** `coingecko` readiness check.
- Add the stage's new environment variable `WATCHLIST_MAX_ITEMS`.
- No multiple watchlists per user, no user-submitted requests for new coins, and no manual ordering of items — out of scope here, as the source requirement document states.

## Capabilities

### New Capabilities
- `watchlist-store`: the `watchlist_items` collection — its fields (`userId`, `coinId`, `note`, `addedAt`, `updatedAt`), the unique compound index on `{ userId, coinId }`, the supporting indexes on `{ userId, addedAt }` and `{ coinId }`, and the `WATCHLIST_MAX_ITEMS` cap.
- `watchlist-read-api`: `GET /api/v1/me/watchlist` — the `$match`/`$lookup`/`$unwind`/`$sort` aggregation, the four sort options, the deliberate absence of pagination, the display of deactivated coins with their frozen `latest`, the `{ data, meta: { count, max } }` envelope and the `private, no-cache` header.
- `watchlist-write-api`: `POST` (the fixed validation order producing 400, 404, 422 `LIMIT_REACHED` and 409 `CONFLICT`, plus the `Location` header), `PATCH /:coingeckoId` (note editing, working for deactivated coins) and `DELETE /:coingeckoId` (idempotent 204 even when nothing was deleted).
- `user-data-isolation`: the rule that every watchlist query filters by the authenticated user's `_id`, that no endpoint accepts a client-supplied `userId`, and that services receive `userId` as an explicit parameter.
- `admin-coin-management`: `GET /api/v1/admin/coins` with `watchersCount`, `POST /api/v1/admin/coins` validating against CoinGecko (201 create, 200 reactivate, 409 already active, 422 unknown id, 502 upstream failure) with an `info` audit log naming the acting admin, `PATCH /api/v1/admin/coins/:coingeckoId` toggling `isActive` and returning `watchersCount`, and the documented reason there is no delete.
- `account-deletion-cascade`: `usersService.deleteAccount(userId)` — the dependents-before-owner ordering, its idempotence under partial failure, and the rule that each module deletes its own data rather than the users module reaching into foreign collections.

### Modified Capabilities
- `me-endpoints`: `DELETE /api/v1/me` now delegates to `usersService.deleteAccount(userId)`, which removes the user's watchlist items before the user document.
- `health-checks`: the readiness check list gains an optional `coingecko` entry, disabled by default so an upstream outage cannot take the API out of rotation.
- `worker-process`: `COINGECKO_API_KEY` is now required by the API entrypoint as well, since the admin coin endpoints call CoinGecko; the previous statement that the API does not need it no longer holds.

## Impact

- Adds `src/modules/watchlist/` (model, schemas, service, controller, routes) following the per-domain folder convention.
- Extends `src/modules/coins/` with the admin service, controller and routes, and with the `watchersCount` aggregation over `watchlist_items`.
- Extends `src/modules/users/` with `deleteAccount(userId)`, which calls the watchlist service rather than deleting from a foreign collection directly.
- Extends the readiness check list in the health module with the optional `coingecko` entry.
- Moves the API's `COINGECKO_API_KEY` assertion from worker-and-scripts-only to all entrypoints, and constructs the CoinGecko client in `src/server.ts`.
- Extends `.env.example`, the config schema, the README and the `.http` collection.
- No change to `price_snapshots`, to the polling job, or to any public read endpoint; the `coins` document shape is unchanged, only its lifecycle gains admin-driven transitions.
