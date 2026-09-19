# Spec Delta

## MODIFIED Requirements

### Requirement: Recoverable failures are surfaced once
The extension SHALL emit a warning for distinct recoverable failures involving model-catalog refresh or parsing, cache access, status-config access, credential resolution, Hypercredit refresh, team metadata, device-session metadata, or usage-ledger read or write access. Repeating the same warning message within a process MUST NOT emit duplicate warnings.

#### Scenario: Warning before UI activation
- **WHEN** a recoverable failure occurs before any UI session is active
- **THEN** a single `HyperCharm warning:` message describing that failure is written to stderr

#### Scenario: Warning after UI activation
- **WHEN** a recoverable failure occurs after a UI-capable session activates warning delivery
- **THEN** a single Pi notification with warning severity describes the failure instead of silently swallowing it

#### Scenario: Repeated identical failure is deduplicated
- **WHEN** the same failure message occurs more than once in the process
- **THEN** that message is emitted only on its first occurrence

#### Scenario: Ledger access failure warns once and continues
- **WHEN** the usage ledger cannot be read (other than being absent) or a record cannot be appended
- **THEN** the extension emits a single warning through the same delivery path and continues rendering status from the last known state

#### Scenario: Absent ledger shard is not a failure
- **WHEN** a usage-ledger shard for a day does not exist
- **THEN** that day contributes no records and no warning is emitted
