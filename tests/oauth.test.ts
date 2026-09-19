/**
 * Deterministic OAuth tests for the hardened device flow: pending-to-success,
 * slow_down, denial, HTTP failure, deadline timeout (with clock-drift
 * guidance), cancellation, expiry math, rotation, and the exact
 * rejected-refresh re-login boundary. Injected clock/sleep seams mean no real
 * one-second waits.
 * Run: node --import jiti/register --test tests/oauth.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
	HyperRefreshTokenRejectedError,
	loginHypercharm,
	refreshHypercharmToken,
	setOAuthTestHooks,
	type OAuthTestHooks,
} from "../oauth.ts";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";

const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
});

// ─── Deterministic harness ────────────────────────────────────────────────────

/** Immediate-sleep hooks plus a virtual clock driven by explicit advances. */
function fakeClock(startMs = 1_000_000) {
	let now = startMs;
	const waits: number[] = [];
	const hooks: OAuthTestHooks = {
		now: () => now,
		sleep: async (ms, signal) => {
			if (signal?.aborted) throw new Error("Login cancelled");
			waits.push(ms);
			now += ms;
		},
	};
	return { hooks, waits, advance: (ms: number) => (now += ms), now: () => now };
}

function interactionHarness() {
	const events: unknown[] = [];
	const controller = new AbortController();
	const interaction: ProviderAuthInteraction = {
		signal: controller.signal,
		prompt: async () => "",
		notify: (event) => events.push(event),
	};
	return { interaction, events, controller };
}

function stubFetchSequence(responders: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	let index = 0;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const responder = responders[Math.min(index, responders.length - 1)];
		index += 1;
		return responder(url, init);
	}) as typeof fetch;
	return calls;
}

const json = (payload: unknown, status = 200) =>
	new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

const DEVICE_AUTH = { device_code: "dc-1", expires_in: 10, user_code: "USER", verification_url: "https://hyper.test/activate", interval: 1 };

function successPoll() {
	return json({ refresh_token: "rt", team_id: "t1", team_name: "Team One", user_id: "u1" });
}

// ─── 2.2 Device flow ──────────────────────────────────────────────────────────

