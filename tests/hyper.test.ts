/**
 * Focused test for hyper.ts: the versioned user agent, URL composition, and
 * JSON header set. Run: node --import jiti/register --test tests/hyper.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import pkg from "../package.json" with { type: "json" };
import { HYPER_API_URL, HYPER_BASE_URL, HYPER_PROVIDER_URL, PACKAGE_NAME, USER_AGENT, VERSION, bearerAuth, jsonHeaders } from "../hyper.ts";
import { PROVIDER_ID } from "../identity.ts";

test("user agent is the namespaced package name and package version", () => {
	assert.equal(USER_AGENT, `${PACKAGE_NAME}/${VERSION}`);
	assert.equal(PACKAGE_NAME, "pi-hypercharm-provider");
	assert.equal(VERSION, pkg.version);
	// The agent string stays namespaced away from the official provider's.
	assert.match(USER_AGENT, /^pi-hypercharm-provider\/\d+\.\d+\.\d+$/);
	assert.ok(!USER_AGENT.includes("pi-hyper-provider"), "must not use the official provider's package name");
	// The package name encodes the registered provider id by convention.
	assert.ok(PACKAGE_NAME.includes(PROVIDER_ID));
});

test("URLs compose the Hyper control plane once", () => {
	assert.equal(HYPER_BASE_URL, "https://hyper.charm.land");
	assert.equal(HYPER_API_URL, "https://hyper.charm.land/v1");
	assert.equal(HYPER_PROVIDER_URL, "https://hyper.charm.land/v1/provider");
});

test("jsonHeaders sends the JSON content type plus the versioned user agent", () => {
	const headers = jsonHeaders();
	assert.equal(headers["Content-Type"], "application/json");
	assert.equal(headers["User-Agent"], USER_AGENT);
	const merged = jsonHeaders({ Authorization: "Bearer k" });
	assert.equal(merged.Authorization, "Bearer k");
	assert.equal(merged["User-Agent"], USER_AGENT);
});

test("bearerAuth formats the authorization header", () => {
	assert.deepEqual(bearerAuth("key-123"), { Authorization: "Bearer key-123" });
});
