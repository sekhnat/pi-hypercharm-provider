## Why

This repo (sekhnat/pi-hypercharm-provider) forked from monotykamary/pi-hypercharm-provider at v1.3.22 (merge-base `c130fdf`) and has diverged (model-catalog pipeline, Pi Atelier sidebar, extra tests, CI). Upstream has since published v1.3.23–v1.3.26: the HyperCharm provider API delisted 11 models on 2026-09-17, and upstream shipped a legacy-terminal footer-glyph fix. The fork still serves the stale 34-model catalog (empty deprecation graveyard) and lacks the glyph safety behavior, so it drifts further from upstream with every API catalog change.

## What Changes

- **Adopt upstream's generated catalog data verbatim** (same API, same pipeline): `models.json` drops from 34 to 23 models; `deprecated-models.json` gains the 11 delisted models — `glm-5`, `glm-5.1`, `kimi-k2.5`, `kimi-k2.6`, `llama-3.3-70b-instruct`, `llama-4-maverick-17b-128e-instruct-fp8`, `qwen3-coder-480b-a35b-instruct-int4-mixed-ar`, `qwen3-next-80b-a3b-instruct`, `qwen3.6-flash`, `qwen3.6-max`, `qwen3.6-plus` — stamped `deprecatedAt: 2026-09-17T02:00:12.965Z` (grace clock preserved, not reset; the fork's existing 14-day grace keeps them selectable until ~2026-10-01). Surviving models pick up upstream's metadata refresh (pricing/context tweaks, e.g. GLM 5.3 now text-only at 128K, Kimi K2.7 Code 262K→256K).
- **Port upstream's footer glyph terminal-safety feature**: new `glyphs` status config (`auto` | `unicode` | `ascii`, default `auto`), persisted to config and settable via `/hypercharm-status glyphs …` and the interactive `/hypercharm-status` menu; ASCII fallback on legacy terminals (mintty/Cygwin/msys) whose cell-width tables disagree with the widget width math; the below-editor widget never paints the terminal's last column; an explicit `unicode` choice is clamped to ASCII for widget content on legacy terminals (statusbar honors the exact choice).
- **Fork-specific integration**: thread the glyph set through the fork's sidebar panel builders (`buildSidebarRows` / `buildAccountSidebarRows` / `buildSidebarPanel`) so widget, statusbar, and sidebar all honor the same glyph policy.
- **Merge upstream history** (`c130fdf..fde5375`, 7 commits) into the fork branch and resolve the conflicts in the files both sides changed: `index.ts`, `status.ts`, `tests/status.smoke.ts`, `README.md`, `package.json`. Fork-only files (`model-catalog.ts`, `sidebar.ts`, extra tests, CI workflow) are untouched by upstream.
- **Housekeeping**: `package.json` version 1.3.22 → 1.3.26; README gains upstream's regenerated model table (23 rows) and glyphs documentation while keeping the fork's sidebar sections; `tests/status.smoke.ts` merges upstream's glyph/width assertions (widget renders at width − 1) with the fork's sidebar tests.

### Assumptions (recorded, not blocking)

- "Rebase with those changes" is scoped to the **full upstream delta** (catalog data + glyphs fix + version), not models-only: a fork sync brings all upstream commits, and the parenthetical "(they're changes to the models API)" characterizes the trigger, not a filter. Tasks are grouped so the catalog-data step and the glyph-integration step remain independently reviewable.
- Mechanism is a **git merge** of upstream main, not a literal history-rewriting rebase: the fork branch (with its merged PR) is published, and a merge preserves its history while bringing upstream in. A literal rebase remains an option if explicitly requested.

## Capabilities

### New Capabilities

- `model-catalog`: the extension's served model catalog — active models, the deprecated-models graveyard with its 14-day grace period, and how catalog data tracks the upstream/provider API.
- `status-display`: the footer/account status surfaces (widget, statusbar, sidebar panel) — their config surface, glyph sets, and terminal-safety behavior.

### Modified Capabilities

(none — `openspec/specs` is empty; both capabilities are established by this change)

## Impact

- **Data files** (auto-generated, adopt upstream wholesale): `models.json`, `deprecated-models.json`. `patch.json` (3 DeepSeek thinkingLevelMap entries) and `custom-models.json` (empty) need no edits — neither references any delisted model.
- **Code**: `status.ts` (GlyphMode/GlyphSet plumbing, widget last-column guard), `index.ts` (config persistence, command surface, renderStatus dual-path glyph resolution, sidebar render path), no changes to `model-catalog.ts`/`sidebar.ts`/`oauth.ts` beyond what the glyph plumbing requires.
- **Tests**: `tests/status.smoke.ts` (widget width expectations 80→79 etc., + glyph policy assertions); existing sidebar/models/oauth/routing/update-models smokes unaffected (verified: no test or script references any of the 11 delisted models).
- **Docs**: `README.md` model table + glyphs section.
- **No API, auth, dependency, or breaking changes**: delisted models remain servable through the grace window; eviction after grace is the pipeline's existing behavior, now exercised with real data.
- **CI**: `.github/workflows/check.yml` runs `npm run check` (tsc + 7 smoke suites) — the acceptance gate for the merge.
