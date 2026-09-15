/**
 * Shared model-catalog pipeline — the single source of truth for the
 * transform + merge stages run by both consumers:
 *
 *   - index.ts (runtime): embedded models.json → disk cache → live
 *     /v1/provider fetch, then patch.json + custom-models.json on top.
 *   - scripts/update-models.js (sync): fetches /v1/provider, rewrites
 *     models.json and the README table.
 *
 * Pure by design (like status.ts and sidebar.ts): no pi imports, no fs, no
 * network. Deprecation helpers take `now` explicitly so the grace logic is
 * testable; call sites default to Date.now().
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JsonModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsStore?: boolean;
		maxTokensField?: "max_completion_tokens" | "max_tokens";
		thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template" | "deepseek";
		supportsReasoningEffort?: boolean;
		requiresReasoningContentOnAssistantMessages?: boolean;
	};
}

export interface PatchEntry {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}

export type PatchData = Record<string, PatchEntry>;

/** A delisted model preserved in deprecated-models.json with its deprecation stamp. */
export type DeprecatedEntry = JsonModel & { deprecatedAt?: string };
export type DeprecatedData = Record<string, DeprecatedEntry>;

// ─── Thinking levels ──────────────────────────────────────────────────────────

export const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Charm's official extension treats a reasoning-capable model with no levels as
// a boolean on/off model: Pi's max level selects the single on state.
export const ON_OFF_THINKING_LEVEL_MAP: Record<string, string | null> = {
	off: "off",
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
};

export function buildThinkingLevelMap(levels: string[]): Record<string, string | null> | undefined {
	if (levels.length === 0) return undefined;
	const available = new Set(levels);
	const result: Record<string, string | null> = {
		// The provider enum uses "none" for the off state on newer deployments;
		// the official extension looked only for the older "off" spelling.
		off: available.has("off") ? "off" : available.has("none") ? "none" : null,
	};
	for (const level of PI_THINKING_LEVELS) {
		result[level] = available.has(level) ? level : null;
	}
	return result;
}

// ─── API transform ────────────────────────────────────────────────────────────

/**
 * API returns $/M directly; round to 6 decimals to preserve sub-cent cache
 * prices. Numeric strings are accepted (and finite-checked) so a server-side
 * string encoding can never leak into cost arithmetic as a string.
 */
function convertPricing(v: unknown): number {
	const n = typeof v === "string" ? Number(v) : v;
	if (typeof n !== "number" || !Number.isFinite(n)) return 0;
	return Math.round(n * 1e6) / 1e6;
}

/** Transform a model from Charm's official typed Hyper /v1/provider catalog. */
export function transformApiModel(apiModel: any): JsonModel | null {
	if (typeof apiModel?.id !== "string" || apiModel.id.length === 0) return null;

	const reasoningLevels = Array.isArray(apiModel.reasoning_levels)
		? apiModel.reasoning_levels.filter((level: any) => typeof level === "string")
		: [];
	const supportsReasoningEffort = reasoningLevels.length > 0;
	const thinkingLevelMap = supportsReasoningEffort
		? buildThinkingLevelMap(reasoningLevels)
		: apiModel.can_reason === true
			? ON_OFF_THINKING_LEVEL_MAP
			: undefined;

	return {
		id: apiModel.id,
		name: apiModel.name || apiModel.id,
		reasoning: apiModel.can_reason === true,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: apiModel.supports_attachments === true ? ["text", "image"] : ["text"],
		cost: {
			input: convertPricing(apiModel.cost_per_1m_in),
			output: convertPricing(apiModel.cost_per_1m_out),
			cacheRead: convertPricing(apiModel.cost_per_1m_out_cached),
			cacheWrite: convertPricing(apiModel.cost_per_1m_in_cached),
		},
		contextWindow: apiModel.context_window || 0,
		maxTokens: apiModel.default_max_tokens || apiModel.context_window || 0,
		compat: {
			supportsStore: false,
			supportsReasoningEffort,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
	};
}

// ─── Patch application ────────────────────────────────────────────────────────

export function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
	const result = { ...model };

	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
	if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };

	if (patch.cost) {
		result.cost = {
			input: patch.cost.input ?? result.cost.input,
			output: patch.cost.output ?? result.cost.output,
			cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
			cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
		};
	}
	if (patch.compat) {
		result.compat = { ...(result.compat || {}), ...patch.compat };
	}

	if (!result.reasoning && result.compat?.thinkingFormat) {
		delete result.compat.thinkingFormat;
	}
	if (!result.reasoning && result.thinkingLevelMap) {
		delete result.thinkingLevelMap;
	}
	if (result.compat && Object.keys(result.compat).length === 0) {
		delete result.compat;
	}

	return result;
}

/**
 * Full pipeline: base models → patch → custom → result. Grace-period
 * deprecated models are seeded before patches apply, so patch.json entries
 * reach them exactly as while the model was live (withDeprecated keeps live
 * data on id conflicts).
 */
