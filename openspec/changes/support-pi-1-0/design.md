# Design

## Context

See `proposal.md` for motivation. Findings from running a scratch copy of this repo against Pi 1.0.0 (`@earendil-works/*` 1.0.0, Node 26):

| Check | Result on 1.0.0 |
|---|---|
| `tsc --noEmit` | clean, no source changes needed |
| `npm run smoke` (6 suites) | all pass |
| `npm test` | 97/98 pass; the failure is the clock-dependent deprecated-grace assertion (`tests/provider.integration.test.ts:221`) |
| Upstream `scripts/test-pi-compat.mjs` | fails at "providers register before session startup" |

Why the upstream probe fails: this fork calls `pi.registerProvider()` with a *complete native provider* (`createHypercharmProvider` in `provider.ts`, with `getModels`, `refreshModels`, `auth`, `streamSimple`, `currentCatalog`). Pi 1.0 queues that in `runtime.pendingNativeProviderRegistrations`. Upstream's script only reads `pendingProviderRegistrations`, which holds config-style registrations, so on this fork it sees zero providers. Upstream's extension is still config-style.

Host-API surface the extension imports, which determines what 1.0's removals could break:

- `@earendil-works/pi-ai`: `envApiKeyAuth`, `lazyOAuth`, and types
- `@earendil-works/pi-ai/compat`: `openAICompletionsApi`
- `@earendil-works/pi-coding-agent`: `getAgentDir` and `ExtensionAPI`/`ExtensionContext` types
- `@earendil-works/pi-tui`: `Text`

Pi 1.0 removed the `@earendil-works/pi-agent-core` `./node` and `./harness/*` exports, which broke other extensions. This fork imports nothing from `pi-agent-core`, so it is unaffected. All current peers are already `*`.

## Goals / Non-Goals

**Goals:**
- Make Pi 1.0.0 the pinned, verified development host with a repeatable offline check.
- Keep the shipped extension unchanged except for the footer-routing fix below (found during manual verification), unless the probe uncovers a real incompatibility.
- Make the suite pass today and stay passing as time moves on.

**Non-Goals:**
- Any new runtime feature (see "Pi 1.0 feature advice" below, which is advisory).
- Version bump, CHANGELOG, or mirroring upstream's release numbers.
- Supporting a range of host majors beyond the wildcard peers. The probe verifies one pinned version.
- Live-provider tests.

## Decisions

### D1. Exact dev pin `1.0.0`, wildcard peers unchanged
Dev dependencies move to exactly `1.0.0` for `pi-ai`, `pi-coding-agent` and `pi-tui`. Peers stay `*`.
- *Why*: reproducible CI, and the probe can assert `VERSION === "1.0.0"` against the pin. Wildcard peers avoid forcing users onto a specific host, matching how Pi warns against listing host packages in `dependencies`.
- *Alternatives*: `^1.0.0` dev ranges (drift between lockfile refreshes, probe version assertion becomes loose); a `>=1` peer range (Pi 0.x hosts are still in the wild, and a narrower range would block them for no tested reason).

### D2. Adapt the upstream probe to native registrations
Port `scripts/test-pi-compat.mjs` and change only registration discovery:
- Collect providers from `pendingNativeProviderRegistrations` (native; models via `provider.getModels()`) and from `pendingProviderRegistrations` (config-style; models via `config.models`). Assert at least one provider in total, which keeps the "register before session startup" failure message.
- Keep upstream's catalog-shape assertions (unique `type/id`, `api`, `baseUrl`, positive `contextWindow`/`maxTokens`, text input, finite non-negative costs) and its four transport probes: Unicode text, tool call, empty response, and abort. Each also asserts usage, `onPayload`, `onResponse` and `onProviderStreamEvent` hooks.
- Drive the transport through the host's `ModelRuntime.streamSimple` so the fork's namespaced `streamSimple` interceptor and max-tokens delegation are exercised, not bypassed.
- Keep `PI1_HOST_PACKAGE` and `PI1_HOST_ENTRY=bundle` so the same script can test an installed host's real and bundled runtime.
- *Alternative*: duplicate coverage inside `tests/provider.integration.test.ts` only. Rejected because the integration suite loads through the dev copy and cannot target an installed host or its bundled entry, which is where subpath-export breakages like 1.0's `./node` removal show up.
- *Open detail for apply*: confirm native models carry `type` (the chat/image/classifier discriminator). If absent, treat as chat, as Pi's own catalog code does.

### D3. Fix time-dependence by injecting the clock, not by editing data
`deprecated-models.json` is auto-generated and must not be hand-edited. The grace test instead pins `Date.now` for catalog loading only, to `max(deprecatedAt) + 24h`, and computes its fresh/stale partition from that same instant. This is what upstream did, and the stub is restored right after `loader.reload()` so timeouts and later provider work keep the real clock.
- *Alternative*: relax the assertion to allow zero fresh models. Rejected because it silently stops testing the grace window.

### D4. Shutdown before dispose
The test `load()` helper gains `shutdown()`, which emits `session_shutdown` and then calls `session.dispose()`. All test teardown calls it. The extension's `session_shutdown` handler clears the drift timer, status keys and widget, so skipping it left that path untested and diverged from the CLI.

