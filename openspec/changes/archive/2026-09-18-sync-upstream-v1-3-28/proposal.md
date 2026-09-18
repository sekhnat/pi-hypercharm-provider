## Why

The fork is currently synchronized through upstream v1.3.26, while `monotykamary/pi-hypercharm-provider` has advanced to v1.3.28 with a corrected model snapshot and runtime safeguards for provider coexistence, visible failures, and Prism route attribution. Bringing in that complete upstream delta now prevents further divergence while retaining the fork's model-catalog pipeline, Pi Atelier sidebar, expanded smoke suites, and CI behavior.

## What Changes

- Merge the four upstream commits from v1.3.26 (`fde5375`) through v1.3.28 (`4d7d607`) rather than reimplementing or cherry-picking them, resolving the predicted conflicts in `index.ts` and `package.json` while preserving fork-specific behavior.
- Adopt upstream's generated `models.json` snapshot for `gpt-oss-120b`: a 131,072-token context window and only the supported `low`, `medium`, and `high` reasoning levels.
- Centralize every shared Pi identifier under the `hypercharm` namespace and guarantee that this extension can be installed alongside the official `@charmland/pi-hyper-provider` without provider, API, command, entry-renderer, status, widget, auth, or file-name collisions.
- Surface catalog, cache, status-config, credential-resolution, credit, team, and device refresh failures as deduplicated warnings: stderr before a UI is available and Pi warning notifications after UI activation, while retaining cached/embedded data and treating session aborts as non-errors.
- Capture validated `x-prism-model-name` / `x-prism-model-id` response headers for successful HyperCharm assistant turns and append a durable, namespaced `Prism → <route>` session entry that survives session reloads.
- Add the upstream unit/integration suites and their fixture, and combine the upstream test runner with all fork-owned smoke suites so model hot-swapping, deprecation grace, sidebar publishing, routing accounting, diagnostics, Prism persistence, and co-installation remain covered together.
- Update package/release metadata and dependency declarations to v1.3.28, including the Pi TUI peer dependency used by the Prism entry renderer and `jiti` for TypeScript node tests. Preserve the fork's sidebar documentation while accepting the regenerated model-table correction.

## Capabilities

### New Capabilities

- `provider-coexistence`: Namespaced provider identity and collision-free co-installation with the official Charm Hyper provider across all shared Pi registration and persistence surfaces.
- `provider-diagnostics`: Non-fatal runtime failures are surfaced once through the appropriate stderr or UI warning channel without interrupting fallback behavior.
- `prism-routing`: Safe Prism routing metadata is scoped to a successful HyperCharm assistant turn, recorded durably, and rendered in restored sessions.
- `model-catalog`: The served catalog exposes upstream's current `gpt-oss-120b` limits and supported reasoning-level map while preserving cache, patch, custom-model, and deprecation behavior.

### Modified Capabilities

- None. `openspec/specs` currently contains no mainline capabilities; the paths above establish behavioral contracts for the existing implementation and this upstream delta.

## Impact

- **Git history:** integrate upstream `fde5375..4d7d607` (four commits) with a merge; predicted textual conflicts are limited to `index.ts` and `package.json`, while `README.md` auto-merges.
- **Runtime code:** `index.ts` plus new `identity.ts`, `notify.ts`, and `prism.ts`; fork-owned `model-catalog.ts`, `sidebar.ts`, `oauth.ts`, status/glyph behavior, and Atelier publishing must remain intact.
- **Generated data/docs:** adopt upstream changes to `models.json` and the generated README model row; do not hand-edit generated files outside the merge result.
- **Tests/tooling:** add upstream identity, notification, Prism, and provider integration tests plus the official-surface fixture; preserve and continue running the fork's seven smoke suites and `.github/workflows/check.yml` acceptance gate.
- **Dependencies:** add `@earendil-works/pi-tui` as peer/dev dependency and `jiti` as a dev dependency, updating `bun.lock` consistently.
- **Compatibility:** no intentional breaking change. Existing provider id, command, auth environment variable, config/cache file names, status surfaces, sidebar behavior, and catalog fallback semantics remain stable; the new guarantees primarily make coexistence and failures observable.
