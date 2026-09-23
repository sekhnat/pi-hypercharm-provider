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
 *   Lifecycle (mirrors pi-neuralwatt-provider): the footer widget/status bar
 *   render nothing before this session's first HyperCharm turn completes, so
 *   fresh sessions and other providers' sessions see no half-empty line; the
 *   Atelier sidebar panel instead publishes as soon as a HyperCharm model is
 *   active, with a placeholder row until real data lands. Credits/team are prefetched
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
 * Fabric Child Accounting Mode (pi-fabric integration):
 *   pi-fabric spawns agents (workflow workers, trajectory handoffs, persistent
 *   actors) as separate `pi --mode rpc` children carrying a PI_FABRIC_* env
 *   envelope (PI_FABRIC_PARENT_RUN, PI_FABRIC_MAIN_AGENT_ID lineage,
 *   PI_FABRIC_AGENT_NAME, PI_FABRIC_ACTOR_ID/NAME). Two modes:
 *
 *   - Child mode (envelope present): the per-request usage tee runs as usual,
 *     but the child makes no status-related account requests (no /credits,
 *     /teams, /devices — no prefetch, no agent_settled poll, no 402 refresh).
 *     At each committed turn with observed usage it appends one JSONL record
 *     (requests, hypercredit spend, latest rate-limit snapshot, out-of-credits
 *     flag) to the daily shard <agentDir>/cache/hypercharm-usage-YYYYMMDD.jsonl
 *     (the shard prefix is identity.ts's LEDGER_SHARD_PREFIX; the record shape
 *     is ledger.ts's, version-stamped). Write failures warn once, never throw.
 *
 *   - Parent mode: the render path reads the current and previous day's
 *     shards (mtime-cached), filters records by its own lineage key
 *     `session:` + session id — the same derivation fabric uses, so a
 *     replaced session starts clean — and rolls them up per agent. The
 *     sidebar panel gains an agent block (summary + capped per-agent rows +
 *     overflow) after the session rows; the widget/statusbar session line
 *     gains a compact agent atom with its own width-compaction tiers. Agent
 *     spend counts as session activity for the show-after-activity gate.
 *     Shards past a 7-day retention are unlinked best-effort at session start.
 *
 *   Drift-window reconciliation: observing a fabric_exec tool execution arms
 *   a window whose timer (on the credits-throttle cadence, 15 s) re-reads the
 *   ledger; new records refresh the balance within the existing throttle,
 *   merge the newest child rate snapshot, and re-render. The window extends
 *   on activity, disarms after 5 minutes of ledger silence, and is torn down
 *   on session replacement via the status epoch. A record carrying the 402
 *   flag fires the existing out-of-credits notification once per session and
 *   forces a balance refresh. Sessions that never see fabric_exec run no
 *   timer and make no extra calls; childless non-fabric behavior is unchanged.
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
 *     "lowBalanceHc": 25,             // warn threshold, null/false disables
 *     "glyphs": "auto"                // "auto" | "unicode" | "ascii"
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
 *     /hypercharm-status glyphs auto|unicode|ascii
 *
 *   - glyphs "auto" swaps the emoji footer glyphs for ASCII on legacy
 *     terminals (mintty/Cygwin), whose cell-width tables disagree with the
 *     width math and wrap the full-width widget line. "unicode"/"ascii"
 *     force a set. The widget never paints the terminal's last column, and
 *     clamps an explicit "unicode" to ASCII on legacy terminals; the
 *     statusbar is not edge-padded and honors the exact choice.
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

import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { HYPER_API_URL, PI_DEVICE_NAME } from "./hyper";
import {
	API_KEY_ENV,
	API_KEY_PLACEHOLDER,
	API_NAME,
	CACHE_FILE_NAME,
	CONFIG_FILE_NAME,
	PRISM_ENTRY_TYPE,
	PROVIDER_ID,
	STATUS_COMMAND,
	STATUS_KEY_ACCOUNT,
	STATUS_KEY_SESSION,
	WIDGET_KEY,
} from "./identity";
import { createNotifier } from "./notify";
import { prismRouteFromHeaders, prismRouteLabel, readPrismRoute, type PrismRoute } from "./prism";
import {
	aggregateLineage,
	currentShardNames,
	EMPTY_LINEAGE_USAGE,
	expiredShardNames,
	LEDGER_RECORD_VERSION,
	parseLedgerRecord,
	serializeLedgerRecord,
	shardFileName,
	type LineageUsage,
	type UsageLedgerRecord,
} from "./ledger";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import { createAccountRuntime, CREDITS_MIN_INTERVAL_MS } from "./account";
import { createHypercharmProvider } from "./provider";
import { embeddedCatalogHash, parseModelsCache, type DeprecatedData, type JsonModel } from "./model-catalog";
import {
	applyOptimisticSpend,
	buildAccountTiers,
	buildSessionLine,
	buildSessionLineWithAgents,
	buildSidebarPanel,
	coerceStatusConfig,
	DEFAULT_STATUS_CONFIG,
	EMPTY_ACCOUNT,
	EMPTY_SESSION_STATS,
	StatusLineWidget,
	accountHasData,
	resolveGlyphSet,
	resolveWidgetGlyphSet,
	type AccountState,
	type SessionStats,
	type GlyphSet,
	type StatusConfig,
} from "./status";
import { createSidebarUsagePublisher, type EventTransport, type SidebarUsagePublisher } from "./sidebar";
import fs from "fs";
import path from "path";

const openAICompletions = openAICompletionsApi();

// ─── Types ────────────────────────────────────────────────────────────────────

// Warning sink for fetch/parse failures: deduplicated, routed to the session UI
// once one is active, stderr before that. Warnings must never throw.
const notifier = createNotifier();

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ─── Model Catalog Sources ────────────────────────────────────────────────────
// Pi's standard model store is the primary persisted catalog (owned by the
// complete provider in provider.ts). The namespaced legacy cache below is a
// READ-ONLY compatibility input: it seeds the initial snapshot for rollback
// safety, and new successful refreshes persist only through pi.

const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, CACHE_FILE_NAME);
const EMBEDDED_HASH = embeddedCatalogHash(modelsData as JsonModel[]);

