# Pi Atelier Sidebar Panel — pi-hypercharm-provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish HyperCharm session and account state as a read-only Pi Atelier sidebar panel by default, with the below-editor widget as fallback and the existing `statusbar`/`off` modes unchanged.

**Architecture:** `status.ts` (pure presentation) gains a `sidebar` display mode as the new default plus a `buildSidebarRows` pure builder implementing layout C (session line, balance line, combined rate-limit/auth line; team name never included). A new pure `atelier.ts` module owns the local wire contract (capability detection plus a register/unregister publisher). `index.ts` routes each part to the panel, widget, or status bar based on compatible-host detection, keeping every existing lifecycle guard (epochs, stale-ctx swallowing, aborts, optimistic balance).

**Tech Stack:** TypeScript (no build step; sources ship as-is), `tsc --noEmit`, Node ≥ 23 native type-stripping for `tests/status.smoke.ts`.

**Spec:** https://github.com/sekhnat/pi-atelier/blob/design/provider-usage-sidebar/docs/superpowers/specs/2026-09-15-provider-usage-sidebar-design.md — the wire contract is inlined below so this plan is self-contained.

## Global Constraints

- Branch: `feat/pi-atelier-sidebar` (already checked out). Repo rules come from `AGENTS.md`.
- Per `AGENTS.md`: never edit `models.json` or the README model table; the correct files for this change are `index.ts`, `status.ts`, and the new `atelier.ts`.
- `status.ts` and `atelier.ts` stay pure modules: no pi imports, no network, structural interfaces only.
- Conventional commits; stage explicit paths; never `git add -A`.
- Verify with `npm run check` (runs `tsc --noEmit && node tests/status.smoke.ts`).
- Display routing invariants: the sidebar panel exists only while a HyperCharm model is the active provider (regardless of `hideOnOtherProvider`); the same metric never renders in two destinations; a part explicitly set to `widget`/`statusbar`/`off` keeps that destination; `sidebar` falls back to the widget only when no compatible host is present; panels publish in TUI mode only.

## Wire Contract Reference (from the Pi Atelier spec)

- Channel: `pi-atelier:sidebar-panels`; protocol version: `1`.
- Discovery (host → contributors): `{ version: 1, type: "discover", requestId: string, capabilities?: string[] }`. Only hosts advertising the capability `"panel-defaults-v1"` are compatible.
- Register (contributor → host): `{ version: 1, type: "register", source: "hypercharm", revision: number, panel: { id: "hypercharm:usage", title: "HyperCharm", rows: [{ text: string, role?: "dim" | "ready" | "warning" | "error" }], defaults: { visible: true, after: "usage" } }, requestId?: string }`.
- Unregister: `{ version: 1, type: "unregister", source: "hypercharm", revision: number, id: "hypercharm:usage" }`.
- `revision` must be a safe integer, strictly increasing per source per process.
- On a compatible discovery, contributors re-emit their current register with the event's `requestId`.
- Host sanitization limits: title ≤ 48 visible chars, ≤ 24 rows, row text ≤ 160 visible chars, ANSI stripped.

---

### Task 1: `sidebar` display mode and panel rows in status.ts

**Files:**
- Modify: `status.ts` (DisplayMode near line 20; DEFAULT_STATUS_CONFIG near line 33; new section after `buildAccountTiers` near line 196)
- Test: `tests/status.smoke.ts`

**Interfaces:**
- Produces: `type DisplayMode = "sidebar" | "widget" | "statusbar" | "off"`; `type SidebarPanelRole = "dim" | "ready" | "warning" | "error"`; `interface SidebarPanelRow { text: string; role?: SidebarPanelRole }`; `buildSidebarRows(stats: SessionStats | undefined, acc: AccountState | undefined, lowBalance: boolean): SidebarPanelRow[]`.

- [ ] **Step 1: Update the smoke tests (failing)**

In `tests/status.smoke.ts`, add `buildSidebarRows` to the import block from `"../status.ts"` (after `buildSessionLine,`).

