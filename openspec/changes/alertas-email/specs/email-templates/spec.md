## ADDED Requirements

### Requirement: Pure template renderer
The system SHALL implement `src/modules/notifications/templates/alert-triggered.ts` exporting a pure function `render(payload) → { subject, text, html }` that performs no input or output of its own.

#### Scenario: Rendering is deterministic and side-effect free
- **WHEN** `render` is called twice with the same payload
- **THEN** it returns identical output both times without reading any collection or external service

### Requirement: Subject per alert type
The system SHALL produce a subject that names the coin symbol and the condition, distinguishing the three alert types — a below-threshold price, an above-threshold price and a 24-hour movement — and formatting monetary amounts with `Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD' })`.

#### Scenario: A below-threshold alert names the direction and amount
- **WHEN** a `PRICE_BELOW` notification for BTC with threshold 50000 is rendered
- **THEN** the subject identifies the coin, states that the price fell below the threshold, and shows the amount in the configured currency format

#### Scenario: A movement alert names the percentage
- **WHEN** a `CHANGE_24H_ABS_GTE` notification is rendered
- **THEN** the subject states the 24-hour movement as a percentage

### Requirement: Body content
The system SHALL include, in both the text and HTML bodies with the same information, the coin's name and symbol, the configured condition and threshold, the value that triggered it, the 24-hour change, the trigger timestamp in UTC together with the reference local time from `MAIL_DISPLAY_TIMEZONE`, the user's note when present, and the API call that disables the alert (`PATCH /api/v1/me/alerts/<id>` with `{ "enabled": false }`).

#### Scenario: Both body variants carry the same facts
- **WHEN** a notification is rendered
- **THEN** the text and HTML bodies both state the coin, the condition, the threshold, the triggering value, the 24-hour change, the timestamp and how to disable the alert

#### Scenario: A user note is included when present
- **WHEN** the payload carries a note
- **THEN** the note appears in both bodies

### Requirement: HTML escaping of untrusted values
The system SHALL escape `&`, `<`, `>`, `"` and `'` in every value originating from a user or a third party — including `note` and `coinName` — when building the HTML body.

#### Scenario: Markup in a note is escaped
- **WHEN** a note contains `<b>hola</b>`
- **THEN** the HTML body contains `&lt;b&gt;hola&lt;/b&gt;` and no live `<b>` element

### Requirement: Subject header injection prevention
The system SHALL remove carriage return and line feed characters from the subject before returning it.

#### Scenario: Newlines are stripped from the subject
- **WHEN** a rendered subject would otherwise contain `\r` or `\n`
- **THEN** those characters are removed from the returned subject

### Requirement: Self-contained HTML
The system SHALL use simple HTML with inline styles and SHALL NOT reference external images, remote stylesheets or tracking pixels.

#### Scenario: The email loads nothing from the network
- **WHEN** the HTML body is rendered
- **THEN** it contains no reference to any external image, stylesheet or tracking resource

### Requirement: Low-value price precision
The system SHALL format amounts with 2 decimal places by default and with up to 8 decimal places when the value is smaller than 1, so very low-priced coins are not displayed as zero.

#### Scenario: A sub-unit price keeps its precision
- **WHEN** a triggering value smaller than 1 is rendered
- **THEN** it is shown with up to 8 decimal places rather than rounded to 2
