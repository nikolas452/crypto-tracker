## Context

The project now has authenticated users (`auth-firebase`) and a coin catalog with a live `latest` projection (`api-rest`), but no data that belongs to a user. This stage introduces that relationship and, with it, two questions the project has not had to answer before: how to model a many-to-many link in MongoDB, and how to guarantee that one user's request can never reach another user's rows. It also hands the admin real authority over the catalog, which previously only the seed script could change.

The functional shape is fixed by `requerimientos/05-etapa-4-watchlists.md`. This document records why the modelling choices were made and where a limitation is being accepted deliberately.

## Goals / Non-Goals

**Goals:**
- Model the user-to-coin relationship so that duplicates are impossible at the database level, not merely unlikely.
- Make cross-user access structurally impossible rather than defended against case by case.
- Give the admin a way to change what the system tracks without ever destroying history.
- Keep the watchlist read cheap enough that pagination is genuinely unnecessary.

**Non-Goals:**
- No multiple named watchlists per user. There is exactly one, implied by the user's identity.
- No user-submitted requests to add coins. Adding a coin is an admin action.
- No manual ordering of items. Sorting is by a chosen field, not by a stored position.
- No coin deletion endpoint, at all — see Decisions.

## Decisions

- **One document per item, referencing both sides, rather than an array embedded in the user**: the obvious alternative is `users.watchlist: [coinId]`. It is rejected for three reasons. The list changes often, so an embedded array means rewriting the user document on every add and remove. The coin's interesting data (`latest`) is live state that changes every ten minutes, so it cannot be embedded anyway and would have to be looked up regardless. And a separate document lets a unique compound index on `{ userId, coinId }` enforce "no duplicates" in the database, whereas an array would need `$addToSet` plus application logic to produce a meaningful 409. *Rationale*: the index is the whole argument — it turns a race condition into a caught `E11000`.

- **Isolation is a filter in the service, and `userId` is never accepted from the client**: every query carries `userId: req.user._id`, no route reads a `userId` from body, query or params, and services take `userId` as their explicit first parameter rather than digging it out of a context object. *Rationale*: this is the IDOR defence, and making it a parameter rather than ambient state means a service that forgets to scope its query does not compile cleanly — the argument is right there, unused. The `DELETE` and `PATCH` routes identify the item by `coingeckoId` within the caller's own watchlist, so there is no item id in any URL that could be swapped for someone else's.

- **The 50-item cap is checked before insert and is deliberately not atomic**: counting and then inserting leaves a window in which two concurrent requests both see 49 and both insert, producing 51 items. This is accepted and documented rather than solved. *Rationale*: the correct fix is a counter on the user document updated with a conditional `$inc`, which adds a second source of truth for the item count and a reconciliation problem of its own. For a personal-scale limit whose only consequence of being exceeded by one is a slightly longer list, that complexity is not worth buying. The alternative is recorded as an open question so the trade-off stays visible.

- **`DELETE` responds 204 even when nothing existed**: deleting an item the user does not have, or a `coingeckoId` that matches no coin at all, still returns 204. *Rationale*: `DELETE` is idempotent by definition — the postcondition "this coin is not in your watchlist" holds either way. Returning 404 would also leak, by omission, whether a given coin exists, and would make a retried delete after a dropped connection look like a failure.

- **A deactivated coin stays visible in the watchlist, with its last known `latest`**: the read endpoint shows it with `isActive: false` and the frozen projection, and `PATCH`/`DELETE` keep working on it. *Rationale*: the user chose to follow it; silently dropping it from their list would look like data loss. Freezing `latest` is automatic rather than designed — the job stops polling inactive coins, so the projection simply stops advancing.

- **Adding a coin to the watchlist requires it to be active, but keeping one does not**: `POST` returns 404 for an inactive coin even though it exists. *Rationale*: the two operations answer different questions. "Start following this" is a request for future data the system will not collect, so it should fail. "Keep showing what I already follow" costs nothing and preserves the user's intent.

- **There is no `DELETE /admin/coins/:id`, only deactivation**: *Rationale*: deleting a coin would orphan every `watchlist_items` row referencing it and strand its snapshots in a time series nothing points at. Soft deactivation keeps the history queryable and the references valid, and it is reversible — `POST /admin/coins` with an existing inactive id reactivates it (200) rather than erroring. The absence of a delete endpoint is a documented decision, not an omission.

