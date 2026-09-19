/**
 * Unit tests for the pure usage-ledger core (ledger.ts) — record round-trip,
 * malformed-line skipping, lineage filtering, per-agent rollup, summary math,
 * shard-date math, and newest-wins snapshot selection.
 * Run: npm test (jiti resolves the extensionless TS imports).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	EMPTY_LINEAGE_USAGE,
	LEDGER_RECORD_VERSION,
	aggregateLineage,
	currentShardNames,
	expiredShardNames,
	isOwnLineage,
	parseLedgerRecord,
	parseRateSnapshot,
	parseShardFileName,
	serializeLedgerRecord,
	shardFileName,
	type UsageLedgerRecord,
} from "../ledger.ts";
import { LEDGER_SHARD_PREFIX } from "../identity.ts";

const PREFIX = LEDGER_SHARD_PREFIX; // "hypercharm-usage"

function record(overrides: Partial<UsageLedgerRecord> = {}): UsageLedgerRecord {
	return {
		v: LEDGER_RECORD_VERSION,
		lineage: "session:abc",
		agentId: "run-1",
		agentName: "map-persistence",
		ts: 1_758_000_000_000,
		requests: 12,
		spendHc: 4.2,
		...overrides,
	};
}

// ── record round-trip ──

test("record serializes to one JSONL line and parses back", () => {
	const original = record({
		rate: { limitHour: 1000, limitDay: 10000, remainingHour: 996, remainingDay: 9996, capturedAt: 5 },
		outOfCredits: true,
	});
	const line = serializeLedgerRecord(original);
	assert.ok(!line.includes("\n"), "one line");
	const parsed = parseLedgerRecord(line);
	assert.deepEqual(parsed, original);
});

test("optional fields are absent when not set", () => {
	const parsed = parseLedgerRecord(serializeLedgerRecord(record()));
	assert.ok(parsed);
	assert.equal(parsed.rate, undefined);
	assert.equal(parsed.outOfCredits, undefined);
	assert.ok(!("rate" in parsed), "rate key not materialized");
	assert.ok(!("outOfCredits" in parsed), "flag key not materialized");
});

// ── malformed-line skipping ──

test("malformed lines return undefined instead of throwing", () => {
	for (const line of ["", "not json", '{"v":1,', "[]", "null", "42", '"text"']) {
		assert.equal(parseLedgerRecord(line), undefined, JSON.stringify(line));
	}
});

test("foreign and future records are skipped, not misparsed", () => {
	assert.equal(parseLedgerRecord('{"v":2,"lineage":"x","agentId":"y","agentName":"z","ts":1,"requests":1,"spendHc":1}'), undefined, "future version");
	assert.equal(parseLedgerRecord('{"other":"record"}'), undefined, "foreign object");
	assert.equal(parseLedgerRecord('{"v":"1","lineage":"x","agentId":"y","agentName":"z","ts":1,"requests":1,"spendHc":1}'), undefined, "string version");
	assert.equal(parseLedgerRecord(serializeLedgerRecord(record({ lineage: "" }))), undefined, "empty lineage");
	assert.equal(parseLedgerRecord(serializeLedgerRecord(record({ agentId: "" }))), undefined, "empty agentId");
	assert.equal(parseLedgerRecord(serializeLedgerRecord(record({ requests: -1 }))), undefined, "negative requests");
	assert.equal(parseLedgerRecord(serializeLedgerRecord(record({ spendHc: Number.NaN }))), undefined, "NaN spend serializes to null");
	assert.equal(parseLedgerRecord("x".repeat(5000)), undefined, "oversize line");
});

test("invalid rate snapshots are dropped but the record survives", () => {
	const partial = parseLedgerRecord(serializeLedgerRecord(record({ rate: { limitHour: 1 } as never })));
	assert.ok(partial);
	assert.equal(partial.rate, undefined);
	const nanRate = parseLedgerRecord(
		serializeLedgerRecord(record({ rate: { limitHour: 1, limitDay: 2, remainingHour: 3, remainingDay: Number.NaN, capturedAt: 5 } })),
	);
	assert.ok(nanRate);
	assert.equal(nanRate.rate, undefined);
});

// ── shard-date math ──

test("shard names are UTC-dated and round-trip", () => {
	const name = shardFileName(new Date(Date.UTC(2026, 8, 19)));
	assert.equal(name, `${PREFIX}-20260919.jsonl`);
	const parsed = parseShardFileName(name, PREFIX);
	assert.ok(parsed);
	assert.equal(parsed.toISOString(), "2026-09-19T00:00:00.000Z");
	// A local-timezone offset (here 3h) must not shift the UTC date label.
	const lateUtc = new Date(Date.UTC(2026, 8, 19, 23, 59));
	assert.equal(shardFileName(lateUtc), `${PREFIX}-20260919.jsonl`);
});

test("foreign file names do not parse as shards", () => {
	assert.equal(parseShardFileName("hypercharm-models.json", PREFIX), undefined);
	assert.equal(parseShardFileName("hyper-usage-20260919.jsonl", PREFIX), undefined);
	assert.equal(parseShardFileName(`${PREFIX}-20260919.txt`, PREFIX), undefined);
	assert.equal(parseShardFileName(`${PREFIX}-202609311.jsonl`.replace("311", "3110"), PREFIX), undefined);
	assert.equal(parseShardFileName(`${PREFIX}-20260230.jsonl`, PREFIX), undefined, "Feb 30 rolls over and must be rejected");
	assert.equal(parseShardFileName(`${PREFIX}-20260919x.jsonl`, PREFIX), undefined);
});

test("reads cover the midnight rollover", () => {
	const names = currentShardNames(new Date(Date.UTC(2026, 8, 19, 0, 0, 1)), PREFIX);
	assert.deepEqual(names, [`${PREFIX}-20260918.jsonl`, `${PREFIX}-20260919.jsonl`]);
});

test("expired shards are everything before the retention window", () => {
	const now = new Date(Date.UTC(2026, 8, 19));
	const expired = expiredShardNames(now, 7, PREFIX);
	assert.ok(expired.length >= 7, "covers the retention horizon");
	// Today and yesterday are inside the window and never expire.
	for (const live of [`${PREFIX}-20260919.jsonl`, `${PREFIX}-20260918.jsonl`]) {
		assert.ok(!expired.includes(live), live + " must not expire");
	}
	assert.equal(expired.includes(`${PREFIX}-20260911.jsonl`), true, "8 days back is expired");
	assert.equal(expired.includes(`${PREFIX}-20260912.jsonl`), false, "7 days back is retained");
	// Newest-first walk (oldest last) is irrelevant; set equality is what matters.
	assert.equal(new Set(expired).size, expired.length, "no duplicate day names");
	assert.equal(expiredShardNames(now, 0, PREFIX).length, 0, "retention disabled expires nothing");
});

// ── lineage filter ──

test("only own-lineage records aggregate", () => {
	assert.equal(isOwnLineage(record(), "session:abc"), true);
	assert.equal(isOwnLineage(record(), "session:other"), false);
	const agg = aggregateLineage(
		[record(), record({ lineage: "session:foreign", spendHc: 999 })],
		"session:abc",
	);
	assert.equal(agg.summary.spendHc, 4.2, "foreign spend excluded");
});

// ── per-agent / actor rollup ──

test("turns of one run sum into one entry", () => {
	const agg = aggregateLineage(
		[
			record({ requests: 3, spendHc: 1 }),
			record({ requests: 9, spendHc: 3.2, ts: 2 }),
		],
		"session:abc",
	);
	assert.equal(agg.entries.length, 1);
	assert.deepEqual(agg.entries[0], { id: "run-1", name: "map-persistence", requests: 12, spendHc: 4.2 });
});

test("distinct runs and actors roll up separately", () => {
	const agg = aggregateLineage(
		[
			record({ agentId: "run-1", agentName: "runner" }),
			record({ agentId: "actor-a", agentName: "librarian", requests: 2, spendHc: 0.5 }),
			record({ agentId: "actor-a", agentName: "librarian", requests: 4, spendHc: 1.5, ts: 2 }),
			record({ agentId: "run-2", agentName: "second" }),
		],
		"session:abc",
	);
	assert.equal(agg.summary.agents, 3);
	const actor = agg.entries.find((e) => e.id === "actor-a");
	assert.deepEqual(actor, { id: "actor-a", name: "librarian", requests: 6, spendHc: 2 });
	// Actor activations keep one identity (the actor's), even when names vary.
	const renamed = aggregateLineage(
		[record({ agentId: "actor-a", agentName: "first" }), record({ agentId: "actor-a", agentName: "second", ts: 2 })],
		"session:abc",
	);
	assert.equal(renamed.entries[0].name, "first", "first-seen name wins; identity is the id");
});

// ── summary math ──

test("summary totals cover requests, spend, and agent count", () => {
	const agg = aggregateLineage(
		[
			record({ requests: 3, spendHc: 1 }),
			record({ agentId: "b", requests: 4, spendHc: 2.25 }),
			record({ lineage: "other", requests: 100, spendHc: 100 }),
		],
		"session:abc",
	);
	assert.deepEqual(agg.summary, { requests: 7, spendHc: 3.25, agents: 2 });
	assert.equal(agg.outOfCredits, false);
});

test("empty aggregation is the documented empty value", () => {
	assert.deepEqual(aggregateLineage([], "session:abc"), EMPTY_LINEAGE_USAGE);
	assert.deepEqual(aggregateLineage([record({ lineage: "x" })], "session:abc"), EMPTY_LINEAGE_USAGE);
});

// ── out-of-credits flag ──

test("any flagged record in the lineage trips the flag", () => {
	const agg = aggregateLineage(
		[record(), record({ agentId: "b", outOfCredits: true })],
		"session:abc",
	);
	assert.equal(agg.outOfCredits, true);
});

// ── snapshot newest-wins ──

test("the newest capturedAt snapshot wins, ties keep the later record", () => {
	const older = { limitHour: 1, limitDay: 10, remainingHour: 1, remainingDay: 10, capturedAt: 100 };
	const newer = { limitHour: 2, limitDay: 20, remainingHour: 2, remainingDay: 20, capturedAt: 200 };
	const agg = aggregateLineage(
		[record({ rate: older }), record({ agentId: "b", rate: newer, ts: 2 })],
		"session:abc",
	);
	assert.deepEqual(agg.latestRate, newer);

	const tie = aggregateLineage(
		[record({ rate: older }), record({ agentId: "b", rate: { ...older, remainingHour: 99 }, ts: 2 })],
		"session:abc",
	);
	assert.equal(tie.latestRate?.remainingHour, 99, "equal capturedAt → later append wins");

	assert.equal(aggregateLineage([record()], "session:abc").latestRate, undefined);
	assert.deepEqual(aggregateLineage([record({ rate: older })], "session:abc").latestRate, older);
});
