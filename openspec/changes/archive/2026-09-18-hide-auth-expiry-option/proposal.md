## Why

The HyperCharm account block always renders the OAuth device-session expiry atom — `expires 30d` as a sidebar panel row, `⟳ 30d` in the compact account line. HyperCharm device sessions run on a rolling ~30-day window, so the readout is nearly static; for users who don't track it, it is noise that spends scarce sidebar width. Today the only way to remove it is to hide the entire account line (team, balance, and rate limits with it).

## What Changes

- Add a `hideAuthExpiry` boolean to the persisted status config (`StatusConfig` in `status.ts`), defaulting to `false` — the expiry atom keeps rendering exactly as today until the user opts out.
- When `hideAuthExpiry` is `true`, the OAuth device-session expiry atom is omitted from every status surface: the sidebar panel row (`expires Nd`) and the compact account-tier atom (`⟳ Nd`) used by the widget and statusbar. Omission follows the existing missing-atom rules; no other account composition changes.
- Extend the `/hypercharm-status` surface: a new non-interactive key (`authexpiry true|false`) and a new interactive-menu toggle ("Hide auth expiry: on/off").
- Update `statusSummary()` and the command usage string so both list the new option; document the option in the README status section.

## Capabilities

### New Capabilities

- `status-display`: Footer/status presentation — session and account line composition, the Atelier sidebar panel rows, and the `/hypercharm-status` configuration surface. This follows the capability path already used for this area in archived changes (`sync-upstream-models-and-glyphs`); no main spec is materialized under `openspec/specs/` yet, so the delta adds the requirements.

### Modified Capabilities

- (none)

## Impact

- `status.ts` — `StatusConfig`, `DEFAULT_STATUS_CONFIG`, `coerceStatusConfig`, `buildAccountTiers`, and `buildAccountSidebarRows` (the hide flag threads through both render paths); `tests/status.smoke.ts` gains coverage.
- `index.ts` — `/hypercharm-status` key parsing, the interactive menu option, `statusSummary()`, `STATUS_USAGE`, and the render call sites that pass config into the account builders.
- `README.md` — status-section prose only (the model table stays script-generated).
- No provider-API or auth behavior change: `/v1/devices` is still fetched and token refresh is untouched; this is presentation-only.