Replace the two default-coercion assertion blocks:

```ts
assert.deepEqual(coerceStatusConfig(undefined), {
	session: "sidebar",
	account: "sidebar",
	hideOnOtherProvider: true,
	lowBalanceHc: 25,
});
assert.deepEqual(coerceStatusConfig({ session: "bogus", lowBalanceHc: -3 }), {
	session: "sidebar",
	account: "sidebar",
	hideOnOtherProvider: true,
	lowBalanceHc: 25,
});
```

Replace `assert.deepEqual(coerceStatusConfig(null).session, "widget");` with:

```ts
assert.deepEqual(coerceStatusConfig(null).session, "sidebar");
assert.equal(coerceStatusConfig({ session: "widget" }).session, "widget");
assert.equal(coerceStatusConfig({ session: "sidebar" }).session, "sidebar");
```

Add before the final `console.log("status.smoke: all assertions passed")` line:

```ts
// ── sidebar panel rows ──
assert.deepEqual(buildSidebarRows({ requests: 7, spendHc: 1.24 }, full, false), [
	{ text: "⚡ 1.24 hc · 7 req", role: "dim" },
	{ text: "◆ 249 hc", role: "ready" },
	{ text: "996/1k/h · 10k/10k/d · 29d", role: "dim" },
]);
assert.deepEqual(buildSidebarRows(undefined, undefined, false), []);
assert.deepEqual(buildSidebarRows({ requests: 1, spendHc: 0 }, undefined, false), [
	{ text: "⚡ 0 hc · 1 req", role: "dim" },
]);
assert.deepEqual(buildSidebarRows(undefined, acc({ balance: 12 }), true), [
	{ text: "⚠ ◆ 12 hc", role: "warning" },
]);
for (const row of buildSidebarRows(undefined, acc({ balance: 249, teamName: "ACME", rate, authDaysLeft: 3 }), false)) {
	assert.ok(!row.text.includes("ACME"), "sidebar rows must omit the team name");
}
assert.deepEqual(buildSidebarRows(undefined, acc({ rate, authDaysLeft: 3 }), false), [
	{ text: "996/1k/h · 10k/10k/d · 3d", role: "dim" },
]);
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run: `npm run smoke`
Expected: FAIL — `buildSidebarRows` is not exported from `../status.ts`, and the coercion defaults still expect `"widget"`.

- [ ] **Step 3: Implement the mode and row builder**

In `status.ts`, change the display mode type and mode set:

```ts
export type DisplayMode = "sidebar" | "widget" | "statusbar" | "off";
```

```ts
const VALID_MODES = new Set<string>(["sidebar", "widget", "statusbar", "off"]);
```

Change the defaults (and update the two field doc comments to mention the sidebar destination):

```ts
export const DEFAULT_STATUS_CONFIG: StatusConfig = {
	session: "sidebar",
	account: "sidebar",
	hideOnOtherProvider: true,
	lowBalanceHc: 25,
};
```

After `buildAccountTiers`, before the `// ─── Terminal width math ───` banner, add:

