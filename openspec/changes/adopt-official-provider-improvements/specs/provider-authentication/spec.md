# Spec Delta

## Purpose

Defines how HyperCharm resolves API-key credentials and performs cancellable, validated Hyper OAuth device login and token refresh without colliding with the official provider.

## ADDED Requirements

### Requirement: HyperCharm authentication remains namespaced and deterministic
Authentication SHALL remain registered under provider `hypercharm`. A stored `hypercharm` API-key credential SHALL take precedence over `HYPERCHARM_API_KEY`; the environment variable SHALL be used when no stored credential is available. OAuth credentials SHALL remain stored under `hypercharm`, and loading or using authentication MUST NOT register or modify the official provider's `hyper` auth surface.

#### Scenario: Stored API key and environment key both exist
- **WHEN** a stored `hypercharm` API key and `HYPERCHARM_API_KEY` are both configured
- **THEN** requests use the stored key

#### Scenario: Only the environment key exists
- **WHEN** no stored `hypercharm` credential exists and `HYPERCHARM_API_KEY` is set
- **THEN** the provider resolves the environment value as its API key

#### Scenario: Official provider is co-installed
- **WHEN** both HyperCharm and the official Hyper provider register authentication
- **THEN** each provider resolves and persists only its own credentials

### Requirement: Device authorization honors server cadence, expiry, and cancellation
OAuth login SHALL initiate a Hyper device authorization for `Pi (<hostname>)`, notify the caller of the user code, verification URL, interval, and expiry, and wait once before its first poll. Polling SHALL use at least a one-second interval, stop at the device-code deadline, continue on `authorization_pending`, increase the interval by five seconds on `slow_down`, terminate with the provider description for terminal authorization errors, and stop promptly when cancelled.

#### Scenario: User authorizes after a pending poll
- **WHEN** the device endpoint returns `authorization_pending` and later returns a valid authorization result
- **THEN** polling follows the advertised cadence and login continues with the returned refresh token and team metadata

#### Scenario: Hyper asks the client to slow down
- **WHEN** the device endpoint returns one or more `slow_down` responses
- **THEN** later polls use the increased interval and a deadline reached after slowing down reports guidance about possible host clock drift

#### Scenario: User denies access
- **WHEN** the device endpoint returns `access_denied` with a description
- **THEN** login ends with that authorization failure and does not attempt token exchange

#### Scenario: Login is cancelled
- **WHEN** the login abort signal fires during a wait or request
- **THEN** login stops with the cancellation outcome and performs no later poll

### Requirement: Token exchange produces validated buffered credentials
A successful token exchange SHALL contain non-empty access and token-type values plus either a positive relative expiry or a future absolute expiry. Initial login MUST also receive a non-empty refresh token. During credential refresh, a rotated refresh token SHALL replace the previous token; if a compatible response omits a replacement, the previous refresh token SHALL be retained. The stored credential expiry SHALL be reduced by the lesser of 30 seconds or half the token lifetime, and team metadata obtained during login SHALL survive later refreshes.

#### Scenario: Relative token expiry is returned
- **WHEN** token exchange returns a positive `expires_in`
- **THEN** the credential expires before the server deadline by the required safety buffer

#### Scenario: Absolute token expiry is returned
- **WHEN** token exchange returns a future `expires_at`
- **THEN** the absolute expiry is converted to milliseconds and buffered before storage

#### Scenario: Refresh token rotates
- **WHEN** refresh returns a new refresh token
- **THEN** the credential stores the new token while preserving its team metadata

#### Scenario: Token is already expired
- **WHEN** the computed server expiry is not in the future
- **THEN** refresh fails and leaves the existing credential unchanged

### Requirement: Invalid-session guidance is limited to confirmed refresh rejection
The extension SHALL tell the user to re-authenticate only when token exchange returns HTTP 401 with Hyper's exact rejected-refresh-token payload. Other HTTP 401 responses, malformed bodies, network failures, timeouts, and caller cancellation SHALL preserve their actual failure classification and MUST NOT be mislabeled as an invalid session.

#### Scenario: Hyper confirms the refresh token no longer exists
- **WHEN** refresh returns HTTP 401 with the recognized rejected-refresh-token payload
- **THEN** the error tells the user to run `/login` for HyperCharm again

#### Scenario: Unrecognized 401 is returned
- **WHEN** refresh returns HTTP 401 with a different or malformed body
- **THEN** the operation reports an HTTP authentication failure without asserting that the refresh token was rejected
