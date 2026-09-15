/**
 * HyperCharm Provider Extension
 *
 * Registers HyperCharm (hyper.charm.land) as a custom provider using the
 * openai-completions API. Base URL: https://hyper.charm.land/v1
 *
 * Model metadata comes from Charm's typed official-catalog endpoint,
 * /v1/provider, matching @charmland/pi-hyper-provider. It provides canonical
 * names, pricing, context and output limits, reasoning levels, and attachment
 * support. patch.json remains available for verified endpoint regressions; it
 * currently restores Pi's max thinking level on the DeepSeek V4 models.
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /v1/models → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Footer Status Widget:
 *   A below-editor line shows HyperCharm session + account state:
 *
 *     ⚡ 1.24 hc · 7 req          Xu's Team ◆ 249 hc · 996/1k/h · 10k/10k/d · ⟳ 29d
 *     └─ session activity ──┘  └─────────────── account / quota ─────────────────┘
 *
 *   The left side reports what this session has spent/sent (from Hyper's
 *   usage.cost extension on each chat completion — pi requests
 *   stream_options.include_usage, so the final SSE chunk carries cost and we
 *   read it off a teed response stream, no polling). The right side reports
 *   the team (public /v1/teams — works for API-key auth), the canonical
 *   Hypercredit balance (/v1/credits), per-hour/day rate limits captured from
 *   response headers, and OAuth device-session days remaining (/v1/devices).
 *   The right side compresses across progressive tiers as the terminal
 *   narrows. The balance flips to a ⚠ warning at/below lowBalanceHc.
 *
 *   Lifecycle (mirrors pi-neuralwatt-provider): nothing renders before this
 *   session's first HyperCharm turn completes, so fresh sessions and other
 *   providers' sessions see no half-empty line. Credits/team are prefetched
 *   on session start or model select when a HyperCharm model is active, so
 *   the first turn ends with data already cached. The balance is polled
 *   again on pi's agent_settled event (fires only once no automatic retry,
 *   compaction, or queued continuation can follow) — and nowhere else, so
 *   sessions without HyperCharm turns make zero status-related API calls.
 *   Between polls the balance moves optimistically: each turn's
 *   usage.cost.hypercredits is deducted from the last /v1/credits value at
 *   turn_end so the account line tracks spend live; the agent_settled poll
 *   reconciles any drift.
 *
 *   Unit note (observed): 20 hypercredits = $1. usage.cost.hypercredits is in
 *   the same display unit /v1/credits reports; usage.cost.usd ÷ 20 matches.
 *   usage.remaining.hypercredits is USD-denominated despite the name — we
 *   therefore display only the polled /v1/credits balance.
 *
 * Display Configuration:
 *   Create ~/.pi/agent/extensions/hypercharm.json:
 *   {
 *     "session": "sidebar",           // "sidebar" | "widget" | "statusbar" | "off"
 *     "account": "sidebar",           // "sidebar" | "widget" | "statusbar" | "off"
 *     "hideOnOtherProvider": true,    // hide when a non-HyperCharm model is active
 *     "lowBalanceHc": 25              // warn threshold, null/false disables
 *   }
 *
 *   - "sidebar" (default): published as a structured panel to the Pi Atelier
 *     sidebar (visible by default after Atelier's Usage panel); falls back to
 *     the below-editor widget when no compatible Atelier host is loaded.
 *     Sidebar contributions are always limited to the active HyperCharm
 *     provider; hideOnOtherProvider governs only widget/statusbar.
 *   - "widget": rendered in the below-editor status line
 *   - "statusbar": rendered in the built-in pi status bar
 *   - "off": hidden entirely (account=off also skips/quota fetches)
 *
 *   Manage interactively with /hypercharm-status, or non-interactively:
 *     /hypercharm-status session sidebar|widget|statusbar|off
 *     /hypercharm-status account sidebar|widget|statusbar|off
 *     /hypercharm-status hide true|false
 *     /hypercharm-status lowBalance <hc>|off
 *     /hypercharm-status refresh          (re-fetch balance/team now)
 *     /hypercharm-status reset
 * Usage:
 *   # Option 1: OAuth — run pi, send /login, and pick "HyperCharm"
 *   # (device flow; provider id "hypercharm", distinct from the official
 *   # @charmland/pi-hyper-provider registration "hyper")
 *
 *   # Option 2: Store in auth.json
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "hypercharm": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 3: Set as environment variable
 *   export HYPERCHARM_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-hypercharm-provider
 *
 * Then use /model to select from available models.
 *
 * @see https://hyper.charm.land
 */