```ts
// ─── Sidebar panel rows (Pi Atelier) ─────────────────────────────────────────

/** Semantic roles accepted by the Pi Atelier sidebar host. */
export type SidebarPanelRole = "dim" | "ready" | "warning" | "error";

export interface SidebarPanelRow {
	text: string;
	role?: SidebarPanelRole;
}

/**
 * Structured rows for the Pi Atelier usage panel (layout C): session line,
 * balance line, then a combined rate-limit/auth line. Pass `stats` or `acc`
 * as undefined when that part is not sidebar-targeted, so callers control
 * exactly which metrics land in the panel. The team name is never included;
 * missing account atoms are omitted, never placeholder-filled.
 */
export function buildSidebarRows(
	stats: SessionStats | undefined,
	acc: AccountState | undefined,
	lowBalance: boolean,
): SidebarPanelRow[] {
	const rows: SidebarPanelRow[] = [];
	const session = stats === undefined ? undefined : buildSessionLine(stats);
	if (session !== undefined) rows.push({ text: session, role: "dim" });
	if (acc !== undefined && accountHasData(acc)) {
		if (acc.balance !== null) {
			const gem = lowBalance ? "⚠ ◆" : "◆";
			rows.push({ text: `${gem} ${formatBalHc(acc.balance)} hc`, role: lowBalance ? "warning" : "ready" });
		}
		const atoms: string[] = [];
		if (acc.rate !== null) {
			atoms.push(
				`${formatRateCompact(acc.rate.remainingHour)}/${formatRateCompact(acc.rate.limitHour)}/h`,
				`${formatRateCompact(acc.rate.remainingDay)}/${formatRateCompact(acc.rate.limitDay)}/d`,
			);
		}
		if (acc.authDaysLeft !== null) atoms.push(`${acc.authDaysLeft}d`);
		if (atoms.length > 0) rows.push({ text: atoms.join(" · "), role: "dim" });
	}
	return rows;
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npm run smoke`
Expected: PASS — all assertions, including the pre-existing widget and tier suites.

- [ ] **Step 5: Commit**

```bash
git add status.ts tests/status.smoke.ts
git commit -m "feat(status): add sidebar display mode and panel rows"
```

### Task 2: Atelier wire-contract adapter

**Files:**
- Create: `atelier.ts`
- Test: `tests/status.smoke.ts`

**Interfaces:**
- Produces: `SIDEBAR_PANEL_EVENT_CHANNEL`, `SIDEBAR_PANEL_PROTOCOL_VERSION`, `SIDEBAR_PANEL_DEFAULTS_CAPABILITY`, `HYPERCHARM_USAGE_PANEL_ID`, `isCompatibleDiscovery(data: unknown): boolean`, `createSidebarPanelPublisher(events: SidebarEventBus): SidebarPanelPublisher` where `SidebarPanelPublisher = { publish(rows: readonly { text: string; role?: "dim" | "ready" | "warning" | "error" }[]): void; dispose(): void }`.

- [ ] **Step 1: Write the failing smoke assertions**

In `tests/status.smoke.ts`, add to the imports from `"../atelier"` (new import statement after the `../status` import):

```ts
import {
	createSidebarPanelPublisher,
	isCompatibleDiscovery,
	SIDEBAR_PANEL_DEFAULTS_CAPABILITY,
	SIDEBAR_PANEL_EVENT_CHANNEL,
} from "../atelier";
```

Add before the final `console.log` line:

```ts
// ── atelier panel publisher ──
{
	const emitted: unknown[] = [];
	const listeners = new Set<(data: unknown) => void>();
	const events = {
		on: (_channel: string, handler: (data: unknown) => void) => {
			listeners.add(handler);
		return () => listeners.delete(handler);
		},
		emit: (_channel: string, data: unknown) => {
			emitted.push(data);
			for (const listener of [...listeners]) listener(data);
		},
	};
	const publisher = createSidebarPanelPublisher(events);
	publisher.publish([{ text: "⚡ 1.24 hc · 7 req", role: "dim" }]);
	const register = emitted.find((data) => (data as { type?: string }).type === "register") as {
		source?: string;
		revision?: number;
		panel?: { id?: string; title?: string; defaults?: { visible: boolean; after: string } };
	};
	assert.equal(register.source, "hypercharm");
	assert.equal(register.revision, 1);
	assert.equal(register.panel?.id, "hypercharm:usage");
	assert.equal(register.panel?.title, "HyperCharm");
	assert.deepEqual(register.panel?.defaults, { visible: true, after: "usage" });
	assert.ok(
		isCompatibleDiscovery({ version: 1, type: "discover", requestId: "atelier-1", capabilities: ["panel-defaults-v1"] }),
	);
	assert.ok(!isCompatibleDiscovery({ version: 1, type: "discover", requestId: "atelier-1" }));
	events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
		version: 1,
		type: "discover",
		requestId: "atelier-2",
		capabilities: [SIDEBAR_PANEL_DEFAULTS_CAPABILITY],
	});
	const replay = emitted.at(-1) as { type?: string; requestId?: string; revision?: number };
	assert.equal(replay.type, "register");
	assert.equal(replay.requestId, "atelier-2");
	assert.equal(replay.revision, 2);
	publisher.publish([]);
	const withdrawn = emitted.at(-1) as { type?: string };
	assert.equal(withdrawn.type, "unregister");
	publisher.dispose();
}
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run: `npm run smoke`
Expected: FAIL — `../atelier` does not exist.

- [ ] **Step 3: Implement the adapter**

Create `atelier.ts`:

```ts
/**
 * Pi Atelier sidebar panel adapter for pi-hypercharm-provider.
 *
 * Publishes the HyperCharm usage panel over Pi's shared event bus using the
 * public `pi-atelier:sidebar-panels` protocol. Pure module: no pi imports,
 * no network — callers resolve state and decide when to publish. A host is
 * only treated as compatible when its discovery event advertises the
 * panel-defaults capability.
 */

