## Context

See `proposal.md` for motivation. The fork's current `main` is at merge commit `224e49b`, with upstream v1.3.26 (`fde5375`) already in its ancestry. The selected upstream head is v1.3.28 (`4d7d607`), four commits ahead. A dry merge predicts content conflicts only in `index.ts` and `package.json`; `README.md` overlaps but auto-merges, and all other upstream files are additions or upstream-only changes.

The fork is not a stock v1.3.26 checkout. It has extracted catalog policy into `model-catalog.ts`, writes a version/hash-stamped cache envelope, owns a Pi Atelier publisher in `sidebar.ts`, extends status behavior with `sidebar` mode and glyph plumbing, captures usage/rate data in a custom stream wrapper, runs seven smoke suites, and gates them in CI. Upstream v1.3.28 was authored against the simpler upstream layout and adds identity, notification, Prism, and real-runtime integration modules/tests. The merge therefore needs semantic integration even where Git can apply a hunk automatically.

The behavioral contracts are in `specs/provider-coexistence`, `specs/provider-diagnostics`, `specs/prism-routing`, and `specs/model-catalog`.

## Goals / Non-Goals

**Goals:**

- Preserve upstream commits as ancestry so future upstream syncs compare and merge cleanly.
- Integrate upstream behavior through the fork's existing catalog, status, sidebar, and stream abstractions rather than replacing them.
- Keep every existing external identifier and fork feature stable while adding collision guarantees, diagnostics, Prism entries, and the v1.3.28 catalog correction.
- Produce one acceptance command that exercises both the fork-owned smoke suites and upstream's new unit/integration suites.

**Non-Goals:**

- Rebase or otherwise rewrite the published fork history.
- Run a fresh provider API model sync beyond upstream commit `4d7d607`; this change adopts the upstream generated snapshot.
- Redesign the catalog cache envelope, sidebar protocol, status layout, OAuth flow, or streaming/usage accounting.
- Add warning configuration, telemetry, Prism notifications, or Prism entries to model context.

## Decisions

### D1 — Merge the pinned upstream head

Fetch `upstream` and merge commit `4d7d607` into the fork branch. Do not squash, rebase, or cherry-pick the four commits.

A merge preserves both histories, makes v1.3.28 an explicit ancestor, and avoids replaying the fork's already-published merge and feature commits. Pinning the reviewed commit prevents a moving `upstream/main` from silently changing implementation scope during apply. If upstream advances, that later delta is a separate change.

### D2 — Centralize identity without changing identifier values

Adopt upstream's `identity.ts` as the only source for provider/API names, the auth environment variable and placeholder, command name, status/widget keys, Prism custom-entry type, and cache/config filenames. Replace duplicate literals in `index.ts` with imports from that module, including the fork-only sidebar/status cleanup paths and the cache/config path construction.

The values remain the fork's existing `hypercharm` values; centralization is what makes disjointness testable. Keeping status, widget, and sidebar behavior keyed through the same constants avoids a conflict resolution that updates one path but leaves another capable of clearing an official-provider slot. A partial approach that centralizes only upstream-touched call sites was rejected because it would leave the coexistence invariant unenforceable.

### D3 — Port diagnostics into fork-native data flows

Adopt upstream's `notify.ts` and one process-scoped notifier. Activate it from `session_start`; before a UI activation warnings go to stderr, after activation they use `ctx.ui.notify`, and stale contexts fall back to stderr. Exact warning strings are deduplicated for the process lifetime.

Wire warnings into the fork's current operations rather than replacing their return shapes:

- Catalog fetch warns on HTTP, parse/transform, empty-result, and non-abort exceptions, then returns no fresh catalog.
- Cache loading keeps the fork's `ModelsCache` parser and version/hash envelope. `ENOENT` is normal; malformed JSON, an invalid envelope, and write failures warn. Successful writes retain `{ version, embeddedHash, models }` so release snapshots cannot be masked by stale shared ids.
- Status config loading/writing retains unknown-key preservation and in-memory fallback. Missing files remain silent; unreadable content and failed writes warn.
- The fork's discriminated account-fetch result stays intact so `metaFetched` and retry behavior remain correct; add an endpoint label to produce specific credit/team/device warnings while suppressing session-abort noise.
- Credential-resolution rejection warns and continues into cached/embedded catalog behavior instead of creating an unhandled rejection.

Taking upstream's simpler array cache or nullable account result verbatim was rejected because it would regress the fork's cache-authority and retry guarantees.

