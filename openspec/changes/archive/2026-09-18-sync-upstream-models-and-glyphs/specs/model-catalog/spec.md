## Purpose

Defines which models the extension serves, how delisted models are preserved and retired, and how the embedded catalog tracks the provider API's model list.

## ADDED Requirements

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