/**
 * Read the namespaced legacy cache. The flag says whether this release's
 * embedded curation wins shared ids (hash mismatch / legacy bare-array cache):
 * shipped curated fixes are never masked by stale on-disk data either way.
 */
function loadLegacyCache(): { models: JsonModel[]; preferEmbedded: boolean } | null {
	try {
		const parsed = parseModelsCache(JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")));
		if (parsed === null || parsed.models.length === 0) {
			if (parsed === null) notifier.warn(`Ignoring malformed HyperCharm model cache at ${CACHE_PATH}.`);
			return null;
		}
		return { models: parsed.models, preferEmbedded: parsed.embeddedHash !== EMBEDDED_HASH };
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			notifier.warn(`Ignoring unreadable HyperCharm model cache at ${CACHE_PATH}: ${describeError(err)}.`);
		}
		return null;
	}
}

// ─── Status Display Configuration ──────────────────────────────────────────────

const CONFIG_PATH = path.join(getAgentDir(), "extensions", CONFIG_FILE_NAME);

let statusConfig: StatusConfig = { ...DEFAULT_STATUS_CONFIG };

function loadStatusConfig(): StatusConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		statusConfig = coerceStatusConfig(raw);
	} catch (err) {
		// A missing file is normal; anything else is worth surfacing once.
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			notifier.warn(`Ignoring unreadable HyperCharm status config at ${CONFIG_PATH}: ${describeError(err)} — using defaults.`);
		}
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
		raw.hideAuthExpiry = statusConfig.hideAuthExpiry;
		raw.lowBalanceHc = statusConfig.lowBalanceHc;
		raw.glyphs = statusConfig.glyphs;
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
	} catch (err) {
		// Non-fatal: the in-memory config still applies to this session.
		notifier.warn(`Could not save the HyperCharm status config to ${CONFIG_PATH}: ${describeError(err)}.`);
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
let pendingRateSnapshot: UsageLedgerRecord["rate"] | undefined;
let outOfCreditsNotified = false;
let widgetGlyphClampNotified = false;

// ─── Fabric Child Accounting Mode ─────────────────────────────────────────────
// pi-fabric spawns agents as separate `pi --mode rpc` children carrying a
// PI_FABRIC_* env envelope. A child keeps the per-request usage tee but has no
// UI: it appends its committed turns to the shared usage ledger (attributed to
// the spawning session's lineage) instead of prefetching account state, and
// the parent reads those shards back. All env reads are guarded — a fabric
// upgrade that renames the envelope degrades to today's behavior.

/** Ledger retention window (days) for parent-side GC of old shards. */
const LEDGER_RETENTION_DAYS = 7;

/** Fabric child mode: the child knows its spawning run. undefined at the top
 * level — a non-child process never writes ledger records. */
function fabricChildEnv(env: NodeJS.ProcessEnv = process.env): {
	parentRun: string;
	lineage: string;
	agentName: string | undefined;
	actorId: string | undefined;
	actorName: string | undefined;
} | undefined {
	const parentRun = env.PI_FABRIC_PARENT_RUN;
	const lineage = env.PI_FABRIC_MAIN_AGENT_ID;
	if (typeof parentRun !== "string" || parentRun.length === 0) return undefined;
	if (typeof lineage !== "string" || lineage.length === 0) return undefined;
	const agentName = typeof env.PI_FABRIC_AGENT_NAME === "string" && env.PI_FABRIC_AGENT_NAME.length > 0 ? env.PI_FABRIC_AGENT_NAME : undefined;
	const actorId = typeof env.PI_FABRIC_ACTOR_ID === "string" && env.PI_FABRIC_ACTOR_ID.length > 0 ? env.PI_FABRIC_ACTOR_ID : undefined;
	const actorName = typeof env.PI_FABRIC_ACTOR_NAME === "string" && env.PI_FABRIC_ACTOR_NAME.length > 0 ? env.PI_FABRIC_ACTOR_NAME : undefined;
	return { parentRun, lineage, agentName, actorId, actorName };
}

// Child state is read lazily (per event), not cached at module load: the env
// envelope is process-lifetime constant, but lazy reads keep the detection
// honest under test harnesses that set the env after module import.
function fabricChild() {
	return fabricChildEnv();
}

function isFabricChild(): boolean {
	return fabricChild() !== undefined;
}

// Ledger shards live under the agent cache dir, resolved per call (not at
// module load) so test harnesses that redirect PI_CODING_AGENT_DIR after
// import observe a consistent world — and so a runtime agent-dir change is
// honored the same way the models cache is not.
function ledgerDir(): string {
	return path.join(getAgentDir(), "cache");
}
let ledgerWriteWarned = false;

/** Append one record as a single line to the day's shard. POSIX O_APPEND makes
 * a single write atomic against concurrent child appenders. Write failures
 * warn once through the notifier and never throw. */
function appendLedgerRecord(record: UsageLedgerRecord): void {
	try {
		const dir = ledgerDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, shardFileName(new Date(record.ts))), serializeLedgerRecord(record) + "\n");
		ledgerWriteWarned = false;
	} catch (err) {
		if (!ledgerWriteWarned) {
			ledgerWriteWarned = true;
			notifier.warn(`Unable to append to the HyperCharm usage ledger: ${describeError(err)}.`);
		}
	}
}

