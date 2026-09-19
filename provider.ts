/**
 * The complete native `hypercharm` provider (specs/model-catalog).
 *
 * Registered once at extension-factory time as a full pi-ai Provider — not the
 * legacy name+config shape and not `createProvider` — so refreshes keep full
 * replacement semantics over one mutable catalog snapshot: a stored or live
 * list that drops an expired model actually removes it, which an immutable
 * baseline + dynamic overlay cannot express.
 *
 * The provider owns:
 *   - namespaced auth: `envApiKeyAuth` over HYPERCHARM_API_KEY with stored-key
 *     precedence, plus lazily loaded OAuth (oauth.ts stays out of startup);
 *   - a synchronous getModels() over the current curated snapshot, seeded from
 *     the embedded catalog reconciled with the read-only namespaced cache;
 *   - refreshModels(context): transactional restore of Pi's stored catalog
 *     through the current embedded/patch/custom/deprecation policy, then —
 *     when Pi allows network and a credential exists — a strictly validated
 *     /v1/provider fetch published atomically (persist + in-memory update)
 *     behind pi's generation check;
 *   - a ProviderStreams adapter over pi's openAICompletionsApi() with the
 *     injected HyperCharm streamSimple interceptor (usage tee, rate headers,
 *     402 capture) still wrapping every chat completion.
 *
 * Pure of pi imports: index.ts wires registration and rendering.
 */
import { envApiKeyAuth, lazyOAuth } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	Provider,
	ProviderStreams,
	RefreshModelsContext,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { API_KEY_ENV, API_NAME, PROVIDER_DISPLAY_NAME, PROVIDER_ID } from "./identity";
import { HYPER_API_URL, HYPER_PROVIDER_URL, USER_AGENT, bearerAuth, jsonHeaders } from "./hyper";
import { fetchJson } from "./http";
import { AccountFetchError } from "./account";
import { NonEmptyString, validateEndpoint } from "./schema";
import {
	buildModels,
	mergeStaleModels,
	mergeWithEmbedded,
	transformApiModel,
	type DeprecatedData,
	type JsonModel,
	type PatchData,
} from "./model-catalog";
import { hypercharmOAuthAuth } from "./oauth";

/** Timeout for the live /v1/provider catalog fetch. */
export const CATALOG_FETCH_TIMEOUT_MS = 8_000;

// ─── Live catalog schema (strict; additive Hyper fields stay allowed) ────────

const ProviderModelSchema = Type.Object({
	id: NonEmptyString,
	name: NonEmptyString,
	cost_per_1m_in: Type.Number({ minimum: 0 }),
	cost_per_1m_out: Type.Number({ minimum: 0 }),
	cost_per_1m_in_cached: Type.Number({ minimum: 0 }),
	cost_per_1m_out_cached: Type.Optional(Type.Number({ minimum: 0 })),
	context_window: Type.Integer({ minimum: 1 }),
	default_max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
	can_reason: Type.Boolean(),
	reasoning_levels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	default_reasoning_effort: Type.Optional(NonEmptyString),
	supports_attachments: Type.Boolean(),
});

/** A live payload must carry at least one usable model; empty is a failure. */
const ProviderCatalogSchema = Type.Object({
	models: Type.Array(ProviderModelSchema, { minItems: 1 }),
});

export interface ProviderModelPayload {
	id: string;
	name: string;
	cost_per_1m_in: number;
	cost_per_1m_out: number;
	cost_per_1m_in_cached: number;
	cost_per_1m_out_cached?: number;
	context_window: number;
	default_max_tokens?: number;
	can_reason: boolean;
	reasoning_levels?: string[];
	default_reasoning_effort?: string;
	supports_attachments: boolean;
}

/**
 * Validate a live /v1/provider payload. The whole payload is rejected when any
 * required model field or range is wrong — a partially malformed catalog must
 * never replace the current one (specs/hyper-api-reliability).
 */
export function parseProviderCatalog(payload: unknown): ProviderModelPayload[] | undefined {
	const parsed = validateEndpoint(ProviderCatalogSchema, payload);
	if (!parsed.ok) return undefined;
	return parsed.value.models as ProviderModelPayload[];
}

// ─── JsonModel ↔ runtime Model adapters ──────────────────────────────────────

/**
 * Project a pure catalog model onto a full runtime model: the namespaced API
 * name, provider id, Hyper base URL, and versioned user-agent header are added
 * only here, at the provider boundary.
 */
