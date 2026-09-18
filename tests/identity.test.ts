/**
 * First-principles co-installation guard: every identifier this extension
 * registers into a shared Pi surface must be namespaced under PROVIDER_ID and
 * disjoint from the official provider's reserved names.
 *
 * OFFICIAL_RESERVED mirrors @charmland/pi-hyper-provider@0.4.0's registration
 * surface (src/hyper.ts, src/index.ts, src/settings.ts, src/credits.ts). Keep
 * it in sync when the official package adds or renames a shared identifier: a
 * failure here means the two extensions could collide on that surface.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	API_KEY_ENV,
	API_NAME,
	IDENTIFIERS,
	PRISM_ENTRY_TYPE,
	PROVIDER_ID,
	STATUS_COMMAND,
	STATUS_KEY_ACCOUNT,
	STATUS_KEY_SESSION,
	WIDGET_KEY,
} from "../identity.ts";

const OFFICIAL_RESERVED = [
	"hyper", // provider id and status key (PROVIDER_NAME)
	"Charm Hyper", // provider + oauth display name
	"hyper-status", // /hyper-status command
	"hyper-prism-route", // prism entry customType
	"hyper-provider", // ~/.pi/agent/hyper-provider settings dir
	"HYPER_API_KEY", // envApiKeyAuth env var (auth key)
	"openai-completions", // api name (openAICompletionsApi)
	"@charmland/pi-hyper-provider", // npm package name
];

test("every registered identifier is namespaced under the provider id", () => {
	for (const identifier of IDENTIFIERS) {
		assert.equal(typeof identifier, "string");
		assert.ok(identifier.length > 0);
		// Normalize the two conventions we use: env vars are upper-cased
		// (HYPERCHARM_API_KEY) and pi's env-var placeholders carry a "$" sigil.
		const normalized = identifier.replace(/^\$/, "").toLowerCase();
		assert.ok(normalized.startsWith(PROVIDER_ID), identifier + " must start with " + PROVIDER_ID);
	}
});

test("identifiers are unique", () => {
	assert.equal(new Set(IDENTIFIERS).size, IDENTIFIERS.length);
});

test("no identifier collides with the official provider's reserved names", () => {
	for (const identifier of IDENTIFIERS) {
		assert.ok(!OFFICIAL_RESERVED.includes(identifier), identifier + " collides with the official provider");
	}
});

test("the specific shared surfaces differ from the official registration", () => {
	assert.equal(PROVIDER_ID, "hypercharm");
	assert.notEqual(PROVIDER_ID, "hyper");
	assert.notEqual(API_NAME, "openai-completions");
	assert.notEqual(API_KEY_ENV, "HYPER_API_KEY");
	assert.notEqual(STATUS_COMMAND, "hyper-status");
	assert.notEqual(PRISM_ENTRY_TYPE, "hyper-prism-route");
	assert.notEqual(STATUS_KEY_SESSION, "hyper");
	assert.notEqual(STATUS_KEY_ACCOUNT, "hyper");
	assert.notEqual(WIDGET_KEY, "hyper");
});

test("status and widget keys stay disjoint so pi cannot cross-clear them", () => {
	assert.ok(WIDGET_KEY.startsWith(PROVIDER_ID));
	assert.ok(STATUS_KEY_SESSION.startsWith(PROVIDER_ID + "-"));
	assert.ok(STATUS_KEY_ACCOUNT.startsWith(PROVIDER_ID + "-"));
	assert.notEqual(STATUS_KEY_SESSION, STATUS_KEY_ACCOUNT);
	assert.notEqual(STATUS_KEY_SESSION, WIDGET_KEY);
	assert.notEqual(STATUS_KEY_ACCOUNT, WIDGET_KEY);
});
