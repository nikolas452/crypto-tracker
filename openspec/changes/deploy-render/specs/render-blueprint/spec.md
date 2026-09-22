## ADDED Requirements

### Requirement: Versioned blueprint file
The system SHALL provide a `render.yaml` blueprint at the repository root describing the deployed infrastructure, validated against Render's current Blueprint specification before being applied.

#### Scenario: Infrastructure is described in the repository
- **WHEN** the repository is inspected
- **THEN** `render.yaml` describes the environment-variable group and the deployed service

### Requirement: Single free web service, no worker
The blueprint SHALL define exactly one service: a Node web service on the free plan running the API, and SHALL NOT define a background worker or a cron job, because those have no free instance and this project deploys no scheduler.

#### Scenario: Only the API is deployed
- **WHEN** the blueprint is applied
- **THEN** one free web service running the API exists and no worker or cron service is created

#### Scenario: The service sleeps when idle
- **WHEN** the deployed web service receives no traffic for the free plan's idle period
- **THEN** it spins down, and the next request wakes it, which is the documented and accepted behavior

### Requirement: Shared environment variable group
The blueprint SHALL define an environment-variable group holding the configuration shared by the application, and the service SHALL consume it with `fromGroup` rather than repeating the variables.

#### Scenario: Shared configuration is defined once
- **WHEN** the blueprint is inspected
- **THEN** shared variables appear once in the group and the service references the group

### Requirement: No secret values in the blueprint
The blueprint SHALL NOT contain a literal value for any secret. Every secret SHALL be declared with `sync: false`, so it is supplied through the platform dashboard, or with `generateValue: true`.

#### Scenario: Secrets are declared without values
- **WHEN** the blueprint declares `MONGODB_URI`, `COINGECKO_API_KEY` or any `FIREBASE_*` credential
- **THEN** each is marked `sync: false` and carries no value in the file

### Requirement: Readiness-gated deploy
The blueprint SHALL set the service's `healthCheckPath` to `/health/ready`, so the platform routes traffic to a new instance only once it reports ready.

#### Scenario: A deploy under load produces no server errors
- **WHEN** the API is redeployed while a client makes 5 requests per second to `GET /api/v1/coins`
- **THEN** no response has a 5xx status

### Requirement: Deploy gated on continuous integration
The blueprint SHALL set `autoDeployTrigger: checksPass`, so a commit is deployed only when its GitHub checks have passed.

#### Scenario: A red build is not deployed
- **WHEN** a commit is pushed to the default branch and its CI checks fail
- **THEN** no deploy is triggered

#### Scenario: A green build is deployed
- **WHEN** a commit is pushed to the default branch and its CI checks pass
- **THEN** a deploy is triggered

### Requirement: Region chosen relative to the database
The blueprint SHALL specify a region close to the MongoDB Atlas cluster's region, and the choice SHALL be documented.

#### Scenario: The region pairing is recorded
- **WHEN** a developer reads the deployment documentation
- **THEN** it names the Render region, the Atlas region and why they were paired
