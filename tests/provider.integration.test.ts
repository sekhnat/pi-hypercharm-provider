/**
 * Real-Pi integration test. Loads this extension through Pi's own extension
 * loader into an isolated agent dir, with the network stubbed, and drives it
 * through pi's ExtensionRunner — the same path the TUI uses.
 *
 * Covers what unit tests cannot: provider registration from the embedded
 * catalog, catalog hot-swap + caching + retention, deprecated-model grace,
 * warning surfacing, prism entry durability, and co-installation with the
 * official provider's identifier surface (tests/fixtures/official-surface.ts).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-hypercharm-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_OFFLINE;
delete process.env.HYPERCHARM_API_KEY;

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const officialSurfacePath = fileURLToPath(new URL("./fixtures/official-surface.ts", import.meta.url));
const deprecatedModelsPath = fileURLToPath(new URL("../deprecated-models.json", import.meta.url));
const embeddedModelsPath = fileURLToPath(new URL("../models.json", import.meta.url));

const EMBEDDED_AUTHORITY_NOTE = "tests must run against the embedded catalog";
const CATALOG_URL = "https://hyper.charm.land/v1/provider";
const PRISM_ENTRY_TYPE = "hypercharm-prism-route";
const DEPRECATED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const FIXTURE_MODEL = {
	id: "fixture-model",
	name: "Fixture model",
	cost_per_1m_in: 2,
	cost_per_1m_out: 7,
	cost_per_1m_in_cached: 1,
	cost_per_1m_out_cached: 0.5,
	context_window: 8192,
	default_max_tokens: 1024,
	can_reason: false,
	supports_attachments: true,
};

const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, probe, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("Timed out waiting for " + label);
		await sleep(25);
	}
}

function captureStderr() {
	const chunks = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk) => {
		chunks.push(String(chunk));
		return true;
	};
	return {
		chunks,
		restore() {
			process.stderr.write = original;
		},
	};
}

function captureUI(runner) {
	const notifications = [];
	const statusKeys = [];
	const widgetKeys = [];
	const base = runner.createContext().ui ?? {};
	const ui = {
		...base,
		theme: { ...(base.theme ?? {}), fg: (_color, text) => text },
		notify: (message) => {
			notifications.push(String(message));
		},
		setStatus: (key) => {
			statusKeys.push(String(key));
		},
		setWidget: (key) => {
			widgetKeys.push(String(key));
		},
	};
	runner.setUIContext(ui, "tui");
	return { notifications, statusKeys, widgetKeys };
}

async function load(options = {}) {
	const extensionPaths = options.extensionPaths ?? [extensionPath];
	globalThis.fetch =
		options.fetchImpl ??
		(async (input) => {
			throw new Error("network disabled in tests: " + String(input));
		});

	const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("hypercharm", async () => ({ type: "api_key", key: "fixture-api-key" }));

	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: path.join(agentDir, "models.json"),
		refreshOnCreate: false,
	});
	const loader = new DefaultResourceLoader({
		agentDir,
		cwd: agentDir,
		additionalExtensionPaths: extensionPaths,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, [], "extension must load without errors");

	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile)
		: SessionManager.create(agentDir, path.join(agentDir, "sessions"));
	const { session } = await createAgentSession({
		agentDir,
		cwd: agentDir,
		modelRuntime: runtime,
		resourceLoader: loader,
		sessionManager,
		noTools: "all",
	});
	// createAgentSession alone does not emit session_start (the pi CLI binds the
	// session, and that binding emits it), so drive the lifecycle event here:
	// the extension session path is part of what this suite verifies.
	const runner = session.extensionRunner;
	await runner.emit({ type: "session_start", reason: "startup" });
	return { credentials, runtime, loader, session, sessionManager, runner };
}

function assistantMessage(overrides = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "fixture response" }],
		api: "hypercharm",
		provider: "hypercharm",
		model: "fixture-model",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

test("loads offline: embedded catalog, deprecated grace, namespaced registrations, no silent failure", async () => {
	const stderr = captureStderr();
	let harness;
	try {
		harness = await load();

		const embedded = harness.runtime.getModel("hypercharm", "deepseek-v4-flash");
		assert.ok(embedded, "embedded catalog must register without any network");
		assert.equal(embedded.contextWindow, 1000000);
		assert.equal(embedded.maxTokens, 384000);
		assert.equal(embedded.cost.input, 0.2);
		assert.equal(EMBEDDED_AUTHORITY_NOTE, "tests must run against the embedded catalog");

		// Deprecated grace: entries inside the 14-day TTL are still served,
		// entries past it are evicted. Derived from the data, not today's date.
		const deprecated = JSON.parse(readFileSync(deprecatedModelsPath, "utf8"));
		const embeddedIds = new Set(
			(Array.isArray(JSON.parse(readFileSync(embeddedModelsPath, "utf8")))
				? JSON.parse(readFileSync(embeddedModelsPath, "utf8"))
				: []
			).map((model) => model.id),
		);
		const deprecatedOnly = Object.values(deprecated).filter((entry) => !embeddedIds.has(entry.id));
		const fresh = deprecatedOnly.filter((entry) => Date.now() - Date.parse(entry.deprecatedAt) <= DEPRECATED_TTL_MS);
		const stale = deprecatedOnly.filter((entry) => Date.now() - Date.parse(entry.deprecatedAt) > DEPRECATED_TTL_MS);
		assert.ok(fresh.length > 0, "expected at least one model inside the deprecated grace window");
		for (const entry of fresh) {
			assert.ok(harness.runtime.getModel("hypercharm", entry.id), entry.id + " must be served during its grace period");
		}
		for (const entry of stale) {
			assert.equal(harness.runtime.getModel("hypercharm", entry.id), undefined, entry.id + " must be evicted after its grace period");
		}

		// Namespacing: nothing is registered on the official provider's surfaces.
		assert.equal(harness.runtime.getModel("hyper", "deepseek-v4-flash"), undefined, "must not register the official provider id");
		assert.equal(harness.runner.getEntryRenderer("hyper-prism-route"), undefined, "must not register the official entry type");
		assert.ok(harness.runner.getEntryRenderer(PRISM_ENTRY_TYPE), "prism entry renderer registered");
		const commandNames = harness.runner.getRegisteredCommands().map((command) => command.name);
		assert.ok(commandNames.includes("hypercharm-status"), "namespaced status command registered");
		assert.equal(commandNames.includes("hyper-status"), false, "must not register the official command");

		// Failures are surfaced, not swallowed.
		const warning = await waitFor("catalog failure warning", () =>
			stderr.chunks.find((chunk) => chunk.includes("model catalog")),
		);
		assert.match(warning, /network disabled/);
	} finally {
		stderr.restore();
		harness?.session.dispose();
	}
});

test("refreshes from /v1/provider, caches the catalog, and retains it when refresh fails", async () => {
	const requests = [];
	const catalogOk = async (input, init) => {
		const url = String(input);
		requests.push(url);
		assert.equal(url, CATALOG_URL);
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-api-key");
		return new Response(JSON.stringify({ models: [FIXTURE_MODEL] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	const first = await load({ fetchImpl: catalogOk });
	try {
		const model = await waitFor("hot-swapped fixture model", () => first.runtime.getModel("hypercharm", "fixture-model"));
		assert.equal(model.contextWindow, 8192);
		assert.equal(model.maxTokens, 1024);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.cost.cacheRead, 0.5);
		assert.equal(model.cost.cacheWrite, 1);
		assert.equal(model.compat.supportsReasoningEffort, false);
		assert.ok(requests.length >= 1, "the catalog endpoint must be the refresh source");

		const cachePath = path.join(agentDir, "cache", "hypercharm-models.json");
		const cached = JSON.parse(readFileSync(cachePath, "utf8"));
		// The fork writes a version-stamped envelope ({ version, embeddedHash, models })
		// instead of upstream's legacy bare array; assert the envelope shape.
		assert.ok(cached && !Array.isArray(cached) && typeof cached === "object", "catalog cache written as the version-stamped envelope");
		assert.equal(typeof cached.version, "string", "envelope records the writing version");
		assert.equal(typeof cached.embeddedHash, "string", "envelope records the embedded catalog hash");
		assert.ok(Array.isArray(cached.models), "envelope holds the models array");
		assert.ok(cached.models.some((entry) => entry.id === "fixture-model"), "cache holds the refreshed catalog");
	} finally {
		first.session.dispose();
	}

	// A later session keeps serving the cached catalog even though Hyper is down.
	const stderr = captureStderr();
	const second = await load({ fetchImpl: async () => new Response("Unavailable", { status: 503 }) });
	try {
		assert.ok(second.runtime.getModel("hypercharm", "fixture-model"), "cached catalog retained across a failed refresh");
		const warning = await waitFor("failed refresh warning", () => stderr.chunks.find((chunk) => chunk.includes("HTTP 503")));
		assert.match(warning, /model catalog/);
	} finally {
		stderr.restore();
		second.session.dispose();
	}
});

test("records prism routing as durable session entries", async () => {
	const harness = await load();
	const { runner, sessionManager } = harness;
	let disposed = false;
	try {
		const routes = () =>
			sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === PRISM_ENTRY_TYPE);
		const message = assistantMessage();
		// pi appends the assistant message as part of a real turn, and that write
		// is what flushes buffered custom entries through to the session file.
		sessionManager.appendMessage(message);
		const ui = captureUI(runner);

		const cases = [
			[{ "x-prism-model-name": " GLM 5.3 Flash ", "x-prism-model-id": "glm-5.3-flash" }, { modelName: "GLM 5.3 Flash", modelId: "glm-5.3-flash" }],
			[{ "x-prism-model-name": "GLM 5.3 Flash" }, { modelName: "GLM 5.3 Flash", modelId: undefined }],
			[{ "x-prism-model-id": "glm-5.3-flash" }, { modelName: undefined, modelId: "glm-5.3-flash" }],
			[{}, undefined],
			[{ "x-prism-model-name": "   " }, undefined],
			[{ "x-prism-model-name": "bad\u001b[31m" }, undefined],
			[{ "x-prism-model-name": "bad\nline" }, undefined],
			[{ "x-prism-model-name": "bad\u202etext" }, undefined],
			[{ "x-prism-model-name": "x".repeat(201) }, undefined],
		];
		let expectedEntries = 0;
		let turnIndex = 0;
		for (const [headers, expected] of cases) {
			await runner.emit({ type: "turn_start", turnIndex, timestamp: 1 });
			await runner.emit({ type: "after_provider_response", status: 200, headers });
			await runner.emitMessageEnd({ type: "message_end", message });
			await runner.emit({ type: "turn_end", turnIndex, message, toolResults: [] });
			turnIndex += 1;
			if (expected === undefined) {
				assert.equal(routes().length, expectedEntries, "unusable headers must not record a route: " + JSON.stringify(headers));
			} else {
				expectedEntries += 1;
				assert.deepEqual(routes().at(-1)?.data, expected);
			}
		}
		assert.equal(routes().length, 3, "exactly the three usable routes are recorded");

		// Auxiliary responses outside the assistant request must not leak.
		const before = routes().length;
		const headers = { "x-prism-model-name": "Do not display" };
		await runner.emit({ type: "after_provider_response", status: 200, headers });
		await runner.emit({ type: "turn_start", turnIndex, timestamp: 2 });
		await runner.emitMessageEnd({ type: "message_end", message });
		await runner.emit({ type: "after_provider_response", status: 200, headers });
		await runner.emit({ type: "turn_end", turnIndex, message, toolResults: [] });
		assert.equal(routes().length, before, "requests between turns must not record a route");

		// Cancelled, failed, and other-provider turns are dropped.
		for (const stopReason of ["aborted", "error"]) {
			await runner.emit({ type: "turn_start", turnIndex, timestamp: 3 });
			await runner.emit({ type: "after_provider_response", status: 200, headers: { "x-prism-model-name": "GLM 5.3 Flash" } });
			await runner.emitMessageEnd({ type: "message_end", message: { ...message, stopReason } });
			await runner.emit({ type: "turn_end", turnIndex, message: { ...message, stopReason }, toolResults: [] });
		}
		await runner.emit({ type: "turn_start", turnIndex, timestamp: 4 });
		await runner.emit({ type: "after_provider_response", status: 200, headers: { "x-prism-model-name": "GLM 5.3 Flash" } });
		await runner.emit({ type: "turn_end", turnIndex, message: { ...message, provider: "other" }, toolResults: [] });
		assert.equal(routes().length, before, "aborted, failed, and other-provider turns must not record a route");
		assert.equal(
			ui.notifications.some((notification) => notification.includes("Prism")),
			false,
			"routing must use durable entries, not notifications",
		);

		// The renderer is registered and rejects unsafe saved labels.
		const renderer = runner.getEntryRenderer(PRISM_ENTRY_TYPE);
		assert.ok(renderer);
		const theme = { fg: (_color, text) => text };
		const [firstRoute] = routes();
		assert.equal(renderer({ ...firstRoute, data: { modelName: 42 } }, { expanded: false }, theme), undefined);
		assert.equal(renderer({ ...firstRoute, data: { modelName: "bad\u001b[31m" } }, { expanded: false }, theme), undefined);
		const component = renderer(firstRoute, { expanded: false }, theme);
		assert.ok(component);
		assert.ok(component.render(80).join("\n").includes("Prism \u2192 GLM 5.3 Flash"));

		// Routes are durable: dispose first (pi flushes on dispose), then reopen
		// the session file in a fresh session and verify the entries and the
		// renderer registration both survive.
		const sessionFile = sessionManager.getSessionFile();
		assert.ok(sessionFile);
		harness.session.dispose();
		disposed = true;

		const restored = await load({ sessionFile });
		try {
			const persisted = restored.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === PRISM_ENTRY_TYPE);
			assert.equal(persisted.length, 3, "routes survive reopening the session");
			assert.deepEqual(persisted[0]?.data, { modelName: "GLM 5.3 Flash", modelId: "glm-5.3-flash" });
			assert.equal(
				restored.sessionManager.buildSessionContext().messages.some((entry) => entry.role === "custom"),
				false,
				"routing entries must not enter model context",
			);
			const restoredRenderer = restored.runner.getEntryRenderer(PRISM_ENTRY_TYPE);
			assert.ok(restoredRenderer, "renderer registration survives a session reload");
			const restoredComponent = restoredRenderer(persisted[0], { expanded: false }, theme);
			assert.ok(restoredComponent);
			assert.ok(restoredComponent.render(80).join("\n").includes("Prism \u2192 GLM 5.3 Flash"));
		} finally {
			restored.session.dispose();
		}
	} finally {
		if (!disposed) harness.session.dispose();
	}
});

test("co-installs with the official identifier surface without interference", async () => {
	const harness = await load({ extensionPaths: [extensionPath, officialSurfacePath] });
	try {
		// Same model id, two providers: provider-scoped resolution must not collide.
		const ours = harness.runtime.getModel("hypercharm", "glm-5.3");
		const official = harness.runtime.getModel("hyper", "glm-5.3");
		assert.ok(ours, "our provider serves glm-5.3");
		assert.ok(official, "the official-surface provider serves its own glm-5.3");
		assert.equal(ours.provider, "hypercharm");
		assert.equal(official.provider, "hyper");
		assert.equal(official.name, "Official fixture GLM 5.3");
		assert.notEqual(ours.name, official.name);

		const commandNames = harness.runner.getRegisteredCommands().map((command) => command.name);
		assert.ok(commandNames.includes("hypercharm-status"));
		assert.ok(commandNames.includes("hyper-status"));
		assert.ok(harness.runner.getEntryRenderer(PRISM_ENTRY_TYPE));
		assert.ok(harness.runner.getEntryRenderer("hyper-prism-route"));

		// Status writes stay in their own namespaces: neither extension can
		// cross-clear the other's footer slots.
		const ui = captureUI(harness.runner);
		await harness.runner.emit({ type: "turn_end", turnIndex: 0, message: assistantMessage(), toolResults: [] });
		const ownKeys = ui.statusKeys.filter((key) => key.startsWith("hypercharm"));
		const officialKeys = ui.statusKeys.filter((key) => key === "hyper");
		assert.ok(officialKeys.length > 0, "the official fixture writes its own status key");
		assert.ok(ownKeys.length > 0, "our extension writes its namespaced status keys");
		for (const key of ui.widgetKeys) {
			assert.ok(key.startsWith("hypercharm"), "widget key must stay namespaced: " + key);
		}
		assert.equal(ui.statusKeys.includes("hyper") && ownKeys.includes("hyper"), false);
	} finally {
		harness.session.dispose();
	}
});
