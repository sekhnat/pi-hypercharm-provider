/**
 * Single source of truth for every identifier this extension registers into
 * shared Pi surfaces.
 *
 * Co-installation with the official `@charmland/pi-hyper-provider` is a hard
 * requirement, so no identifier we register may be a bare shared name. Every
 * key derives from PROVIDER_ID: provider id, custom api name, status and widget
 * keys, command name, prism entry type, auth key and env var, and the on-disk
 * config/cache file names. tests/identity.test.ts and
 * tests/provider.integration.test.ts enforce the invariant (namespacing,
 * uniqueness, and disjointness from the official provider's reserved names).
 */
export const PROVIDER_ID = "hypercharm";
export const PROVIDER_DISPLAY_NAME = "HyperCharm";

/** Custom api name: keeps our streamSimple handler distinct from pi's built-in openai-completions pipeline. */
export const API_NAME = PROVIDER_ID;

export const API_KEY_ENV = "HYPERCHARM_API_KEY";
export const API_KEY_PLACEHOLDER = `$${API_KEY_ENV}`;

export const STATUS_COMMAND = `${PROVIDER_ID}-status`;
export const STATUS_KEY_SESSION = `${PROVIDER_ID}-session`;
export const STATUS_KEY_ACCOUNT = `${PROVIDER_ID}-account`;
export const WIDGET_KEY = PROVIDER_ID;
export const PRISM_ENTRY_TYPE = `${PROVIDER_ID}-prism-route`;

export const CONFIG_FILE_NAME = `${PROVIDER_ID}.json`;
export const CACHE_FILE_NAME = `${PROVIDER_ID}-models.json`;

/**
 * Every distinct namespaced identifier this extension registers or writes.
 * API_NAME and WIDGET_KEY alias PROVIDER_ID by design — pi keys the custom api
 * handler and the below-editor widget by provider id — so the set is deduped;
 * what matters is that no *value* is shared with another extension.
 */
export const IDENTIFIERS: readonly string[] = Object.freeze([
	...new Set([
		PROVIDER_ID,
		API_KEY_ENV,
		API_KEY_PLACEHOLDER,
		STATUS_COMMAND,
		STATUS_KEY_SESSION,
		STATUS_KEY_ACCOUNT,
		PRISM_ENTRY_TYPE,
		CONFIG_FILE_NAME,
		CACHE_FILE_NAME,
	]),
]);
