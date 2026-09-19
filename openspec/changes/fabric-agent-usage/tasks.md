# Tasks

## 1. Identity and ledger core

- [x] 1.1 Add the namespaced usage-ledger file-name constants to `identity.ts` (daily shard prefix rooted in the `hypercharm` namespace) and extend `tests/identity.test.ts` with uniqueness/disjointness assertions for the new names; verify with `node --import jiti/register --test tests/identity.test.ts`
- [x] 1.2 Create the pure ledger module (record type with `v` field, serialize/parse a JSONL line, shard-date math, lineage filter, per-agent/actor rollup, newest-wins rate-snapshot selection, out-of-credits flag) with no pi imports; verify `tsc --noEmit`
- [x] 1.3 Unit-test the ledger core in a new `tests/ledger.test.ts` (node:test): record round-trip, malformed-line skipping, foreign-lineage exclusion, run and actor rollup, summary math, snapshot newest-wins; verify `npm test`

## 2. Status display builders

- [x] 2.1 Extend the glyph sets in `status.ts` with the agent glyph (unicode `⌁`, ASCII `+`) and add pure builders: agent summary row, up-to-four per-agent rows with spend-descending sort and overflow row, and the session-line atom with full/compressed/count-only forms; verify new `tests/status.smoke.ts` assertions pass via `node tests/status.smoke.ts`
- [x] 2.2 Wire the agent block into the sidebar panel builder (after session rows, before the divider, gated on the `session` display mode) and the atom into the session-line tier compaction (drops before the session's own atoms); verify smoke assertions that each metric still lands in exactly one destination and the widget's width-minus-one rule holds with the atom present

## 3. Child-mode accounting (index.ts)

- [x] 3.1 Add guarded fabric-child detection (`PI_FABRIC_PARENT_RUN`, `PI_FABRIC_MAIN_AGENT_ID`, `PI_FABRIC_AGENT_NAME`, actor id/name) and append one ledger record per committed turn with observed usage (single-line append; write failure warns once through the notifier and never throws); verify a new `tests/routing.smoke.ts` case that boots the extension with child env stubs, drives a full turn, and asserts exactly one ledger line and correct record fields
- [x] 3.2 Suppress status-related account requests in child mode — no credits/team/devices prefetch on session start or model select, no agent_settled balance poll, no 402-forced refresh (the flag rides the record instead); verify the routing smoke child case asserts zero `/credits`, `/teams`, `/devices` fetches

## 4. Parent aggregation and drift window (index.ts)

- [x] 4.1 Add parent-side shard reads with mtime caching inside the render path, best-effort GC of shards past retention on session start, and the lineage key `session:` + session id filtering the rollup into render inputs (summary, per-agent entries, latest rate snapshot, out-of-credits flag); missing shards are silent, malformed lines warn once; verify a routing smoke case that seeds a ledger fixture (own lineage + foreign lineage) and asserts only own-lineage agents render
- [x] 4.2 Make agent spend count toward the show-after-activity gate so a session with only lineage records renders its session line and account line; verify smoke assertions for the agent-only-activity case and that `hideOnOtherProvider` still clears agent content
- [x] 4.3 Implement the drift window: observe `tool_execution_start` with `toolName === "fabric_exec"` to arm, tick on the credits-throttle cadence (interval injectable for tests), re-read shards and on new records refresh the balance within the existing throttle plus merge rate snapshots and re-render, extend on activity, disarm after the quiet period, and tear down on session replacement via the status epoch; verify a routing smoke case driving the observer with a shortened tick and promise-drain settlement
- [x] 4.4 On reading a record with the out-of-credits flag, fire the existing out-of-credits notification at most once per session and force a balance refresh; verify a smoke assertion that repeated flagged records notify once

## 5. Integration and full check

- [x] 5.1 Extend `tests/provider.integration.test.ts`: boot the extension in a real runtime with child env stubs and stubbed fetch (asserting no account fetches and one ledger record at turn end), and drive parent aggregation plus drift-window arming through a real `tool_execution_start` event with a ledger fixture; verify `npm test`
- [x] 5.2 Run `npm run check` (tsc --noEmit, all smoke suites, node:test suites) and confirm the full suite is green

## 6. Documentation

- [x] 6.1 Update the `index.ts` header comment (fabric child accounting mode, ledger, drift-window lifecycle) and add the ledger module row to the AGENTS.md file table; verify no ledger name is hardcoded outside `identity.ts` via `pi.grep` and rerun `npm run check`
