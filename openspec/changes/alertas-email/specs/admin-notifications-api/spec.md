## ADDED Requirements

### Requirement: Admin notification listing
The system SHALL expose `GET /api/v1/admin/notifications`, guarded by `requireAuth({ checkRevoked: true })` and `requireRole('admin')`, with a strict query schema accepting `status`, `userId`, `from`, `to`, `page` and `limit`, returning a paginated list that includes the full `lastError` object and `lockedBy`.

#### Scenario: An admin sees full diagnostic detail
- **WHEN** an admin lists notifications that include a failed one
- **THEN** the response includes that notification's complete `lastError` and its `lockedBy` value

#### Scenario: A non-admin cannot list notifications
- **WHEN** a user whose role is `user` calls the admin notification listing
- **THEN** the response is 403 with `error.code: "FORBIDDEN"`

### Requirement: Admin retry of a failed notification
The system SHALL expose `POST /api/v1/admin/notifications/:id/retry`, which for a notification in `failed` sets `status: "pending"`, `attempts: 0`, `nextAttemptAt: now` and `lastError: null`, and for a notification in any other status responds 409 `CONFLICT`.

#### Scenario: A failed notification is requeued
- **WHEN** an admin retries a notification whose status is `failed`
- **THEN** its status becomes `pending` with `attempts: 0` and a cleared `lastError`

#### Scenario: Retrying a sent notification conflicts
- **WHEN** an admin retries a notification whose status is `sent`
- **THEN** the response is 409 with `error.code: "CONFLICT"` and the notification is unchanged

### Requirement: Immediate test email
The system SHALL expose `POST /api/v1/admin/notifications/test-email`, which sends a test message immediately to the authenticated admin's own email without creating an outbox entry, responding 200 with the `messageId` on success and 502 with the mailer's error code when SMTP fails.

#### Scenario: A test email bypasses the outbox
- **WHEN** an admin calls the test-email endpoint successfully
- **THEN** the response is 200 with a `messageId` and no `notifications` document is created

#### Scenario: An SMTP failure surfaces as a bad gateway
- **WHEN** the test email fails because SMTP is unavailable
- **THEN** the response is 502 with the mailer's error code
