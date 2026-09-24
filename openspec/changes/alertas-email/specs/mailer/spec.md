## ADDED Requirements

### Requirement: Mailer contract

The system SHALL define a `Mailer` interface with `send(msg: { to, subject, text, html }): Promise<{ messageId: string }>` and `verify(): Promise<void>`, and SHALL inject it into the jobs and services that need it rather than importing a transport directly.

#### Scenario: Sending returns a provider message id

- **WHEN** `send` succeeds
- **THEN** it resolves with a `messageId`

### Requirement: SMTP transport configuration

The system SHALL implement `SmtpMailer` over `nodemailer.createTransport({ host, port, secure: port === 465, auth })` using `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS`, with connection and socket timeouts of 10 seconds.

#### Scenario: Implicit TLS is selected by port

- **WHEN** `SMTP_PORT` is 465
- **THEN** the transport is created with `secure: true`, and with `secure: false` for any other port

#### Scenario: Local development targets Mailpit

- **WHEN** the project runs with its documented local configuration
- **THEN** mail is delivered to the local Mailpit SMTP service rather than to any external provider

### Requirement: Transient versus permanent error classification

The system SHALL classify a failure carrying a `responseCode` between 500 and 599 as a `MailError` with `permanent: true` and `code: "SMTP_REJECTED"`, and SHALL classify connection errors, timeouts and 4xx responses as `permanent: false` with `code: "SMTP_UNAVAILABLE"`.

#### Scenario: A 550 rejection is permanent

- **WHEN** the SMTP server responds with code 550
- **THEN** the thrown `MailError` has `permanent: true` and `code: "SMTP_REJECTED"`

#### Scenario: A provider rate-limit response is transient

- **WHEN** the SMTP server responds with 421 or 451
- **THEN** the thrown `MailError` has `permanent: false` and `code: "SMTP_UNAVAILABLE"`

#### Scenario: A connection timeout is transient

- **WHEN** the connection to the SMTP host times out
- **THEN** the thrown `MailError` has `permanent: false` and `code: "SMTP_UNAVAILABLE"`

### Requirement: Fake mailer for tests

The system SHALL provide a `FakeMailer`, used only by tests, that records every sent message in memory and can be configured to fail with either a transient or a permanent error.

#### Scenario: Tests assert on captured messages

- **WHEN** a test runs the send job with `FakeMailer`
- **THEN** the sent messages are readable from memory and no SMTP connection is made

### Requirement: Startup verification never stops the worker

The worker SHALL call `mailer.verify()` at startup and, when it fails, SHALL log at `error` and continue starting, leaving notifications `pending` for later retry.

#### Scenario: An SMTP outage at boot does not block the worker

- **WHEN** `mailer.verify()` fails during worker startup
- **THEN** an `error` is logged, the worker continues starting, and price polling proceeds normally

### Requirement: Credentials stay in the environment

The system SHALL read SMTP credentials only from environment variables and SHALL never log them or include them in an error message.

#### Scenario: A send failure does not leak credentials

- **WHEN** a send fails and the error is logged
- **THEN** no log line contains `SMTP_USER` or `SMTP_PASS` values
