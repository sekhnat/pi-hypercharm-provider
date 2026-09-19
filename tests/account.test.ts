/**
 * Tests for the credential-scoped account runtime: endpoint validation,
 * credential races, staged sweeps, lifecycle disposal, and bounded backoff.
 * Run: node --import jiti/register --test tests/account.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
	AccountFetchError,
	CREDITS_MIN_INTERVAL_MS,
	HYPERCREDITS_PER_USD,
	RETRY_INITIAL_MS,
	RETRY_MAX_MS,
	createAccountRuntime,
	fetchCredits,
	fetchDevices,
	fetchTeams,
	isTransientAccountFailure,
} from "../account.ts";

const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
});

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });

const isAccountError = (err: unknown) => err instanceof AccountFetchError;

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for " + label);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

// ─── Deferred fetch harness (abort-aware, like real fetch) ───────────────────

function deferredFetch() {
	const calls: Array<{ url: string }> = [];
	const pending: Array<{ url: string; resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url });
		return new Promise<Response>((resolve, reject) => {
			const entry = { url, resolve, reject };
			pending.push(entry);
			init?.signal?.addEventListener(
				"abort",
				() => {
					const index = pending.indexOf(entry);
					if (index >= 0) pending.splice(index, 1);
					reject(new DOMException("The operation was aborted.", "AbortError"));
				},
				{ once: true },
			);
		});
	}) as typeof fetch;
	return {
		calls,
		pending,
		respond(pattern: RegExp, response: Response) {
			const index = pending.findIndex((p) => pattern.test(p.url));
			assert.ok(index >= 0, "no pending request for " + pattern);
			const [entry] = pending.splice(index, 1);
			entry.resolve(response);
		},
		count(pattern: RegExp) {
			return calls.filter((c) => pattern.test(c.url)).length;
		},
	};
}

/** Drive the runtime with a controllable credential resolver and clock. */
function runtimeHarness(now: () => number) {
	const warnings: string[] = [];
	let credential: string | undefined = "key-A";
	const authResponses: Array<Promise<string | undefined>> = [];
	const runtime = createAccountRuntime({
		resolveCredential: () => (authResponses.length > 0 ? (authResponses.shift() as Promise<string | undefined>) : Promise.resolve(credential)),
		warn: (message) => warnings.push(message),
		now,
		deviceName: "Pi (test-host)",
	});
	return {
		runtime,
		warnings,
		authResponses,
		setCredential(key: string | undefined) {
			credential = key;
		},
	};
}

const teamsOk = (name: string | null) => json({ items: name === null ? [] : [{ name }] });
const devicesOk = (name: string | null, daysFromNow: number) =>
	json({
		items:
			name === null
				? []
				: [{ name, expires_at: new Date(Date.now() + daysFromNow * 86_400_000).toISOString() }],
	});

type Responder = (input: string | URL, init?: RequestInit) => Response | Promise<Response>;

function sweepResponder(balance: number, team: string | null, days: number): Responder {
	return (input) => {
		const url = String(input);
		if (url.includes("/credits")) return json({ balance });
		if (url.includes("/teams")) return teamsOk(team);
		if (url.includes("/devices")) return devicesOk("Pi (test-host)", days);
		throw new Error("unexpected fetch: " + url);
	};
}

function asFetch(responder: Responder): typeof fetch {
	return (async (input: string | URL, init?: RequestInit) => responder(input, init)) as unknown as typeof fetch;
}

// ─── 3.1 Endpoint validation ────────────────────────────────────────────────

