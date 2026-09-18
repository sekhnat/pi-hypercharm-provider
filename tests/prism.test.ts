import assert from "node:assert/strict";
import { test } from "node:test";
import { PRISM_ENTRY_TYPE, prismLabel, prismRouteFromHeaders, prismRouteLabel, readPrismRoute } from "../prism.ts";

test("prismLabel accepts trimmed printable labels", () => {
	assert.equal(prismLabel(" GLM 5.3 Flash "), "GLM 5.3 Flash");
	assert.equal(prismLabel("glm-5.3-flash"), "glm-5.3-flash");
	assert.equal(prismLabel("model-\u30c7\u30fc\u30bf"), "model-\u30c7\u30fc\u30bf");
	assert.equal(prismLabel("x".repeat(200)), "x".repeat(200));
});

test("prismLabel rejects unusable labels", () => {
	const rejected = [
		undefined,
		null,
		42,
		{},
		[],
		"",
		"   ",
		"x".repeat(201),
		"bad\u001b[31m",
		"bad\nline",
		"bad\u202etext",
		"bad\u0000",
	];
	for (const value of rejected) {
		assert.equal(prismLabel(value), undefined, JSON.stringify(value));
	}
});

test("prismRouteFromHeaders keeps whichever routing headers are usable", () => {
	assert.deepEqual(
		prismRouteFromHeaders({ "x-prism-model-name": " GLM 5.3 Flash ", "x-prism-model-id": "glm-5.3-flash" }),
		{ modelName: "GLM 5.3 Flash", modelId: "glm-5.3-flash" },
	);
	assert.deepEqual(prismRouteFromHeaders({ "x-prism-model-name": "GLM 5.3 Flash" }), {
		modelName: "GLM 5.3 Flash",
		modelId: undefined,
	});
	assert.deepEqual(prismRouteFromHeaders({ "x-prism-model-id": "glm-5.3-flash" }), {
		modelName: undefined,
		modelId: "glm-5.3-flash",
	});
	assert.equal(prismRouteFromHeaders({}), undefined);
	assert.equal(prismRouteFromHeaders({ "x-prism-model-name": "   " }), undefined);
	assert.equal(prismRouteFromHeaders({ "x-prism-model-name": "bad\u001b[31m" }), undefined);
	assert.equal(prismRouteFromHeaders({ "x-other-header": "glm-5.3-flash" }), undefined);
	assert.equal(prismRouteFromHeaders(undefined), undefined);
});

test("persisted entry data is re-validated before rendering", () => {
	assert.deepEqual(readPrismRoute({ modelName: "GLM 5.3 Flash" }), { modelName: "GLM 5.3 Flash", modelId: undefined });
	assert.deepEqual(readPrismRoute({ modelId: "glm-5.3-flash" }), { modelName: undefined, modelId: "glm-5.3-flash" });
	const rejected = [null, undefined, 42, "glm-5.3", [], { modelName: 42 }, { modelName: "bad\u001b[31m" }, { modelId: "bad\nline" }, {}];
	for (const data of rejected) {
		assert.equal(readPrismRoute(data), undefined, JSON.stringify(data));
	}
});

test("the route label prefers the human name and the entry type stays namespaced", () => {
	assert.equal(prismRouteLabel({ modelName: "GLM 5.3 Flash", modelId: "glm-5.3-flash" }), "GLM 5.3 Flash");
	assert.equal(prismRouteLabel({ modelId: "glm-5.3-flash" }), "glm-5.3-flash");
	assert.equal(prismRouteLabel({}), undefined);
	assert.ok(PRISM_ENTRY_TYPE.startsWith("hypercharm"));
	assert.notEqual(PRISM_ENTRY_TYPE, "hyper-prism-route");
});
