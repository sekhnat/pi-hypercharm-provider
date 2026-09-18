## Purpose

Defines how recoverable HyperCharm runtime failures become visible without interrupting the extension's cached, embedded, or in-memory fallback behavior.

## ADDED Requirements

### Requirement: Recoverable failures are surfaced once
The extension SHALL emit a warning for distinct recoverable failures involving model-catalog refresh or parsing, cache access, status-config access, credential resolution, Hypercredit refresh, team metadata, or device-session metadata. Repeating the same warning message within a process MUST NOT emit duplicate warnings.

#### Scenario: Warning before UI activation
- **WHEN** a recoverable failure occurs before any UI session is active
- **THEN** a single `HyperCharm warning:` message describing that failure is written to stderr

#### Scenario: Warning after UI activation
- **WHEN** a recoverable failure occurs after a UI-capable session activates warning delivery
- **THEN** a single Pi notification with warning severity describes the failure instead of silently swallowing it

#### Scenario: Repeated identical failure is deduplicated
- **WHEN** the same failure message occurs more than once in the process
- **THEN** that message is emitted only on its first occurrence

### Requirement: Warning delivery remains safe across session lifecycles
Warning delivery SHALL NOT throw when no UI exists, when a non-UI session starts, or when a previously captured UI context becomes stale. If an activated UI context cannot accept a warning, the extension SHALL fall back to stderr.

#### Scenario: Non-UI session starts
- **WHEN** a session without UI capability activates after warnings have been routed to stderr
- **THEN** subsequent warnings continue to use stderr

#### Scenario: Activated UI context becomes stale
- **WHEN** warning notification through the activated UI context throws
- **THEN** the warning is written to stderr and the extension continues operating

### Requirement: Diagnostics preserve fallback behavior
A surfaced recoverable failure SHALL NOT prevent the extension from serving the best available cached or embedded model catalog, retaining the last known account/status data, or applying an in-memory status setting. A missing optional cache/config file and an abort caused by session replacement or shutdown MUST NOT be reported as failures.

#### Scenario: Live catalog refresh fails
- **WHEN** the live model-catalog request fails, returns a non-success status, or yields no usable models
- **THEN** the extension warns once and continues serving cached or embedded models

#### Scenario: Optional state file is absent
- **WHEN** the model cache or status-config file does not exist on first use
- **THEN** the extension uses its normal fallback without emitting a warning

#### Scenario: Session abort cancels a request
- **WHEN** session replacement or shutdown aborts an in-flight catalog or account request
- **THEN** the extension stops using that request without emitting a failure warning

#### Scenario: Persisting optional state fails
- **WHEN** the extension cannot write refreshed cache data or status configuration
- **THEN** it warns once while continuing to use the freshly fetched catalog or in-memory status configuration for the current session
