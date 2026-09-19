# Design

## Context

See `proposal.md` for motivation and the five delta specs for behavior. The comparison used official `@charmland/pi-hyper-provider` v0.4.1 at commit `0016bc38af7d9fdc9eaa3daea8e3d1e01c4efb10` and Pi 0.85.1's current complete-provider API.

The official provider has three architectural advantages:

1. A complete Pi provider owns auth, transactional stored-model restoration, refresh policy, and streaming instead of re-registering a legacy provider from `session_start`.
2. One HTTP/TypeBox boundary classifies timeouts, network failures, HTTP responses, invalid JSON, and invalid endpoint payloads before state mutation.
3. Its credit runtime uses credential leases, cancellation, coalescing, latest-invocation commits, and transient retry delays.

HyperCharm already has behavior that must not regress: an embedded/offline catalog; patch, custom-model, and 14-day deprecation layers; a namespaced custom stream that captures usage, 402s, and rate headers; API-key team lookup; USD-to-Hypercredit conversion; richer sidebar/widget/statusbar presentation; Fabric child accounting; warning fallback across stale UI contexts; and co-installation with the official provider.

Current seams that motivate the design are `index.ts`'s session-level `cachedApiKey`, repeated `registerProvider` calls, separate ad-hoc catalog/account fetchers, and `oauth.ts`'s independently parsed fetch paths. The current namespaced model cache also carries release-specific embedded-hash reconciliation that Pi's generic model store does not encode.

## Goals / Non-Goals

**Goals:**

- Make `hypercharm` one stable complete provider while preserving every public identifier and the custom streaming metadata interceptor.
- Let Pi control cache-only versus network model refresh and generation-checked catalog publication.
- Put every Hyper control-plane response behind one bounded HTTP layer and endpoint schema before state changes.
- Make account refresh safe across concurrent lifecycle events, credential changes, provider switches, and disposal.
- Keep the pure catalog, status, Prism, sidebar, and ledger modules independently testable.
- Preserve a rollback-safe path for installations that only have the existing namespaced model cache.

**Non-Goals:**

- Replacing HyperCharm's rich status system with the official provider's simpler credit line.
- Removing `patch.json`, `custom-models.json`, `deprecated-models.json`, or their merge semantics.
- Changing provider/command/widget/status/auth/cache/ledger identifiers, model request compatibility, generated catalog files, or the generated README model table.
- Reimplementing OpenAI-compatible streaming; the wrapper continues delegating to Pi's `openAICompletionsApi()` implementation.
- Adopting the official package's Biome/mise/release tooling as part of this runtime change.

## Decisions

### 1. Register a complete native Provider, but keep HyperCharm's replacement catalog semantics

Create a focused provider factory (for example `provider.ts`) that returns Pi's complete `Provider` interface and register it once at extension-factory time. It owns:

- `id`/display name from `identity.ts`;
- API-key auth through `envApiKeyAuth` using `HYPERCHARM_API_KEY`;
- lazily loaded OAuth through `lazyOAuth`;
- a synchronous `getModels()` backed by one private current-catalog snapshot;
- `refreshModels(context)` using `context.stored`, `allowNetwork`, `credential`, `signal`, and generation-checked `publish()`;
- the existing namespaced streaming API implementation.

The provider factory will implement the small public `Provider` contract directly rather than use `createProvider` unchanged. `createProvider` merges an immutable baseline with a dynamic overlay; that is ideal for the official provider's empty baseline, but it cannot remove a model retained by HyperCharm's embedded/legacy baseline when local deprecation policy says it has expired. A provider-owned current snapshot gives refreshes full replacement semantics while still using Pi's standard auth, refresh, persistence, and publication lifecycle.

The legacy alternative—continuing to re-register from `session_start`—was rejected because it duplicates Pi's credential and model-store lifecycle, performs mode policy locally, and makes provider identity and in-flight work harder to reason about.

### 2. Restore and publish catalogs through one curation boundary

Keep `model-catalog.ts` free of Pi and network imports. Add explicit adapters between its `JsonModel` shape and Pi runtime models; the runtime adapter adds `provider`, namespaced `api`, `baseUrl`, and versioned headers only at the provider boundary.

Catalog selection proceeds as follows:

