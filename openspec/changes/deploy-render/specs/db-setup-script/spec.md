## ADDED Requirements

### Requirement: Idempotent database setup script

The system SHALL provide `npm run db:setup`, which runs `ensureCollections()` and then `syncIndexes()` for each model, and which produces the same result when run repeatedly.

#### Scenario: Running setup twice changes nothing the second time

- **WHEN** `db:setup` is run twice against the same database with no schema change in between
- **THEN** the second run reports no index changes and modifies nothing

#### Scenario: A missing index is created

- **WHEN** a schema declares an index that does not exist in the database and `db:setup` runs
- **THEN** that index is created

### Requirement: Index diff is logged before it is applied

The system SHALL log the set of index changes — those to be created and those to be dropped — before applying them.

#### Scenario: Changes are visible before they happen

- **WHEN** `db:setup` runs with pending index changes
- **THEN** it logs which indexes will be created and which will be dropped before performing either

### Requirement: Dry-run mode changes nothing

The system SHALL support a `--dry-run` flag that prints the index diff and exits without creating, dropping or otherwise modifying anything.

#### Scenario: A dry run leaves the database untouched

- **WHEN** `db:setup --dry-run` is run against a database with pending index changes
- **THEN** the diff is printed and the database's indexes are unchanged

### Requirement: Index synchronization drops undeclared indexes

The system SHALL document that `syncIndexes()` removes indexes not present in a schema, and SHALL state the corresponding rule that every index must be declared in its model's schema rather than created by hand.

#### Scenario: The destructive behavior is documented

- **WHEN** a developer reads the documentation for `db:setup`
- **THEN** it states that undeclared indexes are dropped and that `--dry-run` exists to review that first

### Requirement: Execution path for production

The system SHALL document how to run `db:setup` against the production database — as a platform pre-deploy command where the plan supports it, and otherwise from an operator's machine before any deploy that changes indexes.

#### Scenario: The production procedure is written down

- **WHEN** an operator needs to apply an index change to production
- **THEN** the runbook tells them how to run `db:setup` against it and when it must happen relative to the deploy