export function toRuntimeModel(json: JsonModel): Model<Api> {
	return {
		id: json.id,
		name: json.name,
		api: API_NAME,
		provider: PROVIDER_ID,
		baseUrl: HYPER_API_URL,
		headers: { "User-Agent": USER_AGENT },
		reasoning: json.reasoning,
		...(json.thinkingLevelMap ? { thinkingLevelMap: json.thinkingLevelMap } : {}),
		input: json.input,
		cost: { ...json.cost },
		contextWindow: json.contextWindow,
		maxTokens: json.maxTokens,
		...(json.compat ? { compat: { ...json.compat } } : {}),
	};
}

/** Strip runtime-only fields back to the pure catalog shape (store projection). */
export function toJsonModel(model: Model<Api>): JsonModel {
	const compat = model.compat as Partial<JsonModel["compat"]> | undefined;
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
		input: [...model.input],
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(compat ? { compat: { ...compat } } : {}),
	};
}

/**
 * Convert a strict, schema-validated live payload model to the pure catalog
 * shape through model-catalog.ts's curation transform — reasoning levels,
 * thinking maps, compat defaults, and pricing normalization all come from the
 * one shared pipeline (the same one scripts/update-models.js uses).
 */
export function payloadToJsonModel(model: ProviderModelPayload): JsonModel | null {
	return transformApiModel(model);
}

// ─── The provider factory ─────────────────────────────────────────────────────

export type StreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface HypercharmProviderOptions {
	/** Embedded models.json catalog for this release. */
	embeddedModels: JsonModel[];
	customModels: JsonModel[];
	patch: PatchData;
	deprecated: DeprecatedData;
	/** The namespaced model cache (read-only compatibility input). The flag says
	 * whether this release's embedded curation wins shared ids. */
	loadLegacyCache: () => { models: JsonModel[]; preferEmbedded: boolean } | null;
	/** Deduplicated warning sink for classified failures. */
	warn: (message: string) => void;
	/** The existing streamSimple interceptor (usage tee, rate headers, 402s). */
	streamSimple: StreamSimpleFn;
}

export interface HypercharmProvider extends Provider {
	/** Current curated snapshot (test/inspection seam). */
	currentCatalog(): JsonModel[];
}

