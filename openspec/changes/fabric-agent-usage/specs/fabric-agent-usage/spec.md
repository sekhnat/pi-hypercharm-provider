# Spec Delta

## Purpose

Cross-process HyperCharm usage accounting for Pi child agents spawned by pi-fabric: children report observed spend to a shared ledger attributed to the spawning session's lineage, and the parent session aggregates that spend into its status surfaces and reconciles account state while agents run.

## ADDED Requirements

### Requirement: Fabric child accounting mode
When the extension runs inside a pi-fabric-spawned Pi child — detected by the presence of `PI_FABRIC_PARENT_RUN` in the process environment — it SHALL capture HyperCharm usage per request exactly as in a UI session and, on each committed turn with observed usage, SHALL append one usage-ledger record attributed to the lineage id given by `PI_FABRIC_MAIN_AGENT_ID`. In child mode the extension SHALL NOT make status-related account requests: no Hypercredit balance fetch, no team metadata, no device-session metadata, including the forced balance refresh that normally follows an observed HTTP 402 — the out-of-credits fact travels in the record instead. A process without `PI_FABRIC_PARENT_RUN` SHALL NOT append usage records; its own spend continues to be accounted in-session as before.

#### Scenario: Child appends one record per committed turn
- **WHEN** a fabric child completes a turn that observed HyperCharm requests
- **THEN** exactly one ledger record covering that turn's spend is appended, attributed to the lineage id from `PI_FABRIC_MAIN_AGENT_ID`

#### Scenario: Child skips account requests
- **WHEN** a fabric child session starts or selects a HyperCharm model
- **THEN** the child makes no `/credits`, `/teams`, or `/devices` requests for status purposes

#### Scenario: Turn without HyperCharm usage writes nothing
- **WHEN** a fabric child's turn observes no HyperCharm requests
- **THEN** no ledger record is appended for that turn

#### Scenario: Non-child process writes no records
- **WHEN** the process environment lacks `PI_FABRIC_PARENT_RUN`
- **THEN** the process appends no usage records and its own spend is accounted in-memory as before

### Requirement: Usage ledger records and attribution
The usage ledger SHALL be an append-only sequence of JSON lines stored in daily shards under the extension's namespace in the Pi agent cache directory. Each record SHALL carry a format version, the lineage id, an agent identity (run id plus agent name, or actor id plus actor name for persistent actors), a timestamp, the turn's request count, the turn's observed Hypercredit spend, the most recent rate-limit header snapshot captured during the turn when one exists, and an out-of-credits flag when the turn observed HTTP 402. Recursive descendants inherit the root lineage id, so every descendant's records attribute to the same lineage.

#### Scenario: Record carries observed spend and identity
- **WHEN** a child turn observing 12 requests and 4.2 hypercredits commits
- **THEN** the appended record contains that request count and spend, the agent's run id and name, and the lineage id

#### Scenario: Rate snapshot rides the record
- **WHEN** the child's responses during the turn carried `x-ratelimit-*` headers
- **THEN** the record carries the latest captured snapshot, and the parent can merge it without any account API call

#### Scenario: Out-of-credits turn is flagged
- **WHEN** a child turn receives an HTTP 402 response
- **THEN** the record for that turn carries the out-of-credits flag instead of triggering a child-side balance fetch

#### Scenario: Recursive descendants attribute to the root
- **WHEN** a grandchild spawned by a fabric child commits usage
- **THEN** its records carry the root lineage id inherited through the environment, rolling into the same lineage totals

### Requirement: Ledger durability and retention
Records SHALL be appended as single-line writes so that concurrent child appenders cannot interleave partial lines. A missing ledger shard SHALL be treated as normal and SHALL NOT emit a warning. An individual malformed line SHALL be skipped without discarding the remaining records of its shard. Reads SHALL cover the current day's shard and the previous day's shard so records spanning a date boundary aggregate. Shards older than the retention window SHALL be removed best-effort when a session starts; removal failure SHALL be non-fatal.

#### Scenario: Concurrent appends stay intact
- **WHEN** two children append records around the same time
- **THEN** every appended record parses as one complete line afterward

#### Scenario: Midnight rollover stays aggregated
- **WHEN** records were appended yesterday and the parent reads today
- **THEN** the parent's aggregation includes both days' records for its lineage

#### Scenario: Malformed line is skipped
- **WHEN** a shard contains one malformed line among valid ones
- **THEN** aggregation uses every valid record and emits at most one warning

#### Scenario: Old shards are garbage-collected
- **WHEN** a session starts and shards older than the retention window exist
- **THEN** those shards are removed, and a failed removal neither warns repeatedly nor breaks startup

### Requirement: Lineage aggregation in the parent
A session with a UI SHALL aggregate ledger records whose lineage id equals its own lineage key, computed the same way fabric derives it: the session id prefixed with `session:`. Aggregation SHALL roll records up per agent identity, yielding per-agent request and spend totals and a lineage-wide summary. Because the key derives from the session id, a replaced session matches no prior records and its agent aggregation starts empty.

#### Scenario: Only own-lineage records are counted
- **WHEN** the ledger contains records attributed to other lineages
- **THEN** those records are excluded from this session's agent totals

#### Scenario: Turns roll up per agent
- **WHEN** several records share one agent run id
- **THEN** they sum into one agent entry carrying that agent's name, request count, and spend

#### Scenario: Session replacement resets agent totals
- **WHEN** the session is replaced through `/new` or `/fork`
- **THEN** the new session's agent aggregation starts from zero with no carryover entries

#### Scenario: Actor activations roll up under the actor
- **WHEN** records originate from persistent actor activations
- **THEN** they roll up under the actor identity rather than per activation

### Requirement: Drift-window reconciliation
Observing a `fabric_exec` tool execution in the session SHALL arm an observation window. While the window is armed, each tick re-reads the ledger and, when new records arrived since the previous tick, refreshes the Hypercredit balance under the extension's existing refresh throttle and merges the newest rate-limit snapshots into account state, then re-renders. The window stays armed while new records keep arriving and disarms after a bounded period of ledger silence. A session that never observes a `fabric_exec` execution SHALL make no additional status-related API calls and SHALL run no timers for this capability.

#### Scenario: Window arms on agent launch
- **WHEN** a `fabric_exec` tool execution starts in the session
- **THEN** the observation window arms and periodic ledger reads begin

#### Scenario: Balance tracks child spend live
- **WHEN** new records arrive while the window is armed
- **THEN** the Hypercredit balance refreshes and rate snapshots merge without waiting for the parent's own turn to end

#### Scenario: Window disarms on silence
- **WHEN** no new records arrive for the quiet period
- **THEN** the window disarms and periodic polling stops

#### Scenario: Childless sessions pay nothing
- **WHEN** no `fabric_exec` execution is ever observed in the session
- **THEN** the session makes zero additional API calls and runs zero timers for this capability

### Requirement: Child-observed account exhaustion surfaces in the parent
When the parent reads a record carrying the out-of-credits flag, it SHALL trigger the existing out-of-credits user notification — at most once per session — and force a Hypercredit balance refresh as part of that read.

#### Scenario: Child exhaustion notifies the parent
- **WHEN** a child record carries the out-of-credits flag
- **THEN** the parent's next ledger read emits the out-of-credits notification and refreshes the balance

#### Scenario: Exhaustion notification is deduplicated
- **WHEN** several flagged records are read across ticks
- **THEN** the out-of-credits notification fires once for the session
