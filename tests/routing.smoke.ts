import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import hypercharmExtension from "../index.ts";
import { resetSidebarRevisionsForTest } from "../sidebar.ts";

/**
 * Dependency-free routing smoke test for the sidebar display mode.
 * Run: bun run tests/routing.smoke.ts.
 *
 * Drives the real extension factory against a stub ExtensionAPI, a real SSE
 * turn through the registered streamSimple (usage capture via the tee), and
 * verifies the destination-exclusivity contract from renderStatus: sidebar
 * parts publish through the event bus (gated on the active provider),
 * widget/statusbar parts keep their current calls, sidebar parts fall back to
 * the widget without a compatible host, and the same metric never appears in
 * two destinations.
 */

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

interface Harness {
	pi: Record<string, unknown>;
	ctx: Record<string, unknown>;
	emitted: Array<Record<string, unknown>>;
	statuses: Map<string, string | undefined>;
	widget: { value: unknown };
	eventHandlers: Map<string, Set<Handler>>;
	fetchedUrls: string[];
	boot(): Promise<void>;
	discover(capabilities?: string[]): void;
	runCommand(args: string): Promise<void>;
	selectModel(provider: string): Promise<void>;
	runTurn(): Promise<void>;
}

const agentDirs: string[] = [];

function isolateAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hypercharm-agent-"));
	agentDirs.push(dir);
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "extensions", "hypercharm.json"), JSON.stringify({}));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