import { clampThinkingLevel, streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { USER_AGENT, loginHypercharm, refreshHypercharmToken } from "./oauth";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import pkg from "./package.json" with { type: "json" };
import {
	buildModels,
	embeddedCatalogHash,
	mergeStaleModels,
	mergeWithEmbedded,
	parseModelsCache,
	transformApiModel,
	type DeprecatedData,
	type JsonModel,
	type ModelsCache,
	type PatchData,
} from "./model-catalog";
import {
	applyOptimisticSpend,
	buildAccountTiers,
	buildSessionLine,
	buildSidebarRows,
	coerceStatusConfig,
	DEFAULT_STATUS_CONFIG,
	EMPTY_ACCOUNT,
	EMPTY_SESSION_STATS,
	StatusLineWidget,
	accountHasData,
	type AccountState,
	type SessionStats,
	type SidebarRow,
	type StatusConfig,
} from "./status";
import { createSidebarUsagePublisher, type EventTransport, type SidebarUsagePublisher } from "./sidebar";
import fs from "fs";
import { hostname } from "os";
import path from "path";

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "hypercharm";
const BASE_URL = "https://hyper.charm.land/v1";
const MODELS_URL = `${BASE_URL}/provider`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;
const EMBEDDED_HASH = embeddedCatalogHash(modelsData as JsonModel[]);
const VERSION = (pkg as { version?: string }).version ?? "0.0.0";

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
	try {
		const response = await fetch(MODELS_URL, {
			headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
			signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const data = await response.json();
		const apiModels = Array.isArray(data) ? data : (data.models || data.data || []);
		if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
		return apiModels.map(transformApiModel).filter((m): m is JsonModel => m !== null);
	} catch {
		return null;
	}
}

function loadCachedModels(): ModelsCache | null {
	try {
		return parseModelsCache(JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")));
	} catch {
		return null;
	}
}

function cacheModels(models: JsonModel[]): void {
	try {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		const envelope = { version: VERSION, embeddedHash: EMBEDDED_HASH, models };
		fs.writeFileSync(CACHE_PATH, JSON.stringify(envelope, null, 2) + "\n");
	} catch {
		// Cache write failure is non-fatal
	}
}

function loadStaleModels(embeddedModels: JsonModel[], graveyard: DeprecatedData): JsonModel[] {
	const cached = loadCachedModels();
	if (!cached || cached.models.length === 0) return embeddedModels;

	// Cache written against different embedded content (older/newer release, or
	// a legacy bare-array cache): this release's curated catalog wins for shared
	// ids and the cache contributes only its extra ids, so fixes shipped in a
	// release are never masked by stale on-disk data. Graveyard ids never come
	// from the cache — the grace layer owns a delisted model's lifetime.
	const preferEmbedded = cached.embeddedHash !== EMBEDDED_HASH;
	return mergeStaleModels(cached.models, embeddedModels, preferEmbedded, graveyard);
}
async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
	if (!apiKey) return null;
	const liveModels = await fetchLiveModels(apiKey, signal);
	if (!liveModels || liveModels.length === 0) return null;
	const merged = mergeWithEmbedded(liveModels, embeddedModels);
	cacheModels(merged);
	return merged;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
	cachedApiKey = await modelRegistry.getApiKeyForProvider(PROVIDER_ID) ?? undefined;
}

// ─── Status Display Configuration ──────────────────────────────────────────────

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "hypercharm.json");

let statusConfig: StatusConfig = { ...DEFAULT_STATUS_CONFIG };

function loadStatusConfig(): StatusConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		statusConfig = coerceStatusConfig(raw);
	} catch {
		// Missing or unreadable file → defaults
	}
	return statusConfig;
}

function writeStatusConfig(): void {
	try {
		let raw: Record<string, unknown> = {};
		try {
			const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
			if (existing && typeof existing === "object" && !Array.isArray(existing)) raw = existing;
		} catch {
			// No existing file — start fresh
		}
		raw.session = statusConfig.session;
		raw.account = statusConfig.account;
		raw.hideOnOtherProvider = statusConfig.hideOnOtherProvider;
		raw.lowBalanceHc = statusConfig.lowBalanceHc;
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
	} catch {
		// Config write failure is non-fatal — the in-memory config still applies
	}
}

loadStatusConfig();

// ─── Response Metadata Capture ────────────────────────────────────────────────
// The custom streamSimple below wraps fetch per request (never globalThis —
// concurrent main/helper requests would clobber a global patch). For every
// /chat/completions response we capture x-ratelimit-* headers and tee the
// body: one copy goes to pi's OpenAI streaming layer, the other is scanned
// for the final usage chunk that Hyper extends with hypercredit cost data.

