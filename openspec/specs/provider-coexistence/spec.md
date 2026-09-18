# provider-coexistence Specification

## Purpose
Defines the stable HyperCharm identity and the isolation guarantees that let this extension run beside the official Charm Hyper provider without shared-surface collisions.

## Requirements

### Requirement: Shared Pi identifiers are namespaced and stable
The extension SHALL use the `hypercharm` namespace for every identifier it registers with or persists through Pi, including its provider id, custom API name, command, custom-entry type, status keys, widget key, authentication environment variable, and config/cache file names. Those identifiers MUST remain unique within the extension and disjoint from the official provider's reserved `hyper` identifiers.

#### Scenario: HyperCharm registers its public surfaces
- **WHEN** the extension loads
- **THEN** it registers provider `hypercharm`, command `hypercharm-status`, entry type `hypercharm-prism-route`, status/widget keys rooted at `hypercharm`, and authentication/config/cache names rooted at `hypercharm` without claiming the official provider's corresponding names

#### Scenario: Existing user-facing identifiers remain compatible
- **WHEN** a user upgrades from v1.3.26 to v1.3.28
- **THEN** the existing `hypercharm` provider id, `/hypercharm-status` command, `HYPERCHARM_API_KEY`, status keys, and config/cache file names continue to resolve unchanged

### Requirement: Official and fork providers can run together
The extension SHALL co-install with `@charmland/pi-hyper-provider` without replacing, clearing, or intercepting the official provider's registrations. Model resolution MUST remain provider-scoped even when both providers publish the same model id.

#### Scenario: Same model id is served by both providers
- **WHEN** both extensions are installed and both publish a model with the same id
- **THEN** selecting that id under provider `hypercharm` resolves this extension's model and selecting it under provider `hyper` resolves the official provider's model

#### Scenario: Commands and transcript renderers coexist
- **WHEN** both extensions register their status commands and Prism entry renderers
- **THEN** each command and renderer remains independently addressable under its own namespace

#### Scenario: Status cleanup remains isolated
- **WHEN** either extension updates or clears its status and widget output
- **THEN** it changes only its own registered keys and leaves the other extension's UI output intact
