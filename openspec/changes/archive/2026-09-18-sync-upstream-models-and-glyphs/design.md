## Context

The fork diverged from upstream at `c130fdf` (v1.3.22). Since then the fork added: the unified model-catalog pipeline (`model-catalog.ts` with the deprecation graveyard + 14-day grace), the Pi Atelier sidebar (`sidebar.ts`, sidebar builders in `status.ts`, a `sidebar` display mode, publishing in `index.ts`), 7 smoke suites, and CI (`.github/workflows/check.yml`). Upstream added: 3 catalog syncs (11 models delisted by the provider API on 2026-09-17, metadata refresh for survivors), the legacy-terminal glyph fix, and releases through v1.3.26 (`fde5375`).

Merge-conflict topology (verified against `merge-base..upstream/main` and `merge-base..HEAD`):

- **Both sides changed** (conflicts, manual resolution): `index.ts`, `status.ts`, `tests/status.smoke.ts`, `README.md`, `package.json`.
- **Upstream-only changed** (clean auto-merge, take upstream): `models.json` (34→23), `deprecated-models.json` (`{}`→11 entries stamped `deprecatedAt: 2026-09-17T02:00:12.965Z`).
- **Fork-only files** (untouched by the merge): `model-catalog.ts`, `sidebar.ts`, `oauth.ts`, 5 extra test suites, CI workflow, `tsconfig.json` (fork changes only).
- No test, script, `patch.json`, or `custom-models.json` entry references any delisted model id, so catalog-data adoption breaks nothing downstream.

## Goals / Non-Goals

**Goals:**

- Bring upstream v1.3.23–v1.3.26 into the fork with upstream's semantics intact (catalog data, glyph behavior, version).
- Keep every fork feature working unchanged (sidebar, catalog pipeline, meters, CI).
- Minimize semantic drift from upstream in the shared files so the *next* sync merges cleanly.

**Non-Goals:**

- A fresh live pull from the provider API (`scripts/update-models.js`) — this change adopts upstream's v1.3.26 snapshot; a live re-sync is a follow-up at the maintainer's discretion.
- A history-rewriting `git rebase` of the published fork branch.
- Any behavior beyond upstream's delta plus the minimal fork-side glyph plumbing.

## Decisions

### D1 — Sync mechanism: `git merge` of upstream main, not a rebase

Add `monotykamary/pi-hypercharm-provider` as a persistent `upstream` remote, fetch, and `git merge upstream/main`, resolving conflicts per file below. Rationale: the fork branch is published and contains a merge-commit PR; a merge preserves its history, keeps upstream's commits pristine (future syncs stay clean), and needs no force-push. A literal rebase would replay the fork's commits (including a merge commit) onto upstream — messy and destructive for a published branch; cherry-picking the 7 upstream commits would duplicate history and worsen the next sync's conflicts.

### D2 — Catalog data: adopt upstream's generated files verbatim

`models.json` and `deprecated-models.json` resolve as "theirs" (upstream). These files are auto-generated from the same provider API by the same script lineage; upstream's files *are* the sync output. Critically, upstream's `deprecatedAt: 2026-09-17T02:00:12.965Z` stamps are preserved — the 11 models keep their full grace window (until ~2026-10-01) exactly as upstream users experience it. Re-running our own `update-models.js` instead would require an API key and would stamp *fresh* `deprecatedAt` values (resetting the grace clock) and could pick up API drift upstream hasn't shipped. The fork's runtime pipeline (`buildModels` → `withDeprecated` seeding → patch/custom merge → live-API merge with stale-cache fallback) already implements every behavior the new data exercises — no pipeline code changes needed.

### D3 — Glyph code: port upstream's implementation as-is, extend to the fork's sidebar path

Resolve `status.ts`/`index.ts` conflicts by taking upstream's glyph hunks (GlyphMode/GlyphSet/`UNICODE_GLYPHS`/`ASCII_GLYPHS`, `detectLegacyTerminal`, `resolveGlyphSet`, `resolveWidgetGlyphSet`, `coerceGlyphMode`, `StatusConfig.glyphs`, glyph params on the line builders/widget, the width−1 render guard, config persistence, `/hypercharm-status glyphs` subcommand, interactive menu cycle, renderStatus dual-set resolution with one-time clamp notification) and re-integrating the fork's code around them (`sidebar` display mode, sidebar panel publishing, one-fact-per-row builders, rate meters). Upstream's default-parameter style (`glyphs: GlyphSet = UNICODE_GLYPHS`) is kept so existing fork call sites and sidebar tests pass unchanged.

