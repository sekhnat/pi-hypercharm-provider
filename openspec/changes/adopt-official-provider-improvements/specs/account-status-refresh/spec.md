# Spec Delta

## Purpose

Defines when HyperCharm acquires account status and how concurrent, failed, or rate-limited refreshes preserve coherent last-known balance, team, and device-session data.

## ADDED Requirements

### Requirement: Account requests are demand-gated
Automatic account refresh SHALL run only in a non-Fabric-child session that has used or selected the `hypercharm` provider and has resolvable credentials. A session that never activates HyperCharm, a Fabric child, or a session with no resolved credential MUST NOT request credits, teams, or devices. Existing session-usage accounting, response-header rate-limit capture, and status destinations SHALL remain unchanged.

#### Scenario: Session never uses HyperCharm
- **WHEN** a session starts and completes work using another provider only
- **THEN** no credits, teams, or devices request is made

#### Scenario: Fabric child uses HyperCharm
- **WHEN** a Fabric child completes a HyperCharm turn
- **THEN** it records usage through the existing ledger and makes no account metadata request

#### Scenario: HyperCharm becomes active
- **WHEN** a parent session selects HyperCharm with resolvable credentials
- **THEN** account refresh may begin and its results are rendered through the existing configured surfaces

### Requirement: Account state is credential-scoped and latest work wins
Balance, team, and device-session values committed together SHALL belong to the same resolved credential generation. Concurrent refreshes for the same credential SHALL share in-flight work where possible. A credential change, provider switch, session replacement, or shutdown SHALL invalidate or abort obsolete work, and a late result from obsolete work MUST NOT update or relabel visible account state.

#### Scenario: Two refresh triggers overlap
- **WHEN** two automatic refreshes start for the same credential before the first completes
- **THEN** they share the applicable request work and produce one coherent account update

#### Scenario: Credential changes during refresh
- **WHEN** account A has a request in flight and account B becomes the resolved credential
- **THEN** account A's late result is not attributed to account B and cannot overwrite account B's later state

#### Scenario: User switches away during refresh
- **WHEN** the selected model changes away from HyperCharm while account requests are pending
- **THEN** pending work is invalidated and no late HyperCharm status is rendered for the other provider

#### Scenario: Session shuts down during refresh
- **WHEN** session shutdown occurs before account requests complete
- **THEN** the requests are aborted and cannot update disposed UI or state

### Requirement: Failed refreshes retain coherent last-known data
A missing credential, credential-resolution failure, HTTP failure, timeout, network failure, or invalid account payload SHALL leave the last committed account snapshot available. Data from a new credential MUST NOT be combined with balance, team, or device metadata from an older credential; until a coherent new snapshot is available, the previous snapshot MAY remain visible only with its original attribution.

#### Scenario: Refresh fails after a successful balance
- **WHEN** a later credits request fails
- **THEN** the last committed balance remains available and is not replaced with an empty or zero value

#### Scenario: New account refresh fails
- **WHEN** credentials change from Team A to Team B and Team B's first request fails
- **THEN** Team A's balance is never displayed under Team B's name

#### Scenario: One account endpoint is malformed
- **WHEN** one metadata endpoint returns an invalid payload while another returns valid data
- **THEN** invalid data is not committed and no mixed-credential snapshot is produced

### Requirement: Transient account failures apply bounded backoff
Network failures, timeouts, HTTP 408, HTTP 429, and HTTP 5xx responses SHALL defer later automatic requests for the affected account operation. A valid server `Retry-After` delay SHALL take precedence; otherwise the delay SHALL grow exponentially from five seconds and cap at five minutes. A successful request or credential change SHALL reset the failure state. An explicit `/hypercharm-status refresh` SHALL bypass the automatic retry gate while still coalescing with compatible in-flight work.

#### Scenario: Repeated service failures occur
- **WHEN** automatic credits requests repeatedly receive HTTP 503 without `Retry-After`
- **THEN** retries use exponentially increasing delays no shorter than five seconds and no longer than five minutes

#### Scenario: Hyper supplies Retry-After
- **WHEN** an account request receives a transient response with a valid retry delay
- **THEN** automatic refresh does not issue that request again before the supplied delay expires

#### Scenario: User explicitly refreshes during backoff
- **WHEN** the user runs `/hypercharm-status refresh` while an automatic retry gate is active
- **THEN** the extension attempts an immediate refresh unless compatible work is already in flight

#### Scenario: Refresh succeeds after failures
- **WHEN** a deferred account operation later succeeds
- **THEN** its backoff state resets to the initial delay for any future failure sequence

### Requirement: Hypercredit units remain compatible
The account balance SHALL accept a finite numeric `balance` in Hypercredits. When the endpoint instead returns a finite numeric `balance_usd`, the extension SHALL convert it at 20 Hypercredits per US dollar. Optimistic session-spend deductions, low-balance warnings, and status formatting SHALL continue to use Hypercredits.

#### Scenario: Hyper returns Hypercredits
- **WHEN** `/v1/credits` returns `balance: 249`
- **THEN** the account state records 249 Hypercredits

#### Scenario: Hyper returns US dollars
- **WHEN** `/v1/credits` returns `balance_usd: 12.45`
- **THEN** the account state records 249 Hypercredits