export function createHypercharmProvider(options: HypercharmProviderOptions): HypercharmProvider {
	const { embeddedModels, customModels, patch, deprecated } = options;

	// Initial snapshot: embedded catalog reconciled with the compatible legacy
	// cache, through the full patch/custom/deprecation policy (read-only —
	// successful refreshes persist through pi's model store from here on).
	const cached = options.loadLegacyCache();
	const staleBase = cached
		? mergeStaleModels(
				cached.models,
				embeddedModels,
				cached.preferEmbedded,
				deprecated,
		  )
		: embeddedModels;
	let currentCatalogData: JsonModel[] = buildModels(staleBase, customModels, patch, deprecated);

	const base = openAICompletionsApi();
	const streams: ProviderStreams = {
		// Full stream dispatch goes through pi's implementation with the model
		// re-typed to the delegated OpenAI-completions shape.
		stream: (model, context, requestOptions) =>
			base.stream({ ...model, api: "openai-completions", baseUrl: model.baseUrl || HYPER_API_URL }, context, requestOptions),
		// The HyperCharm interceptor (index.ts) owns streamSimple end to end:
		// it retypes the model, delegates to openAICompletionsApi().streamSimple,
		// and tees usage/rate/402 metadata off the response.
		streamSimple: (model, context, requestOptions) => options.streamSimple(model, context, requestOptions),
	};

	/** Rebuild a curated catalog from a stored runtime list (4.4): entries the
	 * graveyard owns never come back (grace re-adds within-TTL ids; expired
	 * ones are evicted), embedded curation wins shared ids, and the stored
	 * source contributes only ids this release's embedded snapshot lacks. */
	function catalogFromStored(storedModels: readonly Model<Api>[]): JsonModel[] {
		const embeddedMap = new Map(embeddedModels.map((m) => [m.id, m]));
		const graveyardIds = new Set(Object.keys(deprecated));
		const extras: JsonModel[] = [];
		for (const model of storedModels) {
			if (model.provider !== PROVIDER_ID) continue;
			if (embeddedMap.has(model.id) || graveyardIds.has(model.id)) continue;
			const json = toJsonModel(model);
			// A stored entry must still be a usable catalog model.
			if (json.contextWindow > 0 && json.maxTokens > 0) extras.push(json);
		}
		const merged = mergeStaleModels(extras, embeddedModels, true, deprecated);
		return buildModels(merged, customModels, patch, deprecated);
	}

	async function fetchLiveCatalog(credentialKey: string, signal: AbortSignal): Promise<JsonModel[]> {
		const outcome = await fetchJson({
			url: HYPER_PROVIDER_URL,
			operation: "HyperCharm model catalog",
			headers: { ...jsonHeaders(), ...bearerAuth(credentialKey) },
			signal,
			timeoutMs: CATALOG_FETCH_TIMEOUT_MS,
		});
		if (!outcome.ok) throw new AccountFetchError(outcome.failure, "HyperCharm model catalog");
		const models = parseProviderCatalog(outcome.value);
		if (!models) {
			throw new AccountFetchError(
				{ kind: "payload", reason: "catalog payload failed validation" },
				"HyperCharm model catalog",
			);
		}
		const jsonModels = models.map(payloadToJsonModel);
		if (jsonModels.some((m) => m === null)) {
			// The strict schema already rejected unusable entries; a null here
			// means the curation transform refused a validated payload — treat
			// the whole catalog as malformed rather than serving a partial list.
			throw new AccountFetchError({ kind: "payload", reason: "catalog model failed curation" }, "HyperCharm model catalog");
		}
		return jsonModels as JsonModel[];
	}

	const provider: HypercharmProvider = {
		id: PROVIDER_ID,
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: HYPER_API_URL,
		headers: { "User-Agent": USER_AGENT },
		auth: {
			apiKey: envApiKeyAuth("HyperCharm API key", [API_KEY_ENV]),
			oauth: lazyOAuth({
				name: PROVIDER_DISPLAY_NAME,
				// oauth.ts loads on first login/refresh/toAuth, keeping the
				// flow code out of extension startup.
				load: async () => hypercharmOAuthAuth(),
			}),
		},
		getModels: () => currentCatalogData.map(toRuntimeModel),
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			// Phase 1 — transactional restore of pi's stored catalog through the
			// current policy. In-memory only: the store already holds it.
			if (context.stored && Array.isArray(context.stored.models) && context.stored.models.length > 0) {
				const restored = catalogFromStored(context.stored.models);
				if (restored.length > 0) {
					const published = await context.publish({
						update: () => {
							currentCatalogData = restored;
						},
					});
					if (!published) return; // superseded or aborted
				}
			}

			// Phase 2 — live refresh, only when pi's policy permits and a
			// credential is available.
			if (!context.allowNetwork || context.signal.aborted) return;
			const credential = context.credential;
			const key =
				credential?.type === "oauth"
					? typeof credential.access === "string" && credential.access
						? credential.access
						: undefined
					: credential?.type === "api_key"
						? typeof credential.key === "string" && credential.key
							? credential.key
							: undefined
						: undefined;
			if (!key) return;

			try {
				const liveModels = await fetchLiveCatalog(key, context.signal);
				if (context.signal.aborted) return;
				const merged = mergeWithEmbedded(liveModels, embeddedModels);
				const curated = buildModels(merged, customModels, patch, deprecated);
				const runtimeModels = curated.map(toRuntimeModel);
				const published = await context.publish({
					persist: { models: runtimeModels, checkedAt: Date.now() },
					update: () => {
						currentCatalogData = curated;
					},
				});
				void published; // false = superseded; snapshot untouched either way
			} catch (error) {
				// Lifecycle cancellation (session replacement, provider switch,
				// credential invalidation, shutdown) is never a failure; every real
				// failure (HTTP, network, timeout, invalid payload) leaves the
				// current snapshot and persisted store untouched (atomic).
				if (error instanceof AccountFetchError && error.failure.kind === "aborted") return;
				if (context.signal.aborted) return;
				options.warn(describeCatalogFailure(error));
			}
		},
		stream: (model, context, requestOptions) => streams.stream(model, context, requestOptions),
		streamSimple: (model, context, requestOptions) => streams.streamSimple(model, context, requestOptions),
		currentCatalog: () => currentCatalogData,
	};
	return provider;
}

/** Normalize unexpected errors into safe classified messages. */
function describeCatalogFailure(error: unknown): string {
	if (error instanceof AccountFetchError) return error.message;
	const message = error instanceof Error ? error.message : String(error);
	return `HyperCharm model catalog refresh failed: ${message}.`;
}
