/**
 * Local wire contract for publishing the HyperCharm usage panel to Pi
 * Atelier's sidebar. Self-contained by design: no imports from pi-atelier.
 * The channel, protocol version, and capability string mirror the public seam
 * Atelier documents; event shapes are local structural types.
 *
 * The publisher:
 *   - subscribes to the discovery channel at factory time (load-order safe:
 *     Pi completes extension factory initialization before lifecycle events)
 *   - marks the host compatible only when discovery advertises the exact
 *     `panel-defaults-v1` capability
 *   - never emits default-placement metadata before that capability is seen
 *   - replays the current panel (with the discovery requestId) so loading
 *     either extension first converges without a restart
 *   - allocates per-source revisions that never decrease across publisher
 *     incarnations in the same runtime (hosts tombstone revisions per source)
 */

export const SIDEBAR_PANEL_EVENT_CHANNEL = "pi-atelier:sidebar-panels" as const;
export const SIDEBAR_PANEL_PROTOCOL_VERSION = 1 as const;
export const SIDEBAR_PANEL_DEFAULTS_CAPABILITY = "panel-defaults-v1" as const;

export type SidebarRowRole =
	| "primary"
	| "accent"
	| "muted"
	| "dim"
	| "ready"
	| "working"
	| "warning"
	| "error";

export interface SidebarRow {
	text: string;
	role?: SidebarRowRole;
}

export interface SidebarPanelContribution {
	id: `${string}:${string}`;
	title: string;
	rows: ReadonlyArray<string | SidebarRow>;
	role?: SidebarRowRole;
	defaults?: { visible: boolean; after?: string };
}

interface SidebarPanelRegisterEvent {
	version: typeof SIDEBAR_PANEL_PROTOCOL_VERSION;
	type: "register";
	source: string;
	revision: number;
	panel: SidebarPanelContribution;
	requestId?: string;
}

interface SidebarPanelUnregisterEvent {
	version: typeof SIDEBAR_PANEL_PROTOCOL_VERSION;
	type: "unregister";
	source: string;
	revision: number;
	id: SidebarPanelContribution["id"];
}

interface SidebarPanelDiscoveryEvent {
	version: typeof SIDEBAR_PANEL_PROTOCOL_VERSION;
	type: "discover";
	requestId: string;
	capabilities?: readonly string[];
}

export interface SidebarUsagePublisher {
	/** Publish or refresh the panel. No-op until a compatible host is seen. */
	update(panel: SidebarPanelContribution): void;
	/** Withdraw the panel while keeping the discovery subscription. */
	withdraw(): void;
	/** Stop listening and withdraw. The publisher must not be reused. */
	dispose(): void;
	/** Whether a defaults-capable host has been observed. */
	isCompatible(): boolean;
	/** Whether a panel is currently published. */
	isPublished(): boolean;
}

// Revisions must be monotonically increasing per source for the host to accept
// them, including across publisher incarnations inside one pi process. A
// module-level clock shared by every incarnation makes the guarantee trivial.
const sourceRevisions = new Map<string, number>();

function nextRevision(source: string): number {
	const next = (sourceRevisions.get(source) ?? 0) + 1;
	sourceRevisions.set(source, next);
	return next;
}

/** Test-only: reset the per-source revision clock (one pi runtime == one module instance). */
export function resetSidebarRevisionsForTest(): void {
	sourceRevisions.clear();
}

export interface EventTransport {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

function isDiscoveryEvent(value: unknown): value is SidebarPanelDiscoveryEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as SidebarPanelDiscoveryEvent).version === SIDEBAR_PANEL_PROTOCOL_VERSION &&
		(value as SidebarPanelDiscoveryEvent).type === "discover" &&
		typeof (value as SidebarPanelDiscoveryEvent).requestId === "string"
	);
}

/**
 * Create a usage-panel publisher bound to this runtime's event bus. One
 * publisher owns one stable panel ID; `update` takes the full panel and the
 * ID is taken from it.
 */
export function createSidebarUsagePublisher(
	events: EventTransport,
	panelId: SidebarPanelContribution["id"],
	options: { source?: string } = {},
): SidebarUsagePublisher {
	const source = options.source ?? (panelId.includes(":") ? panelId.slice(0, panelId.indexOf(":")) : panelId);
	let current: SidebarPanelContribution | undefined;
	let compatible = false;
	let disposed = false;

	const emitRegister = (requestId?: string): void => {
		if (disposed || !compatible || !current) return;
		events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: SIDEBAR_PANEL_PROTOCOL_VERSION,
			type: "register",
			source,
			revision: nextRevision(source),
			panel: current,
			...(requestId !== undefined && requestId.length > 0 && requestId.length <= 256 ? { requestId } : {}),
		} satisfies SidebarPanelRegisterEvent);
	};

	const emitUnregister = (): void => {
		if (disposed || !current) return;
		events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: SIDEBAR_PANEL_PROTOCOL_VERSION,
			type: "unregister",
			source,
			revision: nextRevision(source),
			id: current.id,
		} satisfies SidebarPanelUnregisterEvent);
	};

	const unsubscribe = events.on(SIDEBAR_PANEL_EVENT_CHANNEL, (data: unknown) => {
		if (disposed || !isDiscoveryEvent(data)) return;
		compatible =
			Array.isArray(data.capabilities) && data.capabilities.includes(SIDEBAR_PANEL_DEFAULTS_CAPABILITY);
		if (!compatible) return;
		emitRegister(data.requestId);
	});

	return {
		update(panel) {
			if (disposed) return;
			current = { ...panel, id: panelId };
			if (compatible) emitRegister();
		},
		withdraw() {
			if (disposed || !compatible || !current) return;
			emitUnregister();
			current = undefined;
		},
		dispose() {
			if (disposed) return;
			if (current !== undefined && compatible) emitUnregister();
			current = undefined;
			disposed = true;
			unsubscribe();
		},
		isCompatible: () => compatible,
		isPublished: () => !disposed && compatible && current !== undefined,
	};
}