1. The factory's immediate fallback is the existing embedded catalog reconciled with the compatible namespaced cache, then passed through `buildModels()`.
2. On provider refresh, a valid `context.stored` list is projected back to catalog data, entries owned by current custom/graveyard sources are removed, the stored source is reconciled with this release's embedded metadata, and patch/custom/deprecation policy is reapplied. It is published as an in-memory replacement before network work.
3. If network access and a credential are available, `/v1/provider` is fetched and validated as one payload. The transformed live base is merged with embedded data and passed through the same policy. The final runtime list is atomically published and persisted to Pi's model store.
4. Any failure occurs before `publish()`, leaving the current snapshot untouched.

The namespaced cache becomes read-only compatibility input; new successful refreshes persist through Pi. It is not deleted automatically, so rollback to the current release still has a usable cache. Pi-stored data is always recurred through current patch/custom/deprecation policy, preventing an expired graveyard entry or old curated field from bypassing a new release.

Persisting only raw upstream models was considered, but Pi's standard model store is intended to restore provider-ready models. Persisting the fully curated list gives immediate offline model availability; re-normalizing it on restore keeps release policy authoritative.

### 3. Preserve the custom stream as an adapter over Pi's OpenAI implementation

Build a `ProviderStreams` object from `openAICompletionsApi()` and override only `streamSimple` with the existing per-request fetch interceptor. The interceptor continues to:

- delegate request construction, thinking compatibility, `max_tokens`, streaming, aborts, and error normalization to Pi;
- capture request count, rate-limit headers, 402 exhaustion, and Hypercredit usage from a tee of chat-completion responses;
- use the request-scoped `options.apiKey` resolved by the complete provider rather than a process-global fallback.

Models retain the namespaced `API_NAME`, so assistant/session records and co-installation behavior do not change. Reimplementing the stream or switching models to the shared `openai-completions` API id was rejected because either would duplicate Pi behavior or change a persisted identity.

### 4. Centralize endpoint identity, HTTP behavior, and schema parsing

Introduce narrowly scoped modules:

- `hyper.ts`: Hyper base URLs, package-derived user agent, and JSON/header helpers; it imports namespaced identity constants rather than redefining them.
- `http.ts`: `fetchJson`/`fetchJsonResponse`, composed timeout/caller signals, response-body reading, normalized `Retry-After`, and typed HTTP/timeout/network/payload failures.
- `schema.ts`: a small TypeBox validator-to-error adapter that reports at most a bounded set of useful paths.

HTTP errors are built from a caller-supplied operation label, not a raw URL. This avoids leaking a device code embedded in a polling URL. Only a strictly validated, bounded OpenAI-style error envelope can add server text. The common layer never formats request headers or bodies into an error.

Endpoint schemas stay next to their consumers (`provider.ts`, `account.ts`, and `oauth.ts`). They reject missing/wrong required fields and invalid ranges while allowing benign unknown properties for forward compatibility. Exact `additionalProperties: false` schemas, as used by parts of the official provider, were rejected because a harmless additive Hyper field should not take an otherwise healthy account or login path offline.

`typebox` will be declared as a runtime peer and pinned dev dependency, matching Pi's supported extension import surface. The currently imported Pi packages will also be declared as peers rather than relying only on development installation layout.

### 5. Move account acquisition into a credential-leased runtime

Create `account.ts` as a runtime with `refresh`, `deactivate`, and `dispose` operations plus injectable clock/sleep seams for tests. `index.ts` remains responsible for lifecycle wiring and rendering, while the runtime owns auth resolution and network state.

Each refresh resolves current provider auth through `ctx.modelRegistry.getProviderAuth(PROVIDER_ID)`. A lease contains the in-memory credential value plus a monotonically increasing epoch; secrets are never persisted, logged, or returned in diagnostics. A credential change increments the epoch and aborts prior controllers.

The runtime maintains per-endpoint in-flight work and retry state. Compatible same-credential requests share work. Commit checks require the runtime to be live, the lease to still own the credential epoch, and the invocation not to be superseded. Switching providers deactivates UI/account work; shutdown aborts and disposes it.

For the already committed credential, successful endpoint results may update their corresponding atoms independently. On a newly observed credential, results are staged until credits, teams, and devices complete a valid sweep (an empty valid team/device list still counts); only then is the new snapshot committed. This prevents a new balance from appearing under an old team or vice versa. If the sweep fails, the previous coherent snapshot remains intact.

Retry state is per endpoint and credential. Network/timeout/408/429/5xx failures set `retryAt` from valid `Retry-After` or exponential 5-second-to-5-minute backoff. Lifecycle-triggered refreshes consult the gate; the explicit status command bypasses it. No retry timer runs in the background—normal session/model/settled/drift events trigger the next eligible attempt, satisfying Pi's rule not to start factory-time background resources.