test("credits: Hypercredit balance, USD conversion, finite checks, malformed rejection", async () => {
	globalThis.fetch = asFetch(() => json({ balance: 249 }));
	assert.equal((await fetchCredits("k", new AbortController().signal)).balance, 249);

	globalThis.fetch = asFetch(() => json({ balance_usd: 12.45 }));
	assert.equal((await fetchCredits("k", new AbortController().signal)).balance, 12.45 * HYPERCREDITS_PER_USD);

	for (const bad of [{}, { balance: "12" }, { balance: null }, { other: 1 }, "nope"]) {
		globalThis.fetch = asFetch(() => json(bad));
		await assert.rejects(fetchCredits("k", new AbortController().signal), isAccountError, JSON.stringify(bad));
	}
	// Non-finite via 1e999 parses to Infinity and must be rejected.
	globalThis.fetch = asFetch(() => new Response('{"balance": 1e999}', { status: 200 }));
	await assert.rejects(fetchCredits("k", new AbortController().signal), isAccountError);
});

test("teams/devices: valid empty collections count; malformed payloads reject", async () => {
	globalThis.fetch = asFetch(() => json({ items: [{ name: " Xu's Team " }] }));
	assert.equal((await fetchTeams("k", new AbortController().signal)).teamName, "Xu's Team");
	globalThis.fetch = asFetch(() => json({ items: [] }));
	assert.equal((await fetchTeams("k", new AbortController().signal)).teamName, undefined);
	for (const bad of [{}, { items: "x" }, { items: [{}] }, { items: [{ name: "" }] }]) {
		globalThis.fetch = asFetch(() => json(bad));
		await assert.rejects(fetchTeams("k", new AbortController().signal), isAccountError, JSON.stringify(bad));
	}

	globalThis.fetch = asFetch(() => devicesOk("Pi (test-host)", 29.5));
	assert.equal((await fetchDevices("k", new AbortController().signal, "Pi (test-host)", () => Date.now())).authDaysLeft, 30);
	globalThis.fetch = asFetch(() => json({ items: [] }));
	assert.equal(
		(await fetchDevices("k", new AbortController().signal, "Pi (test-host)", () => Date.now())).authDaysLeft,
		undefined,
	);
	globalThis.fetch = asFetch(() => json({ items: [{ name: "Pi (test-host)", expires_at: "not-a-date" }] }));
	await assert.rejects(fetchDevices("k", new AbortController().signal, "Pi (test-host)", () => Date.now()), isAccountError);
	globalThis.fetch = asFetch(() => json({ items: [{ name: "Pi (test-host)" }] }));
	await assert.rejects(fetchDevices("k", new AbortController().signal, "Pi (test-host)", () => Date.now()), isAccountError);
});

// ─── 3.2 Credential races ───────────────────────────────────────────────────

test("overlapping same-key refreshes share per-endpoint work", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	const dfd = deferredFetch();
	try {
		const first = harness.runtime.refresh();
		const second = harness.runtime.refresh({ force: true });
		await waitFor(() => dfd.pending.length >= 3, "first sweep requests");
		assert.equal(dfd.count(/\/credits/), 1, "one credits request shared by both refreshes");
		assert.equal(dfd.count(/\/teams/), 1);
		assert.equal(dfd.count(/\/devices/), 1);
		dfd.respond(/\/credits/, json({ balance: 100 }));
		// (devicesOk fixture below uses 10.5 days so Math.ceil is stable)
		dfd.respond(/\/teams/, teamsOk("Team A"));
		dfd.respond(/\/devices/, devicesOk("Pi (test-host)", 10.5));
		await first;
		await second;
		assert.equal(dfd.count(/\/credits/), 1, "still exactly one credits request");
		assert.deepEqual(harness.runtime.snapshot(), {
			balance: 100,
			teamName: "Team A",
			authDaysLeft: 11,
			key: "key-A",
			epoch: 1,
		});
	} finally {
		harness.runtime.dispose();
	}
});