const sessionStats: SessionStats = { ...EMPTY_SESSION_STATS };
const account: AccountState = { ...EMPTY_ACCOUNT };

// Per-turn pending state — teed streams settle asynchronously, so capture
// lands in pending* and is committed at turn_end.
let pendingRequests = 0;
let pendingSpendHc = 0;
let pendingSawUsage = false;
let pendingSawOutOfCredits = false;
let outOfCreditsNotified = false;

const teeReaders = new Set<Promise<void>>();

function trackTeeReader(promise: Promise<void>): void {
	teeReaders.add(promise);
	const release = () => { teeReaders.delete(promise); };
	promise.then(release, release);
}

function settleTeeReaders(): Promise<void> {
	if (teeReaders.size === 0) return Promise.resolve();
	const pending = Array.from(teeReaders);
	return Promise.allSettled(pending).then(() => undefined);
}

function captureRateLimitHeaders(headers: Headers): void {
	const limitHour = headers.get("x-ratelimit-limit-hour");
	const limitDay = headers.get("x-ratelimit-limit-day");
	const remainingHour = headers.get("x-ratelimit-remaining-hour");
	const remainingDay = headers.get("x-ratelimit-remaining-day");
	// Absent headers must not become a zeroed rate window (Number(null) === 0).
	if (limitHour === null || limitDay === null || remainingHour === null || remainingDay === null) return;
	const rate = {
		limitHour: Number(limitHour),
		limitDay: Number(limitDay),
		remainingHour: Number(remainingHour),
		remainingDay: Number(remainingDay),
		capturedAt: Date.now(),
	};
	if (![rate.limitHour, rate.limitDay, rate.remainingHour, rate.remainingDay].every((v) => Number.isFinite(v))) return;
	account.rate = rate;
}

/** Extract spend data from a parsed completion chunk/body's usage object. */
function captureUsage(obj: any): void {
	const usage = obj?.usage;
	if (typeof usage !== "object" || usage === null) return;
	const hc = usage.cost?.hypercredits;
	if (typeof hc === "number" && Number.isFinite(hc)) {
		pendingSpendHc += hc;
	}
	pendingSawUsage = true;
}

/** Scan a teed response for the final usage chunk (SSE) or JSON body usage. */
async function readUsageFromTee(body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const processLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data: ")) return;
		const payload = trimmed.slice(6);
		if (payload === "[DONE]") return;
		try {
			captureUsage(JSON.parse(payload));
		} catch {
			// Not JSON or no usage — benign
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		}
	} catch {
		// Tee stream may error if the main stream is aborted — that's fine
	}

	const trailing = (buffer + decoder.decode(new Uint8Array(0), { stream: false })).trim();
	if (trailing) {
		if (trailing.startsWith("data: ")) {
			processLine(trailing);
		} else if (trailing.startsWith("{")) {
			try {
				captureUsage(JSON.parse(trailing));
			} catch {
				// Partial non-SSE body — ignore
			}
		}
	}

	try {
		reader.releaseLock();
	} catch {
		// Ignore
	}
}

// ─── Custom Streaming Provider ────────────────────────────────────────────────

function streamHypercharm(
	model: any,
	context: any,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = (options as any)?.apiKey || cachedApiKey || "";
	if (!apiKey) {
		throw new Error(
			`No API key for HyperCharm. Add it to ~/.pi/agent/auth.json, ` +
			`set HYPERCHARM_API_KEY env var, or use --api-key.`,
		);
	}

	const hyperModel = { ...model, api: "openai-completions", baseUrl: model.baseUrl || BASE_URL };

	// pi hands the user's thinking selection as options.reasoning (a raw
	// ThinkingLevel); streamOpenAICompletions only reads reasoningEffort.
	// Replicate pi-ai's clamp+convert so levels reach the request body.
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(hyperModel, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	const { reasoning: _reasoning, ...streamOptions } = (options ?? {}) as any;

	// Per-request fetch wrapper: owns its interceptor, safe under concurrency.
	const upstreamFetch = (streamOptions as any).fetch ?? globalThis.fetch;
	const metaFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await upstreamFetch(input as any, init);
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!url.includes("/chat/completions")) return response;

		pendingRequests += 1;
		captureRateLimitHeaders(response.headers);
		if (response.status === 402) pendingSawOutOfCredits = true;
		if (!response.ok || !response.body) return response;

		const [bodyForSdk, bodyForMeta] = response.body.tee();
		trackTeeReader(readUsageFromTee(bodyForMeta));
		return new Response(bodyForSdk, {
			headers: response.headers,
			status: response.status,
			statusText: response.statusText,
		});
	};

	return streamOpenAICompletions(hyperModel, context, {
		...streamOptions,
		fetch: metaFetch,
		reasoningEffort,
		apiKey,
	} as any);
}

