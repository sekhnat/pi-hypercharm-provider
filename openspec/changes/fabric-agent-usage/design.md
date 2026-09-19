# Design

## Context

See proposal.md — Why. Today every fabric-spawned Pi child (`pi --mode rpc` under `dist/worker.js`) loads this extension and counts its own usage in process-local memory nobody displays; the parent's account line drifts until its own next turn. The mechanics that make a fix possible, verified against pi-fabric 0.92.x and pi 0.85.1:

- The child env carries `PI_FABRIC_PARENT_RUN`, `PI_FABRIC_AGENT_NAME`, `PI_FABRIC_MAIN_AGENT_ID` (the root lineage id, inherited recursively), plus `PI_FABRIC_ACTOR_ID`/`PI_FABRIC_ACTOR_NAME` for actors.
- Fabric derives a root's lineage id as `session:${sessionManager.getSessionId()}` — the same call this extension can make locally in the parent, so the attribution key matches by construction.
- pi-ai's `parseChunkUsage` rebuilds `usage` and discards the provider's `usage.cost` extension fields, which is why the per-request tee is the only observer of real Hypercredit spend. Nothing upstream of the extension can supply hypercredits; the extension is the sole writer of this data.
- The parent observes its own session events, including `tool_execution_start` with `event.toolName`, so it can see a `fabric_exec` invocation without any fabric API access (pi extensions cannot call fabric guest APIs such as `mesh.*` — a mesh-topic design is out of reach from this repo).
- Both parent and children share the Pi agent cache directory on one machine; the durable resident host is also a local process.

## Goals / Non-Goals

**Goals:**
- Attribute fabric children's observed spend to the spawning session's lineage and display it (per-agent rows + summary atom).
- Keep the account line truthful while detached agents spend: activity-triggered balance polls and rate-snapshot merging.
- Remove wasted status API calls in headless children and surface child-observed 402 exhaustion to the parent.
- Preserve the existing invariants: zero status API calls/timers for sessions without HyperCharm activity or fabric tool use; single-writer semantics per process; all shared names namespaced through `identity.ts`.

**Non-Goals:**
- Persisting Hypercredit cost into session transcripts or fabric run records (stream/message augmentation was explicitly declined).
- Any new user-facing config knob (agent content rides the existing `session` display mode; it appears only when records exist).
- Liveness tracking of children (no start/end ledger records, no "agent is running" indicators).
- Cross-machine aggregation (remote mesh children are simply un-attributed locally; the balance still reconciles from the server).
- Upstream changes to pi-fabric or pi-ai.

## Decisions

### 1. Usage-only ledger, no lifecycle records
Records are appended only at a child's `turn_end` commit (the same `pending*` → committed transition the parent uses). Liveness is inferred from record activity, not from start/end markers.

*Why:* start/end records would need reliable `session_shutdown` delivery in headless children plus stale-start heuristics when children crash; usage records already arrive exactly when spend happens, which is the only thing the drift window cares about. Crash-mid-turn loses that turn's record — the balance poll corrects the account line, and the parent has the identical failure semantics today.

*Alternative rejected:* liveness records with timeout-based GC of stale entries (fragile under 24h agent ceilings).

### 2. Daily shards, 7-day retention, GC at session start
File layout: `<agentDir>/cache/<ledger-prefix>-YYYYMMDD.jsonl`, one record per line, ~150 bytes. The parent reads the current and previous day's shard (midnight rollover); old shards are unlinked best-effort on `session_start` (ENOENT and failure are silent or single-warning). The file name(s) are constants in `identity.ts` so the co-installation tests enforce the namespace.

*Why:* rotation by date gives lock-free compaction (deletion, not rewrite), bounds growth under agent swarms, and makes multi-writer appends trivially safe (POSIX `O_APPEND` single-line writes; `fs.appendFileSync` performs one write).

*Alternative rejected:* one growing file with periodic rewrite-compaction — requires cross-process locking and risks record loss mid-rewrite.

### 3. Split module: pure ledger core + thin IO
A new dependency-free module (like `prism.ts`/`status.ts`) owns the record type, line parsing/serialization, shard-date math, lineage filtering, per-agent rollup, and snapshot-merge selection. `index.ts` keeps all `fs` calls (append, read, GC) behind small functions so the core stays unit-testable with plain node:test. The aggregation result is a plain value: `{ summary: {requests, spendHc, agents}, entries: [{id, name, requests, spendHc}], sawOut_ofCredits, latestRate? }` consumed by `status.ts` builders.

