import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Exercise the real extension render path with the same synchronous event-bus
// ordering as Atelier's registry: discovery may occur after HyperCharm renders.
const agentDir = mkdtempSync(join(tmpdir(), "hypercharm-discovery-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));
const cacheDir = join(agentDir, "cache");
mkdirSync(cacheDir, { recursive: true });
const yyyyMMdd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
writeFileSync(join(cacheDir, `hypercharm-usage-${yyyyMMdd}.jsonl`), JSON.stringify({
  v: 1, lineage: "session:probe", agentId: "child", agentName: "child",
  ts: Date.now(), requests: 1, spendHc: 1,
}) + "\n");
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
after(() => { globalThis.fetch = originalFetch; });
const { default: factory } = await import("../index.ts");

function runtime() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const listeners = new Set<(event: unknown) => void>();
  const events: Array<any> = [];
  const widgets = new Map<string, unknown>();
  const statuses = new Map<string, unknown>();
  const pi = {
    events: {
      on: (_channel: string, listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (_channel: string, event: unknown) => {
        events.push(event);
        for (const listener of [...listeners]) listener(event);
      },
    },
    registerProvider: () => undefined,
    registerCommand: () => undefined,
    registerEntryRenderer: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  const ctx = {
    hasUI: true, model: { provider: "hypercharm" },
    sessionManager: { getSessionId: () => "probe" },
    modelRegistry: { getApiKeyForProvider: async () => undefined, getProviderAuth: async () => undefined },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (key: string, value: unknown) => { widgets.set(key, value); },
      setStatus: (key: string, value: unknown) => { statuses.set(key, value); },
      notify: () => undefined,
    },
  };
  return {
    pi, ctx, events, widgets, statuses,
    dispatch: async (name: string) => {
      for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
    },
    discover: () => pi.events.emit("pi-atelier:sidebar-panels", {
      version: 1, type: "discover", requestId: "atelier-probe-1", capabilities: ["panel-defaults-v1"],
    }),
  };
}

test("early compatible discovery avoids footer fallback", async () => {
  const r = runtime();
  factory(r.pi as any);
  r.discover();
  await r.dispatch("session_start");
  assert.ok(r.events.some((event) => event.type === "register"));
  assert.equal([...r.widgets.values()].at(-1), undefined);
});

// In Pi, all factories load before session_start, but Atelier's registry is
// created during its session_start. If HyperCharm's handler runs first, its
// fallback widget exists before Atelier sends discovery.
test("sidebar-only output clears fallback when Atelier discovers after initial render", async () => {
  const r = runtime();
  factory(r.pi as any);
  await r.dispatch("session_start");
  assert.equal(typeof [...r.widgets.values()].at(-1), "function", "fixture must have visible fallback usage");
  r.discover();
  assert.equal([...r.widgets.values()].at(-1), undefined, "widget must be cleared once Atelier is available");
  assert.ok(r.events.some((event) => event.type === "register"), "Atelier receives usage panel");
  assert.ok([...r.statuses.values()].every((status) => status === undefined), "sidebar-only must not use statusbar");
});

test("without usage there is no fallback content to leak", async () => {
  rmSync(join(cacheDir, `hypercharm-usage-${yyyyMMdd}.jsonl`));
  const r = runtime();
  factory(r.pi as any);
  await r.dispatch("session_start");
  assert.equal([...r.widgets.values()].at(-1), undefined);
  r.discover();
  assert.equal([...r.widgets.values()].at(-1), undefined);
});