/** Best-effort GC: unlink shards past retention at session start. Failures
 * (including ENOENT races) are silent — removal is an optimization. */
function gcLedgerShards(now: Date): void {
	for (const name of expiredShardNames(now, LEDGER_RETENTION_DAYS)) {
		try {
			fs.unlinkSync(path.join(ledgerDir(), name));
		} catch {
			// Silent by design: a shard another process already removed or an
			// unreadable directory must not break startup.
		}
	}
}

/** Read one shard; missing files are normal (silent), anything else warns once. */
function readLedgerShard(name: string): UsageLedgerRecord[] {
	const shardPath = path.join(ledgerDir(), name);
	let content: string;
	try {
		content = fs.readFileSync(shardPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			notifier.warn(`Unable to read the HyperCharm usage ledger shard ${name}: ${describeError(err)}.`);
		}
		return [];
	}
	const records: UsageLedgerRecord[] = [];
	for (const line of content.split("\n")) {
		if (line.length === 0) continue;
		const record = parseLedgerRecord(line);
		if (record) records.push(record);
	}
	return records;
}

/** mtime+size cache so the render path re-reads only shards that changed. */
const shardReadCache = new Map<string, { mtimeMs: number; size: number; records: UsageLedgerRecord[] }>();

/**
 * Read the current and previous day's shards (mtime-cached), returning every
 * valid record. Missing shards are silent; malformed lines warn once via the
 * ledger module's parse contract (they are skipped, never fatal).
 */
function readLedgerRecords(now: Date): UsageLedgerRecord[] {
	const records: UsageLedgerRecord[] = [];
	for (const name of currentShardNames(now)) {
		const shardPath = path.join(ledgerDir(), name);
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(shardPath);
		} catch {
			// Missing shard: a normal empty day.
		}
		if (!stat) continue;
		const cached = shardReadCache.get(name);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			records.push(...cached.records);
			continue;
		}
		const shardRecords = readLedgerShard(name);
		shardReadCache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, records: shardRecords });
		records.push(...shardRecords);
	}
	// Shards that rotated out of the read window stop being cached.
	for (const name of [...shardReadCache.keys()]) {
		if (!currentShardNames(now).includes(name)) shardReadCache.delete(name);
	}
	return records;
}

/** The parent's lineage key — the same derivation fabric uses for roots. */
function parentLineageKey(ctx: ExtensionContext): string {
	try {
		return `session:${ctx.sessionManager.getSessionId()}`;
	} catch {
		return "";
	}
}

