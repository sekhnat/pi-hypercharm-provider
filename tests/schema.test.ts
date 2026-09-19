/**
 * Focused tests for schema.ts: bounded TypeBox diagnostics and endpoint-safe
 * path formatting. Run: node --import jiti/register --test tests/schema.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { DEFAULT_MAX_VALIDATION_ERRORS, formatErrorPath, validateEndpoint } from "../schema.ts";

const catalogSchema = Type.Object({
	models: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			cost: Type.Object({ input: Type.Number({ minimum: 0 }) }),
		}),
	),
});

test("valid values pass through typed", () => {
	const value = { models: [{ id: "m1", cost: { input: 0.2 } }] };
	const result = validateEndpoint(catalogSchema, value);
	assert.equal(result.ok, true);
	if (result.ok) assert.deepEqual(result.value, value);
});

test("nested invalid paths are reported in endpoint-safe form", () => {
	const result = validateEndpoint(catalogSchema, { models: [{ id: "", cost: { input: -1 } }] });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.errors.some((e) => e.startsWith("models[0].id:")), JSON.stringify(result.errors));
		assert.ok(result.errors.some((e) => e.startsWith("models[0].cost.input:")), JSON.stringify(result.errors));
	}
});

test("diagnostics truncate after the configured error count and say so", () => {
	const payload = { models: Array.from({ length: 10 }, () => ({ id: "", cost: { input: -1 } })) };
	const result = validateEndpoint(catalogSchema, payload, 3);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.errors.length, 4, "3 bounded diagnostics + 1 truncation notice");
		assert.match(result.errors[3], /further validation diagnostics omitted/);
	}
	const defaulted = validateEndpoint(catalogSchema, payload);
	assert.equal(defaulted.ok, false);
	if (!defaulted.ok) assert.equal(defaulted.errors.length, DEFAULT_MAX_VALIDATION_ERRORS + 1);
	// Fewer diagnostics than the bound: no truncation notice.
	const small = validateEndpoint(catalogSchema, { models: [{ id: "", cost: { input: 1 } }] }, 5);
	assert.equal(small.ok, false);
	if (!small.ok) assert.equal(small.errors.length, 1);
});

test("formatErrorPath is structural and safe for odd keys", () => {
	assert.equal(formatErrorPath(""), "(root)");
	assert.equal(formatErrorPath("/models/0/cost/input"), "models[0].cost.input");
	assert.equal(formatErrorPath("/a b/c"), '"a b".c');
	assert.equal(formatErrorPath("/0"), "[0]");
});

test("root-level failures format without a path prefix crash", () => {
	const result = validateEndpoint(Type.String(), 42);
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.errors.length >= 1);
});
