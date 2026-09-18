## 1. Upstream sync setup

- [x] 1.1 Add the upstream remote and fetch it: `git remote add upstream https://github.com/monotykamary/pi-hypercharm-provider && git fetch upstream`. Verify the sync points: `git merge-base HEAD upstream/main` reports `c130fdf` and `git log -1 upstream/main` reports `fde5375` (v1.3.26).
- [x] 1.2 Start `git merge upstream/main` and confirm the conflict set is exactly `index.ts`, `status.ts`, `tests/status.smoke.ts`, `README.md`, `package.json`, with `models.json` and `deprecated-models.json` auto-merged (verify with `git status` during the merge). Leave the merge open — conflicts are resolved in tasks 3–6 and committed in task 7.4.

## 2. Catalog data acceptance

- [x] 2.1 Verify the auto-merged data files match upstream v1.3.26: `models.json` contains exactly 23 models and none of the 11 delisted ids (`glm-5`, `glm-5.1`, `kimi-k2.5`, `kimi-k2.6`, `llama-3.3-70b-instruct`, `llama-4-maverick-17b-128e-instruct-fp8`, `qwen3-coder-480b-a35b-instruct-int4-mixed-ar`, `qwen3-next-80b-a3b-instruct`, `qwen3.6-flash`, `qwen3.6-max`, `qwen3.6-plus`); `deprecated-models.json` contains all 11 with `deprecatedAt` stamps of `2026-09-17T02:00:12.965Z` (grace clock preserved, not reset). Verify with a node/jq id-set comparison against `git show upstream/main:models.json`.

## 3. status.ts glyph integration

- [x] 3.1 Resolve the `status.ts` conflict by taking upstream's glyph additions into the fork's file: `GlyphMode`/`GlyphSet` types, `UNICODE_GLYPHS`/`ASCII_GLYPHS`, `detectLegacyTerminal`, `resolveGlyphSet`, `resolveWidgetGlyphSet`, `coerceGlyphMode` + `StatusConfig.glyphs` (default `auto`), keeping all fork code (sidebar builders, meters, `sidebar` display mode) around them. Verify with `npx tsc --noEmit` clean.
- [x] 3.2 Apply upstream's signature changes: `buildSessionLine`/`buildAccountTiers` take a trailing `GlyphSet` (default `UNICODE_GLYPHS`), `truncateAnsi` takes an `ellipsis` param, `StatusLineWidget` stores a `GlyphSet` and renders within `width − 1` (never paints the last column). Verify with a targeted node probe: `new StatusLineWidget(theme, left, tiers).render(80)` measures 79 visible columns.
- [x] 3.3 Fork-side extension: thread a trailing `GlyphSet` param (default `UNICODE_GLYPHS`) through `buildAccountSidebarRows`, `buildSidebarRows`, and `buildSidebarPanel`, replacing the hardcoded `◆` and session-line glyphs. Verify the existing sidebar smokes pass unchanged: `node tests/sidebar.smoke.ts && bun run tests/sidebar-publish.smoke.ts`.

## 4. index.ts glyph integration

- [x] 4.1 Resolve the `index.ts` conflict by taking upstream's config/command plumbing into the fork's file: `glyphs` in `writeStatusConfig`/`statusSummary`/`STATUS_USAGE`, the `/hypercharm-status glyphs auto|unicode|ascii` subcommand (usage error on invalid values), and the interactive menu's glyph cycle option. Verify with `npx tsc --noEmit` clean.
- [x] 4.2 Port upstream's `renderStatus` glyph resolution into the fork's version: resolve `glyphs` + `widgetGlyphs`, one-time clamp notification on legacy terminals, widget-variant session/account lines, pass `widgetGlyphs` to `StatusLineWidget` — and pass the resolved (unclamped) glyph set to the fork's sidebar panel publishing. Verify with `npx tsc --noEmit` and `node tests/status.smoke.ts` (after task 6.1) — for this task, typecheck is the gate.

## 5. Version and README

- [x] 5.1 Resolve `package.json`: take upstream's `version` (1.3.26), keep the fork's scripts and devDependencies. Verify: `node -p "require('./package.json').version"` prints `1.3.26` and `git diff upstream/main -- package.json` shows only fork-side additions.
- [x] 5.2 Resolve `README.md`: take upstream's regenerated model table (34 rows — 23 active + the 11 grace-period models upstream documents as served; criterion amended during apply to match upstream's actual artifact) and glyphs documentation (config table row, `/hypercharm-status glyphs` command line, legacy-terminal explainer paragraph), keeping the fork's sidebar sections. Verified: the table is byte-identical to upstream's (`git diff upstream/main -- README.md` shows no table hunk) and the `glyphs` row/section are present.

## 6. Test merge

- [x] 6.1 Resolve `tests/status.smoke.ts` from the fork's version plus upstream's changes: new glyph imports, widget width−1 render expectations (79/51/left+2/9/69/39), `glyphs: "auto"` added to the `coerceStatusConfig` deep-equals, and the legacy-terminal glyph policy sections (detection, resolution, clamping, ASCII purity, ellipsis). Verify: `node tests/status.smoke.ts` prints `status.smoke: all assertions passed`.
- [x] 6.2 Add fork-side assertions: sidebar rows built with `ASCII_GLYPHS` (via `buildSidebarRows`/`buildSidebarPanel`) contain no non-ASCII codepoints (ASCII purity across surfaces, per the status-display spec). Verify: `node tests/status.smoke.ts` still passes with the new assertions.

## 7. Integration verification and commit

- [x] 7.1 Verify the served catalog end to end with a node probe (type-stripping, as the smokes run): `buildModels` over the adopted data yields the 23 active models plus the 11 grace-period deprecated models (34 servable today), patch entries still apply to their DeepSeek models, and `activeDeprecatedModels` with a `now` 15 days past the stamps returns none (eviction). This covers the model-catalog spec scenarios.
- [x] 7.2 Run the full suite: `npm run check` (`tsc --noEmit` + all 7 smoke suites) exits 0.
- [x] 7.3 Manual sanity in a pi session with the extension loaded: `/hypercharm-status` usage lists the `glyphs` option; the model list shows the 23 active models (plus grace-period deprecated ones); the below-editor widget renders without wrapping at the terminal edge.
- [x] 7.4 Conclude the merge: commit the resolved merge (`git commit`), then verify `git log --merges -1 --oneline` shows the upstream merge and `git status` is clean.
