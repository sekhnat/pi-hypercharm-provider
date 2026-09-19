/**
 * Dependency-free smoke test for the shared model-catalog pipeline
 * (model-catalog.ts) — the transform + merge stages previously duplicated
 * across index.ts and scripts/update-models.js.
 * Run: node tests/models.smoke.ts (Node ≥ 23 strips types natively).
 */
import assert from "node:assert/strict";
import {
	DEPRECATED_MODEL_TTL_MS,
	ON_OFF_THINKING_LEVEL_MAP,
	activeDeprecatedModels,
	applyPatch,
	buildModels,
	buildThinkingLevelMap,
	embeddedCatalogHash,
	mergeStaleModels,
	mergeWithEmbedded,
	parseModelsCache,
	reconcileDeprecated,
	transformApiModel,
	withDeprecated,
	type DeprecatedData,
	type JsonModel,
} from "../model-catalog.ts";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const model = (id: string, over: Partial<JsonModel> = {}): JsonModel => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
	...over,
});

const depEntry = (id: string, ageDays: number) => ({
	...model(id),
	deprecatedAt: new Date(NOW - ageDays * DAY).toISOString(),
});

// ── buildThinkingLevelMap ──
assert.equal(buildThinkingLevelMap([]), undefined);
assert.deepEqual(buildThinkingLevelMap(["low", "high"]), {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: null,
});
assert.equal(buildThinkingLevelMap(["off", "high"])!.off, "off");
assert.equal(buildThinkingLevelMap(["none", "high"])!.off, "none", 'provider "none" maps the off state');

// ── ON_OFF thinking map (boolean reasoning models) ──
assert.deepEqual(ON_OFF_THINKING_LEVEL_MAP, {
	off: "off",
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
});

// ── transformApiModel ──
assert.equal(transformApiModel(null), null);
assert.equal(transformApiModel(undefined), null);
assert.equal(transformApiModel({}), null);
assert.equal(transformApiModel({ id: "" }), null);

const full = transformApiModel({
	id: "test-model",
	name: "Test Model",
	can_reason: true,
	reasoning_levels: ["low", "high"],
	supports_attachments: true,
	cost_per_1m_in: 0.2,
	cost_per_1m_out: 1.2,
	cost_per_1m_out_cached: 0.05555555,
	cost_per_1m_in_cached: 0.123456789,
	context_window: 1_000_000,
	default_max_tokens: 262_144,
})!;
assert.equal(full.id, "test-model");
assert.equal(full.name, "Test Model");
assert.equal(full.reasoning, true);
assert.deepEqual(full.input, ["text", "image"]);
assert.equal(full.contextWindow, 1_000_000);
assert.equal(full.maxTokens, 262_144);
assert.equal(full.cost.input, 0.2);
assert.equal(full.cost.output, 1.2);
assert.equal(full.cost.cacheRead, 0.055556, "pricing rounds to 6 decimals");
assert.equal(full.cost.cacheWrite, 0.123457, "pricing rounds to 6 decimals");
assert.equal(full.compat!.thinkingFormat, "deepseek");
assert.equal(full.compat!.supportsReasoningEffort, true);
assert.equal(full.compat!.maxTokensField, "max_tokens");
assert.equal(full.compat!.supportsStore, false);
assert.equal(full.thinkingLevelMap!.low, "low");
assert.equal(full.thinkingLevelMap!.max, null);

const onOff = transformApiModel({ id: "oo", can_reason: true })!;
assert.deepEqual(onOff.thinkingLevelMap, ON_OFF_THINKING_LEVEL_MAP, "no published levels → on/off map");
assert.equal(onOff.compat!.supportsReasoningEffort, false);

const plain = transformApiModel({ id: "p" })!;
assert.equal(plain.reasoning, false);
assert.ok(!("thinkingLevelMap" in plain), "non-reasoning models carry no thinkingLevelMap key");
assert.deepEqual(plain.compat, {
	supportsStore: false,
	supportsReasoningEffort: false,
	thinkingFormat: "deepseek",
	maxTokensField: "max_tokens",
});