### D4 — Add Prism attribution as an independent lifecycle concern

Adopt `prism.ts` validation and register a namespaced custom-entry renderer using Pi TUI's `Text`. Keep per-extension-instance route state that opens at `turn_start`, accepts only `after_provider_response` events during that window, closes on assistant `message_end`, and is consumed at `turn_end` only for a successful `hypercharm` assistant message.

This state remains separate from the custom stream wrapper's usage/rate-limit capture. Pi's response lifecycle event is the authoritative route source, while the per-request fetch wrapper remains responsible for request counts, spend, and rate headers. The existing async status `turn_end` handler remains in place; the Prism handler appends a custom entry without altering status accounting or the model-visible message list.

Persisted entry data is revalidated at render time because session files are user-editable. The renderer prefers a valid human model name, falls back to model id, and renders nothing for unsafe data. Notifications were rejected for Prism because they are transient and cannot survive session restore.

### D5 — Preserve generated-source and release boundaries

Accept upstream's `models.json`, `README.md` generated row, `bun.lock`, and version `1.3.28` from the merge. Do not hand-edit the generated catalog or README model table. The only catalog semantic delta is upstream's `gpt-oss-120b` metadata correction; the fork's patch/custom/deprecation composition remains authoritative at runtime.

Take the new Pi TUI peer/dev dependency and `jiti` dev dependency. The peer declaration prevents bundling a second TUI copy while allowing the entry renderer to return the host's component type.

### D6 — Compose, rather than replace, the test commands

Set `check` to typecheck, run the full existing `smoke` script, then run the new Node test suite. Keep `smoke` as the fork's seven-suite command; add upstream's `test` command using `node --import jiti/register --test` for identity, notification, Prism, and provider integration tests. CI continues to invoke `npm run check` and therefore covers both families.

Adopt the upstream tests and official-surface fixture, but adapt assumptions that are implementation-specific to the fork. In particular, integration assertions SHALL inspect the fork's version/hash cache envelope and its `models` array rather than requiring upstream's legacy bare-array cache. Add or retain assertions that the real runtime still publishes/withdraws the Atelier panel, uses deprecation grace, hot-swaps models, captures usage/rate data, and keeps all registration keys namespaced.

Copying upstream's package scripts wholesale was rejected because its one-file smoke command would silently stop running six fork-owned suites.

## Risks / Trade-offs

- [A textually clean hunk can still bypass fork abstractions, especially cache parsing or status/sidebar cleanup] → Resolve against both current fork behavior and upstream post-merge behavior; search mechanically for duplicated shared identifiers and old silent `catch` paths before testing.
- [The new real-runtime integration suite assumes upstream's bare-array cache] → Adapt only the storage-shape assertion to the fork's envelope and retain the behavioral assertion that refreshed models survive a later failed refresh.
- [Two `turn_end` concerns can interfere through ordering or stale state] → Keep Prism state isolated, clear it on every terminal path, and test successful, aborted, failed, other-provider, and auxiliary-response sequences in the real runtime.
- [Warnings can spam or report expected session cancellation] → Deduplicate exact messages, suppress `ENOENT` and aborted requests, and exercise pre-UI, UI, non-UI, and stale-context paths.
- [Importing Pi TUI directly can create host-version incompatibility] → Declare it as an unconstrained peer with the repository's current `0.85.1` dev version, matching the upstream release.
- [Upstream may move after planning] → Apply the pinned `4d7d607` commit; review any newer commits in a follow-up rather than broadening this merge.

## Migration Plan

1. Confirm the working tree contains no implementation edits, fetch `upstream`, and verify `upstream/main` still contains pinned commit `4d7d607`.
2. Merge `4d7d607`; resolve `index.ts` by combining upstream identity/diagnostic/Prism behavior with the fork catalog, sidebar, status, OAuth, and stream paths. Resolve `package.json` by composing both test families and dependencies.
3. Accept upstream-only generated/new files, adapt the provider integration test to the cache envelope, and regenerate dependency lock data only through the package manager if the merge result is inconsistent.
4. Run targeted identity, notification, Prism, provider integration, model-catalog, sidebar, routing, and status checks, then run `npm run check` as the complete gate.
5. Commit the merge only after all behavior and namespace searches pass.

Rollback is a mainline-aware revert of the completed merge (`git revert -m 1 <merge-commit>`), which removes v1.3.28 while preserving the fork history. Any cache envelope written by the merged version remains readable by the pre-merge fork because the envelope format is unchanged.
