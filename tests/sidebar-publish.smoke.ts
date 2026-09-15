/**
 * Integration smoke test for eager sidebar publication on model selection.
 * Run: node tests/sidebar-publish.smoke.ts (Node ≥ 23 strips types natively).
 *
 * Boots the real extension factory against a fake pi runtime: a temp agent
 * dir (PI_CODING_AGENT_DIR) keeps the developer's ~/.pi/agent untouched, and
 * a stubbed fetch answers the account endpoints so no network is touched.
 * Asserts the register / unregister envelopes on the sidebar-panels channel
 * while driving session_start / model_select without any turn.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "hypercharm-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const CHANNEL = "pi-atelier:sidebar-panels";
const PLACEHOLDER = "no usage yet this session";

// Stub network before any extension code can reach it. /credits, /teams and
// /devices return account atoms; /provider returns an empty catalog so the
// model-revalidation path stays a no-op.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

const { default: factory } = await import("../index.ts");

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

type PanelRows = Array<{ text: string; role?: string }>;

function makeRuntime(modelProvider: string | undefined, apiKey: string | undefined) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void | Promise<void>>>();
	const busListeners = new Set<(data: unknown) => void>();
	const emitted: Array<Record<string, unknown>> = [];
	const widgetValues: Array<unknown> = [];
	const statusSlots = { session: undefined as unknown, account: undefined as unknown };
	const commandHandlers: CommandHandler[] = [];
	const pi = {
		events: {
			on: (_channel: string, handler: (data: unknown) => void) => {
				busListeners.add(handler);
				return () => busListeners.delete(handler);
			},
			emit: (_channel: string, data: unknown) => {
				emitted.push(data as Record<string, unknown>);
				for (const listener of [...busListeners]) listener(data);
			},
		},
		registerProvider: (_providerId: string, _config: unknown) => undefined,
		registerCommand: (_name: string, command: { handler: CommandHandler }) => {
			commandHandlers.push(command.handler);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, value: unknown) => {
				if (key === "hypercharm-session") statusSlots.session = value;
				if (key === "hypercharm-account") statusSlots.account = value;
			},
			setWidget: (_key: string, value: unknown) => widgetValues.push(value),
			notify: () => undefined,
		},
		modelRegistry: { getApiKeyForProvider: async () => apiKey },
		model: { provider: modelProvider },
	};
	return {
		setActiveModel: (provider: string | undefined) => {
			// model_select handlers read ctx.model, which real pi keeps in sync
			// with the selection; the fake mirrors that.
			(ctx.model as { provider?: string }).provider = provider;
		},
		pi,
		ctx,
		emitted,
		widgetValues,
		statusSlots,
		commandHandlers,
		dispatch: async (event: string, payload: unknown = {}) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

const registers = (runtime: ReturnType<typeof makeRuntime>) => runtime.emitted.filter((event) => event.type === "register");
const unregisters = (runtime: ReturnType<typeof makeRuntime>) => runtime.emitted.filter((event) => event.type === "unregister");
const lastPanelRows = (runtime: ReturnType<typeof makeRuntime>): PanelRows =>
	(registers(runtime).at(-1) as { panel: { rows: PanelRows } }).panel.rows;
const discover = (runtime: ReturnType<typeof makeRuntime>) =>
	runtime.pi.events.emit(CHANNEL, {
		version: 1,
		type: "discover",
		requestId: "atelier-1",
		capabilities: ["panel-defaults-v1"],
	});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── Run 1 — no API key: selection publishes the placeholder, immediately ──────
const idle = makeRuntime("hypercharm", undefined);
await (factory as unknown as (api: unknown) => void)(idle.pi);
discover(idle);
await idle.dispatch("model_select", { model: { provider: "hypercharm" } });
assert.equal(registers(idle).length, 1, "model_select publishes the panel with zero turns");
assert.deepEqual(lastPanelRows(idle), [{ text: PLACEHOLDER, role: "muted" }]);

await idle.dispatch("session_start");
await flush();
assert.ok(registers(idle).length >= 2, "session_start with an active HyperCharm model publishes too");
assert.deepEqual(lastPanelRows(idle), [{ text: PLACEHOLDER, role: "muted" }]);
assert.equal(unregisters(idle).length, 0, "never withdrawn while a HyperCharm model stays active");

// ── Run 2 — with an API key: the prefetch lands account rows without any ─────
// message sent (stubbed /credits returns a balance; no turn is dispatched).
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = String(input);
	const body = url.includes("/credits")
		? { balance: 249 }
		: url.includes("/teams")
			? { items: [{ name: "ACME Team" }] }
			: {};
	return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const keyed = makeRuntime("hypercharm", "hc-test-key");
await (factory as unknown as (api: unknown) => void)(keyed.pi);
discover(keyed);
await keyed.dispatch("session_start");
await flush();
assert.deepEqual(lastPanelRows(keyed), [{ text: "◆ 249 hc", role: "ready" }]);

// ── Run 3 — switching providers withdraws; switching back re-publishes ────────
keyed.setActiveModel("openai");
await keyed.dispatch("model_select", { model: { provider: "openai" } });
assert.equal(unregisters(keyed).length, 1, "panel withdrawn on non-HyperCharm selection");
const before = registers(keyed).length;
keyed.setActiveModel("hypercharm");
await keyed.dispatch("model_select", { model: { provider: "hypercharm" } });
assert.ok(registers(keyed).length > before, "panel re-published on switching back");
assert.ok(lastPanelRows(keyed).some((row) => row.text.includes("249 hc")), "account data returns with the panel");

// ── Run 4 — widget/statusbar keep their activity gate; off-sidebar config ────
// never publishes the panel.
const [statusCommand] = keyed.commandHandlers;
assert.ok(statusCommand, "hypercharm-status command registered");
await statusCommand("session widget", keyed.ctx);
await statusCommand("account widget", keyed.ctx);
await flush();
assert.ok(unregisters(keyed).length >= 2, "panel withdrawn once neither part targets the sidebar");
assert.ok(
	keyed.widgetValues.every((value) => value === undefined),
	"no below-editor widget before the first turn",
);
assert.equal(keyed.statusSlots.session, undefined, "no status bar session slot before the first turn");
assert.equal(keyed.statusSlots.account, undefined, "no status bar account slot before the first turn");

await statusCommand("session statusbar", keyed.ctx);
await statusCommand("account off", keyed.ctx);
await flush();
const registersAfterConfig = registers(keyed).length;
assert.equal(registers(keyed).length, registersAfterConfig, "no panel for statusbar/off configuration");
assert.equal(keyed.statusSlots.session, undefined, "status bar still silent before the first turn");

// Restore the real fetch so later imports in the same process stay honest.
globalThis.fetch = realFetch;

console.log("sidebar-publish.smoke: all assertions passed");