/** Aggregated lineage usage for the render path (empty without a key). */
function lineageUsageFor(ctx: ExtensionContext): LineageUsage {
	const lineage = parentLineageKey(ctx);
	if (lineage.length === 0) return EMPTY_LINEAGE_USAGE;
	return aggregateLineage(readLedgerRecords(new Date()), lineage);
}

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
	// The latest snapshot of the turn rides the child's ledger record.
	pendingRateSnapshot = rate;
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
	// The complete provider resolves auth per request (stored key over
	// HYPERCHARM_API_KEY) and hands it to us through options.apiKey.
	const apiKey = (options as any)?.apiKey || "";
	if (!apiKey) {
		throw new Error(
			`No API key for HyperCharm. Add it to ~/.pi/agent/auth.json, ` +
			`set ${API_KEY_ENV} env var, or use --api-key.`,
		);
	}

	const hyperModel = { ...model, api: "openai-completions", baseUrl: model.baseUrl || HYPER_API_URL };

	// Per-request fetch wrapper: owns its interceptor, safe under concurrency.
	const upstreamFetch = options?.fetch ?? globalThis.fetch;
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

	return openAICompletions.streamSimple(hyperModel, context, {
		...options,
		fetch: metaFetch,
		apiKey,
	});
}

// ─── Credential-Scoped Account Runtime ────────────────────────────────────────
// Balance, team, and device-session acquisition lives in account.ts. This
// module only wires lifecycle triggers to it and renders committed snapshots:
// the runtime owns auth resolution, credential epochs, coalescing, staged
// first sweeps, and per-endpoint backoff (specs/account-status-refresh).

// Bumped on every session_start; async continuations compare against this to
// drop renders belonging to a replaced session (its ctx is stale and throws).
let statusEpoch = 0;

/** Latest session context; the runtime's credential resolver reads through it. */
let accountCtx: ExtensionContext | undefined;

async function resolveAccountCredential(): Promise<string | undefined> {
	const ctx = accountCtx;
	if (!ctx) return undefined;
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
		return auth?.auth.apiKey;
	} catch {
		return undefined; // stale ctx after a session replacement
	}
}

const accountRuntime = createAccountRuntime({
	resolveCredential: resolveAccountCredential,
	warn: (message) => notifier.warn(message),
	deviceName: PI_DEVICE_NAME,
});

/** Copy committed, attributed atoms into the display state. Rate-limit state
 * stays here: it comes from chat-completion headers, not these endpoints. */
function syncAccountFromRuntime(): void {
	const snap = accountRuntime.snapshot();
	if (snap.key === undefined) return;
	account.balance = snap.balance;
	account.teamName = snap.teamName;
	account.authDaysLeft = snap.authDaysLeft;
}

/** One account refresh; resolves when this invocation's eligible work settles. */
function accountRefresh(force: boolean): Promise<void> {
	return accountRuntime.refresh({ force }).then(syncAccountFromRuntime);
}

// (Endpoint fetching moved to account.ts — see the runtime above.)

// ─── Drift-Window Reconciliation ──────────────────────────────────────────────
// Armed by a fabric_exec tool execution; while armed, a timer re-reads the
// ledger on the credits-throttle cadence and refreshes the balance when child
// records arrived. Session-scoped: torn down on session replacement via the
// status epoch. Sessions that never observe fabric_exec run no timer here.

/** Ledger silence that disarms the parent's drift window. */
const DRIFT_WINDOW_QUIET_MS = 5 * 60_000;

let driftTimer: NodeJS.Timeout | null = null;
/** Injectable for tests; defaults to the credits-throttle cadence. Tests may
 * shorten it via the same globalThis seam the atelier fixture uses. */
let driftTickMs = CREDITS_MIN_INTERVAL_MS;
const driftTickOverride = (globalThis as { __hypercharmDriftTickMs?: unknown }).__hypercharmDriftTickMs;
if (typeof driftTickOverride === "number" && Number.isFinite(driftTickOverride) && driftTickOverride > 0) {
	driftTickMs = driftTickOverride;
}

function stopDriftWindow(): void {
	if (driftTimer !== null) {
		clearInterval(driftTimer);
		driftTimer = null;
	}
}

