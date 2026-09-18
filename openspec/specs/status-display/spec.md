# status-display Specification

## Purpose
Defines the HyperCharm footer/status presentation — session and account line composition, the Atelier sidebar panel rows, and the `/hypercharm-status` configuration surface, including per-atom visibility of the OAuth device-session expiry.

## Requirements

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

### Requirement: Configurable footer glyph set

The status configuration SHALL accept a `glyphs` setting with the values `auto`, `unicode`, and `ascii`, defaulting to `auto`. The setting SHALL persist in the extension's status config across sessions and SHALL be settable non-interactively via `/hypercharm-status glyphs auto|unicode|ascii` and through the interactive `/hypercharm-status` menu by cycling the three modes. The status summary and command usage text SHALL reflect the glyph setting and document the new option.

#### Scenario: Set glyphs via command
- **WHEN** the user runs `/hypercharm-status glyphs ascii`
- **THEN** status surfaces render with ASCII glyphs and the choice survives an extension restart

#### Scenario: Invalid command argument shows usage
- **WHEN** the user runs `/hypercharm-status glyphs bogus`
- **THEN** the command prints its usage text and changes nothing

#### Scenario: Invalid config value falls back to auto
- **WHEN** the persisted config contains an unrecognized `glyphs` value
- **THEN** the mode resolves to `auto`

### Requirement: Automatic ASCII fallback on legacy terminals

In `auto` mode the extension SHALL detect legacy terminals — `TERM_PROGRAM` of `mintty`, `cygwin`, or `msys`, or a `TERM` value starting with `cygwin` or `msys` — and render every status surface with ASCII glyph equivalents there. An explicit `unicode` SHALL force the unicode set and an explicit `ascii` SHALL force ASCII on all terminals.

#### Scenario: Auto degrades on legacy terminals
- **WHEN** `glyphs` is `auto` and the session runs in mintty (`TERM_PROGRAM=mintty`) or under a `cygwin`/`msys` TERM
- **THEN** status surfaces render with ASCII glyphs

#### Scenario: Auto keeps unicode on modern terminals
- **WHEN** `glyphs` is `auto` and the terminal is not legacy (e.g. `TERM_PROGRAM=Windows_Terminal`)
- **THEN** status surfaces render with the unicode glyph set

### Requirement: Widget terminal-safety behavior

The below-editor widget SHALL never paint the terminal's last column: a render at width N SHALL produce lines measuring at most N − 1 visible columns. On a legacy terminal, an explicit `unicode` glyph choice SHALL be clamped to ASCII for widget content, because widget lines are edge-padded to the terminal width and a cell-width disagreement there wraps the line and corrupts the terminal's row bookkeeping; the user SHALL be notified of the clamp once per session. Statusbar content is not edge-padded and SHALL honor the exact choice.

#### Scenario: Widget renders at width minus one
- **WHEN** the widget renders at width 80
- **THEN** the rendered line measures 79 visible columns

#### Scenario: Explicit unicode is clamped for the widget on legacy terminals
- **WHEN** `glyphs` is `unicode` and the terminal is legacy
- **THEN** widget content uses ASCII glyphs with a one-time notification, while statusbar content keeps the unicode glyphs

### Requirement: Sidebar panel honors the glyph set

The Pi Atelier sidebar panel SHALL render its rows with the resolved glyph set: `auto` degrades to ASCII on legacy terminals, and explicit `unicode`/`ascii` choices are honored (sidebar rows are host-sanitized and not edge-padded). In `ascii` mode, widget and statusbar lines SHALL emit only ASCII codepoints, and sidebar rows SHALL render their glyph characters (bolt, gem, warn, auth, separator) from the ASCII set; structural rows — the divider rule and rate-limit meter cells — are panel furniture outside the glyph set and render unchanged.

#### Scenario: Sidebar rows degrade with the terminal
- **WHEN** `glyphs` is `auto` on a legacy terminal and the sidebar panel is published
- **THEN** its rows use ASCII glyphs

#### Scenario: ASCII purity across surfaces
- **WHEN** `glyphs` is `ascii`
- **THEN** rendered widget/statusbar lines and sidebar glyph rows contain only ASCII codepoints, while structural rows (the divider rule, meter cells) are unchanged panel furniture
