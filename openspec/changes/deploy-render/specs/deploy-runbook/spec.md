## ADDED Requirements

### Requirement: Runbook document

The system SHALL provide `docs/runbook.md` describing how to operate the deployment, written to be usable by someone who has not touched the project recently.

#### Scenario: The runbook exists and is versioned

- **WHEN** the repository is inspected
- **THEN** `docs/runbook.md` is present and describes deployment operations

### Requirement: Deploy and rollback procedures

The runbook SHALL describe how to deploy and how to roll back to a previous successful deploy through the platform's dashboard.

#### Scenario: Rollback is a documented, repeatable action

- **WHEN** an operator needs to revert a bad deploy
- **THEN** the runbook tells them how to redeploy a previous successful build

### Requirement: Secret rotation procedures

The runbook SHALL describe how to rotate each secret the system uses: the Atlas connection credential, the CoinGecko API key, the Firebase service account, and the SMTP credentials.

#### Scenario: Each secret has a rotation procedure

- **WHEN** an operator needs to rotate any one of the project's secrets
- **THEN** the runbook names the steps for that specific secret

### Requirement: Failure playbooks

The runbook SHALL describe what to do when the status endpoint reports stale, when notifications are in `failed`, when the CoinGecko quota is exhausted, and when the Atlas cluster has auto-paused after inactivity.

#### Scenario: A paused cluster has a recovery procedure

- **WHEN** the Atlas cluster has auto-paused after 30 days without connections
- **THEN** the runbook explains how to recognize that state and how to resume the cluster

#### Scenario: A stale status is explained rather than alarming

- **WHEN** an operator sees `stale: true` on the deployed API
- **THEN** the runbook explains that this is the normal resting state because no worker runs in the cloud, and how to change it by running the worker locally

### Requirement: Production data procedures

The runbook SHALL describe how to run `db:setup` and `seed:coins` against production, including that production credentials are exported into the shell for the command only and never written to a committed file, and SHALL note that adding coins through the admin endpoint is the alternative.

#### Scenario: Seeding production does not persist credentials

- **WHEN** an operator follows the documented seeding procedure
- **THEN** the production URI and API key are supplied to the command through the environment and are never written into a repository file

#### Scenario: An admin account can be provisioned in production

- **WHEN** an operator needs an admin on the deployed system
- **THEN** the runbook describes calling an authenticated endpoint once and then running `user:set-role` against the production database

### Requirement: Diagnostic queries

The runbook SHALL include useful diagnostic queries: the most recent job runs, notifications in `failed`, and collection sizes.

#### Scenario: An operator can inspect system state directly

- **WHEN** an operator needs to check recent job activity or storage usage
- **THEN** the runbook provides the queries to run

### Requirement: No secrets anywhere in the repository

The system SHALL keep every credential out of the repository and its history, including the Atlas URI, the CoinGecko API key and the Firebase private key, and the security checklist SHALL state that this is verified.

#### Scenario: Searching the repository history finds no credentials

- **WHEN** the repository, including its full history, is searched for the Atlas URI, the CoinGecko key or the Firebase private key
- **THEN** none of them is found