// ─── Account Metadata Fetching ────────────────────────────────────────────────

const CREDITS_MIN_INTERVAL_MS = 15_000;
const ACCOUNT_FETCH_TIMEOUT_MS = 8_000;

let statusAbort: AbortController | null = null;
// Bumped on every session_start; async continuations compare against this to
// drop work belonging to a replaced session (its ctx is stale and throws).
let statusEpoch = 0;
let lastCreditsFetchAt = 0;
let creditsInFlight: Promise<void> | null = null;
let metaFetched = false;

type FetchJsonResult = { ok: true; value: any } | { ok: false };

async function fetchJsonGet(url: string, apiKey: string, signal?: AbortSignal): Promise<FetchJsonResult> {
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
			signal: signal
				? AbortSignal.any([AbortSignal.timeout(ACCOUNT_FETCH_TIMEOUT_MS), signal])
				: AbortSignal.timeout(ACCOUNT_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return { ok: false };
		return { ok: true, value: await response.json() };
	} catch {
		return { ok: false };
	}
}

/** Canonical Hypercredit balance from /v1/credits. Throttled unless forced. */
function refreshCredits(apiKey: string | undefined, signal: AbortSignal | undefined, force: boolean): Promise<void> {
	if (!apiKey) return Promise.resolve();
	if (!force && Date.now() - lastCreditsFetchAt < CREDITS_MIN_INTERVAL_MS) return Promise.resolve();
	lastCreditsFetchAt = Date.now();
	if (creditsInFlight) return creditsInFlight;
	creditsInFlight = (async () => {
		try {
			const result = await fetchJsonGet(`${BASE_URL}/credits`, apiKey, signal);
			if (!result.ok) return;
			const data = result.value;
			// /credits can report hypercredits ("balance") or USD ("balance_usd",
			// USD-billed accounts). Handle both at the observed 20 hc = $1 rate so a
			// server-side unit switch can never silently freeze the balance readout.
			const rawBalance = typeof data?.balance === "number" ? data.balance : typeof data?.balance_usd === "number" ? data.balance_usd * 20 : undefined;
			if (typeof rawBalance === "number" && Number.isFinite(rawBalance)) {
				account.balance = rawBalance;
			}
		} finally {
			creditsInFlight = null;
		}
	})();
	return creditsInFlight;
}

/** Team name (/v1/teams) + OAuth device-session expiry (/v1/devices). */
/** Team name (/v1/teams) + OAuth device-session expiry (/v1/devices). */
async function refreshAccountMeta(apiKey: string | undefined, signal?: AbortSignal): Promise<void> {
	if (!apiKey || metaFetched) return;
	const [teams, devices] = await Promise.all([
		fetchJsonGet(`${BASE_URL}/teams`, apiKey, signal),
		fetchJsonGet(`${BASE_URL}/devices`, apiKey, signal),
	]);
	if (signal?.aborted) return;

	const teamName = teams.ok ? teams.value?.items?.[0]?.name : undefined;
	if (typeof teamName === "string" && teamName.trim()) {
		account.teamName = teamName.trim();
	}

	// Devices: the OAuth device flow registers this machine as
	// `Pi (<hostname>)`. Match by name; skip silently for API-key auth
	// (the endpoint returns OAuth sessions and may be empty).
	if (devices.ok && Array.isArray(devices.value?.items)) {
		const own = (devices.value.items as Array<{ name?: unknown; expires_at?: unknown }>).find(
			(d) => typeof d?.name === "string" && d.name === `Pi (${hostname()})`,
		);
		const expMs = own ? Date.parse(String(own.expires_at ?? "")) : NaN;
		if (!Number.isNaN(expMs)) {
			account.authDaysLeft = Math.max(0, Math.ceil((expMs - Date.now()) / 86_400_000));
		}
	}

	// One completed sweep stops the per-turn retries even when the account
	// exposes no atoms (API-key auth has no /v1/devices entries). Failed
	// fetches keep retrying on the next activity.
	metaFetched = teams.ok && devices.ok;
}

// ─── Status Rendering ─────────────────────────────────────────────────────────

const WIDGET_KEY = "hypercharm";
const STATUS_KEY_SESSION = "hypercharm-session";
const STATUS_KEY_ACCOUNT = "hypercharm-account";