test("delayed auth: a superseded invocation commits and fetches nothing", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	const dfd = deferredFetch();
	try {
		// Refresh #1's credential resolution hangs.
		let resolveFirst: ((key: string | undefined) => void) | undefined;
		harness.authResponses.push(
			new Promise<string | undefined>((resolve) => {
				resolveFirst = resolve;
			}),
		);
		void harness.runtime.refresh();
		await waitFor(() => dfd.calls.length === 0, "yield while auth pending");
		assert.equal(dfd.calls.length, 0, "nothing fetched while auth is pending");

		// Refresh #2 resolves immediately and completes its sweep.
		const second = harness.runtime.refresh();
		await waitFor(() => dfd.pending.length >= 3, "second sweep requests");
		dfd.respond(/\/credits/, json({ balance: 7 }));
		dfd.respond(/\/teams/, teamsOk("Team"));
		dfd.respond(/\/devices/, devicesOk("Pi (test-host)", 4));
		await second;
		assert.equal(harness.runtime.snapshot().balance, 7);

		// The delayed auth resolves: invocation #1 is now superseded and must
		// fetch nothing and commit nothing.
		resolveFirst?.("key-A");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(dfd.count(/\/credits/), 1, "superseded invocation made no extra requests");
		assert.equal(harness.runtime.snapshot().balance, 7);
	} finally {
		harness.runtime.dispose();
	}
});

test("key A→B: A's late response never attributes to B; B's sweep stages atomically", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	const dfd = deferredFetch();
	try {
		const first = harness.runtime.refresh();
		await waitFor(() => dfd.pending.length >= 3, "A sweep requests");
		// Answer teams/devices for A but HOLD A's credits response.
		dfd.respond(/\/teams/, teamsOk("Team A"));
		dfd.respond(/\/devices/, devicesOk("Pi (test-host)", 10));

		// Switch credentials while A's credits is still pending: the lease
		// change aborts A's in-flight request (real fetch semantics), so its
		// result can never land — not even as a late response.
		harness.setCredential("key-B");
		const second = harness.runtime.refresh({ force: true });
		await waitFor(() => dfd.count(/\/credits/) >= 2, "B credits request");
		assert.equal(dfd.pending.filter((p) => /\/credits/.test(p.url)).length, 1, "only B's credits is pending; A's was aborted");
		await first; // A's aborted work settles silently

		// B's sweep completes atomically.
		dfd.respond(/\/teams/, teamsOk("Team B"));
		dfd.respond(/\/devices/, devicesOk("Pi (test-host)", 20));
		dfd.respond(/\/credits/, json({ balance: 222 }));
		await second;

		const snap = harness.runtime.snapshot();
		assert.equal(snap.key, "key-B");
		assert.equal(snap.balance, 222, "B's own balance");
		assert.equal(snap.teamName, "Team B", "never Team A under key B");
		assert.equal(snap.authDaysLeft, 21);
		assert.deepEqual(harness.warnings, [], "no warnings from the aborted/obsolete work");
	} finally {
		harness.runtime.dispose();
	}
});

test("new credential's failed sweep retains the previous coherent snapshot", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	try {
		globalThis.fetch = asFetch(sweepResponder(50, "Team A", 10));
		harness.setCredential("key-A");
		await harness.runtime.refresh({ force: true });
		assert.equal(harness.runtime.snapshot().balance, 50);
		assert.equal(harness.runtime.snapshot().teamName, "Team A");

		harness.setCredential("key-B");
		// B's sweep: credits succeed, teams malformed → nothing commits.
		globalThis.fetch = asFetch((input) => {
			const url = String(input);
			if (url.includes("/credits")) return json({ balance: 60 });
			if (url.includes("/teams")) return json({ items: "malformed" });
			return json({ items: [] });
		});
		await harness.runtime.refresh({ force: true });
		const snap = harness.runtime.snapshot();
		assert.equal(snap.key, "key-A", "still attributed to A");
		assert.equal(snap.balance, 50, "B's balance never leaked");
		assert.equal(snap.teamName, "Team A");
	} finally {
		harness.runtime.dispose();
	}
});

// ─── 3.3 Lifecycle disposal ─────────────────────────────────────────────────

test("deactivate aborts in-flight work, suppresses warnings, keeps last-known data", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	const dfd = deferredFetch();
	try {
		const pending = harness.runtime.refresh();
		await waitFor(() => dfd.pending.length >= 3, "sweep requests");
		harness.runtime.deactivate(); // provider switch mid-flight
		await pending;
		assert.deepEqual(harness.warnings, [], "lifecycle cancellation is not a failure");
		assert.equal(harness.runtime.snapshot().balance, null);
	} finally {
		harness.runtime.dispose();
	}
});