export const SIDEBAR_PANEL_EVENT_CHANNEL = "pi-atelier:sidebar-panels" as const;
export const SIDEBAR_PANEL_PROTOCOL_VERSION = 1 as const;
export const SIDEBAR_PANEL_DEFAULTS_CAPABILITY = "panel-defaults-v1" as const;
export const HYPERCHARM_USAGE_PANEL_ID = "hypercharm:usage" as const;
const PANEL_SOURCE = "hypercharm" as const;
const PANEL_TITLE = "HyperCharm" as const;

export interface SidebarPanelRow {
	text: string;
	role?: "dim" | "ready" | "warning" | "error";
}

export interface SidebarEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True only for a discovery event from a host that honors contribution defaults. */
export function isCompatibleDiscovery(data: unknown): boolean {
	return (
		isRecord(data) &&
		data.version === SIDEBAR_PANEL_PROTOCOL_VERSION &&
		data.type === "discover" &&
		typeof data.requestId === "string" &&
		data.requestId !== "" &&
		Array.isArray(data.capabilities) &&
		data.capabilities.includes(SIDEBAR_PANEL_DEFAULTS_CAPABILITY)
	);
}

export interface SidebarPanelPublisher {
	/** Publish (or update) the panel; an empty row list withdraws it. */
	publish(rows: readonly SidebarPanelRow[]): void;
	dispose(): void;
}

export function createSidebarPanelPublisher(events: SidebarEventBus): SidebarPanelPublisher {
	let revision = 0;
	let registered = false;
	let currentRows: readonly SidebarPanelRow[] | undefined;
	let disposed = false;

	const emitRegister = (requestId?: string): void => {
		if (disposed || currentRows === undefined) return;
		revision += 1;
		registered = true;
		events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: SIDEBAR_PANEL_PROTOCOL_VERSION,
			type: "register",
			source: PANEL_SOURCE,
			revision,
			panel: {
				id: HYPERCHARM_USAGE_PANEL_ID,
				title: PANEL_TITLE,
				rows: currentRows.map((row) => ({ text: row.text, ...(row.role ? { role: row.role } : {}) })),
				defaults: { visible: true, after: "usage" },
			},
			...(requestId !== undefined ? { requestId } : {}),
		});
	};

	const withdraw = (): void => {
		if (disposed || !registered) return;
		revision += 1;
		registered = false;
		events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: SIDEBAR_PANEL_PROTOCOL_VERSION,
			type: "unregister",
			source: PANEL_SOURCE,
			revision,
			id: HYPERCHARM_USAGE_PANEL_ID,
		});
	};

	const unsubscribe = events.on(SIDEBAR_PANEL_EVENT_CHANNEL, (data) => {
		if (!isCompatibleDiscovery(data)) return;
		emitRegister(data.requestId);
	});

	return {
		publish(rows) {
			if (disposed) return;
			if (rows.length === 0) {
				currentRows = undefined;
				withdraw();
				return;
			}
			currentRows = rows;
			emitRegister();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			currentRows = undefined;
			withdraw();
		},
	};
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npm run smoke`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add atelier.ts tests/status.smoke.ts
git commit -m "feat: add pi-atelier sidebar panel publisher"
```