The current single `creditsInFlight`, `lastCreditsFetchAt`, and `metaFetched` flags were rejected as the long-term design because they do not identify the credential that owns their result or failure state.

### 6. Harden OAuth behind lazy native auth

`lazyOAuth` advertises OAuth without eagerly evaluating `oauth.ts`. On first login/refresh it loads functions that use the shared HTTP and schema layers.

The flow keeps the current device name and token-expiry buffer, while adopting the official provider's cancellation-safe sleep, first-poll delay, minimum interval, `slow_down` increment, clock-drift timeout guidance, token variants, rotation, team metadata preservation, and exact rejected-refresh-token match. A generic 401 remains an HTTP error; only the recognized Hyper payload becomes re-login guidance.

The endpoint variants will be represented as discriminated TypeBox unions. Login requires complete device/team identity and a refresh token. Refresh accepts a compatible response that omits token rotation and falls back to the stored refresh token.

### 7. Test pure boundaries first, then the real Pi runtime

Add node:test suites for the HTTP/schema layer, account runtime, and OAuth flow. Use injected clocks or bounded fake timers rather than the current OAuth smoke test's real one-second waits. Cover response-body timeouts, caller abort identity, safe/unsafe error details, `Retry-After` forms, malformed endpoint payloads, slow-down/deadline behavior, exact refresh rejection, credential races, coalescing, backoff, manual bypass, and disposal.

Extend `tests/provider.integration.test.ts` through `DefaultResourceLoader`, `ModelRuntime`, and `createAgentSession` to prove:

- one complete `hypercharm` provider registration and unchanged identities;
- embedded/legacy fallback, Pi-store restore, valid network refresh, malformed atomic rejection, and cache-only mode behavior;
- custom stream accounting and max-token behavior still traverse the real runtime auth path;
- inactive sessions and Fabric children make zero account calls;
- account state cannot cross credentials or survive disposal incorrectly;
- the official fixture remains co-installable.

Keep pure status/sidebar/ledger/Prism suites unchanged except where their harness must call the new account boundary. `npm run check` remains the acceptance command after targeted tests pass.

## Risks / Trade-offs

- **[Pi-store migration changes catalog precedence]** → Normalize every stored list through the current embedded merge plus patch/custom/deprecation pipeline, and retain the namespaced cache as a read-only rollback fallback.
- **[Strict validation rejects a provider deployment the lenient parser accepted]** → Require only documented fields/ranges, allow unknown additions, retain the last good state atomically, and surface a bounded diagnostic.
- **[Complete-provider migration could break the custom stream or auth precedence]** → Preserve `API_NAME`, wrap Pi's existing stream object rather than replace it, and test stored-key-over-env plus real runtime request dispatch.
- **[Staged first refresh for a changed credential may leave an old snapshot visible longer]** → Keep the old snapshot coherent and attributed; commit the new snapshot only after one valid sweep, with explicit refresh available to bypass retry gates.
- **[More peer dependencies can expose host version skew]** → Use wildcard peers as the official provider does, retain 0.85.1 dev pins for compilation/tests, and validate with the installed runtime integration suite.
- **[Backoff can delay automatic recovery]** → Honor explicit user refresh and reset immediately on success or credential change; cap local backoff at five minutes.
- **[The official provider evolves after the analyzed commit]** → Record the exact comparison commit, port behaviors rather than copy files blindly, and keep HyperCharm-specific tests as the authority.

## Migration Plan

1. Add and test `hyper.ts`, `http.ts`, and `schema.ts` without changing provider registration.
2. Refactor OAuth and account fetching onto those boundaries, preserving current event wiring and status output while adding race/backoff tests.
3. Introduce the complete provider factory and catalog adapters; register it once, then remove session-time re-registration, `cachedApiKey`, and manual cache writes.
4. On first run, serve the current embedded/namespaced fallback immediately. Pi's cache-only refresh restores any standard stored catalog; the next allowed successful network refresh writes the standard store.
5. Update package peers and README prose outside the generated model table, then run targeted tests, `npm run check`, strict OpenSpec validation, and a package-content sanity check.

Rollback is code-only: reinstalling the prior release restores legacy registration and can still read the untouched namespaced cache. Authentication, status configuration, ledger shards, patches, custom models, deprecated models, and registered names remain compatible; no destructive data migration is performed.
