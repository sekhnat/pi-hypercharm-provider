/**
 * The warning sink is the difference between a degraded session and a silent
 * one, so its three behaviours are pinned here: deduplication, UI routing once
 * a UI session activates it, and a stderr fallback when the captured ctx has
 * gone stale (a refresh landing after its session was replaced).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotifier } from "../notify.ts";

function captureStderr() {
	const chunks = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk) => {
		chunks.push(String(chunk));
		return true;
	};
	return {
		chunks,
		restore() {
			process.stderr.write = original;
		},
	};
}

function fakeContext(hasUI, notify) {
	return { hasUI, ui: { notify: notify ?? (() => {}) } };
}

test("warnings are deduplicated and reach stderr before any UI exists", () => {
	const stderr = captureStderr();
	try {
		const notifier = createNotifier();
		notifier.warn("first failure");
		notifier.warn("first failure");
		notifier.warn("second failure");
		const lines = stderr.chunks.filter((chunk) => chunk.includes("HyperCharm warning:"));
		assert.equal(lines.length, 2, "each distinct warning is emitted once");
		assert.ok(lines[0].includes("first failure"));
		assert.ok(lines[1].includes("second failure"));
	} finally {
		stderr.restore();
	}
});

test("activation routes later warnings through the session UI as warnings", () => {
	const stderr = captureStderr();
	try {
		const notifications = [];
		const notifier = createNotifier();
		notifier.activate(fakeContext(true, (message, type) => notifications.push([message, type])));
		notifier.warn("catalog refresh failed");
		notifier.warn("catalog refresh failed");
		assert.deepEqual(notifications, [["catalog refresh failed", "warning"]]);
		assert.equal(
			stderr.chunks.some((chunk) => chunk.includes("catalog refresh failed")),
			false,
			"an activated notifier must not also write to stderr",
		);
	} finally {
		stderr.restore();
	}
});

test("a stale context falls back to stderr instead of throwing", () => {
	const stderr = captureStderr();
	try {
		const notifier = createNotifier();
		notifier.activate(
			fakeContext(true, () => {
				throw new Error("This extension ctx is stale");
			}),
		);
		assert.doesNotThrow(() => notifier.warn("after session replacement"));
		assert.ok(stderr.chunks.some((chunk) => chunk.includes("after session replacement")));
	} finally {
		stderr.restore();
	}
});

test("a non-UI session never claims the warning channel", () => {
	const stderr = captureStderr();
	try {
		const notifications = [];
		const notifier = createNotifier();
		notifier.activate(fakeContext(false, (message) => notifications.push(message)));
		notifier.warn("headless failure");
		assert.deepEqual(notifications, []);
		assert.ok(stderr.chunks.some((chunk) => chunk.includes("headless failure")));
	} finally {
		stderr.restore();
	}
});

test("a context that throws on hasUI is ignored rather than fatal", () => {
	const stderr = captureStderr();
	try {
		const notifier = createNotifier();
		const hostile = {
			get hasUI() {
				throw new Error("stale ctx");
			},
			ui: { notify: () => {} },
		};
		assert.doesNotThrow(() => notifier.activate(hostile));
		notifier.warn("still reported");
		assert.ok(stderr.chunks.some((chunk) => chunk.includes("still reported")));
	} finally {
		stderr.restore();
	}
});