### 4. Child detection and identity
Child mode = presence of `PI_FABRIC_PARENT_RUN`. Record identity: run id = `PI_FABRIC_PARENT_RUN`, name = `PI_FABRIC_AGENT_NAME`; actor records prefer `PI_FABRIC_ACTOR_ID`/`PI_FABRIC_ACTOR_NAME` so multi-activation actors roll up under one id. Lineage id = `PI_FABRIC_MAIN_AGENT_ID` (present for every child, including recursive ones because fabric re-injects the root id). The parent computes `session:${ctx.sessionManager.getSessionId()}` and filters. All env reads are guarded; a fabric upgrade that renames these variables degrades to today's behavior (child counts nothing extra, parent shows no agent content) rather than breaking.

### 5. Child-mode account suppression
In child mode: no credits/team/devices prefetch on `session_start`/`model_select`, no `agent_settled` balance poll, and the 402-forced refresh inside `commitPending` is skipped — the flag goes into the record and the parent reacts. The notifier keeps its stderr fallback (harmless in headless children). The per-request tee stays identical in both modes.

### 6. Drift window: arm on `tool_execution_start`, activity-extend, silence-disarm
On `tool_execution_start` with `toolName === "fabric_exec"`, arm the window. Tick interval = the existing credits throttle (15 s). Each tick: re-read shards when mtime/size changed; if new records arrived since the last poll, `refreshCredits(force within throttle)` and merge rate snapshots (newest `capturedAt` wins, same field validation as `captureRateLimitHeaders`); re-render if anything changed. New records extend the armed window; `5 minutes` of ledger silence disarms and clears the timer. The window only runs when the account part is not `off`. A record carrying the 402 flag on read triggers the existing out-of-credits notification (once per session, existing flag) plus a forced refresh. Timers are unref'd-style session-scoped and torn down on session replacement (`statusEpoch` bump) like other async work.

*Why not poll only on own turn events:* detached agents outlive the parent's turn; the UI would sit stale for their whole run. *Why not always-on polling:* violates the zero-API-calls invariant for childless sessions.

### 7. Display shapes
- Sidebar agent block (after session rows, before the divider): summary row `⌁ 12.4 hc · 57 req · 3 agents` (role `muted`), then up to 4 rows `▸ map-persistence  4.2 hc · 12 req` sorted by spend desc, then `+2 more agents` overflow row.
- Session-line atom: `⌁ 12.4 hc · 3 ag`, compressed to `⌁ 3 ag` and then dropped under tier compaction before the session's own atoms.
- Glyph set gains an `agent` glyph: `⌁` unicode, `+` ASCII (widget uses the width-safe resolved set; the legacy-terminal clamp applies automatically).
- Visibility: agent spend counts toward the show-after-activity gate; `hideOnOtherProvider` still clears everything when another provider's model is active.

### 8. Ordering and rendering cadence
The parent reads shards (mtime-cached) inside `updateStatus` — cheap enough for every render — so agent totals appear on every existing render trigger (turn end, model select, command, poller tick) without new event subscriptions. Only the poller introduces a timer, and only when armed.

## Risks / Trade-offs

- [Fabric env contract is not a public API] → all env reads guarded; absence degrades to current behavior; records carry a `v` field for forward-compatible parsing.
- [Child crash mid-turn undercounts] → same semantics as the parent's own pending state; balance polls reconcile the account line; accepted.
- [Clock skew between processes] → timestamps only order rate snapshots within the same machine; monotonic ordering is not load-bearing.
- [Swarm write volume] → ~150 B per committed turn in daily shards; 7-day retention bounds disk use; GC is best-effort and silent.
- [Fork/new while children run] → children keep writing to the old lineage key; the new session shows nothing for them (by design, matches session-stat reset semantics) and the balance poll still reconciles.
- [hideOnOtherProvider hides agent spend when the main model is another provider] → documented trade-off honoring the existing contract; revisit only on user feedback.
- [Dual-extension co-installation] → all new persisted names go through `identity.ts`; the identity test suite enforces uniqueness/disjointness automatically.

## Migration Plan

Purely additive: no config format, cache format, or display default changes. Rollback = revert the code; ledger files become inert data (nothing reads them) and can be deleted manually. No version coordination with fabric or pi is required.