### Task 3: Display routing in index.ts

**Files:**
- Modify: `index.ts`

This repo has no unit-test harness for `index.ts`; this task's verification cycle is the full `npm run check` (typecheck plus the Task 1/2 smoke suites) plus the Task 5 cross-repo TUI smoke. Keep every existing lifecycle guard (epoch checks, stale-ctx swallowing, aborts) — the routing change is additive.

- [ ] **Step 1: Add imports and module state**

Extend the `./status` import block with `buildSidebarRows,` (after `buildSessionLine,`) and `type DisplayMode,` `type SidebarPanelRow,` (with the other type imports). Add a new import after it:

```ts
import {
	createSidebarPanelPublisher,
	isCompatibleDiscovery,
	SIDEBAR_PANEL_EVENT_CHANNEL,
	type SidebarPanelPublisher,
} from "./atelier";
```

Next to `let statusConfig: StatusConfig = { ...DEFAULT_STATUS_CONFIG };` (near line 436), add:

```ts
// True once a pi-atelier discovery event advertising the panel-defaults
// capability is observed. Only such a host may own the sidebar display.
let atelierHostAvailable = false;
let usagePublisher: SidebarPanelPublisher | undefined;
let lastStatusCtx: ExtensionContext | undefined;
```

- [ ] **Step 2: Capture the render context and add routing helpers**

Change `updateStatus` to remember the context (the existing stale-ctx swallow stays):

```ts
function updateStatus(ctx: ExtensionContext): void {
	lastStatusCtx = ctx;
	try {
		renderStatus(ctx);
	} catch (err) {
		if (!isStaleCtxError(err)) throw err;
	}
}
```

Above `renderStatus`, add:

```ts
/** Resolve where a display part actually renders: sidebar falls back to the widget without a compatible host. */
function effectiveMode(mode: DisplayMode): DisplayMode {
	if (mode !== "sidebar") return mode;
	return atelierHostAvailable ? "sidebar" : "widget";
}

/** Publish (or withdraw) the HyperCharm usage panel; the publisher is bound in the factory. */
function publishUsagePanel(rows: readonly SidebarPanelRow[]): void {
	usagePublisher?.publish(rows);
}
```

- [ ] **Step 3: Replace renderStatus**

Replace the entire `renderStatus` function with:

```ts
function renderStatus(ctx: ExtensionContext): void {
	const provider = currentProviderId(ctx);
	const hiddenByOtherProvider =
		statusConfig.hideOnOtherProvider && provider !== undefined && provider !== PROVIDER_ID;

	const clearLegacy = () => {
		ctx.ui.setStatus(STATUS_KEY_SESSION, undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	if (hiddenByOtherProvider) {
		clearLegacy();
		publishUsagePanel([]);
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

	// Sidebar contributions exist only while a HyperCharm model is the active
	// provider and only in TUI mode, regardless of hideOnOtherProvider. A
	// sidebar-targeted part falls back to the widget when no compatible
	// pi-atelier host has advertised itself, so a metric never doubles up.
	const sessionDest = effectiveMode(statusConfig.session);
	const accountDest = effectiveMode(statusConfig.account);
	const sidebarWanted =
		provider === PROVIDER_ID &&
		ctx.mode === "tui" &&
		(sessionDest === "sidebar" || accountDest === "sidebar");
	const panelRows = sidebarWanted
		? buildSidebarRows(
				sessionDest === "sidebar" ? sessionStats : undefined,
				accountDest === "sidebar" && accountVisible ? account : undefined,
				lowBalance,
			)
		: [];
	publishUsagePanel(panelRows);

	// Status bar (built-in footer slots) — destinations unchanged
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

	// Below-editor widget (two-zone, width-aware) — sidebar parts render here
	// only as the no-host fallback
	const leftW = sessionDest === "widget" ? sessionLine : undefined;
	const rightW = accountDest === "widget" && accountVisible ? accTiers : undefined;
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
```

