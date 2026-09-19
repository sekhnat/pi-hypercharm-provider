# Spec Delta

## Purpose

Defines reliable, bounded, and safely diagnosable behavior for every non-streaming request the extension makes to Hyper control-plane endpoints.

## ADDED Requirements

### Requirement: Hyper control-plane requests are bounded and cancellable
Every non-streaming request to Hyper for provider models, credits, teams, devices, device authorization, device polling, or token exchange SHALL send the extension's versioned `pi-hypercharm-provider` user agent. Requests with JSON bodies SHALL send a JSON content type. Each request SHALL combine a finite operation-specific timeout with any caller-provided abort signal, and caller cancellation SHALL remain distinguishable from a timeout or network failure.

#### Scenario: Hyper does not answer
- **WHEN** a control-plane request does not produce a response before its configured deadline
- **THEN** the request fails as a timeout and does not remain pending indefinitely

#### Scenario: Session lifecycle cancels a request
- **WHEN** the caller aborts an in-flight control-plane request because a session is replaced or shut down
- **THEN** the request stops without being reported as a Hyper timeout or network failure

#### Scenario: JSON request headers are consistent
- **WHEN** the extension sends a device-auth or token-exchange JSON body
- **THEN** the request includes both `Content-Type: application/json` and the versioned extension user agent

### Requirement: HTTP and JSON failures expose safe bounded details
A non-success HTTP response SHALL be represented with its status and any valid retry delay. The extension MAY include a provider error detail only when the body matches the expected OpenAI-style error envelope, the type and code are safe bounded tokens, and the trimmed message is at most 200 Unicode characters with no control, format, line-separator, paragraph-separator, or angle-bracket character. Empty, unreadable, or invalid JSON bodies SHALL be reported as response-payload failures rather than accepted as endpoint data. Authorization headers, access tokens, refresh tokens, and request bodies MUST NOT appear in diagnostics.

#### Scenario: Safe provider error is returned
- **WHEN** Hyper returns a non-success response with a valid bounded error type, code, and message
- **THEN** the failure includes the HTTP status and that safe provider detail

#### Scenario: Unsafe provider error is returned
- **WHEN** a provider error message is oversized or contains markup, controls, bidirectional formatting, or line separators
- **THEN** the failure includes the HTTP status but omits the unsafe provider text

#### Scenario: Successful response has invalid JSON
- **WHEN** Hyper returns a success status with an empty or syntactically invalid JSON body
- **THEN** the operation fails without treating that body as endpoint state

### Requirement: Endpoint payloads are validated before state changes
Responses from the provider catalog, credits, teams, devices, device authorization, device polling, and token exchange endpoints SHALL be checked against their endpoint contract before they update models, status state, or credentials. Required strings SHALL be non-empty, numeric limits and expiries SHALL be finite and in range, model pricing SHALL be non-negative, and collection fields SHALL have the expected shape. An invalid payload SHALL fail atomically for the consuming operation.

#### Scenario: One live model is malformed
- **WHEN** a live provider catalog contains a model missing required metadata or containing an invalid numeric limit
- **THEN** the live catalog operation is rejected and no model from that response replaces the current catalog

#### Scenario: Account payload is malformed
- **WHEN** a credits, teams, or devices response does not match its endpoint contract
- **THEN** no account atom is updated from that response

#### Scenario: OAuth payload is malformed
- **WHEN** a device-flow or token-exchange response omits required values or contains an invalid expiry
- **THEN** no credential is created or replaced from that response

### Requirement: Retry-After values are normalized defensively
A `Retry-After` value on an HTTP failure SHALL be accepted only when it is an integer number of seconds or a canonical HTTP date. The resulting non-negative delay SHALL be capped at 24 hours; malformed values SHALL be ignored.

#### Scenario: Retry delay is expressed in seconds
- **WHEN** Hyper returns `Retry-After: 30`
- **THEN** retry-aware consumers receive a 30-second delay

#### Scenario: Retry delay is an excessive date
- **WHEN** Hyper returns a valid HTTP date more than 24 hours in the future
- **THEN** retry-aware consumers receive a delay capped at 24 hours

#### Scenario: Retry delay is malformed
- **WHEN** `Retry-After` is neither integer seconds nor a canonical HTTP date
- **THEN** retry-aware consumers receive no server-specified delay
