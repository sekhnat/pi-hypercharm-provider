# Tasks

## 1. Pin Pi 1.0.0

- [x] 1.1 Set `@earendil-works/pi-ai`, `pi-coding-agent` and `pi-tui` dev dependencies to exactly `1.0.0` in `package.json`, leaving the four `peerDependencies` at `*` and `dependencies` empty; verify with `node -e` that no host package is under `dependencies`
- [x] 1.2 Regenerate `bun.lock` with `bun install` and verify `bun install --frozen-lockfile` succeeds and `node_modules/@earendil-works/pi-coding-agent/package.json` reports `1.0.0`
- [x] 1.3 Run `npx tsc --noEmit` and verify it is clean with no source edits (scratch run was clean; if it is not, stop and raise a separate change)

## 2. Make the integration suite time-independent

- [x] 2.1 In `tests/provider.integration.test.ts`, add a `catalogNow` option to `load()` that pins `Date.now` only around `loader.reload()` and restores it in `finally`; verify the clock is real again immediately after load
- [x] 2.2 Update the "loads offline" test to load at `max(deprecatedAt) + 24h` from `deprecated-models.json` and compute its fresh/stale partition from that instant instead of `Date.now()`; verify the test passes today (it currently fails on 2026-10-02) and still asserts `fresh.length > 0`
- [x] 2.3 Add `shutdown()` to the `load()` harness (emit `session_shutdown` with reason `quit`, then `session.dispose()`) and replace every `session.dispose()` in test teardown with `await harness.shutdown()`, including the `first`/`second`/`restored` harnesses; verify `grep -n "session.dispose" tests/provider.integration.test.ts` shows only the one inside `shutdown()`
- [x] 2.4 Run `npm test` and verify all 98 cases pass with no test-only failures

## 3. Offline Pi-host compatibility probe

- [x] 3.1 Add `scripts/test-pi-compat.mjs` adapted from upstream: temp `PI_CODING_AGENT_DIR`, `fetch` stubbed to a 503, host selectable via `PI1_HOST_PACKAGE` / `PI1_HOST_ENTRY=bundle`, asserts executing and dev host `VERSION === "1.0.0"`, and asserts host packages are wildcard peers and never `dependencies`; verify it fails clearly if the version differs
- [x] 3.2 Discover providers from both `pendingNativeProviderRegistrations` (models via `provider.getModels()`) and `pendingProviderRegistrations` (models via `config.models`), asserting at least one provider with the message "providers register before session startup"; verify it finds `hypercharm` on the fork
- [x] 3.3 Keep the catalog-shape assertions (unique `type/id`, `api`, `baseUrl`, positive `contextWindow`/`maxTokens`, text input, finite non-negative costs) and confirm how native models express `type`, defaulting to chat if absent; verify the assertions run over every embedded model
- [x] 3.4 Keep the offline transport probes through `ModelRuntime.streamSimple` (Unicode text, tool call, empty response, abort) asserting one `start`, one terminal event, usage totals, and `onPayload`/`onResponse`/`onProviderStreamEvent` hooks; verify the fork's namespaced stream wrapper is the code path exercised (e.g. the probe's payload hook sees the `max_tokens` ceiling)
- [x] 3.5 Add `"test:pi": "node scripts/test-pi-compat.mjs"` to `package.json` and verify `npm run test:pi` prints a JSON summary with `lifecycle: "passed"` and exits 0
- [x] 3.6 Negative check: temporarily make the extension register no provider (scratch copy or `git stash`, reverted afterwards) and verify the probe fails with the "providers register" message; confirm the working tree is clean afterwards

## 4. CI and documentation

- [x] 4.1 Add a `bun run test:pi` step after `bun run check` in `.github/workflows/check.yml` and verify the YAML parses and the step order is install → check → test:pi
- [x] 4.2 Add a "Pi 1.0 compatibility" section to `README.md` (above `## Features`, outside the auto-generated model table) stating "Tested with Pi 1.0.0", wildcard peers vs exact dev pins, `npm run test:pi`, and `PI1_HOST_PACKAGE` / `PI1_HOST_ENTRY=bundle`; verify `node scripts/update-models.js` leaves the new section intact (or confirm by reading the script that it only rewrites the model table)

## 5. Footer-routing fix (found during manual verification)

- [x] 5.1 In `index.ts` `renderStatus`, route the widget fallback by sidebar-host presence only (not by active provider); verify `tests/sidebar-model-switch.test.ts` fails on the old code and passes on the new
- [x] 5.2 Register `tests/sidebar-model-switch.test.ts` in the `npm test` script; verify `npm run check` runs it and passes

## 6. Verification

- [x] 6.1 Run `npm run check && npm run test:pi` from a clean `bun install --frozen-lockfile` and verify everything passes
- [ ] 6.2 Manually run pi 1.0.0 with a HyperCharm model selected in `tuiMode: "fullscreen"` (default) and `"regular"`, and verify the footer status, sidebar panel and `/hypercharm-status` render and clear correctly on model switch; record the result in the PR description
- [x] 6.3 Run `openspec validate support-pi-1-0 --strict` and verify it passes
