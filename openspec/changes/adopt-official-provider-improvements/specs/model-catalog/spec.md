# Spec Delta

## MODIFIED Requirements

### Requirement: Catalog startup and refresh remain resilient
The extension SHALL register `hypercharm` as a complete provider with one stable custom streaming API and SHALL make a usable model catalog available immediately from the current embedded snapshot plus the best compatible namespaced legacy-cache fallback. Pi's standard provider model store SHALL become the primary persisted dynamic catalog: a valid stored catalog SHALL be restored transactionally before an allowed network refresh, and a successful live refresh SHALL be published and persisted transactionally without re-registering the provider. Network refresh SHALL occur only when Pi's runtime policy permits it and credentials are available. A failed, cancelled, empty, or schema-invalid live refresh MUST retain the previously usable catalog rather than unregistering models or preventing provider startup. Every restored or live source SHALL continue through the existing patch, custom-model, and deprecation policy before it is served.

#### Scenario: Extension starts without network access
- **WHEN** network refresh is unavailable or disallowed during startup
- **THEN** a valid Pi-stored, compatible namespaced-cache, or embedded catalog remains registered and selectable

#### Scenario: Pi has a persisted provider catalog
- **WHEN** Pi starts the provider with a valid stored `hypercharm` catalog
- **THEN** that catalog is restored as the current dynamic source before any permitted network refresh

#### Scenario: Upgrade has only the namespaced legacy cache
- **WHEN** no Pi-stored catalog exists but the existing HyperCharm cache is compatible with the current embedded snapshot
- **THEN** the extension uses that cache as a startup fallback while preserving embedded curation and deprecation rules

#### Scenario: Live refresh succeeds
- **WHEN** Pi permits network access and Hyper returns a valid usable catalog
- **THEN** the extension atomically updates the provider's models and Pi's standard model store with the fully curated result

#### Scenario: Live catalog is malformed
- **WHEN** the provider response or any required model entry fails schema validation
- **THEN** no part of that response is published and the previously usable catalog remains served

#### Scenario: Refresh fails after a cached catalog exists
- **WHEN** a later provider refresh times out or returns an HTTP, network, empty-catalog, or payload error
- **THEN** the previously persisted catalog remains served

#### Scenario: Non-interactive startup is cache-only
- **WHEN** Pi starts in a mode whose provider refresh policy disallows network access
- **THEN** the provider restores local catalog state without making a catalog request

#### Scenario: Models refresh while a session is active
- **WHEN** a permitted refresh publishes changed model metadata
- **THEN** model lookup sees the new curated catalog without replacing the provider's auth or streaming registrations