export function buildModels(
	base: JsonModel[],
	custom: JsonModel[],
	patch: PatchData,
	deprecated: DeprecatedData,
	now: number = Date.now(),
): JsonModel[] {
	const modelMap = new Map<string, JsonModel>();

	for (const model of withDeprecated(base, deprecated, now)) {
		modelMap.set(model.id, model);
	}

	for (const [id, patchEntry] of Object.entries(patch)) {
		const existing = modelMap.get(id);
		if (existing) {
			modelMap.set(id, applyPatch(existing, patchEntry));
		}
	}

	for (const model of custom) {
		const existing = modelMap.get(model.id);
		const patchEntry = patch[model.id];
		if (existing && patchEntry) {
			modelMap.set(model.id, applyPatch(model, patchEntry));
		} else if (existing) {
			modelMap.set(model.id, model);
		} else if (patchEntry) {
			modelMap.set(model.id, applyPatch(model, patchEntry));
		} else {
			modelMap.set(model.id, model);
		}
	}

	return Array.from(modelMap.values());
}

// ─── Live/embedded merge ──────────────────────────────────────────────────────

export function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
	const embeddedMap = new Map(embeddedModels.map((m) => [m.id, m]));
	const seen = new Set<string>();
	const result: JsonModel[] = [];
	for (const liveModel of liveModels) {
		const embedded = embeddedMap.get(liveModel.id);
		seen.add(liveModel.id);
		if (embedded) {
			// The official /v1/provider catalog is authoritative for pricing, including
			// legitimately zero-priced preview models. Curation (reasoning/input/compat/name)
			// still wins via ...embedded.
			result.push({
				...liveModel,
				...embedded,
				cost: liveModel.cost,
				contextWindow: liveModel.contextWindow || embedded.contextWindow,
			});
		} else {
			result.push(liveModel);
		}
	}
	// Append any embedded models that the live API didn't return
	for (const em of embeddedModels) {
		if (!seen.has(em.id)) {
			result.push(em);
		}
	}
	return result;
}

// ─── Deprecation grace ────────────────────────────────────────────────────────

// Grace period for delisted models. When the provider API stops listing a
// model, update-models.js moves its last-known definition into
// deprecated-models.json (stamped with deprecatedAt) instead of dropping it.
// For 14 days the model keeps working so in-flight sessions and saved model
// settings do not break; afterwards it is evicted permanently.
export const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Grace-period deprecated models with deprecation metadata stripped. */
export function activeDeprecatedModels(deprecated: DeprecatedData, now: number = Date.now()): JsonModel[] {
	const result: JsonModel[] = [];
	for (const entry of Object.values(deprecated)) {
		if (!entry?.id) continue;
		const removedAt = Date.parse(entry.deprecatedAt ?? "");
		if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
		const model: DeprecatedEntry = { ...entry };
		delete model.deprecatedAt;
		result.push(model);
	}
	return result;
}

/** Append grace-period deprecated models the list does not already have (live data wins). */
export function withDeprecated(
	models: JsonModel[],
	deprecated: DeprecatedData,
	now: number = Date.now(),
): JsonModel[] {
	const seen = new Set(models.map((m) => m.id));
	const extras = activeDeprecatedModels(deprecated, now).filter((m) => !seen.has(m.id));
	return extras.length > 0 ? [...models, ...extras] : models;
}

/**
 * Reconcile the deprecated graveyard against the freshly fetched model list
 * (pure — file I/O stays with the caller):
 *   - in old models.json but not the API → moved into the graveyard
 *     (deprecatedAt = now; preserved on repeat runs so the grace clock is not reset)
 *   - back in the API → resurrected (dropped from the graveyard)
 *   - deprecatedAt older than 14 days (or missing/invalid) → evicted permanently
 */
export function reconcileDeprecated(
	oldModels: JsonModel[],
	newModels: JsonModel[],
	deprecated: DeprecatedData,
	nowMs: number,
): { deprecated: DeprecatedData; added: string[]; resurrected: string[]; evicted: string[] } {
	const deprecatedOut: DeprecatedData = { ...deprecated };
	const currentIds = new Set(newModels.map((m) => m.id));
	const added: string[] = [];
	const resurrected: string[] = [];
	const evicted: string[] = [];

	for (const old of oldModels) {
		if (old && old.id && !currentIds.has(old.id) && !deprecatedOut[old.id]) {
			deprecatedOut[old.id] = { ...old, deprecatedAt: new Date(nowMs).toISOString() };
			added.push(old.id);
		}
	}

	for (const [id, entry] of Object.entries(deprecatedOut)) {
		if (currentIds.has(id)) {
			delete deprecatedOut[id];
			resurrected.push(id);
			continue;
		}
		const removedAt = Date.parse(entry && entry.deprecatedAt ? entry.deprecatedAt : "");
		if (Number.isNaN(removedAt) || nowMs - removedAt > DEPRECATED_MODEL_TTL_MS) {
			delete deprecatedOut[id];
			evicted.push(id);
		}
	}

	return { deprecated: deprecatedOut, added, resurrected, evicted };
}