- [ ] **Step 4: Wire the factory listener and publisher**

Inside `export default function (pi: ExtensionAPI) {`, after the `pi.registerCommand("hypercharm-status", …)` block and before `pi.on("session_start", …)`, add:

```ts
	// Pi Atelier announces itself on the shared event bus. Only a host that
	// advertises the panel-defaults capability may own the sidebar display;
	// re-render so a late-arriving host flips the widget fallback immediately.
	pi.events.on(SIDEBAR_PANEL_EVENT_CHANNEL, (data) => {
		if (!isCompatibleDiscovery(data) || atelierHostAvailable) return;
		atelierHostAvailable = true;
		if (lastStatusCtx !== undefined) updateStatus(lastStatusCtx);
	});

	// Rebind the panel publisher to this runtime's event bus (the factory
	// re-runs on /reload); withdrawing on the old bus is harmless.
	usagePublisher?.dispose();
	usagePublisher = createSidebarPanelPublisher(pi.events);
```

- [ ] **Step 5: Withdraw on shutdown**

In the `session_shutdown` handler, after `ctx.ui.setWidget(WIDGET_KEY, undefined);`, add:

```ts
		publishUsagePanel([]);
```

- [ ] **Step 6: Accept the new mode in the command**

Change `STATUS_USAGE` to:

```ts
const STATUS_USAGE =
	"Usage: /hypercharm-status [session|account sidebar|widget|statusbar|off · hide true|false · lowBalance <hc>|off · refresh · reset]";
```

In `handleStatusCommand`, extend the value validation:

```ts
		if (value !== "sidebar" && value !== "widget" && value !== "statusbar" && value !== "off") {
```

In `configureStatusInteractive`, change the modes array:

```ts
	const modes = ["sidebar", "widget", "statusbar", "off"] as const;
```

- [ ] **Step 7: Update the header documentation**

In the `index.ts` header comment, replace the `Display Configuration:` block's mode lines with:

```ts
 *   {
 *     "session": "sidebar",            // "sidebar" | "widget" | "statusbar" | "off"
 *     "account": "sidebar",            // "sidebar" | "widget" | "statusbar" | "off"
 *     "hideOnOtherProvider": true,    // hide when a non-HyperCharm model is active
 *     "lowBalanceHc": 25              // warn threshold, null/false disables
 *   }
 *
 *   - "sidebar" (default): published as a read-only panel to Pi Atelier's
 *     sidebar over the pi-atelier:sidebar-panels event protocol; falls back
 *     to the below-editor widget when no compatible Atelier host is loaded.
 *     Sidebar panels appear only while a HyperCharm model is active,
 *     regardless of hideOnOtherProvider, and never include the team name.
 *   - "widget": rendered in the below-editor status line
 *   - "statusbar": rendered in the built-in pi status bar
 *   - "off": hidden entirely (account=off also skips balance/quota fetches)
 *
 *   Manage interactively with /hypercharm-status, or non-interactively:
 *     /hypercharm-status session sidebar|widget|statusbar|off
 *     /hypercharm-status account sidebar|widget|statusbar|off
```

- [ ] **Step 8: Run the full check**

Run: `npm run check`
Expected: `tsc --noEmit` passes and `node tests/status.smoke.ts` prints `status.smoke: all assertions passed`.

- [ ] **Step 9: Commit**

```bash
git add index.ts
git commit -m "feat: route status parts to the pi-atelier sidebar"
```

### Task 4: Documentation and push

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

In the Configuration section, replace the settings table with:

```markdown
| Setting | Values | Default |
|---------|--------|---------|
| `session` | `sidebar` \| `widget` \| `statusbar` \| `off` | `sidebar` |
| `account` | `sidebar` \| `widget` \| `statusbar` \| `off` | `sidebar` |
| `hideOnOtherProvider` | `true` \| `false` | `true` |
| `lowBalanceHc` | number \| `null` | `25` |
```