// Sidebar panel publisher. The event bus arrives at factory time
// (initSidebarPublisher) because renderStatus runs before and outside session
// lifecycle events; a compatible Pi Atelier host is observed via discovery.
let sidebarPublisher: SidebarUsagePublisher | undefined;
/** Inert bus so render paths stay safe before the factory wires the real one. */
const NoopEventTransport = {
	on: () => () => undefined,
	emit: () => undefined,
} satisfies Pick<EventTransport, "on" | "emit">;

function initSidebarPublisher(pi: ExtensionAPI): void {
	sidebarPublisher = createSidebarUsagePublisher(pi.events, "hypercharm:usage");
}

const publisher = (): SidebarUsagePublisher =>
	sidebarPublisher ?? createSidebarUsagePublisher(NoopEventTransport, "hypercharm:usage");

function currentProviderId(ctx: ExtensionContext): string | undefined {
	// ctx.model is a getter that can throw on stale contexts
	try {
		return (ctx.model as any)?.provider as string | undefined;
	} catch {
		return undefined;
	}
}

function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("This extension ctx is stale");
}

// Render entry point: swallows the stale-ctx throw so a refresh racing a
// session replacement (newSession/fork/switchSession/reload) can't crash pi.
function updateStatus(ctx: ExtensionContext): void {
	try {
		renderStatus(ctx);
	} catch (err) {
		if (!isStaleCtxError(err)) throw err;
	}
}

// Re-render once an async refresh lands, unless the session was replaced
// meanwhile (epoch bump) — its ctx is stale and the render is obsolete anyway.
function updateStatusAfter(promise: Promise<void>, ctx: ExtensionContext): void {
	const epoch = statusEpoch;
	void promise.then(() => {
		if (epoch === statusEpoch) updateStatus(ctx);
	});
}

function renderStatus(ctx: ExtensionContext): void {
	const provider = currentProviderId(ctx);
	const isHyperCharmActive = provider === undefined || provider === PROVIDER_ID;
	const hiddenByOtherProvider =
		statusConfig.hideOnOtherProvider && provider !== undefined && provider !== PROVIDER_ID;

	const clearAll = () => {
		ctx.ui.setStatus(STATUS_KEY_SESSION, undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		publisher().withdraw();
	};

	if (hiddenByOtherProvider) {
		clearAll();
		return;
	}

	const hasActivity = sessionStats.requests > 0 || sessionStats.spendHc > 0;
	const sessionLine = statusConfig.session !== "off" ? buildSessionLine(sessionStats) : undefined;
	// Show only after HyperCharm activity this session (like pi-neuralwatt):
	// no empty-gap line on fresh sessions, no stale account glare on other
	// providers' sessions.
	const accountVisible = statusConfig.account !== "off" && accountHasData(account) && hasActivity;
	const lowBalance =
		statusConfig.lowBalanceHc !== null && account.balance !== null && account.balance <= statusConfig.lowBalanceHc;
	const accTiers = accountVisible ? buildAccountTiers(account, lowBalance) : [];

	// Sidebar panel: parts targeted at "sidebar" publish here whenever a
	// compatible host is present, gated on the active provider (the legacy
	// hideOnOtherProvider option governs only widget/statusbar). Without a
	// compatible host, sidebar parts fall back to the widget below. Each
	// metric lands in exactly one destination because routing switches on the
	// part's mode.
	const sidebarCompatible = publisher().isCompatible() && isHyperCharmActive;
	const sessionInSidebar = statusConfig.session === "sidebar" && sidebarCompatible;
	const accountInSidebar = statusConfig.account === "sidebar" && sidebarCompatible;
	if (sidebarCompatible && (statusConfig.session === "sidebar" || statusConfig.account === "sidebar")) {
		const sidebarRows: SidebarRow[] = [];
		if (hasActivity && statusConfig.session === "sidebar") {
			const line = buildSessionLine(sessionStats);
			if (line) sidebarRows.push({ text: line, role: "muted" });
		}
		if (statusConfig.account === "sidebar" && accountVisible) {
			// Account atoms directly (balance + limits row); the session row is
			// handled above, so pass empty stats to skip it rather than slicing.
			sidebarRows.push(...buildSidebarRows(EMPTY_SESSION_STATS, account, lowBalance));
		}
		if (sidebarRows.length > 0) {
			publisher().update({
				id: "hypercharm:usage",
				title: "HyperCharm",
				rows: sidebarRows,
				defaults: { visible: true, after: "usage" },
			});
		} else {
			publisher().withdraw();
		}
	} else {
		// Sidebar parts fall back to the widget without a compatible host, or
		// withdraw entirely while another provider is active.
		publisher().withdraw();
	}

	// Status bar (built-in footer slots) — statusbar-targeted parts only.
	const sBar = statusConfig.session === "statusbar" ? sessionLine : undefined;
	const aBar = statusConfig.account === "statusbar" && accountVisible ? accTiers[0] : undefined;
	if (sBar && aBar) {
		// Combined to avoid eating two footer slots
		ctx.ui.setStatus(STATUS_KEY_SESSION, ctx.ui.theme.fg(lowBalance ? "warning" : "dim", `${sBar} · ${aBar}`));
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
	} else {
		ctx.ui.setStatus(STATUS_KEY_SESSION, sBar ? ctx.ui.theme.fg("dim", sBar) : undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, aBar ? ctx.ui.theme.fg(lowBalance ? "warning" : "dim", aBar) : undefined);
	}

	// Below-editor widget (two-zone, width-aware). Sidebar parts route here as
	// their fallback when no compatible host is present; a sidebar part with a
	// compatible host must not duplicate into the widget.
	const leftW =
		statusConfig.session === "widget" || (statusConfig.session === "sidebar" && !sidebarCompatible)
			? sessionLine
			: undefined;
	const rightW =
		(statusConfig.account === "widget" || (statusConfig.account === "sidebar" && !sidebarCompatible)) &&
		accountVisible
			? accTiers
			: undefined;
	if (leftW !== undefined || (rightW !== undefined && rightW.length > 0)) {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui: any, theme: any) => new StatusLineWidget(theme, leftW ?? "", rightW ?? [], lowBalance),
			{ placement: "belowEditor" },
		);
	} else {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}

