## ADDED Requirements

### Requirement: Alert document shape
The system SHALL define an `alerts` collection with `_id` (ObjectId, exposed as `id`), `userId` (ObjectId, required), `coinId` (ObjectId, required), `type` (enum `PRICE_ABOVE`/`PRICE_BELOW`/`CHANGE_24H_ABS_GTE`, immutable after creation), `threshold` (number — greater than 0 and at most 1e9 for price types, between 0.1 and 100 percentage points for the change type), `mode` (enum `once`/`recurring`, default `recurring`), `status` (enum `armed`/`triggered`/`completed`/`disabled`, default `armed`), `cooldownMinutes` (integer 5-10080, default 60), `rearmPct` (number 0-20, default 1), `note` (string or null, at most 200 characters), `version` (integer, default 0), `triggerCount` (integer, default 0), `lastTriggeredAt` (Date or null), `lastTriggeredValue` (number or null), `lastEvaluatedAt` (Date or null), and `createdAt`/`updatedAt` timestamps.

#### Scenario: Alert document matches the fixed shape
- **WHEN** an alert is created
- **THEN** it has `userId`, `coinId`, `type`, `threshold`, `mode`, `status`, `cooldownMinutes`, `rearmPct`, `note`, `version`, `triggerCount` and the tracking timestamps

#### Scenario: A new alert starts armed and untriggered
- **WHEN** an alert is created
- **THEN** its `status` is `"armed"`, its `triggerCount` is 0 and its `version` is 0

### Requirement: Alert indexes
The system SHALL maintain indexes on `{ coinId: 1, status: 1 }` to serve evaluation, `{ userId: 1, createdAt: -1 }` to serve the user's listing, and `{ userId: 1, status: 1 }` to serve the active-alert count.

#### Scenario: Evaluation queries are served by an index
- **WHEN** the evaluation query selecting alerts by `coinId` and `status` is explained
- **THEN** the winning plan uses the `{ coinId: 1, status: 1 }` index rather than a collection scan

### Requirement: Active alert cap per user
The system SHALL cap the number of alerts per user with `status` `armed` or `triggered` at `ALERTS_MAX_ACTIVE` (default 20). Alerts in `completed` or `disabled` SHALL NOT count toward the cap.

#### Scenario: Disabled alerts free capacity
- **WHEN** a user at the cap disables one alert
- **THEN** they can create one new alert

### Requirement: Alert state machine
The system SHALL permit only these transitions: `armed` → `triggered` when the condition is met, the cooldown has elapsed and `mode` is `recurring`; `armed` → `completed` when the condition is met and `mode` is `once`; `triggered` → `armed` when the rearm condition is met; `armed` → `disabled` and `triggered` → `disabled` when the user disables the alert; and `completed` → `armed` and `disabled` → `armed` when the user re-enables it.

#### Scenario: A once-mode alert completes instead of re-arming
- **WHEN** an alert with `mode: "once"` meets its condition
- **THEN** its `status` becomes `"completed"` and it is not evaluated again until the user re-enables it

#### Scenario: A disabled alert is not evaluated
- **WHEN** an alert has `status: "disabled"`
- **THEN** evaluation skips it regardless of the current price

### Requirement: Trigger conditions per alert type
The system SHALL treat the trigger condition as met when, for `PRICE_ABOVE`, the current `priceUsd` is greater than or equal to `threshold`; for `PRICE_BELOW`, the current `priceUsd` is less than or equal to `threshold`; and for `CHANGE_24H_ABS_GTE`, the absolute value of `change24hPct` is greater than or equal to `threshold`. When `change24hPct` is `null`, a `CHANGE_24H_ABS_GTE` alert SHALL NOT be evaluated.

#### Scenario: A price exactly at the threshold triggers
- **WHEN** a `PRICE_BELOW` alert with threshold 50000 is evaluated against a price of exactly 50000
- **THEN** the trigger condition is met

#### Scenario: A null 24h change is a no-op
- **WHEN** a `CHANGE_24H_ABS_GTE` alert is evaluated against a value whose `change24hPct` is `null`
- **THEN** the decision is `NOOP` and nothing is written

### Requirement: Rearm conditions with hysteresis
From `triggered`, the system SHALL treat the rearm condition as met when, for `PRICE_ABOVE`, `priceUsd < threshold × (1 − rearmPct/100)`; for `PRICE_BELOW`, `priceUsd > threshold × (1 + rearmPct/100)`; and for `CHANGE_24H_ABS_GTE`, the absolute `change24hPct` is less than `max(0, threshold − rearmPct)`.

#### Scenario: A price inside the hysteresis band does not rearm
- **WHEN** a triggered `PRICE_BELOW` alert with threshold 50000 and `rearmPct: 1` is evaluated against a price of 50400
- **THEN** the alert remains `triggered`

#### Scenario: A price beyond the hysteresis band rearms
- **WHEN** that same alert is evaluated against a price of 50600
- **THEN** the decision is `REARM` and the alert returns to `armed`

### Requirement: Cooldown between triggers
The system SHALL allow an `armed` alert whose condition is met to trigger only when `lastTriggeredAt` is `null` or `now − lastTriggeredAt` is at least `cooldownMinutes`. While within the cooldown the alert SHALL remain `armed` and be re-evaluated on the next run.

#### Scenario: An alert within its cooldown does not fire
- **WHEN** a rearmed alert whose `lastTriggeredAt` is 20 minutes old and whose `cooldownMinutes` is 60 meets its condition
- **THEN** the decision is `COOLDOWN`, nothing is written and the alert stays `armed`

#### Scenario: An alert past its cooldown fires
- **WHEN** that same alert meets its condition 61 minutes after its last trigger
- **THEN** the decision is `TRIGGER`

### Requirement: Pure decision function
The system SHALL implement `decide(alert, value, now)` as a pure function returning exactly one of `TRIGGER`, `REARM`, `COOLDOWN` or `NOOP`, performing no input or output of its own.

#### Scenario: The decision function is testable without a database
- **WHEN** `decide` is called with a plain alert object, a value and a fixed `now`
- **THEN** it returns a decision without reading or writing any collection
