# Proposal

## Why

The official `@charmland/pi-hyper-provider` v0.4.1 (commit `0016bc38af7d9fdc9eaa3daea8e3d1e01c4efb10`) now has stronger provider-lifecycle, HTTP, schema-validation, OAuth, and account-refresh foundations than HyperCharm's duplicated fetch paths. Adopting those systems will reduce stale-state and malformed-response risks while retaining HyperCharm's richer catalog policy, status surfaces, Fabric accounting, and collision-free `hypercharm` identity.

## What Changes

- Replace repeated legacy provider re-registration and session-owned catalog refresh with a complete Pi provider that owns authentication, model restoration/refresh, and the existing custom streaming adapter. Pi's standard model store becomes the primary persisted dynamic catalog, while the current embedded catalog and namespaced cache remain safe startup/migration fallbacks.
- Add a shared Hyper JSON client with consistent `User-Agent`/JSON headers, caller-abort plus request-timeout composition, typed failure classes, bounded safe server error details, response-body validation, and `Retry-After` parsing.
- Validate provider catalog, credits, team, device, device-flow, and token-exchange payloads before they can update models, credentials, or status state.
- Harden OAuth device login and refresh with server-directed polling, cancellation-safe waits, `slow_down` handling, expiry validation/buffering, refresh-token rotation, preserved team metadata, and precise detection of an actually rejected refresh token.
- Move account metadata refresh into a credential-scoped runtime that coalesces same-credential work, aborts obsolete work, prevents cross-account attribution, retains last-known data on failure, and backs off transient failures while allowing explicit refreshes.
- Expand unit and real-runtime integration coverage for timeout/abort/error parsing, malformed payloads, catalog restoration, OAuth edge cases, credential changes, retry/backoff, lifecycle disposal, and co-installation.
- Declare the runtime peer dependencies used by the new native-provider and schema-validation paths and document the changed refresh/persistence behavior outside the generated README model table.

No registered identifier, auth key, environment variable, command, persisted status setting, model compatibility override, status layout, Fabric ledger behavior, or Prism entry format changes.

## Capabilities

### New Capabilities

- `hyper-api-reliability`: Consistent bounded HTTP behavior, safe error handling, and runtime validation for Hyper control-plane endpoints.
- `provider-authentication`: API-key and OAuth login/refresh behavior under the namespaced HyperCharm provider.
- `account-status-refresh`: Race-safe, credential-scoped, retry-aware acquisition of balance, team, and device-session metadata.

### Modified Capabilities

- `model-catalog`: Move live restoration and refresh onto Pi's complete-provider/model-store lifecycle and reject malformed live catalogs atomically while preserving local catalog policy and offline fallbacks.
- `provider-diagnostics`: Surface classified, sanitized network/HTTP/payload failures without warning on lifecycle cancellation or discarding last-known state.

## Impact

- **Provider/runtime:** `index.ts` and a focused provider/API runtime split will change; `identity.ts`, the custom stream wrapper's namespace, and every registered identifier remain stable.
- **Networking/auth:** `oauth.ts` and new shared HTTP/schema modules will own all non-streaming Hyper requests.
- **Catalog/status:** `model-catalog.ts` remains the pure curation pipeline; account fetching moves out of `index.ts` without changing `status.ts`, `sidebar.ts`, `ledger.ts`, `patch.json`, or `custom-models.json` semantics.
- **Persistence:** Pi's standard model store becomes primary; the existing namespaced model cache is retained only as a compatible startup/migration fallback. Existing status config and usage ledger paths are unchanged.
- **Dependencies/tests/docs:** `package.json`, targeted pure tests, runtime integration tests, OAuth/status smoke coverage, and README prose are affected. Auto-generated `models.json`, `deprecated-models.json`, and the README model table are not hand-edited.
