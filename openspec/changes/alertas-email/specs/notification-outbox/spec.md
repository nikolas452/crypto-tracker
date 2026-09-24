## ADDED Requirements

### Requirement: Notification document shape

The system SHALL define a `notifications` collection with `_id` (ObjectId, exposed as `id`), `userId` (ObjectId), `alertId` (ObjectId), `channel` (enum `email`), `to` (string, the user's email at the moment of the trigger), `status` (enum `pending`/`sending`/`sent`/`failed`/`cancelled`), `dedupeKey` (string), `payload` (object), `attempts` (integer, default 0), `maxAttempts` (integer, default `NOTIFY_MAX_ATTEMPTS`), `nextAttemptAt` (Date, set to `now` on creation), `lockedAt` (Date or null), `lockedBy` (string or null), `lastError` (`{ code, message, permanent }` or null), `sentAt` (Date or null), `providerMessageId` (string or null), and `createdAt`/`updatedAt` timestamps.

#### Scenario: Notification document matches the fixed shape

- **WHEN** a notification is created by a trigger
- **THEN** it has `userId`, `alertId`, `channel`, `to`, `status`, `dedupeKey`, `payload`, `attempts`, `maxAttempts` and `nextAttemptAt`

#### Scenario: A new notification is immediately claimable

- **WHEN** a notification is created
- **THEN** its `status` is `"pending"`, its `attempts` is 0 and its `nextAttemptAt` is the creation time

### Requirement: Frozen event snapshot

The system SHALL store in `payload` the values describing the event at the moment of the trigger — `coingeckoId`, `coinName`, `symbol`, `alertType`, `threshold`, `value`, `priceUsd`, `change24hPct`, `triggeredAt` and `note` — and SHALL store the recipient address in `to` at the same moment, so the rendered email describes what happened rather than the current state.

#### Scenario: A later price change does not alter a queued notification

- **WHEN** the coin's price changes after a notification is created but before it is sent
- **THEN** the notification's `payload` still holds the values captured at the trigger

#### Scenario: A later alert edit does not alter a queued notification

- **WHEN** the user changes the alert's threshold after a notification is created
- **THEN** the notification's `payload.threshold` still holds the threshold that actually fired

### Requirement: Unique dedupe key

The system SHALL set `dedupeKey` to `${alertId}:${triggerCount}` and enforce a unique index on `{ dedupeKey: 1 }`, so the same trigger can never produce two notifications.

#### Scenario: A repeated insert for the same trigger is rejected by the index

- **WHEN** a second insert is attempted with the same `dedupeKey`
- **THEN** it fails with a duplicate-key error

### Requirement: Notification indexes and retention

The system SHALL maintain indexes on `{ dedupeKey: 1 }` (unique), `{ status: 1, nextAttemptAt: 1 }` for claiming, `{ status: 1, lockedAt: 1 }` for stale-lock recovery, `{ userId: 1, createdAt: -1 }` for the user listing and `{ alertId: 1, status: 1 }`, plus a TTL index on `createdAt` using `NOTIFICATIONS_RETENTION_DAYS` (default 90).

#### Scenario: The claim query is served by an index

- **WHEN** the claim query filtering on `status` and `nextAttemptAt` is explained
- **THEN** the winning plan uses the `{ status: 1, nextAttemptAt: 1 }` index

#### Scenario: TTL index exists with the configured retention

- **WHEN** the `notifications` collection is inspected
- **THEN** a TTL index on `createdAt` exists with `expireAfterSeconds` matching `NOTIFICATIONS_RETENTION_DAYS × 86400`

### Requirement: User notification history endpoint

The system SHALL expose `GET /api/v1/me/notifications`, guarded by `requireAuth` and filtered by the caller's `userId`, with a strict query schema accepting `status`, `page` and `limit`, returning `id`, `alertId`, `status`, `payload`, `attempts`, `sentAt`, `createdAt` and a masked form of `to`.

#### Scenario: A user reads only their own notifications

- **WHEN** a user lists their notifications
- **THEN** the response contains only notifications whose `userId` is theirs

#### Scenario: The recipient address is masked

- **WHEN** a notification is returned to a user
- **THEN** its `to` value is masked rather than the full address

### Requirement: Internal fields are never exposed to users

The system SHALL NOT include `lockedBy`, `dedupeKey` or the full `lastError` in the user-facing notification response; when a notification failed, only `lastError.code` SHALL be shown.

#### Scenario: A failed notification exposes only its error code

- **WHEN** a user reads a notification whose status is `failed`
- **THEN** the response includes `lastError.code` and contains no `lockedBy`, no `dedupeKey` and no internal error message
