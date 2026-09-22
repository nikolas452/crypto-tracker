## ADDED Requirements

### Requirement: Seed input resolution
The system SHALL provide `npm run seed:coins`, accepting an optional comma-separated list of coin ids as an argument (e.g. `npm run seed:coins -- bitcoin,ethereum`). When no argument is given, it SHALL use the default list `bitcoin, ethereum, solana, cardano, ripple, dogecoin, polkadot, chainlink, litecoin, avalanche-2`. Ids SHALL be normalized (trimmed, lowercased) and de-duplicated before use.

#### Scenario: No argument uses the default list
- **WHEN** `seed:coins` runs with no argument
- **THEN** it seeds the 10 default coins listed in the requirement

### Requirement: Idempotent upsert from CoinGecko markets
The system SHALL call `getMarkets(ids)` and, for each coin returned, upsert a `coins` document by `coingeckoId`, updating `name` and `symbol` and setting `isActive: true`. Running the script twice with the same list SHALL NOT create duplicate coins.

#### Scenario: Running the seed twice does not duplicate coins
- **WHEN** `seed:coins` runs twice in a row with the same id list
- **THEN** no duplicate `coins` documents are created, and the second run's summary reports coins updated rather than created

### Requirement: Invalid ids are reported, not inserted
Ids that CoinGecko's markets endpoint does not return SHALL be listed as invalid and SHALL NOT be inserted into `coins`.

#### Scenario: A nonexistent id is reported without being inserted
- **WHEN** `seed:coins -- bitcoin,no-existe-xyz` runs
- **THEN** `bitcoin` is created or updated, and `no-existe-xyz` is reported as invalid without a `coins` document being created for it

### Requirement: Summary output and exit code
The system SHALL print a summary of coins created, updated, and invalid. The exit code SHALL be 0 if at least one coin was valid, and 1 if none were valid or an error occurred.

#### Scenario: All-invalid input exits with failure
- **WHEN** every id passed to `seed:coins` is invalid
- **THEN** the process exits with code 1
