# model-catalog Specification

## Purpose
Defines which models the extension serves, how delisted models are preserved and retired, and how the embedded catalog tracks the provider API's model list.

## Requirements

### Requirement: Active catalog tracks the provider API

The embedded active catalog (`models.json`) SHALL reflect the provider API's model list as published by the upstream sync at v1.3.26: exactly 23 active models. The 11 models delisted by the provider API on 2026-09-17 — `glm-5`, `glm-5.1`, `kimi-k2.5`, `kimi-k2.6`, `llama-3.3-70b-instruct`, `llama-4-maverick-17b-128e-instruct-fp8`, `qwen3-coder-480b-a35b-instruct-int4-mixed-ar`, `qwen3-next-80b-a3b-instruct`, `qwen3.6-flash`, `qwen3.6-max`, `qwen3.6-plus` — SHALL NOT appear as active models. Surviving models SHALL carry the metadata refresh published with that sync (pricing, context window, max tokens, and modality changes).

#### Scenario: Delisted models are absent from the active catalog
- **WHEN** the embedded active catalog is loaded
- **THEN** none of the 11 delisted model ids appear as active models

#### Scenario: Surviving model metadata is refreshed
- **WHEN** a surviving model's API metadata changed in the synced catalog
- **THEN** the embedded entry reflects the refreshed values (e.g. `gpt-oss-120b` output cost, `kimi-k2.7-code` context window, `glm-5.3` text-only modality)

### Requirement: Delisted models enter a deprecation graveyard with a 14-day grace period

WHEN a previously served model is no longer listed by the provider API, the sync SHALL preserve its full catalog entry in the deprecated-models graveyard (`deprecated-models.json`) stamped with a `deprecatedAt` timestamp rather than dropping it. The model SHALL remain selectable and usable until 14 days after `deprecatedAt`, after which it SHALL be evicted from the graveyard and no longer offered. A later sync MUST NOT reset an existing `deprecatedAt` stamp.

#### Scenario: Grace window keeps a delisted model usable
- **WHEN** a model's `deprecatedAt` stamp is less than 14 days old
- **THEN** the model is still listed and usable with its preserved catalog entry

#### Scenario: Eviction after the grace period
- **WHEN** a model's `deprecatedAt` stamp is 14 days old or older
- **THEN** the model is no longer offered and is removed from the graveyard

#### Scenario: Grace clock is preserved across syncs
- **WHEN** the catalog is re-synced while a model already sits in the graveyard
- **THEN** that model's original `deprecatedAt` stamp is kept unchanged

### Requirement: Manual overrides keep merging over the synced catalog

Per-model overrides (`patch.json`) and models not present in the provider API (`custom-models.json`) SHALL continue to merge over the synced catalog, including over grace-period deprecated models. A catalog sync MUST NOT remove or alter those override sources.

#### Scenario: Patch entries still apply after the sync
- **WHEN** the served catalog is rebuilt after adopting the v1.3.26 data
- **THEN** existing `patch.json` entries (e.g. the DeepSeek thinking-level maps) apply to their models unchanged

#### Scenario: Custom models survive the sync
- **WHEN** `custom-models.json` lists a model the provider API does not
- **THEN** that model remains served after the sync

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
