import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		modelRegistry: { getApiKeyForProvider: async () => "key" },
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
		registerProvider: (_id: string, config: Record<string, unknown>) => {
			registered.push(config);
		},
		registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, spec.handler);
		},
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
	globalThis.fetch = async (input: unknown) => {
		const url = String(input);
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
	return harness;
}
cleanupAgentDirs();

const registers = (h: Harness) => h.emitted.filter((event) => event.type === "register");
const unregisters = (h: Harness) => h.emitted.filter((event) => event.type === "unregister");
const sidebarPanel = (h: Harness) => {
	const event = registers(h).at(-1);
	return event?.panel as { id: string; rows: Array<{ text: string; role?: string }> } | undefined;
};

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
	// The credits prefetch resolves asynchronously; agent_settled's poll also
	// throttles, so wait for the fetched balance to land before asserting.
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const rows = (registers(h).at(-1)?.panel as { rows?: Array<{ text: string }> } | undefined)?.rows ?? [];
		if (rows.some((row) => row.text.includes("996"))) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await h.selectModel("hypercharm");
	}
	const panel = sidebarPanel(h);
	assert.equal(panel?.id, "hypercharm:usage");
	assert.deepEqual(panel?.rows.at(0), { text: "⚡ 1.24 hc · 1 req", role: "muted" });
	assert.deepEqual(panel?.rows.at(-1), { text: "996/1k/h · 10k/10k/d", role: "muted" });
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

// Panel stays absent before first activity even with a compatible host.
{
	resetSidebarRevisionsForTest();
	const h = makeHarness();
	await h.boot();
	await sessionStart(h);
	await h.discover(["panel-defaults-v1"]);
	// No turn: renderStatus runs via model_select but gates on activity.
	await h.selectModel("hypercharm");
	assert.equal(registers(h).length, 0, "no publish before activity");
	assert.equal(h.widget.value, undefined, "no widget before activity");
}

console.log("routing.smoke: all assertions passed");