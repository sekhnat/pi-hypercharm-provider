## Purpose

Defines the model metadata and resilient source-merging behavior that determine which HyperCharm models and reasoning levels users can select.

## ADDED Requirements

### Requirement: Served GPT-OSS metadata matches upstream v1.3.28
The served `gpt-oss-120b` model SHALL expose a context window of 131,072 tokens and a maximum output of 13,107 tokens. Its reasoning-level mapping SHALL support `low`, `medium`, and `high` with their same-named provider values, and SHALL mark `off`, `minimal`, `xhigh`, and `max` as unsupported.

#### Scenario: User inspects GPT-OSS limits
- **WHEN** the v1.3.28 embedded catalog is loaded
- **THEN** `gpt-oss-120b` reports a 131,072-token context window and a 13,107-token maximum output

#### Scenario: User selects a supported reasoning level
- **WHEN** `low`, `medium`, or `high` is requested for `gpt-oss-120b`
- **THEN** the corresponding same-named provider reasoning value is used

#### Scenario: User selects an unsupported reasoning level
- **WHEN** `off`, `minimal`, `xhigh`, or `max` is requested for `gpt-oss-120b`
- **THEN** the catalog does not advertise a provider reasoning value for that level

### Requirement: Catalog startup and refresh remain resilient
The extension SHALL make a usable model catalog available at startup from the best available persisted cache or embedded snapshot, then refresh from the provider catalog when credentials and connectivity permit. A failed refresh MUST retain the previously usable catalog rather than unregistering models or preventing provider startup.

#### Scenario: Extension starts without network access
- **WHEN** the provider catalog cannot be reached during startup
- **THEN** embedded or valid cached models remain registered and selectable

#### Scenario: Live refresh succeeds
- **WHEN** the provider returns a usable live catalog
- **THEN** the extension updates the registered provider models and persists that refreshed catalog for later sessions

#### Scenario: Refresh fails after a cached catalog exists
- **WHEN** a later provider refresh fails
- **THEN** the previously persisted catalog remains served

### Requirement: Local catalog policy continues to apply
Per-model overrides and custom models SHALL continue to merge over the selected embedded, cached, or live catalog. Models in the deprecation graveyard SHALL remain selectable only within the existing 14-day grace period and SHALL be evicted after that period without resetting their original deprecation timestamp.

#### Scenario: Patch overrides a catalog model
- **WHEN** a patch entry targets a model present in the selected catalog source
- **THEN** the served model reflects the patch while retaining unspecified source metadata

#### Scenario: Custom model is absent upstream
- **WHEN** a custom model is not present in the provider catalog
- **THEN** it remains included in the served catalog

#### Scenario: Deprecated model remains inside its grace period
- **WHEN** a deprecated model's original timestamp is less than 14 days old
- **THEN** the model remains selectable with its preserved metadata

#### Scenario: Deprecated model passes its grace period
- **WHEN** a deprecated model's original timestamp reaches 14 days of age
- **THEN** the model is no longer served and its grace clock is not reset