After the non-interactive toggles code block, add:

```markdown
`sidebar` (the default) publishes session spend and account state as a read-only panel (`hypercharm:usage`) to [Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier)'s sidebar, placed after its Usage panel. Without a compatible Atelier host, `sidebar` falls back to the below-editor widget. Sidebar panels appear only while a HyperCharm model is active, regardless of `hideOnOtherProvider`, and never include the team name.
```

Update the two `/hypercharm-status session …` toggle examples to include `sidebar` in their value lists.

- [ ] **Step 2: Run the check and commit**

Run: `npm run check`
Expected: PASS (docs-only change; smoke still green).

```bash
git add README.md
git commit -m "docs: document the sidebar display mode"
git push -u origin feat/pi-atelier-sidebar
```

Expected: branch `feat/pi-atelier-sidebar` pushed to `sekhnat/pi-hypercharm-provider` with four commits.

### Task 5: Cross-repo TUI smoke verification (manual)

**Files:** none — this is the end-to-end verification gate from the spec. Run it only after the Atelier plan (`feat/panel-defaults`) and the pi-ollama-cloud plan are also complete. No commit.

Preconditions: all three checkouts on their feature branches under `/home/caan9/Projects/`; Pi Atelier has `npm install` run once.

- [ ] **Step 1: Launch all three extensions together**

```bash
cd /home/caan9/Projects/pi-atelier
npx --no-install pi -e . -e /home/caan9/Projects/pi-ollama-cloud -e /home/caan9/Projects/pi-hypercharm-provider
```

- [ ] **Step 2: Verify the Ollama panel**

With an Ollama Cloud model active and an API key configured (`OLLAMA_API_KEY` or `auth.json`), confirm: the sidebar shows an OLLAMA CLOUD panel immediately after the USAGE panel with quota-bar rows (`5h ▕████░░░░░░▏ 40%` style), and the footer carries no `ollama-usage` status. Without an API key, instead run `/ollama-cloud-usage`, confirm the underlying error is reported, and confirm neither the panel nor a footer status lingers.

- [ ] **Step 3: Verify the HyperCharm panel and provider switching**

Switch to a HyperCharm model with `/model` and send one turn. Confirm: the OLLAMA CLOUD panel disappears; a HYPERCHARM panel appears after USAGE with the session line (`⚡ … hc · N req`), the balance line (`◆ … hc`), and the combined rate/auth line — and no team name. Switch back to the Ollama model: the HYPERCHARM panel disappears. Without a HyperCharm API key, confirm instead that no HYPERCHARM panel appears (activity gating) and the widget fallback stays empty.

- [ ] **Step 4: Verify settings persistence**

Open `/atelier` → Display. Confirm both contributed panels are listed as shown (●). Hide one, save, and confirm it disappears from the sidebar. Restart pi and confirm it stays hidden (explicit configuration beats contribution defaults). Reorder one panel, save, and confirm the order persists.

- [ ] **Step 5: Verify fallbacks without the host**

Exit and start pi with only the two providers:

```bash
npx --no-install pi -e /home/caan9/Projects/pi-ollama-cloud -e /home/caan9/Projects/pi-hypercharm-provider
```

Confirm: with an Ollama model active, the footer status bar fallback appears (same quota-bar text); with a HyperCharm model active after one turn, the below-editor widget appears with the session/account line — no sidebar panel in either case.

- [ ] **Step 6: Verify command routing**

Back in the three-extension session: run `/ollama-usage-status off` and confirm both Ollama displays clear; run `/ollama-usage-status sidebar` and confirm the panel returns. Run `/hypercharm-status session widget` and confirm the session line moves to the widget while the panel keeps only balance/rate rows; run `/hypercharm-status session sidebar` and confirm the panel is whole again.

- [ ] **Step 7: Record completion**

Tick every checkbox above, then update the PRD issue (michaelmjhhhh/pi-atelier#47) with a comment summarizing the verified behaviors and the three branch names.