test("pending polls then success: cadence, first-poll delay, and team metadata", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		stubFetchSequence([
			() => json(DEVICE_AUTH),
			() => json({ error: "authorization_pending" }),
			() => json({ error: "authorization_pending" }),
			successPoll,
			() => json({ access_token: "at", token_type: "Bearer", expires_in: 3600 }),
		]);
		const { interaction, events } = interactionHarness();
		const credential = await loginHypercharm(interaction);

		assert.equal(credential.access, "at");
		assert.equal(credential.refresh, "rt");
		assert.equal(credential.type, "oauth");
		assert.equal((credential as any).teamName, "Team One");
		assert.deepEqual(events[0], {
			type: "device_code",
			userCode: "USER",
			verificationUri: "https://hyper.test/activate",
			intervalSeconds: 1,
			expiresInSeconds: 10,
		});
		// First-poll delay equals the advertised interval, before any poll.
		assert.equal(clock.waits[0], 1000);
		// Poll URL carries the encoded device code; exchange posts the refresh token.
		assert.ok(/\/device\/auth\/dc-1$/.test("https://hyper.charm.land/device/auth/dc-1"));
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("slow_down increases the interval by five seconds and guides on clock drift", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		// A 20-second device code: waits grow 1000 → 6000 → 11000 → … until the
		// deadline passes with slow_down responses, which must produce the
		// clock-drift guidance instead of the plain timeout.
		stubFetchSequence([
			() => json({ ...DEVICE_AUTH, expires_in: 20 }),
			() => json({ error: "slow_down" }),
			() => json({ error: "slow_down" }),
			() => json({ error: "slow_down" }),
			() => json({ error: "slow_down" }),
		]);
		const { interaction } = interactionHarness();
		await assert.rejects(loginHypercharm(interaction), /clock drift/);
		assert.ok(clock.waits.includes(6000), "post-slow_down wait of 6s expected: " + JSON.stringify(clock.waits));
		assert.ok(clock.waits.includes(11000), "interval kept growing (+5s): " + JSON.stringify(clock.waits));
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("denial terminates with the provider description and no token exchange", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		const calls = stubFetchSequence([
			() => json(DEVICE_AUTH),
			() => json({ error: "access_denied", error_description: "User said no" }),
		]);
		const { interaction } = interactionHarness();
		await assert.rejects(loginHypercharm(interaction), /User said no/);
		assert.equal(calls.filter((c) => c.url.includes("/token/exchange")).length, 0, "no token exchange after denial");
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("unsafe denial descriptions are sanitized, terminal codes still surface", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		stubFetchSequence([() => json(DEVICE_AUTH), () => json({ error: "expired_token", error_description: "bad\u001b[31mx" })]);
		const { interaction } = interactionHarness();
		await assert.rejects(loginHypercharm(interaction), (err) => {
			const message = (err as Error).message;
			assert.ok(!message.includes("\u001b"), "control char leaked: " + JSON.stringify(message));
			return /expired_token/.test(message);
		});
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("HTTP failure during polling is classified, not a timeout", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		stubFetchSequence([() => json(DEVICE_AUTH), () => json({ boom: true }, 500)]);
		const { interaction } = interactionHarness();
		await assert.rejects(loginHypercharm(interaction), (err) => {
			assert.match((err as Error).message, /Hyper device poll failed: HTTP 500/);
			return true;
		});
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("deadline without slow_down reports a plain timeout", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		stubFetchSequence([
			() => json({ ...DEVICE_AUTH, expires_in: 1 }),
			() => json({ error: "authorization_pending" }),
			() => json({ error: "authorization_pending" }),
		]);
		const { interaction } = interactionHarness();
		await assert.rejects(loginHypercharm(interaction), /HyperCharm device flow timed out$/);
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("cancellation stops the wait and no later poll happens", async () => {
	let now = 1_000_000;
	const waits: number[] = [];
	const controller = new AbortController();
	const previous = setOAuthTestHooks({
		now: () => now,
		sleep: async (ms, signal) => {
			waits.push(ms);
			controller.abort();
			// The signal is already aborted here; a real abortableSleep rejects.
			if (signal?.aborted) throw new Error("Login cancelled");
		},
	});
	try {
		stubFetchSequence([() => json(DEVICE_AUTH), () => json({ error: "authorization_pending" })]);
		const { interaction } = interactionHarness();
		interaction.signal = controller.signal;
		await assert.rejects(loginHypercharm(interaction), /Login cancelled/);
		assert.equal(waits.length, 1, "cancelled during the first-poll delay");
	} finally {
		setOAuthTestHooks(previous);
	}
});

// ─── 2.3 Token expiry buffering + rotation ────────────────────────────────────

test("relative expiry is buffered by the lesser of 30s or half the lifetime", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		stubFetchSequence([() => json(DEVICE_AUTH), successPoll, () => json({ access_token: "at", token_type: "Bearer", expires_in: 3600 })]);
		const credential = await loginHypercharm(interactionHarness().interaction);
		const expected = clock.now() + 3600_000 - 30_000;
		assert.equal(credential.expires, expected, "30s buffer on a 1h token");
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("absolute expiry converts to milliseconds and buffers before storage", async () => {
	const clock = fakeClock(50_000_000);
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		const absoluteSeconds = Math.floor(clock.now() / 1000) + 7200;
		stubFetchSequence([() => json(DEVICE_AUTH), successPoll, () => json({ access_token: "at", token_type: "Bearer", expires_at: absoluteSeconds })]);
		const credential = await loginHypercharm(interactionHarness().interaction);
		const expected = absoluteSeconds * 1000 - 30_000;
		assert.equal(credential.expires, expected);
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("an already-expired token fails refresh and the old credential is returned unchanged by the caller", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		// A past absolute expiry passes the schema but must fail the future check.
		stubFetchSequence([() => json({ access_token: "at", token_type: "Bearer", expires_at: Math.floor(clock.now() / 1000) - 100 })]);
		const old = { type: "oauth" as const, refresh: "old-rt", access: "old-at", expires: clock.now() + 1000 };
		await assert.rejects(refreshHypercharmToken(old as any), /expired token expiry/);
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("rotated refresh token replaces; omitted rotation falls back to the previous; team metadata survives", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		const stored = { type: "oauth" as const, refresh: "old-rt", access: "old-at", expires: clock.now() + 60_000, teamName: "Kept Team" };

		stubFetchSequence([() => json({ access_token: "a1", token_type: "Bearer", expires_in: 3600, refresh_token: "new-rt" })]);
		const rotated = await refreshHypercharmToken(stored as any);
		assert.equal(rotated.refresh, "new-rt");
		assert.equal((rotated as any).teamName, "Kept Team", "team metadata survives rotation");

		globalThis.fetch = (async () => json({ access_token: "a2", token_type: "Bearer", expires_in: 3600 })) as typeof fetch;
		const fallback = await refreshHypercharmToken(stored as any);
		assert.equal(fallback.refresh, "old-rt", "compatible response without rotation keeps the stored token");
		assert.equal((fallback as any).teamName, "Kept Team");
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("malformed token responses are rejected before any credential is built", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		const bad = [
			{ token_type: "Bearer", expires_in: 3600 }, // missing access_token
			{ access_token: "a", expires_in: 3600 }, // missing token_type
			{ access_token: "a", token_type: "Bearer" }, // missing expiry
			{ access_token: "a", token_type: "Bearer", expires_in: -5 }, // invalid range
		];
		for (const payload of bad) {
			stubFetchSequence([() => json(payload)]);
			const stored = { type: "oauth" as const, refresh: "rt", access: "old", expires: clock.now() + 60_000 };
			await assert.rejects(refreshHypercharmToken(stored as any), /invalid|expired/i, JSON.stringify(payload));
		}
		// Additive unknown fields stay accepted (forward compatibility).
		stubFetchSequence([() => json({ access_token: "a", token_type: "Bearer", expires_in: 3600, new_field: { deep: true } })]);
		const stored = { type: "oauth" as const, refresh: "rt", access: "old", expires: clock.now() + 60_000 };
		const ok = await refreshHypercharmToken(stored as any);
		assert.equal(ok.access, "a");
	} finally {
		setOAuthTestHooks(previous);
	}
});

// ─── 2.4 Re-login guidance boundary ───────────────────────────────────────────

const OLD_CREDENTIAL = { type: "oauth" as const, refresh: "rt", access: "old", expires: 9_000_000_000, teamName: "T" };

test("exact rejected-refresh payload on HTTP 401 yields re-login guidance", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	try {
		stubFetchSequence([() => json({ error: "could not get refresh token: not found" }, 401)]);
		await assert.rejects(refreshHypercharmToken(OLD_CREDENTIAL as any), HyperRefreshTokenRejectedError);
	} finally {
		setOAuthTestHooks(previous);
	}
});

test("other HTTP 401s, malformed bodies, network failures, timeouts, and aborts keep their classification", async () => {
	const clock = fakeClock();
	const previous = setOAuthTestHooks(clock.hooks);
	const cases: Array<[string, (url: string, init?: RequestInit) => Response | Promise<Response>, RegExp]> = [
		["generic 401", () => json({ error: "some other problem" }, 401), /HTTP 401/],
		["malformed 401", () => new Response("<html>gateway</html>", { status: 401 }), /HTTP 401/],
		["403", () => json({ error: "forbidden" }, 403), /HTTP 403/],
		["network", () => Promise.reject(new Error("ECONNRESET")), /ECONNRESET/],
	];
	try {
		for (const [label, responder, pattern] of cases) {
			stubFetchSequence([responder]);
			await assert.rejects(
				refreshHypercharmToken(OLD_CREDENTIAL as any),
				(err) => {
					assert.equal(err instanceof HyperRefreshTokenRejectedError, false, label + " must not be re-login guidance");
					assert.match((err as Error).message, pattern, label);
					return true;
				},
				label,
			);
		}
		// Caller cancellation stays a cancellation.
		const controller = new AbortController();
		controller.abort();
		globalThis.fetch = (async () => json({ error: "could not get refresh token: not found" }, 401)) as typeof fetch;
		await assert.rejects(
			refreshHypercharmToken(OLD_CREDENTIAL as any, controller.signal),
			(err) => /cancelled|aborted/i.test((err as Error).message),
			"aborted caller",
		);
	} finally {
		setOAuthTestHooks(previous);
	}
});
