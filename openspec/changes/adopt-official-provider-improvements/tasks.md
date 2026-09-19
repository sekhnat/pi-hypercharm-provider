# Tasks

## 1. Shared Hyper API foundation

- [x] 1.1 Add wildcard runtime peer declarations for `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` while retaining pinned dev dependencies; verify dependency resolution and `tsc --noEmit` succeed.
- [x] 1.2 Add `hyper.ts` as the single source for Hyper URLs, package-version user agent, and JSON headers while importing all shared-surface names from `identity.ts`; verify a focused test asserts the versioned user agent and that `tests/identity.test.ts` still passes.
- [x] 1.3 Add `schema.ts` with bounded TypeBox validation diagnostics and endpoint-safe path formatting; verify unit tests cover valid values, nested invalid paths, and truncation after the configured error count.
- [x] 1.4 Add `http.ts` with composed caller/timeout signals, response-body timeouts, typed HTTP/network/timeout/payload failures, safe OpenAI error extraction, and operation labels that never include dynamic URL secrets; verify `tests/http.test.ts` covers success, caller abort, request/body timeout, network error, non-2xx, empty/invalid JSON, and credential redaction.
- [x] 1.5 Implement defensive `Retry-After` parsing for integer seconds and canonical HTTP dates with a 24-hour cap; verify fake-clock HTTP tests cover past, current, excessive, malformed, and valid values.

## 2. OAuth authentication hardening

- [x] 2.1 Replace ad-hoc OAuth response checks with forward-compatible TypeBox schemas for device initiation, poll success/error variants, token expiry variants, and exact rejected-refresh payloads; verify malformed and additive-field fixtures are accepted or rejected according to `provider-authentication` and `hyper-api-reliability`.
- [x] 2.2 Route device initiation, polling, and token exchange through the shared Hyper HTTP client and implement cancellation-safe waits, first-poll delay, minimum cadence, `slow_down` increments, deadlines, and clock-drift timeout guidance; verify deterministic OAuth tests cover pending-to-success, slow-down, denial, expiry, HTTP failure, timeout, and cancellation without real one-second sleeps.
- [x] 2.3 Implement validated relative/absolute expiry buffering, initial refresh-token requirements, compatible refresh-token fallback/rotation, and team metadata preservation; verify tests assert expiry math, rotation, omitted rotation, expired tokens, and malformed token responses.
- [x] 2.4 Restrict re-login guidance to HTTP 401 with Hyper's exact rejected-refresh payload and preserve other failure classifications; verify tests distinguish exact rejection from generic/malformed 401, network failure, timeout, and abort.

## 3. Credential-scoped account status runtime

- [x] 3.1 Add `account.ts` with schemas and fetchers for credits, teams, and devices, including finite-value checks and `balance_usd * 20` conversion; verify unit tests cover Hypercredit/USD balances, valid empty collections, malformed payloads, and no partial mutation from invalid data.
- [x] 3.2 Implement credential epochs, leases, per-endpoint in-flight sharing, latest-invocation commit checks, and staged first snapshots after credential changes; verify race tests cover overlapping same-key refreshes, delayed auth, key A-to-B transitions, mixed team/balance prevention, and last-known snapshot retention.
- [x] 3.3 Implement provider deactivation and runtime disposal that abort obsolete account work and suppress lifecycle-cancellation warnings; verify tests cover provider switch, session replacement, shutdown, late responses, and stale UI contexts.
- [x] 3.4 Add per-endpoint transient retry state for network/timeout/408/429/5xx failures, server `Retry-After`, 5-second-to-5-minute exponential fallback, success/key-change reset, and forced manual bypass; verify fake-clock tests assert request counts and exact retry gates, including coalescing a manual refresh with compatible in-flight work.
- [x] 3.5 Rewire `index.ts` status-command, session/model, turn/settled, and Fabric drift triggers through the account runtime while preserving render destinations, usage deductions, rate headers, 402 handling, and child-ledger behavior; verify targeted smoke/integration tests prove inactive sessions and Fabric children make zero account calls and `/hypercharm-status refresh` updates existing surfaces.

## 4. Complete provider and catalog lifecycle

- [x] 4.1 Add strict provider-catalog schemas plus tested adapters between pure `JsonModel` values and full Pi runtime models, preserving namespaced API/provider/base URL/headers and rejecting an entire malformed live payload; verify `tests/models.smoke.ts` covers valid official fields, malformed required fields, unknown additive fields, and round-trip normalization.
- [x] 4.2 Implement a complete `hypercharm` Provider factory with `envApiKeyAuth`, lazily loaded OAuth, one mutable catalog snapshot, and a `ProviderStreams` adapter over `openAICompletionsApi()`; verify a focused runtime test asserts stored-key-over-env auth, env fallback, one provider registration, unchanged `API_NAME`, and delegated `max_tokens` behavior.
- [x] 4.3 Implement `refreshModels(context)` to restore Pi-stored models through current embedded/patch/custom/deprecation policy, honor `allowNetwork` and aborts, fetch and validate `/v1/provider`, and generation-check atomic in-memory/persisted publication; verify integration tests cover cache-only restore, successful refresh, cancellation, malformed/empty catalog rejection, and last-good retention.
- [x] 4.4 Keep the namespaced model cache as read-only startup/rollback input, stop manual cache writes after native publication, and ensure stored/custom/graveyard entries are normalized so expired models cannot re-enter; verify migration tests cover legacy-cache-only startup, Pi-store precedence, embedded-hash mismatch, custom models, patches, and 14-day eviction.
- [x] 4.5 Register the complete provider once at factory time and remove session-time re-registration, `cachedApiKey`, manual credential resolution, and ad-hoc catalog fetch paths; verify the real Pi integration harness sees model updates without provider/auth/stream replacement in TUI/RPC refresh and no catalog network request in cache-only print/JSON startup.

## 5. Diagnostics, compatibility, and release checks

- [x] 5.1 Route catalog, account, and persistence failures through the existing deduplicated notifier using safe classified messages, while treating lifecycle aborts and missing optional files as non-errors; verify `tests/notify.test.ts` plus integration probes cover deduplication, UI/stderr fallback, unsafe server-text omission, secret redaction, and last-known-state retention.
- [x] 5.2 Extend real-runtime co-installation coverage with `tests/fixtures/official-surface.ts` to assert disjoint provider/auth/command/status/widget/entry surfaces after the native-provider migration; verify `tests/identity.test.ts` and the co-install integration case pass unchanged public identifiers.
- [x] 5.3 Re-run custom-stream, Prism, status/sidebar, Fabric ledger, and maximum-token regression suites after removing global credential/catalog state; verify every existing focused smoke and node:test suite passes without editing `models.json`, `deprecated-models.json`, or generated README table rows.
- [x] 5.4 Update README prose outside `## Available Models` to describe Pi-managed catalog persistence/refresh and hardened OAuth/account behavior; verify the generated model table is byte-for-byte unchanged and documented commands/identifiers match `identity.ts`.
- [x] 5.5 Run `npm run check`, `openspec validate adopt-official-provider-improvements --strict`, and a package-content dry run; verify all commands pass and the package contains every runtime TypeScript/data file while excluding temporary comparison or test artifacts.