function armDriftWindow(ctx: ExtensionContext): void {
	if (isFabricChild() || statusConfig.account === "off" || driftTimer !== null) return;
	const epoch = statusEpoch;
	const armedAt = Date.now();
	let lastRecordCount = -1;
	let lastSeenSpend: number | null = null;
	driftTimer = setInterval(() => {
		if (epoch !== statusEpoch) {
			stopDriftWindow();
			return;
		}
		try {
			const usage = lineageUsageFor(ctx);
			if (usage.summary.agents === 0) {
				// No records for this lineage yet; nothing to watch. The window
				// stays armed until the quiet period measured from the latest
				// record (or arm time) elapses.
				if (usage.latestTs === undefined && Date.now() - armedAt > DRIFT_WINDOW_QUIET_MS) {
					stopDriftWindow();
				}
				return;
			}
			const hadNewRecords =
				usage.summary.requests !== lastRecordCount || usage.summary.spendHc !== lastSeenSpend;
			if (hadNewRecords) {
				lastRecordCount = usage.summary.requests;
				lastSeenSpend = usage.summary.spendHc;
				// Throttled refresh: new child spend moves the balance within the
				// existing credits cadence, no forced call.
				void accountRefresh(false).then(() => updateStatus(ctx));
			}
			if (usage.latestRate && (!account.rate || usage.latestRate.capturedAt >= account.rate.capturedAt)) {
				// Merge the newest child-observed snapshot into account state
				// (newest-wins by capturedAt; field validation happened at parse).
				account.rate = usage.latestRate;
			}
			if (usage.outOfCredits && !outOfCreditsNotified) {
				outOfCreditsNotified = true;
				if (ctx.hasUI) {
					try {
						ctx.ui.notify("HyperCharm is out of Hypercredits — recharge at hyper.charm.land", "error");
					} catch (err) {
						if (!isStaleCtxError(err)) throw err;
					}
				}
				void accountRefresh(true).then(() => updateStatus(ctx));
			}
			if (usage.latestTs !== undefined && Date.now() - usage.latestTs > DRIFT_WINDOW_QUIET_MS) {
				stopDriftWindow();
				updateStatus(ctx);
				return;
			}
			updateStatus(ctx);
		} catch (err) {
			if (!isStaleCtxError(err)) throw err;
		}
	}, driftTickMs);
	driftTimer.unref?.();
}