function resetStatusState(): void {
	sessionStats.requests = 0;
	sessionStats.spendHc = 0;
	Object.assign(account, EMPTY_ACCOUNT);
	pendingRequests = 0;
	pendingSpendHc = 0;
	pendingSawUsage = false;
	pendingSawOutOfCredits = false;
	outOfCreditsNotified = false;
	lastCreditsFetchAt = 0;
	metaFetched = false;
}

/** Commit per-turn pending capture into session state (after tees settle). */
function commitPending(ctx: ExtensionContext): void {
	if (!pendingSawUsage && pendingRequests === 0) return;
	sessionStats.requests += pendingRequests;
	sessionStats.spendHc += pendingSpendHc;

	// Optimistic balance: deduct this turn's observed spend so the account
	// line ticks down per turn with zero extra API calls. Every credits poll
	// overwrites account.balance (never adjusts), so this cannot
	// double-count; the agent_settled poll reconciles any drift.
	applyOptimisticSpend(account, pendingSpendHc);

	pendingRequests = 0;
	pendingSpendHc = 0;
	pendingSawUsage = false;

	if (pendingSawOutOfCredits) {
		pendingSawOutOfCredits = false;
		// Re-fetch now so the balance reflects exhaustion immediately
		updateStatusAfter(refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true), ctx);
		if (!outOfCreditsNotified && ctx.hasUI) {
			outOfCreditsNotified = true;
			ctx.ui.notify("HyperCharm is out of Hypercredits — recharge at hyper.charm.land", "error");
		}
	}
}

// ─── Status Command ────────────────────────────────────────────────────────────

function statusSummary(): string {
	const lb = statusConfig.lowBalanceHc === null ? "off" : `${statusConfig.lowBalanceHc}`;
	return `session=${statusConfig.session}, account=${statusConfig.account}, hideOnOtherProvider=${statusConfig.hideOnOtherProvider}, lowBalanceHc=${lb}`;
}

const STATUS_USAGE =
	"Usage: /hypercharm-status [session|account sidebar|widget|statusbar|off · hide true|false · lowBalance <hc>|off · refresh · reset]";