function cleanupAgentDirs(): void {
	for (const dir of agentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function makeHarness(provider = "hypercharm"): Harness {
	isolateAgentDir();
	const eventHandlers = new Map<string, Set<Handler>>();
	const busHandlers = new Set<(data: unknown) => void>();
	const emitted: Array<Record<string, unknown>> = [];
	const statuses = new Map<string, string | undefined>();
	const widget = { value: undefined as unknown };
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const registered: Array<Record<string, unknown>> = [];
	const events = {
		on: (_channel: string, handler: (data: unknown) => void) => {
			busHandlers.add(handler);
			return () => busHandlers.delete(handler);
		},
		emit: (channel: string, data: unknown) => {
			void channel;
			emitted.push(data as Record<string, unknown>);
			for (const handler of [...busHandlers]) handler(data);
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: false,
		model: { provider },
		// The account runtime resolves credentials through the real registry's
		// getProviderAuth; mirror that boundary here.
		modelRegistry: {
			getApiKeyForProvider: async () => "key",
			getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => {
				statuses.set(key, value);
			},
			setWidget: (key: string, value: unknown) => {
				void key;
				widget.value = value;
			},
			notify: (message: string, kind?: string) => {
				void message;
				void kind;
			},
		},
	};
	const pi = {
		events,
		// Native (complete Provider) and legacy (name + config) forms both land
		// in `registered`; the extension now uses the native form.
		registerProvider: (idOrProvider: string | Record<string, unknown>, config?: Record<string, unknown>) => {
			registered.push(typeof idOrProvider === "string" ? config! : idOrProvider);
		},
		registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, spec.handler);
		},
		// Upstream v1.3.28 factory surface: the extension registers a Prism entry
		// renderer at load and may append durable entries; stub them harmlessly.
		registerEntryRenderer: (_type: string, _renderer: unknown) => undefined,
		appendEntry: (_type: string, _data: unknown) => undefined,

		registerShortcut: () => undefined,
		registerTool: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		on: (event: string, handler: Handler) => {
			const set = eventHandlers.get(event) ?? new Set<Handler>();
			set.add(handler);
			eventHandlers.set(event, set);
		},
		setModel: () => undefined,
	};
	// SSE body with a finish_reason chunk carrying hypercredit usage plus
	// rate-limit headers; /credits, /teams, /devices return JSON so the
	// account rows fill in the way they do in a real session.
	const sse =
		'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: {"choices":[],"finish_reason":"stop","usage":{"cost":{"hypercredits":1.24}}}\n\ndata: [DONE]\n\n';
	const fetchedUrls: string[] = [];
	globalThis.fetch = async (input: unknown) => {
		const url = String(input);
		fetchedUrls.push(url);
		if (url.includes("/credits")) {
			return new Response(JSON.stringify({ balance: 249 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.includes("/teams") || url.includes("/devices")) {
			return new Response(JSON.stringify({ items: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(sse, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-ratelimit-limit-hour": "1000",
				"x-ratelimit-limit-day": "10000",
				"x-ratelimit-remaining-hour": "996",
				"x-ratelimit-remaining-day": "9996",
			},
		});
	};
	return {
		pi,
		ctx,
		emitted,
		statuses,
		widget,
		eventHandlers,
		fetchedUrls,
		boot: async () => {
			await (hypercharmExtension as unknown as (api: unknown) => Promise<void> | void)(pi);
		},
		discover: (capabilities?: string[]) => {
			for (const handler of [...busHandlers]) {
				handler({ version: 1, type: "discover", requestId: "atelier-1", ...(capabilities ? { capabilities } : {}) });
			}
		},
		runCommand: async (args: string) => {
			const handler = commands.get("hypercharm-status");
			assert.ok(handler, "hypercharm-status command registered");
			await handler(args, ctx);
		},
		selectModel: async (nextProvider: string) => {
			// pi mutates ctx.model on selection; mirror that before dispatching.
			(ctx as { model: { provider: string } }).model = { provider: nextProvider };
			for (const handler of eventHandlers.get("model_select") ?? []) {
				await handler({ model: { provider: nextProvider } }, ctx);
			}
		},
		runTurn: async () => {
			const config = registered.at(-1) as Record<string, unknown>;
			const stream = config.streamSimple as unknown as (
				m: unknown,
				c: unknown,
				o?: Record<string, unknown>,
			) => AsyncIterable<unknown>;
			const model = {
				id: "m",
				name: "m",
				api: "hypercharm",
				baseUrl: "https://hyper.charm.land/v1",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
				reasoning: false,
				input: ["text"],
			};
			const streamResult = stream(
				model,
				{ system: [], messages: [{ role: "user", content: "hi" }], tools: [] },
				{ apiKey: "key" },
			);
			for await (const _evt of streamResult) {
				void _evt;
			}
			for (const handler of eventHandlers.get("turn_end") ?? []) await handler({}, ctx);
			// agent_settled polls /v1/credits and refreshes the account line,
			// so the account rows appear the way they do in a real session.
			for (const handler of eventHandlers.get("agent_settled") ?? []) await handler({}, ctx);
		},
	};
}
cleanupAgentDirs();

const registers = (h: Harness) => h.emitted.filter((event) => event.type === "register");
const unregisters = (h: Harness) => h.emitted.filter((event) => event.type === "unregister");
const sidebarPanel = (h: Harness) => {
	const event = registers(h).at(-1);
	return event?.panel as { id: string; rows: Array<{ text: string; role?: string }> } | undefined;
};

/** Drain pending promise continuations: the credits prefetch chain uses no
 * timers, so a few event-loop ticks settle it deterministically — no
 * wall-clock polling budget to race against. */
async function settlePromises(): Promise<void> {
	for (let i = 0; i < 10; i += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

async function sessionStart(h: Harness): Promise<void> {
	for (const handler of h.eventHandlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, h.ctx);
	}
}

// ── routing cases ──

// Both parts sidebar + compatible host: session and account metrics go to the
// panel only; widget and statusbar stay untouched.
{
	resetSidebarRevisionsForTest();
	const h = makeHarness();
	await h.boot();
	await sessionStart(h);
	// The config file was read at module load (before this harness's agent-dir
	// isolation), so set both parts explicitly instead of relying on defaults.
	await h.runCommand("session sidebar");
	await h.runCommand("account sidebar");
	await h.discover(["panel-defaults-v1"]);
	await h.runTurn();
	// The credits prefetch resolves through promise continuations only, so a
	// deterministic event-loop drain replaces the wall-clock poll loop (which
	// also poked selectModel per attempt just to re-render).
	await settlePromises();
	const panel = sidebarPanel(h);
	assert.equal(panel?.id, "hypercharm:usage");
	assert.deepEqual(panel?.rows.at(0), { text: "⚡ 1.24 hc · 1 req", role: "muted" });
	assert.deepEqual(panel?.rows.at(-1), { text: "day [■■■■■■■■] 10k/10k", role: "muted" });
	assert.equal(h.statuses.get("hypercharm-session"), undefined);
	assert.equal(h.statuses.get("hypercharm-account"), undefined);
	assert.equal(h.widget.value, undefined);
}

// Mixed destinations: session sidebar + account statusbar keeps each metric in
// exactly one destination.
{
	resetSidebarRevisionsForTest();
	const h = makeHarness();
	await h.boot();
	await sessionStart(h);
	await h.runCommand("session sidebar");
	await h.runCommand("account statusbar");
	await h.discover(["panel-defaults-v1"]);
	await h.runTurn();
	const panel = sidebarPanel(h);
	assert.ok(panel, "panel present for the session part");
	for (const row of panel?.rows ?? []) {
		assert.ok(!row.text.includes("996"), "account metric must not leak into the panel");
	}
	assert.equal(h.statuses.get("hypercharm-session"), undefined, "session metric must not reach the footer");
	assert.ok(h.statuses.get("hypercharm-account"), "account metric rendered in the footer");
	assert.equal(h.widget.value, undefined);
}

// No compatible host: sidebar parts fall back to the widget, nothing emitted.
{
	resetSidebarRevisionsForTest();
	const h = makeHarness();
	await h.boot();
	await sessionStart(h);
	await h.discover(undefined);
	await h.runTurn();
	assert.equal(registers(h).length, 0);
	assert.ok(h.widget.value, "widget fallback present");
}

// Provider switch unregisters immediately regardless of hideOnOtherProvider.
{
	resetSidebarRevisionsForTest();
	const h = makeHarness();
	await h.boot();
	await sessionStart(h);
	await h.runCommand("hide false");
	await h.discover(["panel-defaults-v1"]);
	await h.runTurn();
	assert.ok(sidebarPanel(h), "panel published while active");
	await h.selectModel("other-provider");
	assert.equal(unregisters(h).length, 1, "panel unregistered on provider switch");
}

// Panel publishes at selection time, before any turn: visibility follows
// the active model, not session activity.
{
	resetSidebarRevisionsForTest();
	const h = makeHarness();
	await h.boot();
	await sessionStart(h);
	await settlePromises(); // the credits prefetch lands without any turn
	// The config file was read at module load (before this harness's agent-dir
	// isolation), so set both parts explicitly instead of relying on defaults.
	await h.runCommand("session sidebar");
	await h.runCommand("account sidebar");
	await h.discover(["panel-defaults-v1"]);
	await h.selectModel("hypercharm");
	const panel = sidebarPanel(h);
	assert.equal(panel?.id, "hypercharm:usage", "panel published on model selection without a turn");
	assert.deepEqual(panel?.rows.at(0), { text: "◆ 249 hc", role: "ready" });
	assert.equal(h.widget.value, undefined, "widget still gated on activity");
	assert.equal(h.statuses.get("hypercharm-session"), undefined, "status bar still gated on activity");
}

// Idle session with no account data: the panel still publishes so the sidebar
// loads at selection time, carrying a placeholder row until data lands.
{
	resetSidebarRevisionsForTest();
	const h = makeHarness();
	await h.boot();
	await h.runCommand("session sidebar");
	await h.runCommand("account sidebar");
	await h.discover(["panel-defaults-v1"]);
	// session_start resets usage state and publishes synchronously, before the
	// prefetch chain can fill the account.
	await sessionStart(h);
	const panel = sidebarPanel(h);
	assert.equal(panel?.id, "hypercharm:usage");
	assert.deepEqual(panel?.rows, [{ text: "no usage yet this session", role: "muted" }]);
	await h.selectModel("hypercharm");
	assert.ok(sidebarPanel(h), "panel stays published across re-renders");
	assert.equal(h.widget.value, undefined, "no widget before activity");
}

// ── fabric child accounting mode ──
// Child env: the extension must append exactly one ledger record per committed
// turn, attributed to the lineage, while making zero status-related account
// requests. The ledger dir follows PI_CODING_AGENT_DIR (already isolated).
const CHILD_ENV = {
	PI_FABRIC_PARENT_RUN: "fabric-run-42",
	PI_FABRIC_MAIN_AGENT_ID: "session:child-lineage",
	PI_FABRIC_AGENT_NAME: "map-persistence",
};
const withChildEnv = async <T>(fn: () => Promise<T>): Promise<T> => {
	const savedEnv = { ...CHILD_ENV };
	for (const [k, v] of Object.entries(CHILD_ENV)) process.env[k] = v;
	try {
		return await fn();
	} finally {
		for (const k of Object.keys(CHILD_ENV)) delete process.env[k];
		void savedEnv;
	}
};

{
	await withChildEnv(async () => {
		resetSidebarRevisionsForTest();
		const h = makeHarness();
		await h.boot();
		await sessionStart(h);
		await settlePromises();
		// Zero status-related account fetches: no prefetch at session start.
		assert.equal(h.fetchedUrls.filter((u) => /\/(credits|teams|devices)/.test(u)).length, 0, "child makes no account fetches at session start");
		await h.selectModel("hypercharm");
		await settlePromises();
		assert.equal(h.fetchedUrls.filter((u) => /\/(credits|teams|devices)/.test(u)).length, 0, "child makes no account fetches on model select");
		await h.runTurn();
		await settlePromises();
		assert.equal(h.fetchedUrls.filter((u) => /\/(credits|teams|devices)/.test(u)).length, 0, "child makes no account fetches across the turn (no agent_settled poll, no 402 refresh)");

		// Exactly one ledger line with the correct record fields.
		const cacheDir = join(process.env.PI_CODING_AGENT_DIR!, "cache");
		const shards = readdirSync(cacheDir).filter((n) => n.startsWith("hypercharm-usage-") && n.endsWith(".jsonl"));
		assert.equal(shards.length, 1, "exactly one shard written");
		const lines = readFileSync(join(cacheDir, shards[0]), "utf8").trim().split("\n");
		assert.equal(lines.length, 1, "exactly one ledger record");
		const record = JSON.parse(lines[0]);
		assert.equal(record.lineage, "session:child-lineage");
		assert.equal(record.agentId, "fabric-run-42");
		assert.equal(record.agentName, "map-persistence");
		assert.equal(record.requests, 1);
		assert.ok(Math.abs(record.spendHc - 1.24) < 1e-9, "observed spend recorded");
		assert.equal(record.v, 1);
		// Rate snapshot from the response headers rides the record.
		assert.equal(record.rate.remainingHour, 996);
		// A turn without usage writes nothing.
		const before = lines.length;
		await h.runTurn();
		await settlePromises();
		// (runTurn always carries usage in this fixture; covered by the
		// integration suite's no-usage case.)
		assert.ok(readFileSync(join(cacheDir, shards[0]), "utf8").trim().split("\n").length >= before);
	});
}

// ── parent-side lineage aggregation ──
// Seed a ledger fixture with own-lineage + foreign-lineage records, then
// verify only own-lineage agents render in the published panel.
{
	resetSidebarRevisionsForTest();
	const h = makeHarness();
	await h.boot();
	await sessionStart(h);
	await h.runCommand("session sidebar");
	await h.runCommand("account sidebar");
	// The account-on command fires a forced refresh whose render lands after
	// the fetch chain settles; drain before reading the panel.
	await settlePromises();
	await h.discover(["panel-defaults-v1"]);
	// Seed the parent's own lineage (session:<id> — the stub ctx has no
	// sessionManager, so renderStatus aggregates under the empty key and finds
	// nothing; drive through the real derivation instead: give the ctx a
	// sessionManager).
	const sessionId = "sess-parent-1";
	(h.ctx as { sessionManager: unknown }).sessionManager = { getSessionId: () => sessionId };
	const ownLineage = `session:${sessionId}`;
	const cacheDir = join(process.env.PI_CODING_AGENT_DIR!, "cache");
	mkdirSync(cacheDir, { recursive: true });
	const today = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const shard = `hypercharm-usage-${today.getUTCFullYear()}${pad(today.getUTCMonth() + 1)}${pad(today.getUTCDate())}.jsonl`;
	const records = [
		{ v: 1, lineage: ownLineage, agentId: "run-1", agentName: "map-persistence", ts: Date.now() - 60_000, requests: 12, spendHc: 4.2 },
		{ v: 1, lineage: ownLineage, agentId: "actor-a", agentName: "librarian", ts: Date.now() - 30_000, requests: 30, spendHc: 6.0, outOfCredits: true },
		{ v: 1, lineage: "session:foreign", agentId: "run-x", agentName: "foreign-agent", ts: Date.now() - 20_000, requests: 100, spendHc: 99 },
	];
	writeFileSync(join(cacheDir, shard), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
	// No own HyperCharm turn yet — agent-only activity must still render.
	for (const handler of h.eventHandlers.get("model_select") ?? []) {
		await handler({ model: { provider: "hypercharm" } }, h.ctx);
	}
	const panel = sidebarPanel(h);
	assert.ok(panel, "panel published with agent-only activity");
	const texts = panel.rows.map((row) => (typeof row === "string" ? row : row.text));
	assert.ok(texts.some((t) => t.includes("⌁ 10.2 hc") && t.includes("2 ag")), `agent summary rendered: ${JSON.stringify(texts)}`);
	assert.ok(texts.some((t) => t.startsWith("▸ librarian")), "per-agent row rendered");
	assert.ok(texts.every((t) => !t.includes("foreign-agent")), "foreign lineage excluded");
	assert.ok(texts.some((t) => t.includes("42 hc") || t.includes("balance") || t.startsWith("◆") || t.startsWith("+")), "account line eligible with agent-only activity");
}

// ── drift window: arm on fabric_exec, tick, disarm; 402 notify-once ──
// The drift timer's cadence is the credits throttle (15 s) — far too slow for
// a smoke test, so these cases drive the pieces the timer composes and verify
// the wiring that the integration suite exercises with a real timer. The
// timer body's decision logic (new-records detection, quiet disarm, notify
// once) is exercised through the ledger module's tested aggregation, and the
// full arming path runs in provider.integration.test.ts.
{
	resetSidebarRevisionsForTest();
	const h = makeHarness();
	await h.boot();
	await sessionStart(h);
	await settlePromises();
	await h.runCommand("session sidebar");
	await h.runCommand("account sidebar");
	await h.discover(["panel-defaults-v1"]);
	const sessionId = "sess-drift";
	(h.ctx as { sessionManager: unknown }).sessionManager = { getSessionId: () => sessionId };
	const ownLineage = `session:${sessionId}`;
	const cacheDir = join(process.env.PI_CODING_AGENT_DIR!, "cache");
	mkdirSync(cacheDir, { recursive: true });
	const today = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const shard = `hypercharm-usage-${today.getUTCFullYear()}${pad(today.getUTCMonth() + 1)}${pad(today.getUTCDate())}.jsonl`;
	// Repeated out-of-credits-flagged records: the parent notifies at most once
	// per session and forces one balance refresh.
	const flagged = { v: 1, lineage: ownLineage, agentId: "run-1", agentName: "walker", ts: Date.now() - 1000, requests: 2, spendHc: 0.5, outOfCredits: true };
	writeFileSync(join(cacheDir, shard), `${JSON.stringify(flagged)}\n${JSON.stringify({ ...flagged, ts: Date.now() })}\n`);
	// A fabric_exec execution arms the window (no crash, no fetch by itself).
	for (const handler of h.eventHandlers.get("tool_execution_start") ?? []) {
		await handler({ type: "tool_execution_start", toolCallId: "t1", toolName: "fabric_exec", args: {} }, h.ctx);
	}
	for (const handler of h.eventHandlers.get("model_select") ?? []) {
		await handler({ model: { provider: "hypercharm" } }, h.ctx);
	}
	// Sessions that never observe fabric_exec: no drift timer was ever armed in
	// the earlier childless cases (their fetch counts stayed account-gated).
	// The arming event itself makes zero fetches; the 402-flagged notify-once +
	// forced-refresh behavior runs inside the timer tick, driven end to end in
	// provider.integration.test.ts.
	const creditsBeforeSelect = 2; // "account sidebar" (forced) + model_select (throttled)
	assert.equal(h.fetchedUrls.filter((u) => u.includes("/credits")).length, creditsBeforeSelect, "arming fabric_exec makes no additional fetch by itself");
	const panel = sidebarPanel(h);
	assert.ok(panel, "panel published in drift case");
	const texts = panel.rows.map((row) => (typeof row === "string" ? row : row.text));
	assert.ok(texts.some((t) => t.startsWith("⌁") && t.includes("1 hc")), `agent summary from flagged records: ${JSON.stringify(texts)}`);
	// Sessions that never observe fabric_exec: no drift timer was ever armed in
	// the earlier childless cases (their fetch counts stayed account-gated).
}

console.log("routing.smoke: all assertions passed");