test("dispose stops refreshes and no further fetch happens", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	const dfd = deferredFetch();
	try {
		const pending = harness.runtime.refresh();
		await waitFor(() => dfd.pending.length >= 1, "requests");
		harness.runtime.dispose();
		await pending; // aborted requests settle
		assert.deepEqual(harness.warnings, []);
		let called = 0;
		globalThis.fetch = asFetch(() => json({}));
		await harness.runtime.refresh({ force: true });
		assert.equal(called, 0, "disposed runtime never fetches");
		void called;
	} finally {
		harness.runtime.dispose();
	}
});

test("missing credential retains the last-known snapshot and fetches nothing", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	try {
		globalThis.fetch = asFetch(sweepResponder(77, "Team A", 9));
		harness.setCredential("key-A");
		await harness.runtime.refresh({ force: true });
		assert.equal(harness.runtime.snapshot().balance, 77);

		let called = 0;
		globalThis.fetch = asFetch(() => {
			called += 1;
			return json({});
		});
		harness.setCredential(undefined);
		await harness.runtime.refresh({ force: true });
		assert.equal(called, 0, "no fetch without a credential");
		assert.equal(harness.runtime.snapshot().balance, 77, "last-known balance retained");
		assert.equal(harness.runtime.snapshot().key, "key-A", "original attribution preserved");
	} finally {
		harness.runtime.dispose();
	}
});

// ─── 3.4 Bounded backoff ────────────────────────────────────────────────────

test("transient failures back off exponentially from 5s to the 5m cap; Retry-After wins", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	try {
		globalThis.fetch = asFetch(() => json({ error: { message: "overloaded" } }, 503));
		await harness.runtime.refresh({ force: true });
		assert.equal(harness.runtime.inspect().retryAtMs.credits, now + RETRY_INITIAL_MS, "first failure defers 5s");

		now += RETRY_INITIAL_MS;
		await harness.runtime.refresh({ force: true });
		assert.equal(harness.runtime.inspect().retryAtMs.credits, now + RETRY_INITIAL_MS * 2, "second failure defers 10s");

		// Retry-After precedence.
		globalThis.fetch = asFetch(() => json({ error: { message: "slow" } }, 429, { "Retry-After": "120" }));
		now += RETRY_INITIAL_MS * 2;
		await harness.runtime.refresh({ force: true });
		assert.equal(harness.runtime.inspect().retryAtMs.credits, now + 120_000, "server Retry-After wins over the ladder");

		// The five-minute cap after enough consecutive failures.
		globalThis.fetch = asFetch(() => json({}, 500));
		for (let i = 0; i < 8; i++) {
			now = harness.runtime.inspect().retryAtMs.credits;
			await harness.runtime.refresh({ force: true });
		}
		assert.equal(harness.runtime.inspect().retryAtMs.credits - now, RETRY_MAX_MS, "delay capped at five minutes");

		// Success resets to the initial delay for any future failure sequence.
		globalThis.fetch = asFetch(sweepResponder(10, "R", 2));
		now = harness.runtime.inspect().retryAtMs.credits;
		await harness.runtime.refresh({ force: true });
		assert.equal(harness.runtime.inspect().retryAtMs.credits, 0, "success clears the gate");
		assert.equal(harness.runtime.snapshot().balance, 10);
		globalThis.fetch = asFetch(() => json({}, 503));
		await harness.runtime.refresh({ force: true });
		assert.equal(harness.runtime.inspect().retryAtMs.credits, now + RETRY_INITIAL_MS, "fresh sequence starts at 5s again");
	} finally {
		harness.runtime.dispose();
	}
});