- **`POST /admin/coins` validates against CoinGecko before writing**: an unknown id becomes 422 with `reason: UNKNOWN_COINGECKO_ID` and an upstream failure becomes 502. *Rationale*: a typo'd coin id that reached the catalog would be requested by every subsequent poll run forever, consuming quota and showing up as a permanently missing coin in `stats.missingCoins`. Validating once at creation is far cheaper than detecting it later. The distinction between 422 and 502 matters: one means "your id is wrong", the other means "try again".

- **`watchersCount` is computed only for the coins on the requested page**: a `$group` over `watchlist_items` restricted to that page's coin ids. *Rationale*: computing it for the whole catalog to serve twenty rows would scale with total watchlist size rather than page size, and the `{ coinId: 1 }` index exists precisely to make the restricted grouping cheap.

- **Cascade deletion is orchestrated by the users service but performed by each module**: `deleteAccount(userId)` calls the watchlist service's own delete function rather than issuing `deleteMany` against `watchlist_items` itself. *Rationale*: the users module should not know the shape of another module's collection. When stage 5 adds alerts and notifications to the cascade, it adds a call, not knowledge of another schema.

- **The `coingecko` readiness check is added but disabled by default**: *Rationale*: readiness controls whether a platform routes traffic to the instance. If a CoinGecko outage made the API report not-ready, the deploy platform would pull a perfectly functional API — one whose read endpoints do not touch CoinGecko at all — out of rotation. The check exists for diagnostics, off by default on purpose.

## Risks / Trade-offs

- **[Risk]** The non-atomic limit check allows a user to momentarily hold `WATCHLIST_MAX_ITEMS + 1` items under concurrent requests. → **Mitigation**: accepted and documented; the overshoot is bounded by the number of simultaneous requests, self-corrects as soon as the user removes anything, and has no effect beyond list length.
- **[Risk]** Making `COINGECKO_API_KEY` required for the API means a missing key now prevents the API from starting, where previously only the worker was affected. → **Mitigation**: this is fail-fast behavior consistent with every other required variable, and the failure names the variable at startup rather than surfacing as a 500 the first time an admin adds a coin.
- **[Risk]** `$lookup` on every watchlist read is a join, and joins are the classic thing that stops scaling. → **Mitigation**: it runs over at most `WATCHLIST_MAX_ITEMS` documents for one user, matched by the `{ userId, addedAt }` index first, and joins on `coins._id`, the primary key. RNF-4.2 makes the index use verifiable with `explain`.
- **[Risk]** An admin deactivating a widely-followed coin silently changes what many users see. → **Mitigation**: `watchersCount` is returned by both the list and the `PATCH` response specifically so the admin sees the blast radius; no further guard is specified, as the source document explicitly declines special treatment.
- **[Trade-off]** The watchlist read is unpaginated. This is safe only because the cap is enforced; if `WATCHLIST_MAX_ITEMS` were ever raised substantially, pagination would have to come with it. The coupling is documented rather than designed around.
- **[Trade-off]** Notes are stored and returned as literal text with no HTML escaping at the API boundary. Accepted: the API is not a renderer, and escaping at storage time would corrupt the stored value. The one place it matters — the alert email in the next stage — escapes at render time, which is where escaping belongs.

## Migration Plan

Purely additive. `watchlist_items` is a new, initially empty collection; no existing document changes shape. The only ordering constraint is that `COINGECKO_API_KEY` must be present in the API's environment before this version starts, since it is now required at boot. Rollback means removing the routes and the collection; nothing else depends on it yet.

## Open Questions

- Should the per-user item cap be made strictly atomic with a counter on the user document and a conditional `$inc`, or is the documented overshoot acceptable? The default specified here is to accept it. Changing the answer later is contained entirely within the watchlist service and the user schema.
- The source document leaves unresolved whether `emailVerified: true` should be required to use the watchlist or only to create alerts (carried over from the previous stage's open questions). This change assumes **not** required for the watchlist, which keeps the watchlist usable by accounts that cannot yet receive email. If that changes, it becomes one validation step in the watchlist write service.
