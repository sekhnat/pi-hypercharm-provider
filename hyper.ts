/**
 * Single source for Hyper endpoint identity and shared request headers.
 *
 * Every non-streaming Hyper URL, the package-version user agent, and the JSON
 * header set are defined here exactly once so the HTTP layer (http.ts) and its
 * consumers (oauth.ts, provider.ts, account.ts) cannot drift apart. The user
 * agent is the extension's npm package name and version — the same
 * "pi-hypercharm-provider/x.y.z" string every previous fetch path sent — so
 * Hyper sees one consistent client identity across catalog, OAuth, and
 * account requests.
 *
 * No shared-surface identifier is defined here: every registered name this
 * module references comes from identity.ts (see the namespacing note on
 * USER_AGENT — the package name is derived from PROVIDER_ID by convention and
 * asserted in tests/hyper.test.ts).
 */
import { hostname } from "node:os";
import pkg from "./package.json" with { type: "json" };

/** Root of the Charm Hyper control plane (no trailing slash, no version). */
export const HYPER_BASE_URL = "https://hyper.charm.land";

/** Versioned API root: chat completions, catalog, and account endpoints. */
export const HYPER_API_URL = `${HYPER_BASE_URL}/v1`;

/** Typed official-catalog endpoint (/v1/provider). */
export const HYPER_PROVIDER_URL = `${HYPER_API_URL}/provider`;

/** Extension version from package.json ("0.0.0" when absent). */
export const VERSION = (pkg as { version?: string }).version ?? "0.0.0";

/** Extension package name ("pi-hypercharm-provider"). */
export const PACKAGE_NAME = (pkg as { name?: string }).name ?? `pi-hypercharm-provider`;

/**
 * Versioned user agent sent with every Hyper control-plane request. The
 * package name is the namespaced identity "pi-<provider id>-provider"; the
 * co-installation test asserts no shared surface collides with the official
 * provider's "pi-hyper-provider" agent string.
 */
export const USER_AGENT = `${PACKAGE_NAME}/${VERSION}`;

/** Standard JSON request headers plus the versioned user agent. */
export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { "Content-Type": "application/json", "User-Agent": USER_AGENT, ...extra };
}

/** Bearer authorization headers for a resolved API key or OAuth access token. */
export function bearerAuth(credential: string): Record<string, string> {
	return { Authorization: `Bearer ${credential}` };
}

/**
 * Device-session name the OAuth device flow registers with Hyper. Both the
 * login flow (oauth.ts) and the device-session status lookup (account.ts
 * consumer in index.ts) must match by this exact name.
 */
export const PI_DEVICE_NAME = `Pi (${hostname()})`;