const costs = transformApiModel({
	id: "c",
	cost_per_1m_in: "0.25",
	cost_per_1m_out: "not-a-number",
	cost_per_1m_out_cached: null,
})!;
assert.equal(costs.cost.input, 0.25, "numeric strings parse instead of leaking or zeroing");
assert.equal(costs.cost.output, 0, "garbage → 0");
assert.equal(costs.cost.cacheRead, 0, "null → 0");

const fallbacks = transformApiModel({ id: "f", context_window: 2048 })!;
assert.equal(fallbacks.name, "f", "missing name falls back to id");
assert.equal(fallbacks.maxTokens, 2048, "maxTokens falls back to context_window");
assert.equal(fallbacks.contextWindow, 2048);

// ── applyPatch ──
{
	const base = model("m", {
		reasoning: true,
		thinkingLevelMap: { off: null, max: "max" },
		compat: { supportsStore: false, thinkingFormat: "deepseek" },
	});

	const patched = applyPatch(base, { name: "Patched", contextWindow: 2000, cost: { input: 1 } });
	assert.equal(patched.name, "Patched");
	assert.equal(patched.contextWindow, 2000);
	assert.equal(patched.cost.input, 1);
	assert.equal(patched.cost.output, 0, "unpatched cost fields survive");
	assert.equal(patched.maxTokens, 100);
	assert.equal(patched.compat!.thinkingFormat, "deepseek", "patch without compat keeps existing compat");

	const compatMerge = applyPatch(model("m2", { compat: { supportsStore: false } }), {
		compat: { supportsReasoningEffort: true },
	});
	assert.equal(compatMerge.compat!.supportsStore, false, "existing compat keys survive the shallow merge");
	assert.equal(compatMerge.compat!.supportsReasoningEffort, true);

	const degated = applyPatch(base, { reasoning: false });
	assert.ok(!("thinkingLevelMap" in degated), "non-reasoning results drop thinkingLevelMap");
	assert.ok(!("thinkingFormat" in (degated.compat as object)), "non-reasoning results drop compat.thinkingFormat");
	assert.ok(!("compat" in degated) === false, "compat with remaining keys survives");

	const emptied = applyPatch(model("m3", { compat: { thinkingFormat: "deepseek" } }), { reasoning: false });
	assert.ok(!("compat" in emptied), "compat emptied by the reasoning gate is deleted");

	// Real patch.json shape applies cleanly (thinkingLevelMap replaces wholesale).
	const deepseek = applyPatch(model("deepseek-v4-pro", { reasoning: true }), {
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: "max" },
	});
	assert.equal(deepseek.thinkingLevelMap!.max, "max");
}

// ── buildModels ──
{
	const baseList = [model("a", { name: "Base A" }), model("b", { name: "Base B" })];
	const customList = [model("a", { name: "Custom A", contextWindow: 5555 }), model("c", { name: "Custom C" })];
	const patch = {
		a: { name: "Patched A" },
		b: { maxTokens: 7 },
		c: { contextWindow: 9 },
		z: { name: "Ghost" },
	};
	const merged = buildModels(baseList, customList, patch, {});
	const byId = new Map(merged.map((m) => [m.id, m] as const));
	assert.deepEqual(merged.map((m) => m.id), ["a", "b", "c"]);
	assert.equal(byId.get("a")!.name, "Patched A", "patch applies on top of the custom entry");
	assert.equal(byId.get("a")!.contextWindow, 5555, "custom model replaces the base entry");
	assert.equal(byId.get("b")!.maxTokens, 7, "patch applies to base models");
	assert.equal(byId.get("c")!.contextWindow, 9, "patch applies to custom-only models");
	assert.ok(!byId.has("z"), "patch with no matching model is a no-op");

	const seeded = buildModels([model("live")], [], { gone: { maxTokens: 33 } }, { gone: depEntry("gone", 1) }, NOW);
	assert.deepEqual(
		seeded.map((m) => ({ id: m.id, maxTokens: m.maxTokens })),
		[
			{ id: "live", maxTokens: 100 },
			{ id: "gone", maxTokens: 33 },
		],
		"grace-period deprecated models are seeded before patches apply",
	);
	assert.ok(!("deprecatedAt" in seeded[1]), "deprecation metadata is stripped from runtime models");
}

