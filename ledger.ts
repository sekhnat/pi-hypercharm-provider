/**
 * Pure usage-ledger core for fabric child accounting.
 *
 * pi-fabric spawns agents (workflow workers, trajectory handoffs, persistent
 * actors) as separate `pi --mode rpc` children, each loading this extension.
 * Children append one usage record per committed turn to daily JSONL shards in
 * the Pi agent cache directory; the spawning parent reads the shards back and
 * aggregates them by lineage (see index.ts, which owns all fs access).
 *
 * This module is deliberately dependency-free (like prism.ts/status.ts): it
 * owns the record type, one-line JSONL serialization/parsing, shard-date math,
 * lineage filtering, per-agent rollup, and newest-wins rate-snapshot selection.
 * No pi imports, no fs, no clocks of its own — time comes in as arguments, so
 * every decision here is unit-testable with plain node:test.
 */

import { LEDGER_SHARD_PREFIX } from "./identity";

/** Format version. Bump on a breaking record-shape change; parsers drop
 * records with a foreign version instead of guessing at their fields. */
export const LEDGER_RECORD_VERSION = 1;

/** Lineage-wide fields are identical for every record of one agent, so the
 * envelope keeps identity and metrics apart for cheap rollups. */
export interface UsageLedgerRecord {
	/** Record format version. */
	v: number;
	/** Root lineage id (`PI_FABRIC_MAIN_AGENT_ID`), inherited recursively. */
	lineage: string;
	/** Agent identity: fabric run id, or the persistent actor's id. */
	agentId: string;
	/** Agent display name (run name, or actor name). */
	agentName: string;
	/** Commit time (ms epoch). */
	ts: number;
	/** Requests observed this turn. */
	requests: number;
	/** Observed Hypercredit spend this turn. */
	spendHc: number;
	/** Latest x-ratelimit-* snapshot captured during the turn, when one exists. */
	rate?: RateSnapshot;
	/** The turn observed HTTP 402 — the account is exhausted. */
	outOfCredits?: boolean;
}

/** Rate-limit header snapshot, same fields the extension captures live. */
export interface RateSnapshot {
	limitHour: number;
	limitDay: number;
	remainingHour: number;
	remainingDay: number;
	capturedAt: number;
}

/** Serialize one record as a single JSONL line (no trailing newline). */
export function serializeLedgerRecord(record: UsageLedgerRecord): string {
	return JSON.stringify(record);
}

/**
 * Parse one JSONL line into a record; undefined for anything not a current-
 * or forward-compatible usage record. Foreign JSON objects (another
 * extension's lines), future versions, and wrong-typed required fields all
 * return undefined so the caller can skip the line without discarding the
 * rest of the shard.
 */
export function parseLedgerRecord(line: string): UsageLedgerRecord | undefined {
	if (line.length === 0 || line.length > 4096) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const r = value as Record<string, unknown>;
	if (r.v !== LEDGER_RECORD_VERSION) return undefined;
	if (typeof r.lineage !== "string" || r.lineage.length === 0) return undefined;
	if (typeof r.agentId !== "string" || r.agentId.length === 0) return undefined;
	if (typeof r.agentName !== "string") return undefined;
	if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return undefined;
	if (typeof r.requests !== "number" || !Number.isFinite(r.requests) || r.requests < 0) return undefined;
	if (typeof r.spendHc !== "number" || !Number.isFinite(r.spendHc) || r.spendHc < 0) return undefined;
	const record: UsageLedgerRecord = {
		v: LEDGER_RECORD_VERSION,
		lineage: r.lineage,
		agentId: r.agentId,
		agentName: r.agentName,
		ts: r.ts,
		requests: r.requests,
		spendHc: r.spendHc,
	};
	const rate = parseRateSnapshot(r.rate);
	if (rate) record.rate = rate;
	if (r.outOfCredits === true) record.outOfCredits = true;
	return record;
}

/** Validate a rate snapshot the same way captureRateLimitHeaders does: every
 * field must be a finite number, absent/invalid snapshots are dropped. */
export function parseRateSnapshot(value: unknown): RateSnapshot | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	const limitHour = r.limitHour;
	const limitDay = r.limitDay;
	const remainingHour = r.remainingHour;
	const remainingDay = r.remainingDay;
	const capturedAt = r.capturedAt;
	if (
		typeof limitHour !== "number" ||
		typeof limitDay !== "number" ||
		typeof remainingHour !== "number" ||
		typeof remainingDay !== "number" ||
		typeof capturedAt !== "number" ||
		![limitHour, limitDay, remainingHour, remainingDay, capturedAt].every((v) => Number.isFinite(v))
	) {
		return undefined;
	}
	return { limitHour, limitDay, remainingHour, remainingDay, capturedAt };
}

// ─── Shard naming ─────────────────────────────────────────────────────────────

/** Zero-pad to the width JSONL shard dates sort lexicographically. */
function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Shard file name for a UTC date: `<prefix>-YYYYMMDD.jsonl`. UTC keeps every
 * process on one machine in agreement regardless of local timezone.
 */