test("automatic refreshes honor the retry gate; forced refresh bypasses and coalesces", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	try {
		globalThis.fetch = asFetch(() => json({}, 503));
		await harness.runtime.refresh({ force: true });
		assert.ok(harness.runtime.inspect().retryAtMs.credits > now, "gate active after failure");

		// A later AUTOMATIC refresh must not re-request the gated endpoints.
		let creditsCalls = 0;
		globalThis.fetch = asFetch((input) => {
			const url = String(input);
			if (url.includes("/credits")) creditsCalls += 1;
			if (url.includes("/teams")) return teamsOk(null);
			if (url.includes("/devices")) return devicesOk(null, 1);
			return json({});
		});
		await harness.runtime.refresh();
		assert.equal(creditsCalls, 0, "gated credits endpoint not re-requested automatically");

		// Forced refresh bypasses the gate...
		await harness.runtime.refresh({ force: true });
		assert.equal(creditsCalls, 1, "forced refresh bypasses the gate");

		// ...but still coalesces with compatible in-flight work.
		now += RETRY_MAX_MS; // every gate expired
		const dfd = deferredFetch();
		const automatic = harness.runtime.refresh();
		await waitFor(() => dfd.pending.length >= 1, "in-flight sweep");
		const forced = harness.runtime.refresh({ force: true });
		await Promise.resolve();
		assert.equal(dfd.count(/\/credits/), 1, "manual refresh coalesces with in-flight work");
		dfd.respond(/\/credits/, json({ balance: 3 }));
		dfd.respond(/\/teams/, teamsOk(null));
		dfd.respond(/\/devices/, devicesOk(null, 1));
		await automatic;
		await forced;
	} finally {
		harness.runtime.dispose();
	}
});

test("a credential change resets backoff; the credits throttle re-arms per key", async () => {
	let now = Date.now();
	const harness = runtimeHarness(() => now);
	try {
		globalThis.fetch = asFetch(sweepResponder(1, "A", 1));
		harness.setCredential("key-A");
		await harness.runtime.refresh({ force: true });
		assert.equal(harness.runtime.inspect().retryAtMs.credits, 0);

		// An immediate automatic refresh is throttled by the credits interval.
		let creditsCalls = 0;
		globalThis.fetch = asFetch((input) => {
			if (String(input).includes("/credits")) creditsCalls += 1;
			return json({});
		});
		await harness.runtime.refresh();
		assert.equal(creditsCalls, 0, "credits throttle holds within the interval");

		// Key change resets state; the new credential sweeps credits again.
		now += CREDITS_MIN_INTERVAL_MS;
		harness.setCredential("key-B");
		globalThis.fetch = asFetch((input) => {
			const url = String(input);
			if (url.includes("/credits")) {
				creditsCalls += 1;
				return json({ balance: 2 });
			}
			if (url.includes("/teams")) return teamsOk("B");
			return devicesOk("Pi (test-host)", 2);
		});
		await harness.runtime.refresh();
		assert.equal(creditsCalls, 1, "new credential sweeps credits");
		assert.equal(harness.runtime.snapshot().balance, 2);
		assert.equal(harness.runtime.snapshot().teamName, "B");
	} finally {
		harness.runtime.dispose();
	}
});

test("isTransientAccountFailure classifies network, timeout, 408, 429, and 5xx", () => {
	assert.equal(isTransientAccountFailure({ kind: "network", message: "x" }), true);
	assert.equal(isTransientAccountFailure({ kind: "timeout", phase: "request" }), true);
	assert.equal(isTransientAccountFailure({ kind: "http", status: 408 }), true);
	assert.equal(isTransientAccountFailure({ kind: "http", status: 429 }), true);
	assert.equal(isTransientAccountFailure({ kind: "http", status: 503 }), true);
	assert.equal(isTransientAccountFailure({ kind: "http", status: 401 }), false);
	assert.equal(isTransientAccountFailure({ kind: "http", status: 402 }), false);
	assert.equal(isTransientAccountFailure({ kind: "payload", reason: "bad" }), false);
	assert.equal(isTransientAccountFailure({ kind: "aborted" }), false);
});
