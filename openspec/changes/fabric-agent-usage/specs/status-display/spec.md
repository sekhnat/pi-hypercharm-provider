# Spec Delta

## MODIFIED Requirements

### Requirement: Sidebar panel honors the glyph set

The Pi Atelier sidebar panel SHALL render its rows with the resolved glyph set: `auto` degrades to ASCII on legacy terminals, and explicit `unicode`/`ascii` choices are honored (sidebar rows are host-sanitized and not edge-padded). In `ascii` mode, widget and statusbar lines SHALL emit only ASCII codepoints, and sidebar rows SHALL render their glyph characters (bolt, gem, warn, auth, separator, agent) from the ASCII set; structural rows — the divider rule and rate-limit meter cells — are panel furniture outside the glyph set and render unchanged.

#### Scenario: Sidebar rows degrade with the terminal
- **WHEN** `glyphs` is `auto` on a legacy terminal and the sidebar panel is published
- **THEN** its rows use ASCII glyphs

#### Scenario: ASCII purity across surfaces
- **WHEN** `glyphs` is `ascii`
- **THEN** rendered widget/statusbar lines and sidebar glyph rows contain only ASCII codepoints, while structural rows (the divider rule, meter cells) are unchanged panel furniture

## ADDED Requirements

### Requirement: Agent summary and per-agent rows in the sidebar panel
When lineage aggregation yields one or more agents, the sidebar panel SHALL render, after the session block and before the account divider, an agent block consisting of a summary row — agent glyph, total lineage Hypercredit spend, total requests, and agent count — followed by up to four per-agent rows sorted by spend descending, each showing the agent's name, spend, and request count. When more agents exist than displayed rows, the block SHALL end with one overflow row naming the remaining count. Agent rows SHALL render only when aggregated records exist, SHALL be governed by the `session` display mode (hidden entirely when it is `off`), and SHALL use the resolved glyph set like every other row.

#### Scenario: Rows appear only when agents have spend
- **WHEN** the sidebar panel renders and lineage aggregation has at least one agent
- **THEN** the agent block renders between the session block and the account divider

#### Scenario: Agent rows are capped with overflow
- **WHEN** lineage aggregation yields six agents
- **THEN** four per-agent rows render sorted by spend descending plus one overflow row naming the remaining two

#### Scenario: Session display mode governs agent rows
- **WHEN** the `session` display mode is `off`
- **THEN** no agent summary or per-agent rows render on any surface

#### Scenario: Agent rows follow the glyph set
- **WHEN** glyphs resolve to ASCII
- **THEN** agent rows render their glyph characters from the ASCII set

### Requirement: Compact agent summary atom on the session line
When lineage aggregation yields agents, the widget session line and the statusbar session line SHALL gain a trailing agent-summary atom — agent glyph, lineage spend, and agent count — appended after the session's own spend atoms, subject to the existing tier compaction: as width narrows the atom compresses to a count-only form and drops before the session's own spend atoms. The widget's last-column safety rule SHALL continue to hold with the atom present. Lineage agent spend SHALL count as session activity for the show-after-activity gate: a session with no own HyperCharm activity but existing lineage records SHALL render its session line and become eligible for the account line instead of staying hidden. The `hideOnOtherProvider` rule SHALL continue to hide all agent content, along with the rest of the status, when another provider's model is active.

#### Scenario: Atom joins the session line
- **WHEN** the session line renders and lineage aggregation yields three agents
- **THEN** the session line ends with an agent atom carrying the lineage spend and agent count

#### Scenario: Atom compresses and drops first under tier compaction
- **WHEN** the widget renders at a narrow width with agent records present
- **THEN** the agent atom compresses to count-only form and is dropped before the session's own spend atoms

#### Scenario: Agent-only activity shows the line
- **WHEN** the session has no own HyperCharm spend but lineage records exist
- **THEN** the session line renders with the agent atom and the account line is no longer gated as inactive

#### Scenario: Other-provider hiding covers agent content
- **WHEN** another provider's model is active and `hideOnOtherProvider` is true
- **THEN** agent atoms, rows, and summary content are hidden together with the rest of the status