// ── mergeWithEmbedded ──
{
	const live = [
		model("a", { name: "Live A", cost: { input: 5, output: 6, cacheRead: 0.1, cacheWrite: 0.2 }, contextWindow: 7777, maxTokens: 444 }),
		model("live-only", { name: "Live Only" }),
	];
	const embedded = [
		model("a", { name: "Embedded A", contextWindow: 1111, maxTokens: 222 }),
		model("embedded-only", { name: "Embedded Only" }),
	];
	const merged = mergeWithEmbedded(live, embedded);
	const byId = new Map(merged.map((m) => [m.id, m] as const));
	assert.equal(byId.size, 3, "union of live+embedded ids, one entry per id");
	assert.equal(byId.get("a")!.cost.input, 5, "live catalog is authoritative for cost");
	assert.equal(byId.get("a")!.contextWindow, 7777, "live contextWindow wins when present");
	assert.equal(byId.get("a")!.name, "Embedded A", "embedded curation wins for name");
	assert.equal(byId.get("a")!.maxTokens, 222);
	assert.ok(byId.has("live-only") && byId.has("embedded-only"), "one-sided models are kept");

	const zeroCtx = mergeWithEmbedded([model("y", { contextWindow: 0 })], [model("y", { contextWindow: 999 })]);
	assert.equal(zeroCtx[0]!.contextWindow, 999, "embedded contextWindow backs a zero live value");
}

// ── deprecation grace ──
assert.equal(DEPRECATED_MODEL_TTL_MS, 14 * 24 * 60 * 60 * 1000);

{
	const depData = {
		fresh: depEntry("fresh", 13),
		boundary: depEntry("boundary", 14),
		expired: depEntry("expired", 15),
		broken: { id: "broken", deprecatedAt: "not-a-date" },
		noid: { name: "no id" },
	} as unknown as DeprecatedData;

	const active = activeDeprecatedModels(depData, NOW);
	assert.deepEqual(active.map((m) => m.id), ["fresh", "boundary"], "only within-TTL entries with ids survive (TTL boundary inclusive)");
	assert.ok(!("deprecatedAt" in active[0]), "deprecation metadata is stripped");

	const withDep = withDeprecated([model("fresh"), model("live")], depData, NOW);
	assert.deepEqual(
		withDep.map((m) => m.id),
		["fresh", "live", "boundary"],
		"already-present deprecated model not duplicated; other active extras appended",
	);
	assert.deepEqual(
		withDeprecated([], depData, NOW).map((m) => m.id),
		["fresh", "boundary"],
	);
}

