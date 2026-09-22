## ADDED Requirements

### Requirement: Alert listing endpoint
The system SHALL expose `GET /api/v1/me/alerts`, guarded by `requireAuth` and always filtered by the caller's `userId`, with a strict query schema accepting `status` (one or more values separated by commas), `coingeckoId`, `page` and `limit`. Results SHALL be paginated, ordered by `createdAt` descending, and each item SHALL include its coin (`coingeckoId`, `symbol`, `name`, `isActive`) together with that coin's `latest.priceUsd` and `latest.change24hPct`.

#### Scenario: A user lists only their own alerts
- **WHEN** two users each have alerts and one of them lists
- **THEN** the response contains only that caller's alerts

#### Scenario: Each alert carries its coin's current values
- **WHEN** an alert is returned by the listing
- **THEN** it includes the coin's identity and its `latest.priceUsd` and `latest.change24hPct`

### Requirement: Alert creation validation order
The system SHALL expose `POST /api/v1/me/alerts`, guarded by `requireAuth`, accepting a strict body of `{ coingeckoId, type, threshold, mode?, cooldownMinutes?, rearmPct?, note? }` where the valid range of `threshold` depends on `type`, and SHALL apply its validations in this fixed order: body shape (400), the caller has a verified email (422 with `reason: "EMAIL_NOT_VERIFIED"`), the coin exists and is active (404), and the active-alert cap is not reached (422 with `reason: "LIMIT_REACHED"`).

#### Scenario: A user without a verified email cannot create an alert
- **WHEN** a user whose `emailVerified` is `false` creates an alert
- **THEN** the response is 422 with `details.reason: "EMAIL_NOT_VERIFIED"`

#### Scenario: A threshold outside its type's range is rejected
- **WHEN** a `CHANGE_24H_ABS_GTE` alert is created with a `threshold` of 150
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

#### Scenario: Reaching the active cap is unprocessable
- **WHEN** a user already holds `ALERTS_MAX_ACTIVE` alerts in `armed` or `triggered` and creates another
- **THEN** the response is 422 with `details.reason: "LIMIT_REACHED"`

### Requirement: Created alerts are not evaluated immediately
The system SHALL create the alert in `armed` without evaluating it during the request, and SHALL report in the 201 response's `meta` both `currentValue` and `conditionCurrentlyMet`, so the caller knows the alert will fire on the next job run.

#### Scenario: A satisfied condition is announced but not acted on
- **WHEN** a user creates a `PRICE_BELOW` alert whose threshold is already above the current price
- **THEN** the response is 201 with `meta.conditionCurrentlyMet: true`, the alert's `status` is `"armed"`, and no notification exists yet

### Requirement: Alert detail endpoint hides other users' alerts
The system SHALL expose `GET /api/v1/me/alerts/:id`, responding 400 when `id` is not a valid ObjectId and 404 when the alert does not exist **or** belongs to another user, so the response never reveals that the resource exists.

#### Scenario: Another user's alert is reported as not found
- **WHEN** user B requests the id of an alert owned by user A
- **THEN** the response is 404 with `error.code: "NOT_FOUND"` rather than 403

### Requirement: Alert update rules
The system SHALL expose `PATCH /api/v1/me/alerts/:id` accepting a strict body of `{ threshold?, cooldownMinutes?, rearmPct?, note?, mode?, enabled? }` with at least one field, rejecting any attempt to change `type` with 400. Setting `enabled: false` SHALL move the alert to `disabled`; setting `enabled: true` from `disabled` or `completed` SHALL move it to `armed` and SHALL count toward the active cap, responding 422 when that cap would be exceeded. Changing `threshold` on a `triggered` alert SHALL move it to `armed` without resetting `lastTriggeredAt` or `triggerCount`.

#### Scenario: Type is immutable
- **WHEN** a client patches an alert with a `type` field
- **THEN** the response is 400 with `error.code: "VALIDATION_ERROR"`

#### Scenario: Re-enabling beyond the cap is refused
- **WHEN** a user at the active cap re-enables a disabled alert
- **THEN** the response is 422 with `details.reason: "LIMIT_REACHED"`

#### Scenario: Changing the threshold rearms a triggered alert
- **WHEN** a user changes the `threshold` of an alert whose status is `triggered`
- **THEN** its status becomes `armed` while `lastTriggeredAt` and `triggerCount` keep their values

### Requirement: Every modification increments the version
The system SHALL perform each alert modification as `updateOne({ _id, userId }, { $set: ..., $inc: { version: 1 } })`, so any concurrent evaluation holding the previous version fails to match.

#### Scenario: A user edit invalidates an in-flight evaluation
- **WHEN** a user patches an alert while a job run holds the previously read version
- **THEN** the alert's `version` increases and the job's conditional write matches nothing

### Requirement: Alert deletion cancels pending notifications
The system SHALL expose `DELETE /api/v1/me/alerts/:id`, which deletes the alert and moves its `pending` notifications to `cancelled` while leaving any notification already in `sending` to finish. It SHALL respond 204 always, including when the alert does not exist or belongs to another user, in which case nothing is deleted.

#### Scenario: Deleting an alert cancels its queued mail
- **WHEN** a user deletes an alert that has a `pending` notification
- **THEN** the response is 204, the alert is gone, and that notification's status is `cancelled`

#### Scenario: Deleting another user's alert changes nothing
- **WHEN** user B deletes the id of an alert owned by user A
- **THEN** the response is 204 and user A's alert still exists
