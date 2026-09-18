## 1. Config + render layer (status.ts)

- [x] 1.1 Add `hideAuthExpiry: boolean` (default `false`) to `StatusConfig`, `DEFAULT_STATUS_CONFIG`, and `coerceStatusConfig` (non-boolean persisted values fall back to `false`); extend `tests/status.smoke.ts` with coercion cases and verify `npm test` passes
- [x] 1.2 Add an optional `{ hideAuthExpiry?: boolean }` opts parameter to `buildAccountTiers` and `buildAccountSidebarRows` (suppress the auth-glyph atom when set) and thread it through `buildSidebarPanel`; add smoke tests proving the `expires <N>d` row and `⟳ <N>d` tier atom vanish while team/balance/rate atoms, tier compaction, and dividers are unchanged, and verify `npm test` passes

## 2. Command surface (index.ts)

- [x] 2.1 Add `authexpiry true|false` parsing to `handleStatusCommand`, extend `STATUS_USAGE` and `statusSummary()`, add the field to `writeStatusConfig`, and include it in the `reset` default; verify by probe that an invalid value prints usage and changes nothing, the summary prints `hideAuthExpiry=`, and the key lands in `hypercharm.json`
- [x] 2.2 Add the interactive "Hide auth expiry: on/off" toggle to `configureStatusInteractive` that persists and calls `updateStatus` immediately; verify by menu probe that the label flips and the footer re-renders
- [x] 2.3 Pass `statusConfig.hideAuthExpiry` into the render call sites (tiers at `index.ts:667`/`:669`, `buildSidebarPanel` options at `:681`); verify by probe that with the flag on, widget/statusbar lines contain no auth-glyph atom and the published sidebar panel has no `expires` row

## 3. Docs + full validation

- [x] 3.1 Add one prose sentence documenting the option to the README status section; verify the model table is untouched (no `update-models` run)
- [x] 3.2 Run `npm run check` (tsc + status smoke + node:test suites) and an end-to-end probe: fresh config shows the atom; `authexpiry true` hides it everywhere and persists across restart; `authexpiry false` shows current days without re-auth; `reset` restores it — each matching a spec scenario