// ── reconcileDeprecated ──
{
	const oldModels = [model("gone"), model("back")];
	const newModels = [model("back"), model("brand-new")];
	const graveyard = {
		recent: depEntry("recent", 1),
		ancient: depEntry("ancient", 20),
		invalid: { id: "invalid", deprecatedAt: "nope" },
		back: depEntry("back", 2),
	} as unknown as DeprecatedData;

	const first = reconcileDeprecated(oldModels, newModels, graveyard, NOW);
	assert.deepEqual(first.added, ["gone"], "delisted models enter the graveyard");
	assert.match(first.deprecated.gone.deprecatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
	assert.deepEqual(first.resurrected, ["back"], "relisted models leave the graveyard");
	assert.deepEqual([...first.evicted].sort(), ["ancient", "invalid"], "expired and undated entries are evicted");
	assert.ok("recent" in first.deprecated, "recent graveyard entries survive untouched");
	assert.ok(!("back" in first.deprecated), "resurrected entry is removed");
	assert.ok(!("ancient" in first.deprecated) && !("invalid" in first.deprecated));

	// Repeat runs never reset the grace clock of preserved entries.
	const second = reconcileDeprecated(oldModels, newModels, first.deprecated, NOW);
	assert.deepEqual(second.added, []);
	assert.equal(second.deprecated.gone.deprecatedAt, first.deprecated.gone.deprecatedAt);
	assert.deepEqual(second.resurrected, []);
	assert.deepEqual(second.evicted, []);
}

// ── mergeStaleModels ──
{
	const cached = [
		model("a", { name: "Cache A", cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } }),
		model("old", { name: "Old" }),
	];
	const embedded = [model("a", { name: "Embedded A", contextWindow: 1234 }), model("new", { name: "Embedded New" })];
	const grave = { gone: depEntry("gone", 1) };

	// Hash match: the cache keeps precedence (it may hold live-merged data newer
	// than the release snapshot, e.g. post-release pricing updates), embedded
	// fills gaps.
	const cacheWins = mergeStaleModels(cached, embedded, false, {});
	assert.deepEqual(
		cacheWins.map((m) => m.id),
		["a", "old", "new"],
	);
	assert.equal(cacheWins[0]!.name, "Cache A", "cache entry keeps precedence on hash match");
	assert.equal(cacheWins[0]!.cost.input, 9);

	// Hash mismatch (older/newer release, or legacy cache): this release's
	// curated catalog wins shared ids; the cache contributes only missing ids.
	const embeddedWins = mergeStaleModels(cached, embedded, true, {});
	assert.deepEqual(
		embeddedWins.map((m) => m.id),
		["a", "new", "old"],
	);
	assert.equal(embeddedWins[0]!.name, "Embedded A", "embedded curation replaces stale cache data");
	assert.equal(embeddedWins[0]!.cost.input, 0);

	// Graveyard-owned ids never come from the cache — the grace layer is the
	// single owner of a delisted model's lifetime (both directions).
	const cachedWithGrave = [model("a", { name: "Cache A" }), model("gone", { name: "Cached Gone" })];
	assert.ok(
		!mergeStaleModels(cachedWithGrave, embedded, false, grave).some((m) => m.id === "gone"),
		"graveyard id dropped from the cache on the hash-match path",
	);
	const mismatch = mergeStaleModels(cachedWithGrave, embedded, true, grave);
	assert.ok(!mismatch.some((m) => m.id === "gone"), "graveyard id dropped from cache extras on mismatch");
	const built = buildModels(mismatch, [], {}, grave, NOW);
	assert.ok(built.some((m) => m.id === "gone"), "within-TTL graveyard model re-added by the grace layer");
}

// ── parseModelsCache ──
assert.equal(parseModelsCache(null), null);
assert.equal(parseModelsCache("nope"), null);
assert.equal(parseModelsCache(42), null);
assert.equal(parseModelsCache({}), null);
assert.equal(parseModelsCache({ models: "x" }), null);
{
	const envelope = parseModelsCache({ version: "1.2.3", embeddedHash: "ab12", models: [model("a")] })!;
	assert.equal(envelope.version, "1.2.3");
	assert.equal(envelope.embeddedHash, "ab12");
	assert.equal(envelope.models.length, 1);
	const legacy = parseModelsCache([model("a"), model("b")])!;
	assert.equal(legacy.embeddedHash, "", "legacy bare-array cache → unknown hash (embedded wins shared ids)");
	assert.equal(legacy.models.length, 2);
}

// ── embeddedCatalogHash ──
{
	const h1 = embeddedCatalogHash([model("a")]);
	const h2 = embeddedCatalogHash([model("a")]);
	const h3 = embeddedCatalogHash([model("a", { name: "Changed" })]);
	assert.equal(h1, h2, "deterministic across runs");
	assert.notEqual(h1, h3, "any embedded content change invalidates the hash");
	assert.match(h1, /^[0-9a-f]{64}$/, "sha256 hex digest");
}

