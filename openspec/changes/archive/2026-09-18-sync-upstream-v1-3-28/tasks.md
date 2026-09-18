## 1. Start the pinned upstream merge

- [x] 1.1 Confirm there are no unrelated implementation edits, fetch `upstream`, and verify `git rev-parse upstream/main` contains pinned commit `4d7d607` and `git merge-base HEAD 4d7d607` is `fde5375`; preserve the OpenSpec planning files while doing this check.
- [x] 1.2 Start `git merge --no-commit 4d7d607` and verify `git diff --name-only --diff-filter=U` reports exactly `index.ts` and `package.json`, with `README.md` auto-merged and upstream-only additions/data staged.

## 2. Accept the v1.3.28 release and catalog baseline

- [x] 2.1 Keep the merge-provided `models.json`, `README.md` model row, `AGENTS.md`, new source/test files, and release metadata rather than hand-editing generated artifacts; verify `models.json` matches `git show 4d7d607:models.json` and the README model table differs from v1.3.26 only in the upstream `gpt-oss-120b` row.
- [x] 2.2 Verify the merged `gpt-oss-120b` entry reports `contextWindow: 131072`, `maxTokens: 13107`, maps only `low`/`medium`/`high` to provider values, and leaves `off`/`minimal`/`xhigh`/`max` unsupported using a direct Node JSON assertion.
- [x] 2.3 Preserve `model-catalog.ts`, `deprecated-models.json`, `patch.json`, and `custom-models.json` semantics across the merge; verify `node tests/models.smoke.ts` still passes and asserts cache-hash authority, patch/custom merging, and 14-day deprecated-model eviction.

## 3. Resolve provider identity and coexistence

- [x] 3.1 Resolve the identity portion of `index.ts` by importing all shared registration, auth, status/widget, Prism, and cache/config names from upstream's `identity.ts`; remove duplicate literals/constants while retaining fork-only sidebar cleanup and publication paths, then verify `npx tsc --noEmit` finds no duplicate or missing identifiers.
- [x] 3.2 Wire `makeProviderConfig`, provider re-registration, `/hypercharm-status`, cache/config path construction, status/widget clearing, and sidebar lifecycle through the centralized constants; verify a repository search finds no hardcoded shared registration name outside `identity.ts`, tests/fixtures, documentation, or intentional user-facing error text.
- [x] 3.3 Run `node --import jiti/register --test tests/identity.test.ts` and the co-install case in `tests/provider.integration.test.ts`; verify duplicate model ids resolve by provider and the official provider's command, renderer, status, and widget keys remain untouched.

## 4. Integrate surfaced diagnostics with fork fallbacks

- [x] 4.1 Adopt upstream's `notify.ts` unchanged in behavior and initialize one process-scoped notifier in `index.ts`; activate it during `session_start`, then verify `tests/notify.test.ts` covers deduplication, pre-UI stderr, UI warning notifications, non-UI sessions, and stale-context stderr fallback.
- [x] 4.2 Add labeled, non-throwing warnings to live catalog HTTP/parse/empty failures, malformed cache reads, cache writes, status-config reads/writes, credential resolution, and credit/team/device fetches while keeping the fork's `ModelsCache` envelope and discriminated account-fetch result; verify direct tests cover each failure class and existing fallback data remains usable.
- [x] 4.3 Suppress warnings for missing optional cache/config files and session-replacement/shutdown aborts; verify targeted notifier/provider tests emit no warning for `ENOENT` or aborted requests but emit one warning for repeated identical real failures.

## 5. Integrate durable Prism route attribution

- [x] 5.1 Adopt `prism.ts`, register the namespaced entry renderer with Pi TUI `Text`, and add per-extension lifecycle state for `turn_start`, `after_provider_response`, assistant `message_end`, and `turn_end` without changing the existing status/usage `turn_end` path; verify `npx tsc --noEmit` and `tests/prism.test.ts` pass.
- [x] 5.2 Verify Prism label validation accepts trimmed printable names/ids, rejects non-strings, empties, values over 200 characters, and control/format/separator characters, and prefers the human model name using `node --import jiti/register --test tests/prism.test.ts`.
- [x] 5.3 Run the provider integration Prism case and verify exactly one durable `hypercharm-prism-route` entry is appended for a successful HyperCharm assistant turn, none leak from auxiliary/aborted/error/other-provider responses, unsafe persisted data is not rendered, and valid entries survive session reopen without entering model context.

## 6. Compose dependencies and both test families

- [x] 6.1 Resolve `package.json` to version `1.3.28`, add `@earendil-works/pi-tui` as peer/dev dependency and `jiti` as a dev dependency, keep the fork's seven-suite `smoke` script, add upstream's four-file `test` script, and set `check` to typecheck plus both; verify the scripts and dependency versions with direct package JSON assertions.
- [x] 6.2 Reconcile `bun.lock` through the package manager only if the merge-provided lock is inconsistent, then verify a frozen/lockfile-respecting dependency install succeeds without unrelated dependency drift.
- [x] 6.3 Adapt `tests/provider.integration.test.ts` to assert the fork's `{ version, embeddedHash, models }` cache envelope instead of a bare array, while retaining upstream's offline load, hot-swap, failed-refresh retention, deprecation grace, warning, Prism durability, and co-install checks; add or retain coverage showing the Atelier sidebar publisher still publishes and withdraws through its dedicated lifecycle test.

## 7. Verify and conclude the merge

- [x] 7.1 Run the fork regression suites directly (`tests/status.smoke.ts`, `sidebar-publish.smoke.ts`, `models.smoke.ts`, `oauth.smoke.ts`, `update-models.smoke.ts`, `sidebar.smoke.ts`, and `routing.smoke.ts`) and fix any loss of sidebar, glyph, OAuth, catalog, usage, rate-limit, or update-script behavior.
- [x] 7.2 Run the upstream-derived suite with `npm test` and verify all identity, notification, Prism, and real-runtime provider integration cases pass.
- [x] 7.3 Run `npm run check`, `git diff --check`, a conflict-marker search, and namespace searches; verify the full gate is green, no unresolved files remain, generated files match upstream, and only the intended v1.3.28 integration plus OpenSpec artifacts are changed.
- [x] 7.4 Stage the resolved files and complete the merge commit; verify `git merge-base --is-ancestor 4d7d607 HEAD`, the latest merge commit has upstream v1.3.28 as its second parent, and `git status` is clean apart from any intentionally uncommitted planning artifacts.
