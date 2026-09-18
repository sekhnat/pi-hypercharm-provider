## Purpose

Defines how HyperCharm records safe Prism routing attribution for successful assistant turns and presents it as durable session history.

## ADDED Requirements

### Requirement: Prism route labels are validated before use
The extension SHALL accept Prism routing metadata from `x-prism-model-name` and `x-prism-model-id` response headers only when each value is a string that remains non-empty after trimming, is no longer than 200 characters, and contains no control, format, line-separator, or paragraph-separator character. A route MAY contain either valid field or both; when both are valid, the human-readable model name SHALL be preferred for display.

#### Scenario: Both route headers are valid
- **WHEN** a HyperCharm response supplies a valid model name and model id
- **THEN** both values are retained and the model name is used as the displayed route label

#### Scenario: Only one route header is usable
- **WHEN** exactly one of the two routing headers passes validation
- **THEN** the route is retained using that value

#### Scenario: Routing headers are unsafe
- **WHEN** all supplied routing values are empty, oversized, non-string, or contain unsafe characters
- **THEN** no route is accepted or rendered

### Requirement: Route attribution is scoped to the successful HyperCharm turn
The extension SHALL record routing metadata only from provider responses associated with the current assistant request. It MUST append a route only when that request ends with a successful assistant message from provider `hypercharm`; auxiliary responses outside the request, responses from another provider, and aborted or failed assistant messages MUST NOT produce a route entry.

#### Scenario: Successful HyperCharm assistant turn
- **WHEN** a HyperCharm assistant request receives usable Prism headers and ends successfully
- **THEN** exactly one route entry for that turn is appended to the session

#### Scenario: Auxiliary response occurs outside a turn
- **WHEN** a response carrying Prism headers occurs before request collection starts or after the assistant request ends
- **THEN** its headers do not leak into a later route entry

#### Scenario: Turn does not qualify
- **WHEN** the assistant message is aborted, ends in error, or belongs to a provider other than `hypercharm`
- **THEN** no route entry is appended even if usable Prism headers were observed

### Requirement: Prism attribution is durable and safe to render
Accepted routes SHALL be stored as namespaced custom session entries and SHALL remain available after the session is closed and reopened. Rendering SHALL revalidate persisted entry data, display a valid entry as `Prism → <preferred route label>`, and omit invalid or tampered data rather than rendering unsafe text.

#### Scenario: Session is reopened
- **WHEN** a session containing Prism route entries is saved and later restored
- **THEN** the entries remain in session history and render with the same validated route labels

#### Scenario: Persisted route data is tampered with
- **WHEN** a stored route entry contains an invalid type or unsafe label
- **THEN** the renderer produces no visible entry for that data
