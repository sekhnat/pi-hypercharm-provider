## Purpose

Defines the HyperCharm footer/status presentation — session and account line composition, the Atelier sidebar panel rows, and the `/hypercharm-status` configuration surface, including per-atom visibility of the OAuth device-session expiry.

## ADDED Requirements

### Requirement: Hideable OAuth device-session expiry atom

The status configuration SHALL accept a `hideAuthExpiry` boolean, defaulting to `false`. When `false`, the OAuth device-session expiry atom SHALL render as before: an `expires <N>d` row in the sidebar panel account block and an auth-glyph atom (`⟳ <N>d`, ASCII `~ <N>d`) in the compact account line. When `true`, the expiry atom SHALL be omitted from every status surface — sidebar panel, widget, and statusbar — while every other account atom (team name, balance, hourly/daily rate limits) and all layout rules (tier compaction, dividers, meters) render unchanged. The setting SHALL NOT affect data collection: the device-session expiry SHALL continue to be fetched from `/v1/devices`, so re-enabling the atom shows the current remaining days without re-authentication or a manual refresh. The choice SHALL persist across sessions.

#### Scenario: Default keeps the expiry atom
- **WHEN** the status config is fresh or legacy (no `hideAuthExpiry` key)
- **THEN** the sidebar panel shows the `expires <N>d` row and the widget/statusbar account line includes the auth-glyph atom

#### Scenario: Hiding removes the atom from every surface
- **WHEN** `hideAuthExpiry` is `true`
- **THEN** no status surface renders the expiry atom, while team, balance, and rate-limit atoms render unchanged in their existing layout

#### Scenario: Expiry data keeps flowing while hidden
- **WHEN** the atom has been hidden and the user later turns hiding off
- **THEN** the atom renders with the current remaining days without re-authentication or a manual refresh

#### Scenario: Unrecognized persisted value falls back to visible
- **WHEN** the persisted config contains a non-boolean `hideAuthExpiry` value
- **THEN** the setting resolves to `false` and the expiry atom renders

### Requirement: Configuring the expiry atom via /hypercharm-status

The `/hypercharm-status` command SHALL accept `authexpiry true|false` to set the flag non-interactively, and SHALL reject any other value for that key by printing the usage text and changing nothing. The interactive menu SHALL include a "Hide auth expiry" entry showing the current state; selecting it SHALL flip the setting, persist it, and re-render status surfaces immediately. The command's status summary and usage text SHALL reflect and document the setting, and the reset action SHALL restore the default (`false`).

#### Scenario: Command hides the atom
- **WHEN** the user runs `/hypercharm-status authexpiry true`
- **THEN** the expiry atom disappears from status surfaces and the choice persists across a restart

#### Scenario: Command shows the atom again
- **WHEN** the user runs `/hypercharm-status authexpiry false`
- **THEN** the expiry atom reappears on status surfaces

#### Scenario: Invalid argument shows usage
- **WHEN** the user runs `/hypercharm-status authexpiry maybe`
- **THEN** the command prints its usage text and the setting is unchanged

#### Scenario: Interactive toggle updates the footer
- **WHEN** the user selects the "Hide auth expiry" entry in the interactive menu
- **THEN** the setting flips, the menu label reflects the new state, the config is persisted, and status surfaces re-render immediately

#### Scenario: Reset restores the default
- **WHEN** the user runs `/hypercharm-status reset`
- **THEN** `hideAuthExpiry` returns to `false` and the expiry atom renders again

#### Scenario: Summary reflects the setting
- **WHEN** the status summary is printed (e.g. `/hypercharm-status` with no arguments in a non-UI context)
- **THEN** the summary includes the current `hideAuthExpiry` value
