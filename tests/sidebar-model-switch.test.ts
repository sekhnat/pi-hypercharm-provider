import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Sidebar-targeted parts must never surface in the footer while a sidebar host
// is present — including after switching to another provider's model with
// hideOnOtherProvider off (the panel is withdrawn; the footer must stay empty).
const agentDir = mkdtempSync(join(tmpdir(), "hypercharm-model-switch-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));
mkdirSync(join(agentDir, "cache"), { recursive: true });
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "hypercharm.json"),
  JSON.stringify({ session: "sidebar", account: "sidebar", hideOnOtherProvider: false }),
);
const yyyyMMdd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
writeFileSync(join(agentDir, "cache", `hypercharm-usage-${yyyyMMdd}.jsonl`), JSON.stringify({
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
  const ctx: any = {
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
    pi, ctx, events,
    footerVisible: () =>
      typeof [...widgets.values()].at(-1) === "function" || [...statuses.values()].some((status) => status !== undefined),
    dispatch: async (name: string, event: unknown = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
    selectModel: async (provider: string) => {
      ctx.model = { provider };
      for (const handler of handlers.get("model_select") ?? []) await handler({ model: ctx.model }, ctx);
    },
    discover: () => pi.events.emit("pi-atelier:sidebar-panels", {
      version: 1, type: "discover", requestId: "atelier-probe-1", capabilities: ["panel-defaults-v1"],
    }),
  };
}

test("switching models with a sidebar host never shows the footer", async () => {
  const r = runtime();
  factory(r.pi as any);
  r.discover();
  await r.dispatch("session_start");
  assert.equal(r.footerVisible(), false, "HyperCharm active: sidebar only");

  await r.selectModel("anthropic");
  assert.equal(r.footerVisible(), false, "other provider active: sidebar parts must not fall back to the footer");
  assert.equal(r.events.at(-1).type, "unregister", "panel is withdrawn while another provider is active");

  await r.selectModel("hypercharm");
  assert.equal(r.footerVisible(), false, "back on HyperCharm: sidebar only");
  assert.equal(r.events.at(-1).type, "register", "panel is published again");
});

test("without a sidebar host the footer fallback is kept", async () => {
  const r = runtime();
  factory(r.pi as any);
  await r.dispatch("session_start");
  assert.equal(r.footerVisible(), true, "no host: sidebar parts fall back to the footer");
  await r.selectModel("anthropic");
  assert.equal(r.footerVisible(), true, "hideOnOtherProvider off: fallback stays on other providers");
});
