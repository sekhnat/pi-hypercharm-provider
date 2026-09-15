/**
 * Dependency-free smoke test for the sidebar publisher wire contract.
 * Run: node tests/sidebar.smoke.ts (Node ≥ 23 strips types natively).
 * Mirrors test/sidebar.test.ts in pi-ollama-cloud: capability gating,
 * discovery replay with requestId echo, revision monotonicity, withdraw/dispose.
 */
import assert from "node:assert/strict";
import {
	SIDEBAR_PANEL_DEFAULTS_CAPABILITY,
	SIDEBAR_PANEL_EVENT_CHANNEL,
	SIDEBAR_PANEL_PROTOCOL_VERSION,
	createSidebarUsagePublisher,
	resetSidebarRevisionsForTest,
	type SidebarPanelContribution,
} from "../sidebar.ts";

function fakeBus() {
	const listeners = new Set<(data: unknown) => void>();
	const emitted: Array<Record<string, unknown>> = [];
	return {
		emitted,
		on: (_channel: string, handler: (data: unknown) => void) => {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		emit: (_channel: string, data: unknown) => {
			emitted.push(data as Record<string, unknown>);
			for (const listener of [...listeners]) listener(data);
		},
		discover: (capabilities?: string[]) => {
			for (const listener of [...listeners]) {
				listener({
					version: SIDEBAR_PANEL_PROTOCOL_VERSION,
					type: "discover",
					requestId: "atelier-1",
					...(capabilities ? { capabilities } : {}),
				});
			}
		},
	};
}

const registers = (bus: { emitted: Array<Record<string, unknown>> }) =>
	bus.emitted.filter((event) => event.type === "register");
const unregisters = (bus: { emitted: Array<Record<string, unknown>> }) =>
	bus.emitted.filter((event) => event.type === "unregister");

const usagePanel = {
	id: "hypercharm:usage" as const,
	title: "HyperCharm",
	rows: [{ text: "⚡ 1.24 hc · 7 req", role: "muted" as const }],
	defaults: { visible: true, after: "usage" },
};

// No emit before compatible discovery.
{
	resetSidebarRevisionsForTest();
	const bus = fakeBus();
	const publisher = createSidebarUsagePublisher(bus, "hypercharm:usage");
	publisher.update(usagePanel);
	assert.equal(registers(bus).length, 0);
	assert.equal(publisher.isCompatible(), false);
	publisher.dispose();
	assert.equal(unregisters(bus).length, 0);
}

// Default-placement metadata only after compatible discovery.
{
	resetSidebarRevisionsForTest();
	const bus = fakeBus();
	const publisher = createSidebarUsagePublisher(bus, "hypercharm:usage");
	publisher.update(usagePanel);
	bus.discover(["some-other-capability"]);
	assert.equal(registers(bus).length, 0);
	assert.equal(publisher.isCompatible(), false);
	bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
	assert.equal(publisher.isCompatible(), true);
	const first = registers(bus);
	assert.equal(first.length, 1);
	assert.deepEqual(
		{ ...first[0] },
		{
			version: 1,
			type: "register",
			source: "hypercharm",
			revision: 1,
			requestId: "atelier-1",
			panel: { id: "hypercharm:usage", title: "HyperCharm", rows: [{ text: "⚡ 1.24 hc · 7 req", role: "muted" }], defaults: { visible: true, after: "usage" } },
		},
	);
	publisher.dispose();
}

// Discovery replay with requestId echo and increasing revisions.
{
	resetSidebarRevisionsForTest();
	const bus = fakeBus();
	const publisher = createSidebarUsagePublisher(bus, "hypercharm:usage");
	publisher.update(usagePanel);
	bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
	bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
	const events = registers(bus);
	assert.equal(events.length, 2);
	assert.equal(events[0]?.revision, 1);
	assert.equal(events[1]?.revision, 2);
	assert.equal(events[1]?.requestId, "atelier-1");
	publisher.dispose();
}

// Updates with increasing revisions, withdraw, dispose.
{
	resetSidebarRevisionsForTest();
	const bus = fakeBus();
	const publisher = createSidebarUsagePublisher(bus, "hypercharm:usage");
	bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
	publisher.update(usagePanel);
	publisher.update({ ...usagePanel, rows: [{ text: "◆ 249 hc", role: "ready" }] });
	const events = registers(bus);
	assert.equal(events.length, 2);
	assert.equal(events[0]?.revision, 1);
	assert.equal(events[1]?.revision, 2);
	assert.deepEqual((events[1]?.panel as { rows: unknown }).rows, [{ text: "◆ 249 hc", role: "ready" }]);
	assert.equal(publisher.isPublished(), true);

	publisher.withdraw();
	assert.equal(unregisters(bus).length, 1);
	assert.deepEqual(
		{ ...unregisters(bus)[0] },
		{ version: 1, type: "unregister", source: "hypercharm", revision: 3, id: "hypercharm:usage" },
	);
	assert.equal(publisher.isPublished(), false);
	assert.equal(SIDEBAR_PANEL_EVENT_CHANNEL, "pi-atelier:sidebar-panels");

	publisher.update(usagePanel);
	assert.equal(registers(bus).length, 3);
	publisher.dispose();
	assert.equal(unregisters(bus).length, 2);
	publisher.update(usagePanel);
	assert.equal(registers(bus).length, 3);
}

// Revisions never decrease across publisher incarnations.
{
	resetSidebarRevisionsForTest();
	const bus = fakeBus();
	const first = createSidebarUsagePublisher(bus, "hypercharm:usage");
	bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
	first.update(usagePanel);
	first.dispose();
	const maxRevision = (list: Array<Record<string, unknown>>) =>
		Math.max(...list.map((event) => event.revision as number));
	assert.equal(maxRevision(bus.emitted), 2);

	const second = createSidebarUsagePublisher(bus, "hypercharm:usage");
	second.update(usagePanel);
	bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
	assert.ok(maxRevision(bus.emitted) > 2);
	second.dispose();
}

console.log("sidebar.smoke: all assertions passed");