console.log("models.smoke: all assertions passed");

// ── provider.ts: strict live-catalog schema + JsonModel<->Model adapters ──
import { parseProviderCatalog, payloadToJsonModel, toRuntimeModel, toJsonModel } from "../provider.ts";
import { HYPER_API_URL, USER_AGENT } from "../hyper.ts";
import { API_NAME, PROVIDER_ID } from "../identity.ts";

const validPayloadModel = {
	id: "live-model",
	name: "Live Model",
	cost_per_1m_in: 0.5,
	cost_per_1m_out: 2,
	cost_per_1m_in_cached: 0.1,
	cost_per_1m_out_cached: 0.05,
	context_window: 262144,
	default_max_tokens: 8192,
	can_reason: true,
	reasoning_levels: ["off", "low"],
	supports_attachments: true,
};

// Valid official fields parse into model payloads.
const parsed = parseProviderCatalog({ models: [validPayloadModel] });
assert.ok(parsed, "a valid official payload parses");
assert.equal(parsed!.length, 1);

// Unknown additive fields stay accepted (forward compatibility).
const additive = parseProviderCatalog({
	models: [{ ...validPayloadModel, brand_new_field: { nested: true } }],
	deployment_hint: "canary",
});
assert.ok(additive, "unknown additive fields are accepted");

// Malformed required fields reject the ENTIRE payload.
for (const broken of [
	{}, // no models array
	{ models: [] }, // empty catalog is a refresh failure
	{ models: [{ ...validPayloadModel, id: "" }] },
	{ models: [{ ...validPayloadModel, name: "" }] },
	{ models: [{ ...validPayloadModel, cost_per_1m_in: -1 }] },
	{ models: [{ ...validPayloadModel, context_window: 0 }] },
	{ models: [{ ...validPayloadModel, can_reason: "yes" }] },
	{ models: [{ ...validPayloadModel, supports_attachments: undefined }] },
	{ models: [validPayloadModel, { ...validPayloadModel, id: "" }] }, // one bad entry fails all
]) {
	assert.equal(parseProviderCatalog(broken), undefined, "payload must reject: " + JSON.stringify(broken).slice(0, 80));
}

// payloadToJsonModel routes through the shared curation transform.
const curated = payloadToJsonModel(parsed![0])!;
assert.equal(curated.id, "live-model");
assert.equal(curated.reasoning, true);
assert.equal(curated.maxTokens, 8192);
assert.equal(curated.compat!.maxTokensField, "max_tokens");
assert.equal(curated.compat!.thinkingFormat, "deepseek");
assert.equal(curated.thinkingLevelMap!.low, "low");
assert.equal(payloadToJsonModel({ ...validPayloadModel, default_max_tokens: undefined })!.maxTokens, 262144, "context-window fallback");

// Round-trip: JsonModel -> runtime Model -> JsonModel is lossless for the pure
// shape, and the runtime model carries the namespaced identity.
const runtime = toRuntimeModel(curated);
assert.equal(runtime.api, API_NAME, "runtime models use the namespaced custom api");
assert.equal(runtime.provider, PROVIDER_ID);
assert.equal(runtime.baseUrl, HYPER_API_URL);
assert.equal(runtime.headers!["User-Agent"], USER_AGENT, "versioned user agent rides the model");
assert.deepEqual(toJsonModel(runtime), curated);

// A stored/graveyard entry can never smuggle a foreign provider or api in.
const projected = toJsonModel({ ...runtime, provider: "hyper", api: "openai-completions" });
const again = toRuntimeModel(projected);
assert.equal(again.provider, PROVIDER_ID, "projection re-stamps the namespaced provider");
assert.equal(again.api, API_NAME, "projection re-stamps the namespaced api");
