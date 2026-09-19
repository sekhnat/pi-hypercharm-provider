# Proposal

## Why

pi-fabric spawns agents, workflow workers, trajectory handoffs, and persistent actors as separate `pi --mode rpc` child processes. Each child loads this extension and counts its own HyperCharm usage in process-local memory that no one ever sees — headless children have no UI, and the parent session's footer widget, sidebar panel, and balance/rate display never learn about the children's spend. The parent's Hypercredit balance and rate-limit readouts drift while detached or durable agents keep spending, and a child that exhausts the account (HTTP 402) never surfaces that warning to the parent. This makes the extension's usage accounting wrong for every fabric-orchestrated workflow, which is now the primary way multi-model work happens in pi.

## What Changes

- **Fabric child accounting mode.** The extension detects fabric child processes via the `PI_FABRIC_*` environment envelope (parent run id, agent name, lineage `PI_FABRIC_MAIN_AGENT_ID`). In child mode it keeps the existing per-request usage tee but skips the account prefetches and balance polls that are useless without a UI (removing wasted `/credits`, `/teams`, `/devices` calls per child).
- **Shared usage ledger.** Child instances append one small JSON record per committed turn to an append-only, daily-sharded JSONL file in the Pi agent cache directory, attributed to the spawning session's lineage id. Records carry requests, observed Hypercredit spend, the latest rate-limit header snapshot, and an out-of-credits flag. Shards older than a retention window are garbage-collected best-effort.
- **Lineage aggregation and display.** The parent session tails the ledger, filters records by its own lineage id (derived the same way fabric derives it: `session:` + its session id), and rolls them up per agent run. The sidebar panel gains a summary row plus per-agent rows; the widget session line and statusbar gain a compact agent-summary atom. Aggregation resets naturally on `/new` and `/fork` because the lineage key changes.
- **Drift-window reconciliation.** Observing a `fabric_exec` tool execution arms an activity window: while new ledger records keep arriving, the parent polls the canonical `/v1/credits` balance on the existing throttle cadence, merges rate-limit snapshots from records into the account state, and re-renders — so the account line tracks child spend live instead of snapping back on the next own turn. The window disarms after ledger silence.
- **Child-sourced exhaustion warnings.** A 402 observed in a child stamps the ledger record; the parent's next read fires the existing out-of-credits notification and forced balance refresh instead of never learning about it.

No changes to model catalog handling, Prism routing, OAuth, or the README pipeline. No breaking changes to existing configuration or display behavior; agent rows and atoms appear only when ledger records exist, so non-fabric users see no difference.

## Capabilities

### New Capabilities
- `fabric-agent-usage`: Cross-process usage accounting for fabric-spawned Pi children — child-mode detection, the shared usage ledger (format, attribution, retention, write safety), parent-side lineage aggregation, and the activity-triggered balance/rate reconciliation window.

### Modified Capabilities
- `status-display`: The sidebar panel gains an agent summary row and capped per-agent rows, and the widget session line / statusbar gain a compact agent-summary atom; existing session/account atom layout, tier compaction, glyph, and hide rules continue to apply to the new content.
- `provider-diagnostics`: New warning sources — usage-ledger read/write failures and out-of-credits observed by a fabric child agent — join the existing surfaced-once recoverable-failure set, delivered through the existing warning sink without throwing.

## Impact

- `index.ts` — fabric-child detection, ledger writes at `turn_end` commit, child-mode suppression of account fetches, parent-side `tool_execution_start` observation, the reconciliation poller, 402 surfacing from records.
- `status.ts` — summary-atom and per-agent row builders (pure functions, exercised by the status smoke test).
- `identity.ts` — new namespaced ledger file-name constants (co-installation invariants then apply automatically).
- New ledger module (pure, no pi imports) for shard naming, record parsing, and aggregation — unit-tested.
- Tests: `tests/status.smoke.ts`, `tests/routing.smoke.ts` (child-mode env path), `tests/identity.test.ts`, `tests/provider.integration.test.ts`, plus a new ledger test suite.
- No dependency, packaging, or API-consumer changes; `models.json`, `patch.json`, `custom-models.json`, and the README table are untouched.