// ─── Status Rendering ─────────────────────────────────────────────────────────


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
	sidebarPublisher = createSidebarUsagePublisher(pi.events, "hypercharm:usage", {
		onCompatibilityChange: () => {
			// Factory subscriptions outlive session initialization; re-route any
			// fallback rendered before Atelier's asynchronous discovery arrived.
			if (accountCtx) updateStatus(accountCtx);
		},
	});
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
	// Lineage aggregation (fabric children's committed turns). Reads the
	// current+previous day's shards with an mtime cache — cheap enough for
	// every render trigger, no new event subscriptions needed.
	const lineage = lineageUsageFor(ctx);
	const hasAgentUsage = lineage.summary.agents > 0;
	// Agent spend counts as session activity: a session whose fabric children
	// spend while it idles still renders its session line (and becomes
	// eligible for the account line) instead of staying hidden.
	const hasAnyActivity = hasActivity || hasAgentUsage;
	// Legacy terminals measure these glyphs with their own cell tables; the
	// widget clamps to ASCII there, the statusbar keeps the explicit choice.
	const glyphs = resolveGlyphSet(statusConfig.glyphs);
	const widgetGlyphs = resolveWidgetGlyphSet(statusConfig.glyphs);
	const widgetClamped = widgetGlyphs !== glyphs;
	if (widgetClamped && !widgetGlyphClampNotified && ctx.hasUI) {
		widgetGlyphClampNotified = true;
		ctx.ui.notify("HyperCharm: widget glyphs stay ASCII on this terminal — unicode glyphs overflow legacy mintty/Cygwin cell widths. Statusbar is unaffected.", "info");
	}
	// Show only after HyperCharm activity this session (like pi-neuralwatt):
	// no empty-gap line on fresh sessions, no stale account glare on other
	// providers' sessions.
	const accountVisible = statusConfig.account !== "off" && accountHasData(account) && hasAnyActivity;
	const lowBalance =
		statusConfig.lowBalanceHc !== null && account.balance !== null && account.balance <= statusConfig.lowBalanceHc;
	const sessionLine =
		statusConfig.session !== "off" ? buildSessionLineWithAgents(sessionStats, lineage, glyphs) : undefined;
	// Width-compaction tiers for the widget path: the agent atom compresses to
	// count-only and drops before the session's own atoms as space runs out.
	const atomHasSpend = lineage.summary.spendHc > 0;
	const sessionLineFull =
		statusConfig.session !== "off" ? buildSessionLineWithAgents(sessionStats, lineage, glyphs, "full") : undefined;
	const sessionLineCount =
		statusConfig.session !== "off" ? buildSessionLineWithAgents(sessionStats, lineage, glyphs, "count") : undefined;
	const sessionLineNone =
		statusConfig.session !== "off" ? buildSessionLineWithAgents(sessionStats, lineage, glyphs, "none") : undefined;
	const accTiers = accountVisible ? buildAccountTiers(account, lowBalance, glyphs, { hideAuthExpiry: statusConfig.hideAuthExpiry }) : [];
	const sessionLineW = widgetClamped && statusConfig.session !== "off" ? sessionLineFull : sessionLine;
	const accTiersW =
		widgetClamped && accountVisible ? buildAccountTiers(account, lowBalance, widgetGlyphs, { hideAuthExpiry: statusConfig.hideAuthExpiry }) : accTiers;

	// Sidebar panel: parts targeted at "sidebar" publish here whenever a
	// compatible host is present and a HyperCharm model is active — panel
	// visibility follows model selection, not session activity, so the panel
	// loads the moment a HyperCharm model is selected and a placeholder row
	// covers the idle window before any usage data lands. The legacy
	// hideOnOtherProvider option governs only widget/statusbar. Without a
	// compatible host, sidebar parts fall back to the widget below. Each
	// metric lands in exactly one destination because routing switches on the
	// part's mode (buildSidebarPanel enforces this).
	const sidebarCompatible = publisher().isCompatible() && isHyperCharmActive;
	const panel = buildSidebarPanel({
		compatible: publisher().isCompatible(),
		isProviderActive: isHyperCharmActive,
		sessionMode: statusConfig.session,
		accountMode: statusConfig.account,
		sessionStats,
		account,
		lowBalance,
		hideAuthExpiry: statusConfig.hideAuthExpiry,
		lineage,
	}, glyphs);
	if (panel.publish) {
		publisher().update({
			id: "hypercharm:usage",
			title: "HyperCharm",
			rows: panel.rows,
			defaults: { visible: true, after: "usage" },
		});
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
		ctx.ui.setStatus(STATUS_KEY_SESSION, ctx.ui.theme.fg(lowBalance ? "warning" : "dim", `${sBar} ${glyphs.sep} ${aBar}`));
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
	} else {
		ctx.ui.setStatus(STATUS_KEY_SESSION, sBar ? ctx.ui.theme.fg("dim", sBar) : undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, aBar ? ctx.ui.theme.fg(lowBalance ? "warning" : "dim", aBar) : undefined);
	}

	// Below-editor widget (two-zone, width-aware). Sidebar parts route here as
	// their fallback when no compatible host is present; a sidebar part with a
	// compatible host must not duplicate into the widget. The left side keeps
	// progressive agent-atom compaction: full atom → count-only → session's
	// own atoms only — the StatusLineWidget picks the first that fits.
	const widgetWantsSession =
		statusConfig.session === "widget" || (statusConfig.session === "sidebar" && !sidebarCompatible);
	const leftW = widgetWantsSession ? sessionLineW : undefined;
	const leftTiers = widgetWantsSession
		? [sessionLineFull, sessionLineCount, sessionLineNone].filter((s): s is string => s !== undefined)
		: [];
	const rightW =
		(statusConfig.account === "widget" || (statusConfig.account === "sidebar" && !sidebarCompatible)) &&
		accountVisible
			? accTiersW
			: undefined;
	if (leftTiers.length > 0 || (rightW !== undefined && rightW.length > 0)) {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui: any, theme: any) => new StatusLineWidget(theme, leftTiers, rightW ?? [], lowBalance, widgetGlyphs),
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
	pendingRateSnapshot = undefined;
	outOfCreditsNotified = false;
	// Account fetch state (throttles, in-flight work, retry gates) is owned by
	// the credential-scoped runtime; the committed snapshot survives the
	// session under its original attribution and is re-synced on session start.
	// A replaced session's drift window dies with its epoch on the next tick;
	// stopping here keeps the old timer from observing a fresh session's key.
	stopDriftWindow();
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

	// Fabric children report their committed spend to the shared ledger (one
	// single-line append per turn); the parent-side account refreshes below
	// are skipped — the out-of-credits fact travels in the record instead.
	const child = fabricChild();
	if (child !== undefined) {
		const record: UsageLedgerRecord = {
			v: LEDGER_RECORD_VERSION,
			lineage: child.lineage,
			agentId: child.actorId ?? child.parentRun,
			agentName: child.actorName ?? child.agentName ?? child.parentRun,
			ts: Date.now(),
			requests: pendingRequests,
			spendHc: pendingSpendHc,
			...(pendingRateSnapshot ? { rate: pendingRateSnapshot } : {}),
			...(pendingSawOutOfCredits ? { outOfCredits: true } : {}),
		};
		appendLedgerRecord(record);
		pendingRequests = 0;
		pendingSpendHc = 0;
		pendingSawUsage = false;
		pendingSawOutOfCredits = false;
		pendingRateSnapshot = undefined;
		return;
	}

	pendingRequests = 0;
	pendingSpendHc = 0;
	pendingSawUsage = false;

	if (pendingSawOutOfCredits) {
		pendingSawOutOfCredits = false;
		// Re-fetch now so the balance reflects exhaustion immediately
		updateStatusAfter(accountRefresh(true), ctx);
		if (!outOfCreditsNotified && ctx.hasUI) {
			outOfCreditsNotified = true;
			ctx.ui.notify("HyperCharm is out of Hypercredits — recharge at hyper.charm.land", "error");
		}
	}
}