### D5. CI runs the probe
Add `bun run test:pi` to `.github/workflows/check.yml` after `bun run check`. It is offline and takes a few seconds. `npm run check` itself is left unchanged so local `check` stays focused on the existing suites.

### D6. Manual check for the one 1.0 behavior change that touches our UI
Pi 1.0 makes the TUI fullscreen by default. Automated tests cannot cover footer, status-key and `setWidget` rendering inside a real fullscreen terminal, so apply includes one recorded manual check in both `tuiMode: "fullscreen"` and `"regular"`.

### D7. Footer fallback keys off sidebar-host presence only
`renderStatus` computed `sidebarCompatible = isCompatible() && isHyperCharmActive` and used it to decide whether sidebar-targeted parts fall back to the widget. With another provider active that was false, so with `hideOnOtherProvider: false` the panel was withdrawn *and* the widget appeared. The fallback now depends on `publisher().isCompatible()` alone; the panel's own provider gate in `buildSidebarPanel` is unchanged.
- *Alternative*: force `hideOnOtherProvider` semantics onto sidebar parts. Rejected: that option documents widget/statusbar-only scope, and the sidebar already follows model selection.

## Pi 1.0 feature advice (not in scope; for follow-up changes)

Ranked by value to this fork. None are implemented by this change.

1. **Virtual models: `hypercharm/auto` router.** Strongest fit. Pi 0.99 added `pi.registerVirtualModel()`, where `route(request, ctx)` picks a physical model and thinking level per request, with session-persisted router `state`, sticky `continuation`/`retry` routing to preserve prompt caches, and automatic footer display (`auto • high → kimi-k3 • medium`) plus per-physical-model cost in `/session`. For example, plan on DeepSeek V4 Pro or GLM 5.3, build on V4 Flash or Qwen3.8-Flash, and fail over to another family on an overload/`retry` reason. This complements Prism, which routes server-side inside Hyper and is only visible here after the fact via response headers. It is also marked experimental in 0.99 and 1.0's notes don't promote it, so a follow-up should first confirm stability and decide whether virtual-model turns still resolve cleanly through `currentProviderId()`, the ledger and prism attribution (assistant messages name the physical model, so they should).
2. **Per-model image input limits.** Data-only. 11 of the catalog's models accept images. Pi 0.87+ supports `inputLimits.images.resize` per model in `models.json`/patches, giving cache-safe resizing for attachments, `read` and tool-result images. Add entries in `patch.json` (never `models.json`) once Hyper's real per-model image limits are known. This needs input from Charm's docs or the maintainer.
3. **Account tool with deferred exposure.** Register a `hypercharm_account` tool (balance, rate-limit headroom, session spend) using 0.99's `exposure: "deferred"`/`"codemode"` and `annotations`, so agents, `codemode` scripts and fabric children can check budget before fanning out. `ctx.executeTool()` nested usage now rolls into session cost. This reuses `account.ts` and the ledger and adds no new data source.
4. **Theme-aware status meters.** Pi 0.99 added `theme.style()`, `theme.colors` and `appearance`, and made the `system` theme (terminal palette) the default. `status.ts` currently uses `fg("dim"|"warning")`. Meters could use theme colors for the low-balance and rate-limit gradient so they track light/dark switches. Cosmetic, low priority.
5. **`provider_stream_event` diagnostics.** A notification-only hook for each parsed provider event, before normalization. It could surface mid-stream usage or a Hyper-specific error shape earlier than `after_provider_response`. Only worth doing if Hyper emits fields not otherwise visible.
6. **Image and classifier model entries.** Pi's catalog now supports discriminated chat/image/classifier model types, and `generateImages()` is exposed to codemode. Only relevant if Hyper's `/v1/provider` starts publishing non-chat models. Today every entry is chat, and "Text + Image" in the README means image *input*. Revisit when the API changes.

Considered and not recommended: `context_with_system` and context-edit entries (no use case here); `registerMcpServer` (Hyper is not an MCP server); Pi Durable (separate package, overlaps the fabric ledger only superficially).

## Risks / Trade-offs

- [The `pi-ai/compat` import path name suggests a future deprecation] → The probe's streaming checks run against the real subpath on every host bump, so removal fails loudly instead of at user runtime.
- [Dev dependency bump pulls new transitive packages (`pi-codemode`, `pi-mcp`, `chord`, `openai` 7.x) and changes `bun.lock`] → Run `bun install --frozen-lockfile` in CI after regenerating the lockfile once. Peers are unaffected, so users are not forced to install anything.
- [Pinning one host version leaves 0.x and later 1.x hosts unverified] → Documented as "tested with Pi 1.0.0", and the probe's `PI1_HOST_PACKAGE` lets operators test other installed hosts.
- [Pinning `Date.now` during catalog load could mask a real clock-related bug] → The stub covers only `loader.reload()` and is restored in `finally`. The grace logic itself is still asserted against stored timestamps.
- [An unstable virtual-model API is a tempting early feature] → Kept explicitly out of scope until verified on 1.0.x.

## Migration Plan

Test, tooling and docs only, so there is nothing to deploy and no user migration. Rollback is reverting the dev pin and the added probe and CI step. If the probe uncovers a real runtime incompatibility during apply, stop and raise it as a separate, specified change instead of folding a behavior fix into this one.
