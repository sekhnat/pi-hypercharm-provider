# Proposal

## Why

Pi 1.0.0 shipped on 2026-10-01 and upstream `monotykamary/pi-hypercharm-provider` has since added Pi 0.87, 0.99 and 1.0.0 support (its v1.3.34–v1.3.37 line). This fork is still pinned to Pi 0.86.0, so it has not been validated against the stable 1.0 host that users are now installing.

A scratch copy of this repo run against Pi 1.0.0 shows the fork is already close:

- `tsc --noEmit` is clean, all smoke suites pass, and 97 of 98 `npm test` cases pass.
- The one failure is test-only. The deprecated-grace fixture in `tests/provider.integration.test.ts` reads the wall clock and assumes a model is still inside the 2-week window. Today (2026-10-02) none are.
- The upstream offline probe, `scripts/test-pi-compat.mjs`, fails on this fork. It reads `pendingProviderRegistrations`, but this fork registers a *native* provider, which Pi 1.0 queues in `pendingNativeProviderRegistrations`.

So the work is validating and locking in 1.0 support, not migrating code.

## What Changes

- Pin the `@earendil-works/pi-ai`, `pi-coding-agent` and `pi-tui` dev dependencies to `1.0.0` and refresh `bun.lock`. Host packages stay wildcard peers and are never bundled. This is already the case for the four peers and is now enforced.
- Add an offline Pi-host compatibility probe (`npm run test:pi`), adapted from upstream to the native-provider registration path. It checks manifest loading, the catalog registered by the native provider, session lifecycle, and real `streamSimple` transport (Unicode, tool calls, empty response, usage, request hooks, cancellation). It stubs all network access.
- Make the integration suite time-independent and lifecycle-correct. The deprecated-grace test pins its clock to a point inside the graveyard's grace window, and test sessions emit `session_shutdown` before `dispose()`, as the pi CLI does.
- Document Pi 1.0 compatibility in the README, covering how to run the probe and how to point it at an installed host.
- Run the new probe in CI next to `bun run check`.
- Record candidate Pi 1.0 features in `design.md` as **advice only**. None are implemented here.

One runtime fix is included, found during the manual Pi 1.0 check: with `hideOnOtherProvider` off, switching to another provider's model withdrew the sidebar panel but let sidebar-targeted parts reappear in the footer. They now stay out of the footer whenever a sidebar host is present. Nothing is **BREAKING**.

## Capabilities

### New Capabilities
- `pi-host-compatibility`: the extension loads and works on the supported Pi host version, declares host packages as wildcard peers (never bundled), and ships an offline probe that proves manifest loading, the native-provider catalog, lifecycle and streaming against a real host without network.

### Modified Capabilities
- `status-display`: sidebar-targeted parts never fall back to the footer while a sidebar host is present, whichever provider is active (ADDED requirement).

## Impact

- **Code**: one footer-routing fix in `index.ts` (`renderStatus`), with `tests/sidebar-model-switch.test.ts`. Otherwise test and tooling only: `tests/provider.integration.test.ts`, new `scripts/test-pi-compat.mjs`, `package.json`, `bun.lock`, `README.md`, `.github/workflows/check.yml`.
- **Dependencies**: dev dependencies `0.86.0` → `1.0.0`. This pulls in Pi's new `pi-codemode`, `pi-mcp` and `chord` packages, and `openai` 7.x, transitively. `peerDependencies` is unchanged.
- **Compatibility**: the `hypercharm` provider id, `/hypercharm-status` command, `HYPERCHARM_API_KEY`, status/widget keys and config/cache filenames are untouched, so the `provider-coexistence` guarantees hold.
- **Assumptions**: no version bump or CHANGELOG is added. The fork's `package.json` version tracks its own merges and has no CHANGELOG, so the maintainer decides on a release. Upstream's own version numbers are not mirrored.
