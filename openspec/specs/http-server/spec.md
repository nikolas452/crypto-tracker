## Purpose

This capability defines the fixed Express middleware chain and route registration order that every request passes through, ensuring consistent request identification, logging, security headers, body parsing, rate limiting, and error handling.

## Requirements

### Requirement: Fixed base middleware order

The system SHALL apply the following middleware chain, in this exact order, before any route: `trust proxy` configuration, request id, request logging (`pino-http`), `helmet()`, JSON body parsing (`express.json({ limit: '100kb' })`), and disabling `x-powered-by`; followed by the health routes, the global rate limiter mounted on `/api`, the application routes under `/api/v1`, then the 404 handler, then the centralized error handler.

#### Scenario: Every response carries the middleware chain's effects

- **WHEN** any request reaches the app
- **THEN** the response has `X-Request-Id` set, does not include the `X-Powered-By` header, and was logged with method, route, status, and duration

#### Scenario: Health routes are registered before the rate limiter

- **WHEN** a request reaches `GET /health` while the caller's `/api` rate-limit budget is exhausted
- **THEN** the health route responds 200 because the limiter is mounted only on `/api`
