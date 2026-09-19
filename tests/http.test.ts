/**
 * Focused tests for http.ts: bounded JSON fetch, typed failures, safe error
 * extraction, and Retry-After normalization.
 * Run: node --import jiti/register --test tests/http.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
	describeFailure,
	fetchJson,
	parseRetryAfterMs,
	redactSecrets,
	safeProviderDetail,
} from "../http.ts";

const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
});

/** Install a stub fetch and return the captured calls + a restore handle. */
function stubFetch(impl: (input: string | URL, init?: RequestInit) => Promise<Response> | Response) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return impl(input, init);
	}) as typeof fetch;
	return calls;
}

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });

// ─── Success ──────────────────────────────────────────────────────────────────

test("success returns the parsed JSON value", async () => {
	stubFetch(() => json({ balance: 249 }));
	const result = await fetchJson({ url: "https://x.test/credits", operation: "balance probe" });
	assert.deepEqual(result, { ok: true, value: { balance: 249 } });
});

test("requests carry the composed JSON headers and body", async () => {
	const calls = stubFetch(() => json({ ok: true }));
	await fetchJson({
		url: "https://x.test/token/exchange",
		operation: "token exchange probe",
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": "ua/1.0", Authorization: "Bearer k" },
		body: { refresh_token: "r" },
	});
	assert.equal(calls.length, 1);
	const headers = new Headers(calls[0].init?.headers);
	assert.equal(headers.get("Content-Type"), "application/json");
	assert.equal(headers.get("User-Agent"), "ua/1.0");
	assert.equal(headers.get("Authorization"), "Bearer k");
	assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { refresh_token: "r" });
});

// ─── Caller abort vs timeout vs network ───────────────────────────────────────

test("caller abort is distinguishable from timeout and network failure", async () => {
	const controller = new AbortController();
	stubFetch(
		(_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
			}),
	);
	const pending = fetchJson({ url: "https://x.test/slow", operation: "slow probe", signal: controller.signal });
	controller.abort();
	const result = await pending;
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.failure.kind, "aborted");
});

test("already-aborted caller signal fails immediately without calling fetch", async () => {
	const controller = new AbortController();
	controller.abort();
	const calls = stubFetch(() => json({}));
	const result = await fetchJson({ url: "https://x.test/x", operation: "probe", signal: controller.signal });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.failure.kind, "aborted");
	assert.equal(calls.length, 0);
});

test("unresponsive endpoint fails as a request timeout", async () => {
	stubFetch(
		(_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "TimeoutError")));
			}),
	);
	const result = await fetchJson({ url: "https://x.test/slow", operation: "slow probe", timeoutMs: 25 });
	assert.equal(result.ok, false);
	if (!result.ok) assert.deepEqual(result.failure, { kind: "timeout", phase: "request" });
});

test(" stalled response body fails as a body timeout", async () => {
	stubFetch(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("{"));
						// Never closes.
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	);
	const result = await fetchJson({ url: "https://x.test/hang", operation: "hang probe", bodyTimeoutMs: 25 });
	assert.equal(result.ok, false);
	if (!result.ok && result.failure.kind === "timeout") assert.equal(result.failure.phase, "body");
	else if (!result.ok) assert.fail("expected timeout failure: " + JSON.stringify(result.failure));
});

test("network rejection is typed with its redacted message", async () => {
	stubFetch(() => {
		throw new Error("getaddrinfo ENOTFOUND hyper.charm.land");
	});
	const result = await fetchJson({ url: "https://x.test/x", operation: "catalog probe" });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.failure.kind, "network");
		if (result.failure.kind === "network") assert.match(result.failure.message, /ENOTFOUND/);
	}
});

// ─── Non-2xx ──────────────────────────────────────────────────────────────────

test("non-2xx reports the status and safe server detail", async () => {
	stubFetch(() => json({ error: { type: "invalid_request_error", code: "bad_key", message: "Key rejected" } }, 401));
	const result = await fetchJson({ url: "https://x.test/x", operation: "probe" });
	assert.equal(result.ok, false);
	if (!result.ok && result.failure.kind === "http") {
		assert.equal(result.failure.status, 401);
		assert.deepEqual(result.failure.detail, { type: "invalid_request_error", code: "bad_key", message: "Key rejected" });
		assert.match(describeFailure(result.failure, "probe"), /probe failed: HTTP 401: invalid_request_error bad_key: Key rejected/);
	} else {
		assert.fail("expected http failure");
	}
});

test("unsafe server text is omitted from detail but the status stays", async () => {
	const cases = [
		{ message: "x".repeat(201) },
		{ message: "bad\u001b[31mcolor" },
		{ message: "line\nbreak" },
		{ message: "markup <script>" },
		{ message: "bidi \u202etext" },
		{ message: "para\u2029sep" },
	];
	for (const [i, error] of cases.entries()) {
		stubFetch(() => json({ error }, 500));
		const result = await fetchJson({ url: "https://x.test/x", operation: "probe" });
		assert.equal(result.ok, false, String(i));
		if (!result.ok && result.failure.kind === "http") {
			assert.equal(result.failure.detail, undefined, JSON.stringify(result.failure.detail));
			assert.equal(describeFailure(result.failure, "probe"), "probe failed: HTTP 500");
		} else {
			assert.fail("expected http failure");
		}
	}
});

