/**
 * Dependency-free smoke test for the HyperCharm OAuth device flow.
 * Run: node tests/oauth.smoke.ts (Node ≥ 23 strips types natively).
 * Stubs globalThis.fetch to drive /device/auth, /device/auth/:code and
 * /token/exchange through the real login/refresh code paths. The poll
 * interval floor is 1s, so the full login path spends ~2s on real timers.
 */
import assert from "node:assert/strict";
import { USER_AGENT, loginHypercharm, refreshHypercharmToken } from "../oauth.ts";

const BASE = "https://hyper.charm.land";
type Route = { match: RegExp; respond: (url: string, init?: RequestInit) => Response };
let fetchCalls = 0;
let restoreFetch: (() => void) | undefined;

function stubFetch(routes: Route[]): void {
	fetchCalls = 0;
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		fetchCalls += 1;
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
		for (const route of routes) {
			if (route.match.test(url)) return route.respond(url, init);
		}
		throw new Error(`unexpected fetch in test: ${url}`);
	}) as unknown as typeof fetch;
	restoreFetch = () => {
		globalThis.fetch = original;
		restoreFetch = undefined;
	};
}

const json = (payload: unknown, status = 200): Response =>
	new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

const deviceAuth = (expires_in = 60, interval = 0.001): Route => ({
	match: /\/device\/auth$/,
	respond: () => json({ device_code: "dc", user_code: "UC-1", verification_url: `${BASE}/activate`, expires_in, interval }),
});

const stubCallbacks = (): Parameters<typeof loginHypercharm>[0] =>
	({ onDeviceCode: () => undefined, signal: undefined }) as unknown as Parameters<typeof loginHypercharm>[0];

// ── USER_AGENT ──
assert.match(USER_AGENT, /^pi-hypercharm-provider\/\d/);

// ── Full device flow: pending → authorized → token exchange ──
{
	let pendingPolls = 0;
	let codeInfo: { userCode?: string; verificationUri?: string } | undefined;
	let exchangeBody: unknown;
	stubFetch([
		deviceAuth(),
		{
			match: /\/device\/auth\/dc$/,
			respond: () => (pendingPolls++ < 1 ? json({ error: "authorization_pending" }) : json({ refresh_token: "rt", team_name: "ACME" })),
		},
		{
			match: /\/token\/exchange/,
			respond: (_url, init) => {
				exchangeBody = JSON.parse(String(init?.body));
				return json({ access_token: "at", refresh_token: "rt2", expires_in: 7200 });
			},
		},
	]);
	const creds = await loginHypercharm({
		onDeviceCode: (info: unknown) => {
			codeInfo = info as { userCode?: string; verificationUri?: string };
		},
		signal: undefined,
	} as unknown as Parameters<typeof loginHypercharm>[0]);
	assert.equal(codeInfo?.userCode, "UC-1", "device code surfaced through the callback");
	assert.equal(codeInfo?.verificationUri, `${BASE}/activate`);
	assert.equal(creds.type, "oauth");
	assert.equal(creds.access, "at");
	assert.equal(creds.refresh, "rt2");
	assert.equal((creds as { teamName?: string }).teamName, "ACME", "team name propagated from the poll");
	const ttl = Number(creds.expires) - Date.now();
	assert.ok(ttl > 7_100_000 && ttl <= 7_200_000, `expiry buffers 30s off a 7200s token (got ${ttl})`);
	assert.equal((exchangeBody as { refresh_token?: string }).refresh_token, "rt", "exchange posts the polled refresh token");
	assert.ok(fetchCalls >= 3);
	restoreFetch!();
}

// ── invalid device-auth payload ──
{
	stubFetch([{ match: /\/device\/auth$/, respond: () => json({ device_code: 1 }) }]);
	await assert.rejects(() => loginHypercharm(stubCallbacks()), /device auth response is invalid/);
	restoreFetch!();
}

// ── device auth HTTP failure ──
{
	stubFetch([{ match: /\/device\/auth$/, respond: () => json({ message: "no" }, 500) }]);
	await assert.rejects(() => loginHypercharm(stubCallbacks()), /device auth failed: HTTP 500/);
	restoreFetch!();
}

// ── poll terminal error carries the description ──
{
	stubFetch([
		deviceAuth(),
		{ match: /\/device\/auth\/dc$/, respond: () => json({ error: "access_denied", error_description: "user said no" }) },
	]);
	await assert.rejects(() => loginHypercharm(stubCallbacks()), /authorization failed: user said no/);
	restoreFetch!();
}

// ── poll HTTP failure ──
{
	stubFetch([
		deviceAuth(),
		{ match: /\/device\/auth\/dc$/, respond: () => json({ message: "gone" }, 404) },
	]);
	await assert.rejects(() => loginHypercharm(stubCallbacks()), /device poll failed: HTTP 404/);
	restoreFetch!();
}

// ── timeout: zero expiry means the deadline is already past ──
{
	stubFetch([deviceAuth(0)]);
	await assert.rejects(() => loginHypercharm(stubCallbacks()), /device flow timed out/);
	restoreFetch!();
}

// ── token exchange 401 → friendly re-login error with cause ──
{
	stubFetch([{ match: /\/token\/exchange/, respond: () => json({ message: "nope" }, 401) }]);
	const cred = { type: "oauth", refresh: "old", access: "old", expires: 0, teamName: "Xu's Team" } as unknown as Parameters<
		typeof refreshHypercharmToken
	>[0];
	await assert.rejects(
		() => refreshHypercharmToken(cred),
		(err: unknown) => {
			const e = err as Error & { cause?: Error };
			return e.message.includes("no longer valid") && String(e.cause).includes("HTTP 401");
		},
	);
	restoreFetch!();
}

// ── refresh success: expiry math + teamName preservation ──
{
	stubFetch([
		{ match: /\/token\/exchange/, respond: () => json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }) },
	]);
	const refreshed = await refreshHypercharmToken(
		{ type: "oauth", refresh: "old", access: "old", expires: 0, teamName: "Xu's Team" } as unknown as Parameters<
			typeof refreshHypercharmToken
		>[0],
	);
	assert.equal(refreshed.access, "a2");
	assert.equal(refreshed.refresh, "r2", "refresh token rotates");
	assert.equal((refreshed as { teamName?: string }).teamName, "Xu's Team", "team name preserved across refresh");
	const refreshTtl = Number(refreshed.expires) - Date.now();
	assert.ok(refreshTtl > 3_540_000 && refreshTtl <= 3_570_000, `30s buffer on a 1h token (got ${refreshTtl})`);
	restoreFetch!();
}

console.log("oauth.smoke: all assertions passed");