// ─── Status Command ────────────────────────────────────────────────────────────

function statusSummary(): string {
	const lb = statusConfig.lowBalanceHc === null ? "off" : `${statusConfig.lowBalanceHc}`;
	return `session=${statusConfig.session}, account=${statusConfig.account}, hideOnOtherProvider=${statusConfig.hideOnOtherProvider}, hideAuthExpiry=${statusConfig.hideAuthExpiry}, lowBalanceHc=${lb}, glyphs=${statusConfig.glyphs}`;
}

const STATUS_USAGE =
	`Usage: /${STATUS_COMMAND} [session|account sidebar|widget|statusbar|off · hide true|false · authexpiry true|false · lowBalance <hc>|off · glyphs auto|unicode|ascii · refresh · reset]`;

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
		// Explicit user refresh: bypasses the automatic retry gates while still
		// coalescing with compatible in-flight work (specs/account-status-refresh).
		await accountRefresh(true);
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
			updateStatusAfter(accountRefresh(true), ctx);
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

	if (key === "authexpiry" && tokens.length === 2) {
		if (value !== "true" && value !== "false") {
			ctx.ui.notify(STATUS_USAGE, "error");
			return;
		}
		statusConfig.hideAuthExpiry = value === "true";
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

	if (key === "glyphs" && tokens.length === 2) {
		if (value !== "auto" && value !== "unicode" && value !== "ascii") {
			ctx.ui.notify(STATUS_USAGE, "error");
			return;
		}
		statusConfig.glyphs = value;
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
	const glyphModes = ["auto", "unicode", "ascii"] as const;
	const nextGlyphMode = () => glyphModes[(glyphModes.indexOf(statusConfig.glyphs as any) + 1) % glyphModes.length];

	for (;;) {
		const lb = statusConfig.lowBalanceHc === null ? "off" : `${statusConfig.lowBalanceHc} hc`;
		const sessionOpt = `Session line (spend/requests): ${statusConfig.session}`;
		const accountOpt = `Account line (team/balance/rate limits): ${statusConfig.account}`;
		const hideOpt = `Hide on other providers: ${statusConfig.hideOnOtherProvider ? "on" : "off"}`;
		const authExpiryOpt = `Hide auth expiry: ${statusConfig.hideAuthExpiry ? "on" : "off"}`;
		const lbOpt = `Low-balance warning: ${lb}`;
		const glyphOpt = `Glyphs (legacy terminals): ${statusConfig.glyphs}`;
		const refreshOpt = "Refresh balance now";
		const doneOpt = "Done";

		const choice = await ctx.ui.select("HyperCharm footer status", [
			sessionOpt,
			accountOpt,
			hideOpt,
			authExpiryOpt,
			lbOpt,
			glyphOpt,
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
				updateStatusAfter(accountRefresh(true), ctx);
			}
			continue;
		}
		if (choice === hideOpt) {
			statusConfig.hideOnOtherProvider = !statusConfig.hideOnOtherProvider;
			writeStatusConfig();
			updateStatus(ctx);
			continue;
		}
		if (choice === authExpiryOpt) {
			statusConfig.hideAuthExpiry = !statusConfig.hideAuthExpiry;
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
		if (choice === glyphOpt) {
			statusConfig.glyphs = nextGlyphMode();
			writeStatusConfig();
			updateStatus(ctx);
			continue;
		}
		if (choice === refreshOpt) {
			await accountRefresh(true);
			updateStatus(ctx);
			continue;
		}
	}
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Prism routing state: collected per assistant request, committed at turn_end.
	let collectingPrismRoute = false;
	let prismRoute: PrismRoute | undefined;

	// Subscribe at factory time so Atelier's later session_start discovery is
	// observed regardless of extension load order. Discovery can arrive after
	// our first render; the compatibility callback then clears the fallback.
	initSidebarPublisher(pi);

	// The complete hypercharm provider registers ONCE at factory time: it owns
	// authentication (stored key over HYPERCHARM_API_KEY, lazily loaded OAuth),
	// the current curated catalog snapshot, pi-store restore/refresh, and the
	// namespaced streamSimple interceptor. Session events no longer re-register
	// anything (specs/model-catalog).
	pi.registerProvider(
		createHypercharmProvider({
			embeddedModels: modelsData as JsonModel[],
			customModels: customModelsData as JsonModel[],
			patch: patchData,
			deprecated: deprecatedData as unknown as DeprecatedData,
			loadLegacyCache,
			warn: (message) => notifier.warn(message),
			streamSimple: streamHypercharm,
		}),
	);

	pi.registerCommand(STATUS_COMMAND, {
		description: "Configure the HyperCharm footer status (session spend, balance, rate limits)",
		handler: async (args, ctx) => {
			await handleStatusCommand(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		notifier.activate(ctx);
		++statusEpoch;
		accountCtx = ctx;
		// A replaced session invalidates the previous one's account leases and
		// aborts its in-flight work; the committed snapshot is retained under
		// its original credential attribution.
		accountRuntime.deactivate();

		loadStatusConfig();
		resetStatusState();
		// Parent-side GC of shards past retention (best-effort, silent).
		if (!isFabricChild()) gcLedgerShards(new Date());
		updateStatus(ctx); // clears carryover; publishes the panel when a HyperCharm model is active
		// Prefetch account metadata only when a HyperCharm model is active, so
		// sessions that never use the provider make zero account calls. Fabric
		// children skip it: no UI, and the ledger record carries the facts home.
		if (!isFabricChild() && currentProviderId(ctx) === PROVIDER_ID) {
			updateStatusAfter(accountRefresh(true), ctx);
		}
	});

	pi.on("model_select", (event, ctx) => {
		updateStatus(ctx);
		const model: any = (event as any).model;
		if (model?.provider !== PROVIDER_ID) {
			// Switching away invalidates pending HyperCharm account work: no late
			// status may render for another provider (specs/account-status-refresh).
			accountRuntime.deactivate();
			return;
		}
		// Child mode: no account prefetches (see session_start).
		if (!isFabricChild()) {
			updateStatusAfter(accountRefresh(false), ctx);
		}
	});

	// fabric_exec observed: a fabric agent is about to run under this session.
	// Arm the drift window so the account line tracks the children's ledger
	// records while they work. Zero timers/calls for sessions that never see
	// one, and none in child mode (children don't spawn fabric agents).
	pi.on("tool_execution_start", (event, ctx) => {
		if ("toolName" in event && event.toolName === "fabric_exec") {
			armDriftWindow(ctx);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Ensure every concurrent response tee has landed before committing.
		await settleTeeReaders();
		commitPending(ctx);
		// If the session_start/model_select credits fetch raced or failed, retry
		// once we have real activity so the very first turn shows the balance.
		// Child mode never fetches account state (the record carries the facts).
		if (!isFabricChild() && sessionStats.requests > 0 && account.balance === null) {
			await accountRefresh(false);
		}
		updateStatus(ctx);
	});

	// agent_settled (not agent_end): fires only when no automatic retry,
	// compaction, or queued continuation can follow — the one moment polling
	// /v1/credits is both fresh and not redundant. Gated on session activity
	// so sessions without HyperCharm turns make zero API calls here. Child
	// mode never polls: no UI, and the parent reconciles from the ledger.
	pi.on("agent_settled", async (_event, ctx) => {
		if (isFabricChild()) return;
		if (sessionStats.requests > 0 || sessionStats.spendHc > 0) {
			await accountRefresh(false);
			updateStatus(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// Abort this session's account work and invalidate its leases. The
		// runtime itself lives for the process (like the catalog snapshot), so a
		// later session in the same process keeps its last-known account data.
		accountRuntime.deactivate();
		stopDriftWindow();
		ctx.ui.setStatus(STATUS_KEY_SESSION, undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		publisher().withdraw();
	});

	// Prism routing: Hyper's edge reports which upstream model actually served the
	// assistant request via response headers. Collection is scoped to that request
	// so auxiliary calls between turns cannot leak a route into the transcript,
	// and the route lands at turn_end as a durable session entry — never a
	// notification — so it survives reopening the session.
	pi.registerEntryRenderer(PRISM_ENTRY_TYPE, (entry, _options, theme) => {
		const route = readPrismRoute(entry.data);
		const label = route ? prismRouteLabel(route) : undefined;
		if (label === undefined) return undefined;
		return new Text(`${theme.fg("muted", "Prism")} ${theme.fg("dim", "→")} ${theme.fg("muted", label)}`, 0, 0);
	});

	pi.on("turn_start", () => {
		collectingPrismRoute = true;
		prismRoute = undefined;
	});

	pi.on("after_provider_response", (event) => {
		if (!collectingPrismRoute) return;
		prismRoute = prismRouteFromHeaders(event.headers);
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") collectingPrismRoute = false;
	});

	pi.on("turn_end", (event) => {
		const route = prismRoute;
		prismRoute = undefined;
		collectingPrismRoute = false;
		if (route === undefined) return;
		if (event.message.role !== "assistant") return;
		if (event.message.provider !== PROVIDER_ID) return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		pi.appendEntry(PRISM_ENTRY_TYPE, route);
	});

}