async function handleStatusCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);

	if (tokens.length === 0) {
		if (!ctx.hasUI) {
			ctx.ui.notify(statusSummary(), "info");
			return;
		}
		await configureStatusInteractive(ctx);
		return;
	}

	const [rawKey, rawValue] = tokens;
	const key = (rawKey ?? "").toLowerCase();
	const value = rawValue?.toLowerCase();

	if (key === "refresh") {
		metaFetched = false;
		await Promise.all([
			refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true),
			refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined),
		]);
		updateStatus(ctx);
		const bal = account.balance !== null ? `${account.balance} hc` : "unknown";
		ctx.ui.notify(`HyperCharm balance: ${bal}. ${statusSummary()}`, "info");
		return;
	}

	if (key === "reset" && tokens.length === 1) {
		statusConfig = { ...DEFAULT_STATUS_CONFIG };
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`HyperCharm status reset. ${statusSummary()}`, "info");
		return;
	}

	if ((key === "session" || key === "account") && tokens.length === 2) {
		if (value !== "sidebar" && value !== "widget" && value !== "statusbar" && value !== "off") {
			ctx.ui.notify(STATUS_USAGE, "error");
			return;
		}
		statusConfig[key] = value;
		writeStatusConfig();
		if (value !== "off" && key === "account") {
			// Turning account on: make sure we have data to show
			updateStatusAfter(refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true), ctx);
			void refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined);
		}
		updateStatus(ctx);
		ctx.ui.notify(`HyperCharm ${key} line: ${value}. ${statusSummary()}`, "info");
		return;
	}

	if ((key === "hide" || key === "hideonotherprovider") && tokens.length === 2) {
		if (value !== "true" && value !== "false") {
			ctx.ui.notify(STATUS_USAGE, "error");
			return;
		}
		statusConfig.hideOnOtherProvider = value === "true";
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`HyperCharm status. ${statusSummary()}`, "info");
		return;
	}

	if (key === "lowbalance" && tokens.length === 2) {
		if (value === "off") {
			statusConfig.lowBalanceHc = null;
		} else {
			const n = Number(value);
			if (!Number.isFinite(n) || n <= 0) {
				ctx.ui.notify(STATUS_USAGE, "error");
				return;
			}
			statusConfig.lowBalanceHc = n;
		}
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`HyperCharm status. ${statusSummary()}`, "info");
		return;
	}

	ctx.ui.notify(STATUS_USAGE, "error");
}

async function configureStatusInteractive(ctx: ExtensionContext): Promise<void> {
	const modes = ["sidebar", "widget", "statusbar", "off"] as const;
	const nextMode = (m: string) => modes[(modes.indexOf(m as any) + 1) % modes.length];

	for (;;) {
		const lb = statusConfig.lowBalanceHc === null ? "off" : `${statusConfig.lowBalanceHc} hc`;
		const sessionOpt = `Session line (spend/requests): ${statusConfig.session}`;
		const accountOpt = `Account line (team/balance/rate limits): ${statusConfig.account}`;
		const hideOpt = `Hide on other providers: ${statusConfig.hideOnOtherProvider ? "on" : "off"}`;
		const lbOpt = `Low-balance warning: ${lb}`;
		const refreshOpt = "Refresh balance now";
		const doneOpt = "Done";

		const choice = await ctx.ui.select("HyperCharm footer status", [
			sessionOpt,
			accountOpt,
			hideOpt,
			lbOpt,
			refreshOpt,
			doneOpt,
		]);

		if (choice === undefined || choice === doneOpt) {
			updateStatus(ctx);
			return;
		}
		if (choice === sessionOpt) {
			statusConfig.session = nextMode(statusConfig.session);
			writeStatusConfig();
			continue;
		}
		if (choice === accountOpt) {
			statusConfig.account = nextMode(statusConfig.account);
			writeStatusConfig();
			if (statusConfig.account !== "off") {
				updateStatusAfter(refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true), ctx);
				void refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined);
			}
			continue;
		}
		if (choice === hideOpt) {
			statusConfig.hideOnOtherProvider = !statusConfig.hideOnOtherProvider;
			writeStatusConfig();
			updateStatus(ctx);
			continue;
		}
		if (choice === lbOpt) {
			const presets = ["off", "10", "25", "50", "100", "200", "500"];
			const current = statusConfig.lowBalanceHc === null ? "off" : String(statusConfig.lowBalanceHc);
			const ordered = presets.includes(current) ? presets : [current, ...presets];
			const pick = await ctx.ui.select("Warn at/below balance (hc)", ordered);
			if (pick !== undefined) {
				statusConfig.lowBalanceHc = pick === "off" ? null : Number(pick);
				writeStatusConfig();
				updateStatus(ctx);
			}
			continue;
		}
		if (choice === refreshOpt) {
			metaFetched = false;
			await Promise.all([
				refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true),
				refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined),
			]);
			updateStatus(ctx);
			continue;
		}
	}
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

// The currently-registered model list — starts stale, hot-swapped when the
// live catalog lands. Provider identity funnels through makeProviderConfig so
// the stream handler and models never desync.
let currentModels: JsonModel[] = [];

