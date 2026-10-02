# Spec Delta

## Purpose

Defines which Pi host versions the extension is verified against and the offline evidence that it loads, serves its catalog, and streams correctly on them, so host upgrades are validated without live provider traffic.

## ADDED Requirements

### Requirement: Extension loads and runs on the supported Pi host
The extension SHALL load without errors or warnings on Pi 1.0.0 through Pi's package-loading path, and SHALL register provider `hypercharm` with its embedded catalog before any session starts. Startup and shutdown MUST complete without extension-reported errors, and existing user-facing behavior (provider id, status command, authentication variable, status surfaces, Prism routing entries) MUST be unchanged by the host upgrade.

#### Scenario: Package loads on Pi 1.0.0
- **WHEN** Pi 1.0.0 loads the extension package from its manifest
- **THEN** every manifest entrypoint loads, no load errors or warnings are reported, and provider `hypercharm` is registered with a non-empty catalog

#### Scenario: Session lifecycle completes cleanly
- **WHEN** a session starts with the extension bound and then shuts down
- **THEN** no extension error is reported at either point

#### Scenario: User-facing identifiers survive the upgrade
- **WHEN** a user upgrades the host from Pi 0.86 to Pi 1.0.0
- **THEN** provider `hypercharm`, command `/hypercharm-status`, `HYPERCHARM_API_KEY`, and the footer and sidebar keys continue to resolve unchanged

### Requirement: Host packages are peers and never bundled
The extension SHALL declare every host-provided Pi package it imports (`pi-ai`, `pi-coding-agent`, `pi-tui`) and `typebox` as wildcard peer dependencies, and MUST NOT list any of them as runtime dependencies. Development dependencies on Pi packages SHALL be pinned to one exact version, and that version SHALL equal the host version the compatibility probe asserts.

#### Scenario: Manifest keeps host packages as wildcard peers
- **WHEN** the package manifest is inspected
- **THEN** each host package that the extension imports appears under peer dependencies with the wildcard range and does not appear under runtime dependencies

#### Scenario: Development pin matches the verified host
- **WHEN** the development dependencies on Pi packages are inspected
- **THEN** they share one exact version, and it is the version the compatibility probe verifies

### Requirement: Offline compatibility probe verifies the host contract
The repository SHALL provide an offline probe that runs the extension inside a real Pi host and verifies, without any network access, that: the manifest loads cleanly; the registered provider exposes a catalog whose entries are unique and well-formed (identifier, name, API, base URL, positive context window and output ceiling, text input, finite non-negative costs); a session binds and shuts down without extension errors; and the provider's streaming path correctly handles Unicode text, tool calls, an empty response, usage accounting, request and response hooks, and cancellation. The probe MUST replace network access with a stub that cannot reach a live endpoint, and MUST be runnable against an installed Pi host selected by the operator instead of the development copy.

#### Scenario: Probe passes on the development host
- **WHEN** the probe runs against the pinned development host
- **THEN** it verifies catalog, lifecycle, and streaming checks for provider `hypercharm`, reports a summary, and exits successfully

#### Scenario: Probe never reaches a live endpoint
- **WHEN** the extension attempts a catalog, account, or completion request during the probe
- **THEN** the request is answered by the stub, and no live provider endpoint is contacted

#### Scenario: Probe targets an installed host
- **WHEN** the operator selects an installed Pi host package, optionally its bundled runtime
- **THEN** the probe executes the extension in that host and fails if the host version differs from the version the probe expects

#### Scenario: Probe detects a missing provider registration
- **WHEN** the extension loads but registers no provider
- **THEN** the probe fails with a message that providers must register before session startup

### Requirement: Compatibility checks are deterministic over time
Automated compatibility and integration tests SHALL NOT depend on the wall-clock date. Tests that exercise the deprecated-model grace window MUST evaluate catalog loading at a fixed instant relative to the stored deprecation timestamps, and every test session MUST emit the session shutdown event before it is disposed so lifecycle cleanup runs as it does in the Pi CLI.

#### Scenario: Grace-window test passes regardless of the current date
- **WHEN** the integration suite runs on a date after every stored deprecation timestamp has aged past the grace window
- **THEN** the grace-window test still observes at least one model inside the window and every expired model evicted

#### Scenario: Test sessions shut down like the CLI
- **WHEN** an integration test finishes with a session
- **THEN** the session shutdown event is emitted before the session is disposed
