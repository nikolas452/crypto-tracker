## 1. Config and wiring

- [x] 1.1 Extend `src/config/env.ts` with `WATCHLIST_MAX_ITEMS` (default 50) and make `COINGECKO_API_KEY` required for the API entrypoint as well as the worker and scripts.
- [x] 1.2 Construct the CoinGecko client in `src/server.ts` and pass it into `createApp(deps)` for the admin coin endpoints.
- [x] 1.3 Update `.env.example` with `WATCHLIST_MAX_ITEMS` and the note that `COINGECKO_API_KEY` is now required by both processes.

## 2. Watchlist model (watchlist-store)

- [x] 2.1 Implement the `watchlist_items` Mongoose model: `userId`, `coinId`, `note` (≤ 200 chars, trimmed, nullable), `addedAt`, `updatedAt`.
- [x] 2.2 Add the unique compound index `{ userId: 1, coinId: 1 }` plus `{ userId: 1, addedAt: -1 }` and `{ coinId: 1 }`.
- [x] 2.3 Integration test: the unique compound index exists and rejects a duplicate pairing while allowing the same coin for two different users.

## 3. Watchlist read endpoint (watchlist-read-api)

- [x] 3.1 Implement the strict query schema (`sort`, `order`) with defaults.
- [x] 3.2 Implement the aggregation: `$match` on `userId` → `$lookup` to `coins` projecting `coingeckoId`, `symbol`, `name`, `isActive`, `latest` → `$unwind` → `$sort`.
- [x] 3.3 Implement the output DTO and the `{ data, meta: { count, max } }` envelope, exposing no `_id`, `userId` or `__v`.
- [x] 3.4 Set `Cache-Control: private, no-cache` on the response.
- [x] 3.5 Integration test **E4-13**: `sort=change24h&order=desc` orders by `latest.change24hPct` descending.
- [x] 3.6 Integration test for **RNF-4.2**: `explain` on the listing query shows an `IXSCAN` on `{ userId: 1, addedAt: -1 }`.
- [x] 3.7 Document the no-pagination decision and its dependence on `WATCHLIST_MAX_ITEMS`.

## 4. Watchlist write endpoints (watchlist-write-api, user-data-isolation)

- [x] 4.1 Implement the `coingeckoId` path normalization (lowercase) shared by `PATCH` and `DELETE`.
- [x] 4.2 Implement `POST /api/v1/me/watchlist` with the fixed validation order: body (400) → coin exists and active (404) → count below cap (422 `LIMIT_REACHED`) → insert.
- [x] 4.3 Translate `E11000` from the unique index into 409 `CONFLICT`.
- [x] 4.4 Return 201 with the item in listing shape and a `Location: /api/v1/me/watchlist/<coingeckoId>` header.
- [x] 4.5 Implement `PATCH /api/v1/me/watchlist/:coingeckoId` with a strict `{ note }` body, resolving the coin whether active or not and the item by `{ userId, coinId }`, 404 when absent.
- [x] 4.6 Implement `DELETE /api/v1/me/watchlist/:coingeckoId` returning 204 unconditionally, and 400 only when the id fails pattern validation.
- [x] 4.7 Ensure every watchlist service function takes `userId` as an explicit first parameter and that no route reads a `userId` from body, query or params.
- [x] 4.8 Unit tests with fake repositories: the RF-4.2 validation order, and the `E11000` → `ConflictError` translation.
- [x] 4.9 Integration tests **E4-1** (add then list), **E4-2** (duplicate → 409), **E4-3** (unknown or inactive coin → 404), **E4-4** (cap → 422 `LIMIT_REACHED`), **E4-6** (double delete → 204/204) and **E4-7** (patch a coin not followed → 404).
- [x] 4.10 Integration test **E4-5** with two distinct fake tokens: A's addition leaves B's list empty, and B's delete of the same coin does not affect A.
- [x] 4.11 Integration test: two concurrent identical `POST` requests via `Promise.all` yield exactly one 201 and one 409.
- [x] 4.12 Document the non-atomic cap check and its accepted overshoot.

## 5. Admin coin management (admin-coin-management)

- [x] 5.1 Implement `GET /api/v1/admin/coins`: paginated, includes inactive coins, optional `isActive` filter, `watchersCount` via a `$group` over `watchlist_items` restricted to the page's coin ids.
- [x] 5.2 Implement `POST /api/v1/admin/coins`: strict `{ coingeckoId }` body, validation through `getMarkets([id])`, 422 `UNKNOWN_COINGECKO_ID` when not returned, 502 `UPSTREAM_ERROR` when the call fails.
- [x] 5.3 Implement the create (201), reactivate (200) and already-active (409) outcomes, refreshing `name` and `symbol` from CoinGecko on create and reactivate.
- [x] 5.4 Implement `PATCH /api/v1/admin/coins/:coingeckoId` with a strict `{ isActive }` body, responding 200 with the coin and its `watchersCount`.
- [x] 5.5 Add `info` audit logging naming the acting admin's `userId` on every coin create, reactivate and activation change.
- [x] 5.6 Unit tests with a fake CoinGecko client: create, reactivate, conflict, unknown id and upstream failure.
- [x] 5.7 Integration tests **E4-9** (role `user` → 403), **E4-10** (unknown id → 422 `UNKNOWN_COINGECKO_ID`), **E4-11** (inactive coin reactivated → 200) and **E4-8** (deactivated coin still listed with `isActive: false`, and the next job run does not request it).
- [x] 5.8 Document why no coin delete endpoint exists (history loss and dangling references).

## 6. Account deletion cascade (account-deletion-cascade, me-endpoints)

- [x] 6.1 Implement `usersService.deleteAccount(userId)` calling the watchlist module's own deletion function before deleting the user document.
- [x] 6.2 Change `DELETE /api/v1/me` to delegate to `deleteAccount`.
- [x] 6.3 Make the cascade idempotent so a repeat run after a partial failure completes cleanly.
- [x] 6.4 Integration test **E4-12**: a user with 3 items calls `DELETE /me` and no `watchlist_items` with that `userId` remain.

## 7. Readiness check (health-checks)

- [x] 7.1 Add the optional `coingecko` entry to the readiness check list, disabled by default.
- [x] 7.2 Integration test: with the check disabled, an unreachable CoinGecko leaves `/health/ready` responding 200.

## 8. Documentation and Definition of Done

- [x] 8.1 Update the README with the new endpoints, `WATCHLIST_MAX_ITEMS`, the now-required `COINGECKO_API_KEY` for the API, the accepted cap overshoot, the no-delete-for-coins rationale, and the quota note that each admin coin creation consumes one CoinGecko call.
- [x] 8.2 Update the `.http` collection with the watchlist and admin coin endpoints.
- [x] 8.3 Verify **RNF-4.3**: no watchlist response contains `userId` or an internal `_id`.
- [x] 8.4 Measure **RNF-4.1**: `GET /me/watchlist` with 50 items responds with p95 under 50 ms locally, and document the result.
- [x] 8.5 Confirm `typecheck`, `lint` and `test` all pass locally and in CI, and that no secret appears in the repo or its history.