export function shardFileName(date: Date, prefix: string = LEDGER_SHARD_PREFIX): string {
	return `${prefix}-${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}.jsonl`;
}

/** Parse a shard file name back to its UTC date; undefined for foreign names. */
export function parseShardFileName(name: string, prefix: string = LEDGER_SHARD_PREFIX): Date | undefined {
	if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) return undefined;
	const body = name.slice(prefix.length + 1, name.length - ".jsonl".length);
	if (!/^\d{8}$/.test(body)) return undefined;
	const date = new Date(
		Date.UTC(Number(body.slice(0, 4)), Number(body.slice(4, 6)) - 1, Number(body.slice(6, 8))),
	);
	// Reject nonexistent calendar dates (20260230) that Date.UTC rolls over.
	if (
		date.getUTCFullYear() !== Number(body.slice(0, 4)) ||
		date.getUTCMonth() !== Number(body.slice(4, 6)) - 1 ||
		date.getUTCDate() !== Number(body.slice(6, 8))
	) {
		return undefined;
	}
	return date;
}

/**
 * Shards to read for a given instant: today's and yesterday's, so records
 * appended before a UTC midnight rollover still aggregate into a read after
 * it. Ordered oldest-first.
 */
export function currentShardNames(now: Date, prefix: string = LEDGER_SHARD_PREFIX): string[] {
	const dayMs = 86_400_000;
	const yesterday = new Date(now.getTime() - dayMs);
	return [shardFileName(yesterday, prefix), shardFileName(now, prefix)];
}

/**
 * Shard names strictly older than the retention window as of `now` (UTC day
 * granularity): everything before the day `retentionDays` ago. The read set
 * (today + yesterday) is inside the window whenever retentionDays >= 1.
 */
export function expiredShardNames(
	now: Date,
	retentionDays: number,
	prefix: string = LEDGER_SHARD_PREFIX,
): string[] {
	if (!Number.isFinite(retentionDays) || retentionDays < 1) return [];
	const names: string[] = [];
	// Walk back over a bounded horizon (2× retention, min 14 days) — far more
	// than any plausible backlog, and cheap: one string build per candidate day.
	const horizonDays = Math.max(14, Math.ceil(retentionDays) * 2);
	for (let i = Math.ceil(retentionDays) + 1; i <= horizonDays; i++) {
		const day = new Date(now.getTime() - i * 86_400_000);
		names.push(shardFileName(day, prefix));
	}
	return names;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/** Per-agent rollup entry. Actors and runs share this shape; the id is the
 * rollup key (actor id preferred for persistent actors). */
export interface AgentUsageEntry {
	id: string;
	name: string;
	requests: number;
	spendHc: number;
}

/** Lineage-wide rollup consumed by the status builders. */
export interface LineageUsage {
	summary: { requests: number; spendHc: number; agents: number };
	entries: AgentUsageEntry[];
	/** Any record in the lineage observed HTTP 402. */
	outOfCredits: boolean;
	/** Newest rate snapshot across the lineage's records, when any. */
	latestRate: RateSnapshot | undefined;
	/** Newest record commit time in the lineage, when any. */
	latestTs: number | undefined;
}

export const EMPTY_LINEAGE_USAGE: LineageUsage = {
	summary: { requests: 0, spendHc: 0, agents: 0 },
	entries: [],
	outOfCredits: false,
	latestRate: undefined,
	latestTs: undefined,
};

/** True when the record belongs to the given lineage. */
export function isOwnLineage(record: UsageLedgerRecord, lineage: string): boolean {
	return record.lineage === lineage;
}

/**
 * Roll records of one lineage up per agent identity and compute lineage-wide
 * totals. Newest-wins for the rate snapshot: the record with the greatest
 * `capturedAt` provides it, ties broken by append order (later record wins).
 */
export function aggregateLineage(records: readonly UsageLedgerRecord[], lineage: string): LineageUsage {
	const byAgent = new Map<string, AgentUsageEntry>();
	let requests = 0;
	let spendHc = 0;
	let outOfCredits = false;
	let latestRate: RateSnapshot | undefined;
	let latestTs: number | undefined;

	for (const record of records) {
		if (!isOwnLineage(record, lineage)) continue;
		requests += record.requests;
		spendHc += record.spendHc;
		if (record.outOfCredits) outOfCredits = true;
		if (latestTs === undefined || record.ts > latestTs) latestTs = record.ts;

		const existing = byAgent.get(record.agentId);
		if (existing) {
			existing.requests += record.requests;
			existing.spendHc += record.spendHc;
		} else {
			byAgent.set(record.agentId, {
				id: record.agentId,
				name: record.agentName,
				requests: record.requests,
				spendHc: record.spendHc,
			});
		}

		if (record.rate && (latestRate === undefined || record.rate.capturedAt >= latestRate.capturedAt)) {
			latestRate = record.rate;
		}
	}

	return {
		summary: { requests, spendHc, agents: byAgent.size },
		entries: [...byAgent.values()],
		outOfCredits,
		latestRate,
		latestTs,
	};
}
