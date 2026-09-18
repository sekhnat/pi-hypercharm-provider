## Context

`status.ts` owns the pure render layer: `StatusConfig` + `coerceStatusConfig`, the compact account tiers (`buildAccountTiers`), and the sidebar account rows (`buildAccountSidebarRows`, reached via `buildSidebarPanel`). `index.ts` owns persistence (`hypercharm.json` under the agent dir), the `/hypercharm-status` command and interactive menu, and the call sites (`index.ts:667`/`:669` for tiers, `buildSidebarPanel` at `:681`). Both render paths are pure functions of `(AccountState, lowBalance, glyphs)` — config does not currently reach them. The expiry atom comes from `AccountState.authDaysLeft`, populated once by `refreshAccountMeta` (`/v1/devices`). `accountHasData` deliberately ignores `authDaysLeft`, so the atom only ever renders alongside other account data; hiding it can never orphan an account block or divider. See proposal.md — Why for motivation.

## Goals / Non-Goals

**Goals:**
- One persisted opt-out that suppresses the expiry atom on all three surfaces (sidebar panel, widget, statusbar).
- Discoverable and reversible from both the command line and the interactive menu.
- Zero behavior change for existing configs (default `false`).

**Non-Goals:**
- Per-surface granularity (one flag governs all surfaces).
- Changing the frozen-countdown behavior (the value is fetched once per process; making it tick/re-fetch is a separate change).
- Any change to `/v1/devices` fetching, token refresh, or the other account atoms.

## Decisions

1. **Config key `hideAuthExpiry: boolean`, default `false`.** Matches the existing hide-prefixed boolean convention (`hideOnOtherProvider`); an absent key in existing config files coerces to `false`, so upgrades are invisible until the user opts in. Alternative considered: inverted `showAuthExpiry` — rejected as inconsistent with the established flag vocabulary.
2. **Thread the flag into the builders as an options parameter** — `buildAccountTiers(acc, lowBalance, glyphs, opts?)` and `buildAccountSidebarRows(acc, lowBalance, glyphs, opts?)` take `{ hideAuthExpiry?: boolean }` (default `false`); `buildSidebarPanel` passes it through to the account rows. Existing signatures stay backward-compatible, so current tests and callers keep working. Alternative considered: zeroing `authDaysLeft` on the account snapshot in `index.ts` before rendering — rejected: it mutates shared state snapshots, obscures intent, and risks leaking the mutation into the sidebar publisher.
3. **CLI key `authexpiry true|false`.** Consistent with the existing boolean-key grammar (`hide true|false`, parsed lowercase). A no-value toggle form was considered and rejected — every existing boolean key requires an explicit value, and the interactive menu already provides toggle ergonomics.
4. **Menu entry mirrors `hideOnOtherProvider`** — a cycling label ("Hide auth expiry: on/off") that persists and calls `updateStatus` immediately.
5. **Summary + usage + README.** `statusSummary()` gains `hideAuthExpiry=`, `STATUS_USAGE` documents `authexpiry true|false`, and the README status section gains one prose sentence (the model table stays script-generated — do not touch it).

## Risks / Trade-offs

- [One flag, no per-surface granularity] → Acceptable: the atom is small and appears in the same contexts on every surface; per-surface keys can be added later without breaking this one.
- [Users may still see a stale "30d" when the atom is visible] → Out of scope by design (Non-Goals); this change only adds the opt-out.
- [Downgrade with a persisted `hideAuthExpiry` key] → Harmless: older builds coerce field-by-field and ignore unknown keys; `writeStatusConfig` merges onto the existing raw object, so no other settings are lost.

## Migration Plan

Additive config + additive function parameters; no data migration. Rollback is a plain revert — a stray `hideAuthExpiry` key in `hypercharm.json` is ignored by older builds. Verification: `npm test` (status smoke + integration suites) plus a manual probe of `/hypercharm-status authexpiry true|false` and the menu toggle.

## Open Questions

None.
