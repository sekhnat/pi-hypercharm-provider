# Spec Delta

## ADDED Requirements

### Requirement: Sidebar-targeted parts never duplicate into the footer when a sidebar host is present
When a session or account part is configured for the `sidebar` destination and a compatible sidebar host is present, the extension SHALL NOT render that part in the footer widget or status bar, regardless of which provider's model is active. The footer fallback for sidebar-targeted parts SHALL apply only while no compatible sidebar host is present. While another provider's model is active, the sidebar panel SHALL be withdrawn and, when `hideOnOtherProvider` is off, parts configured for `widget` or `statusbar` SHALL continue to follow their own destinations.

#### Scenario: Switching to another provider's model with a sidebar host
- **WHEN** a compatible sidebar host is present, `session` and `account` are `sidebar`, `hideOnOtherProvider` is off, and the user switches to another provider's model
- **THEN** the sidebar panel is withdrawn and no footer widget or status bar entry appears

#### Scenario: Switching back to a HyperCharm model
- **WHEN** the user switches from another provider's model back to a HyperCharm model with a sidebar host present
- **THEN** the sidebar panel is published again and the footer remains empty

#### Scenario: No sidebar host keeps the fallback
- **WHEN** no compatible sidebar host is present and a part is configured for `sidebar`
- **THEN** that part renders in the footer widget, including after switching to another provider's model when `hideOnOtherProvider` is off
