# Spec Delta

## MODIFIED Requirements

### Requirement: Recoverable failures are surfaced once
The extension SHALL emit a warning for distinct recoverable failures involving model-catalog refresh or validation, legacy or Pi-managed catalog persistence, status-config access, credential resolution, Hypercredit refresh, team metadata, or device-session metadata. Warnings for HTTP, timeout, network, and response-payload failures SHALL identify the affected operation and MAY include only server detail that satisfies the safe bounded error rules; they MUST NOT expose authorization values, OAuth tokens, request bodies, or unsafe server text. Repeating the same warning message within a process MUST NOT emit duplicate warnings.

#### Scenario: Warning before UI activation
- **WHEN** a recoverable failure occurs before any UI session is active
- **THEN** a single `HyperCharm warning:` message describing that failure is written to stderr

#### Scenario: Warning after UI activation
- **WHEN** a recoverable failure occurs after a UI-capable session activates warning delivery
- **THEN** a single Pi notification with warning severity describes that failure instead of silently swallowing it

#### Scenario: Repeated identical failure is deduplicated
- **WHEN** the same failure message occurs more than once in the process
- **THEN** that message is emitted only on its first occurrence

#### Scenario: Provider returns unsafe error text
- **WHEN** a recoverable HTTP failure includes markup, controls, formatting characters, or an oversized server message
- **THEN** the warning reports the operation and HTTP status without reproducing the unsafe text

#### Scenario: Failure contains credentials
- **WHEN** an operation fails after sending authentication or OAuth data
- **THEN** the warning contains no API key, access token, refresh token, authorization header, or request body

### Requirement: Diagnostics preserve fallback behavior
A surfaced recoverable failure SHALL NOT prevent the extension from serving the best available Pi-stored, compatible namespaced-cache, or embedded model catalog; retaining the last coherent account/status data; or applying an in-memory status setting. A malformed live payload SHALL be treated as a failed refresh and MUST NOT partially mutate current state. A missing optional cache/config file and an abort caused by session replacement, provider switch, credential invalidation, or shutdown MUST NOT be reported as failures.

#### Scenario: Live catalog refresh fails
- **WHEN** the live model-catalog request fails, returns a non-success status, yields no usable models, or fails schema validation
- **THEN** the extension warns once and continues serving the last Pi-stored, compatible namespaced-cache, or embedded catalog

#### Scenario: Optional state file is absent
- **WHEN** the legacy model cache or status-config file does not exist on first use
- **THEN** the extension uses its normal fallback without emitting a warning

#### Scenario: Session abort cancels a request
- **WHEN** session replacement, provider switch, credential invalidation, or shutdown aborts an in-flight catalog or account request
- **THEN** the extension stops using that request without emitting a failure warning

#### Scenario: Account refresh fails
- **WHEN** an account request times out, fails on the network, returns an HTTP error, or yields an invalid payload
- **THEN** the extension warns once, retains the last coherent account snapshot, and continues rendering other available status data

#### Scenario: Persisting optional state fails
- **WHEN** the extension cannot persist refreshed catalog data or status configuration
- **THEN** it warns once while continuing to use the freshly fetched catalog or in-memory status configuration for the current session