function makeProviderConfig(models: JsonModel[] = currentModels) {
	return {
		baseUrl: BASE_URL,
		apiKey: "$HYPERCHARM_API_KEY",
		// Custom API name so our streamSimple registers as its own handler and
		// never shadows pi's built-in openai-completions pipeline for other
		// providers. streamHypercharm delegates to pi-ai's OpenAI-compat streamer.
		api: "hypercharm",
		models,
		streamSimple: streamHypercharm,
		oauth: {
			name: "HyperCharm",
			login: (callbacks: OAuthLoginCallbacks) => loginHypercharm(callbacks),
			refreshToken: (credentials: OAuthCredentials, signal?: AbortSignal) => refreshHypercharmToken(credentials, signal),
			getApiKey: (credentials: OAuthCredentials) => String(credentials.access ?? ""),
		},
	};
}

export default function (pi: ExtensionAPI) {
	const embeddedModels = modelsData as JsonModel[];
	const customModels = customModelsData as JsonModel[];
	const patches = patchData as PatchData;
	const deprecated = deprecatedData as DeprecatedData;

	const staleBase = loadStaleModels(embeddedModels, deprecated);
	const staleModels = buildModels(staleBase, customModels, patches, deprecated);
	currentModels = staleModels;

	// Subscribe to sidebar discovery at factory time: Pi completes extension
	// factory initialization before dispatching session lifecycle events, so
	// this observes Atelier's discovery regardless of load order.
	initSidebarPublisher(pi);

	pi.registerProvider(PROVIDER_ID, makeProviderConfig(staleModels));

	pi.registerCommand("hypercharm-status", {
		description: "Configure the HyperCharm footer status (session spend, balance, rate limits)",
		handler: async (args, ctx) => {
			await handleStatusCommand(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const epoch = ++statusEpoch;
		revalidateAbort?.abort();
		revalidateAbort = new AbortController();
		const signal = revalidateAbort.signal;
		statusAbort?.abort();
		statusAbort = new AbortController();
		const statusSignal = statusAbort.signal;

		loadStatusConfig();
		resetStatusState();
		updateStatus(ctx); // clears any carryover; activity-gated, renders nothing yet
		// Re-register so our identity (custom api + streamSimple) always wins
		// over anything that touched provider registration during load.
		pi.registerProvider(PROVIDER_ID, makeProviderConfig());

		resolveApiKey(ctx.modelRegistry).then(() => {
			// A session replacement while the key resolved invalidated the
			// captured ctx (fast-resume, /new, /fork); nothing below may touch it.
			if (epoch !== statusEpoch) return;
			// Prefetch credits/team metadata only when a HyperCharm model is active
			// (pi-neuralwatt also prefetches so the first turn ends with data, but
			// gating here avoids API calls in sessions that never use the provider).
			if (currentProviderId(ctx) === PROVIDER_ID) {
				updateStatusAfter(refreshCredits(cachedApiKey, statusSignal, true), ctx);
				updateStatusAfter(refreshAccountMeta(cachedApiKey, statusSignal), ctx);
			}
			revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
				if (freshBase && epoch === statusEpoch && !signal.aborted) {
					currentModels = buildModels(freshBase, customModels, patches, deprecated);
					pi.registerProvider(PROVIDER_ID, makeProviderConfig());
				}
			});
		});
	});

	pi.on("model_select", (event, ctx) => {
		updateStatus(ctx);
		const model: any = (event as any).model;
		if (model?.provider === PROVIDER_ID && cachedApiKey) {
			updateStatusAfter(refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, false), ctx);
			void refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Ensure every concurrent response tee has landed before committing.
		await settleTeeReaders();
		commitPending(ctx);
		// If the session_start/model_select credits fetch raced or failed, retry
		// once we have real activity so the very first turn shows the balance.
		if (sessionStats.requests > 0 && account.balance === null) {
			await refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, false);
		}
		updateStatus(ctx);
	});

	// agent_settled (not agent_end): fires only when no automatic retry,
	// compaction, or queued continuation can follow — the one moment polling
	// /v1/credits is both fresh and not redundant. Gated on session activity
	// so sessions without HyperCharm turns make zero API calls here.
	pi.on("agent_settled", async (_event, ctx) => {
		if (sessionStats.requests > 0 || sessionStats.spendHc > 0) {
			await refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, false);
			if (!metaFetched) await refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined);
			updateStatus(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		revalidateAbort?.abort();
		statusAbort?.abort();
		ctx.ui.setStatus(STATUS_KEY_SESSION, undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		publisher().withdraw();
	});
}