**Fork-side extension — sidebar glyph resolution:** the sidebar builders (`buildSidebarRows`, `buildAccountSidebarRows`, `buildSidebarPanel`) gain a trailing `GlyphSet` parameter (default `UNICODE_GLYPHS`) replacing their hardcoded `◆`/session-line glyphs; `index.ts` passes the resolved set when publishing. The sidebar uses `resolveGlyphSet` (the *unclamped* resolver): sidebar rows are host-sanitized and not edge-padded by the extension, so the pending-wrap hazard that justifies clamping explicit `unicode` for the widget does not apply — the statusbar's rationale carries over (`auto` still degrades on legacy terminals; explicit choices are honored). Structural rows (the divider rule, rate-meter cells) are panel furniture outside the glyph policy — the glyph set governs the bolt/gem/warn/auth/sep characters only.

**Why upstream's shape wins over a fork-native redesign:** every deviation from upstream's glyph code becomes permanent merge friction in future syncs. The upstream post-merge files (`git show upstream/main:status.ts`) serve as the reference target for the shared code; the fork's additions sit around them, not inside them.

### D4 — Version and metadata

`package.json`: take upstream's `version` (1.3.26), keep the fork's scripts/devDependencies (the fork has no independent release line). `README.md`: upstream's regenerated model table (34 rows — the 23 active models plus the 11 grace-period models upstream documents as served during the 14-day window, discovered during apply; the auto-merge reproduced it byte-identically) and glyphs documentation (config row, command line, explainer paragraph) replace the fork's counterparts; the fork's sidebar sections stay.

### D5 — Tests: merge both sides of `tests/status.smoke.ts`

Start from the fork's version (sidebar tests included) and apply upstream's changes: new imports (`ASCII_GLYPHS`, `UNICODE_GLYPHS`, `detectLegacyTerminal`, `resolveGlyphSet`, `resolveWidgetGlyphSet`), updated widget render expectations (width−1: 80→79, 52→51, etc.), `glyphs: "auto"` added to the `coerceStatusConfig` deep-equals, and the new glyph-policy sections (detection, resolution, clamping, ASCII purity, ellipsis). Add fork-side assertions covering the sidebar rows under ASCII glyphs (ASCII purity across surfaces). The other six suites need no changes (verified: none reference delisted models or glyph internals).

## Risks / Trade-offs

- [Conflicts in `index.ts`/`status.ts` are semantic, not textual — a naive hunk merge can silently drop fork behavior (sidebar publishing) or upstream behavior (clamp notify)] → Mitigation: resolve against upstream's post-merge file as the glyph-code reference, run `npm run check` after each file, rely on the fork's sidebar smokes to catch regressions.
- [Sidebar glyph behavior has no upstream precedent; explicit `unicode` on a legacy terminal could mis-measure in the host panel] → Mitigation: bounded, cosmetic (host sanitizes rows); `auto` degrades safely; sidebar is a fork-only surface so no upstream drift is possible.
- [Adopting the 2026-09-17 stamps means the 11 models vanish ~2026-10-01 for users still selecting them] → Accepted: identical to upstream's behavior and the pipeline's designed grace mechanism; the README table shows only the 23 active models.
- [Upstream's snapshot may lag the live API] → Accepted: this change is a sync with upstream v1.3.26 by definition; a live re-sync via `scripts/update-models.js` remains available as a follow-up.

## Migration Plan

1. `git remote add upstream https://github.com/monotykamary/pi-hypercharm-provider && git fetch upstream`
2. `git merge upstream/main` → resolve conflicts per D2–D5 (data files: theirs; code: upstream glyph hunks + fork features around them).
3. `npm run check` (tsc + 7 smoke suites) green; manual sanity: `/hypercharm-status` shows the glyphs option, model list = 23 active + grace-period models.
4. Rollback: single-commit revert of the merge (`git revert -m 1 <merge>`).