test("Retry-After headers normalize onto http failures", async () => {
	stubFetch(() => json({ error: { message: "slow down" } }, 429, { "Retry-After": "30" }));
	const result = await fetchJson({ url: "https://x.test/x", operation: "probe" });
	if (!result.ok && result.failure.kind === "http") assert.equal(result.failure.retryAfterMs, 30_000);
	else assert.fail("expected http failure");
});

// ─── Payload failures ─────────────────────────────────────────────────────────

test("empty and invalid JSON success bodies are payload failures", async () => {
	globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch;
	const empty = await fetchJson({ url: "https://x.test/x", operation: "probe" });
	assert.equal(empty.ok, false);
	if (!empty.ok) assert.deepEqual(empty.failure, { kind: "payload", reason: "response body is empty" });

	globalThis.fetch = (async () => new Response("<html>not json</html>", { status: 200 })) as typeof fetch;
	const invalid = await fetchJson({ url: "https://x.test/x", operation: "probe" });
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.equal(invalid.failure.kind, "payload");
});

// ─── Credential redaction ─────────────────────────────────────────────────────

test("credential values never appear in failure messages", async () => {
	const apiKey = "hc-secret-key-abcdef123456";
	stubFetch(() => {
		throw new Error("request to https://hyper.test/v1 failed with Bearer hc-secret-key-abcdef123456 in flight");
	});
	const result = await fetchJson({ url: "https://x.test/x", operation: "probe", secrets: [apiKey] });
	if (!result.ok && result.failure.kind === "network") {
		const message = describeFailure(result.failure, "probe");
		assert.ok(!message.includes(apiKey), "api key leaked: " + message);
		// Every bearer token in the message must be the redaction placeholder.
		const bearerTokens = [...message.matchAll(/Bearer\s+([^\s,;)"']+)/gi)].map((m) => m[1]);
		assert.ok(bearerTokens.length > 0, "expected a bearer token to scrub: " + message);
		assert.deepEqual(bearerTokens, ["[redacted]"]);
	} else {
		assert.fail("expected network failure");
	}
});

test("operation labels keep dynamic URL secrets out of failures", async () => {
	// A polling URL embeds the device code; only the operation label may surface.
	const deviceCode = "DEVICE-CODE-SECRET-99";
	stubFetch(() => json({ error: { message: "nope" } }, 500));
	const result = await fetchJson({ url: `https://x.test/device/auth/${deviceCode}`, operation: "device poll" });
	if (!result.ok) {
		const message = describeFailure(result.failure, "device poll");
		assert.ok(!message.includes(deviceCode), "device code leaked: " + message);
	} else {
		assert.fail("expected failure");
	}
});

// ─── Retry-After parsing (1.5, fake clock) ────────────────────────────────────

const NOW = Date.parse("2026-01-15T12:00:00Z");

test("Retry-After: integer seconds and canonical dates normalize; the rest is ignored", () => {
	assert.equal(parseRetryAfterMs("30", NOW), 30_000);
	assert.equal(parseRetryAfterMs(" 0 ", NOW), 0);
	assert.equal(parseRetryAfterMs("Fri, 16 Jan 2026 12:00:00 GMT", NOW), 86_400_000, "valid date one day out");
	assert.equal(parseRetryAfterMs("Mon, 13 Jan 2026 12:00:00 GMT", NOW), 0, "past date clamps to zero");
	assert.equal(parseRetryAfterMs("Thu, 15 Jan 2026 12:00:00 GMT", NOW), 0, "current date clamps to zero");
	assert.equal(parseRetryAfterMs("30.5", NOW), undefined, "fractional seconds are not integer seconds");
	assert.equal(parseRetryAfterMs("soon", NOW), undefined, "malformed words are ignored");
	assert.equal(parseRetryAfterMs("15 Jan 2026 12:00:00 GMT", NOW), undefined, "non-canonical date form is ignored");
	assert.equal(parseRetryAfterMs("", NOW), undefined);
	assert.equal(parseRetryAfterMs(null, NOW), undefined);
});

test("excessive Retry-After dates cap at 24 hours", () => {
	assert.equal(parseRetryAfterMs("100000", NOW), 24 * 60 * 60 * 1000, "excessive seconds cap");
	assert.equal(
		parseRetryAfterMs("Mon, 20 Jan 2026 12:00:00 GMT", NOW),
		24 * 60 * 60 * 1000,
		"date more than a day out caps",
	);
});

test("safeProviderDetail accepts only the OpenAI-style envelope", () => {
	assert.deepEqual(safeProviderDetail(JSON.stringify({ error: { message: "m", type: "t", code: "c" } })), {
		message: "m",
		type: "t",
		code: "c",
	});
	assert.deepEqual(safeProviderDetail(JSON.stringify({ message: "flat" })), { message: "flat" });
	assert.equal(safeProviderDetail("not json"), undefined);
	assert.equal(safeProviderDetail(JSON.stringify([])), undefined);
	assert.equal(safeProviderDetail(JSON.stringify({ error: { message: 42 } })), undefined);
	assert.equal(safeProviderDetail(JSON.stringify({})), undefined, "empty envelope yields nothing");
});

test("redactSecrets scrubs bearer tokens and exact secrets", () => {
	assert.equal(redactSecrets("Bearer abc.def; next"), "Bearer [redacted]; next");
	assert.equal(redactSecrets("key=supersecret123 here", ["supersecret123"]), "key=[redacted] here");
	assert.equal(redactSecrets("short key ab", ["ab"]), "short key ab", "very short secrets are not scrubbed");
});
