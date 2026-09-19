/**
 * HyperCharm OAuth device flow (provider id "hypercharm").
 *
 * Registered under our own provider id ("hypercharm", display name
 * "HyperCharm") so it never collides with the official provider's "hyper"
 * registration when both extensions are installed. Every request routes
 * through the shared HTTP client (http.ts) with versioned headers
 * (hyper.ts), and every response is validated against a forward-compatible
 * TypeBox schema (schema.ts) before a credential can be created or replaced
 * (specs/provider-authentication, specs/hyper-api-reliability).
 *
 * Device-flow semantics mirror the official provider at the reference commit:
 * a first-poll delay before the initial poll, a one-second minimum interval,
 * a five-second slow_down increment, the device-code deadline, and clock-drift
 * guidance when the deadline passes after one or more slow_down responses.
 *
 * Re-login guidance is restricted to the exact Hyper rejected-refresh-token
 * payload on HTTP 401; every other failure keeps its own classification.
 *
 * Note: both providers register the device under the same name
 * (`Pi (<hostname>)`), so /v1/devices entries are indistinguishable per host
 * when the official provider is also signed in — the status widget's OAuth
 * days-left readout may match either session.
 */
import { hostname } from "node:os";
import type { ModelAuth, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { HYPER_BASE_URL, bearerAuth, jsonHeaders } from "./hyper";
import { HyperHttpFailureError, describeFailure, fetchJson, type HttpFailure } from "./http";
import { NonEmptyString, validateEndpoint, positiveInt } from "./schema";

const OAUTH_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MIN_POLL_INTERVAL_MS = 1_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const CANCEL_MESSAGE = "Login cancelled";
const TIMEOUT_MESSAGE = "HyperCharm device flow timed out";
const SLOW_DOWN_TIMEOUT_MESSAGE =
	"HyperCharm device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
const RE_LOGIN_MESSAGE = "Your Hyper session is no longer valid. Run /login and re-authenticate with HyperCharm.";

// ─── Endpoint schemas (forward-compatible: additive fields allowed) ──────────

const DeviceAuthResponseSchema = Type.Object({
	device_code: NonEmptyString,
	expires_in: positiveInt(),
	user_code: NonEmptyString,
	verification_url: NonEmptyString,
	interval: Type.Optional(positiveInt()),
});

/** Success variant: complete device/team identity plus a refresh token. */
const DevicePollSuccessSchema = Type.Object({
	refresh_token: NonEmptyString,
	team_id: NonEmptyString,
	team_name: NonEmptyString,
	user_id: NonEmptyString,
});

/** Error variant: any terminal or retryable code with an optional description. */
const DevicePollErrorSchema = Type.Object({
	error: NonEmptyString,
	error_description: Type.Optional(Type.String()),
});

/** Token exchange: relative or absolute expiry; rotation is optional on refresh. */
const TokenExchangeWithExpiresInSchema = Type.Object({
	access_token: NonEmptyString,
	token_type: NonEmptyString,
	expires_in: positiveInt(),
	refresh_token: Type.Optional(NonEmptyString),
});
const TokenExchangeWithExpiresAtSchema = Type.Object({
	access_token: NonEmptyString,
	token_type: NonEmptyString,
	expires_at: Type.Number(),
	refresh_token: Type.Optional(NonEmptyString),
});

/**
 * Hyper's exact rejected-refresh-token payload. Only an HTTP 401 whose body
 * matches this exact error string tells the user to re-authenticate; any
 * other 401 (or malformed body) stays a generic HTTP authentication failure.
 */
const RejectedRefreshTokenSchema = Type.Object({
	error: Type.Literal("could not get refresh token: not found"),
});

type DeviceAuthResponse = { device_code: string; expires_in: number; user_code: string; verification_url: string; interval?: number };
type DevicePollSuccess = { refresh_token: string; team_id: string; team_name: string; user_id: string };
type DevicePollError = { error: string; error_description?: string };
type TokenExchange =
	| { access_token: string; token_type: string; expires_in: number; refresh_token?: string }
	| { access_token: string; token_type: string; expires_at: number; refresh_token?: string };

// ─── Test seams (deterministic OAuth tests; defaults are the real ones) ──────

export interface OAuthTestHooks {
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
	now(): number;
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> => abortableSleep(ms, signal, CANCEL_MESSAGE);
let hooks: OAuthTestHooks = { sleep: realSleep, now: () => Date.now() };

/** Swap the clock/sleep seams for tests; returns the previous hooks. */
export function setOAuthTestHooks(next: Partial<OAuthTestHooks>): OAuthTestHooks {
	const previous = hooks;
	hooks = { ...previous, ...next };
	return previous;
}

// ─── Failure plumbing ─────────────────────────────────────────────────────────

/** Re-login guidance error, thrown only for the exact rejected-refresh payload. */
export class HyperRefreshTokenRejectedError extends Error {
	readonly kind = "refresh_token_rejected";
	constructor(cause: HyperHttpFailureError) {
		super(RE_LOGIN_MESSAGE, { cause });
		this.name = "HyperRefreshTokenRejectedError";
	}
}

function toHttpError(failure: HttpFailure, operation: string): HyperHttpFailureError {
	return new HyperHttpFailureError(failure, describeFailure(failure, operation));
}

// ─── Device name ──────────────────────────────────────────────────────────────

function deviceName(): string {
	const host = hostname();
	return host ? `Pi (${host})` : "Pi";
}

// ─── Cancellation-safe sleep ──────────────────────────────────────────────────

function abortableSleep(ms: number, signal: AbortSignal | undefined, cancelMessage: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(cancelMessage));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(cancelMessage));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ─── Endpoint calls (all through the shared HTTP client) ─────────────────────

async function initiateDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthResponse> {
	const outcome = await fetchJson({
		url: `${HYPER_BASE_URL}/device/auth`,
		operation: "Hyper device authorization",
		method: "POST",
		headers: jsonHeaders(),
		body: { device_name: deviceName() },
		signal,
		timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
	});
	if (!outcome.ok) throw toHttpError(outcome.failure, "Hyper device authorization");
	const parsed = validateEndpoint(DeviceAuthResponseSchema, outcome.value);
	if (!parsed.ok) {
		throw new Error(`Hyper device authorization response is invalid: ${parsed.errors.join("; ")}`);
	}
	return parsed.value as DeviceAuthResponse;
}

type PollStep = { kind: "complete"; value: DevicePollSuccess } | { kind: "pending" } | { kind: "slow_down" } | { kind: "failed"; message: string };

function parsePollPayload(payload: unknown): PollStep {
	const success = validateEndpoint(DevicePollSuccessSchema, payload);
	if (success.ok) return { kind: "complete", value: success.value as DevicePollSuccess };
	const failure = validateEndpoint(DevicePollErrorSchema, payload);
	if (failure.ok) {
		const { error, error_description: description } = failure.value as DevicePollError;
		if (error === "authorization_pending") return { kind: "pending" };
		if (error === "slow_down") return { kind: "slow_down" };
		// Terminal: prefer the description, but only when it is safe bounded
		// text (the same rules as server error detail).
		const safeDescription = typeof description === "string" ? sanitizeServerText(description, 200) : undefined;
		return { kind: "failed", message: `Hyper device authorization failed: ${safeDescription ?? error}` };
	}
	throw new Error("Hyper device poll response is invalid");
}

/** Bound, control-free server text for failure messages (no markup, no separators). */
function sanitizeServerText(value: string, maxChars: number): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > maxChars) return undefined;
	if (/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) return undefined;
	return trimmed;
}

/**
 * Device-flow poll loop: first-poll delay, one-second minimum interval,
 * five-second slow_down increments, device-code deadline, prompt termination
 * on terminal errors, and prompt cancellation. The clock/sleep seams are
 * injectable so tests run without real one-second waits.
 */
async function pollDeviceAuth(auth: DeviceAuthResponse, signal?: AbortSignal): Promise<DevicePollSuccess> {
	const deadline = hooks.now() + auth.expires_in * 1000;
	let intervalMs = Math.max(MIN_POLL_INTERVAL_MS, (auth.interval ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000);
	let slowDownResponses = 0;

	// Server-specified cadence starts after the first wait (device codes are
	// never ready immediately; polling sooner only earns slow_down responses).
	const initialRemainingMs = deadline - hooks.now();
	if (initialRemainingMs > 0) {
		await hooks.sleep(Math.min(intervalMs, initialRemainingMs), signal);
	}

	while (hooks.now() < deadline) {
		if (signal?.aborted) throw new Error(CANCEL_MESSAGE);
		const outcome = await fetchJson({
			url: `${HYPER_BASE_URL}/device/auth/${encodeURIComponent(auth.device_code)}`,
			operation: "Hyper device poll",
			headers: jsonHeaders(),
			signal,
			timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
		});
		if (!outcome.ok) throw toHttpError(outcome.failure, "Hyper device poll");
		const step = parsePollPayload(outcome.value);
		if (step.kind === "complete") return step.value;
		if (step.kind === "failed") throw new Error(step.message);
		if (step.kind === "slow_down") {
			slowDownResponses += 1;
			intervalMs = Math.max(MIN_POLL_INTERVAL_MS, intervalMs + SLOW_DOWN_INCREMENT_MS);
		}
		const remainingMs = deadline - hooks.now();
		if (remainingMs <= 0) break;
		await hooks.sleep(Math.min(intervalMs, remainingMs), signal);
	}
	throw new Error(slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}

async function exchangeRefreshToken(refreshToken: string, signal?: AbortSignal): Promise<TokenExchange> {
	const outcome = await fetchJson({
		url: `${HYPER_BASE_URL}/token/exchange`,
		operation: "Hyper token exchange",
		method: "POST",
		headers: jsonHeaders(),
		body: { refresh_token: refreshToken },
		signal,
		timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
	});
	if (!outcome.ok) {
		const error = toHttpError(outcome.failure, "Hyper token exchange");
		// Re-login guidance ONLY for HTTP 401 with Hyper's exact
		// rejected-refresh-token payload; everything else keeps its class.
		if (error.failure.kind === "http" && error.failure.status === 401 && error.failure.bodyText !== undefined) {
			try {
				const body: unknown = JSON.parse(error.failure.bodyText);
				if (validateEndpoint(RejectedRefreshTokenSchema, body).ok) {
					throw new HyperRefreshTokenRejectedError(error);
				}
			} catch (err) {
				if (err instanceof HyperRefreshTokenRejectedError) throw err;
				// Unparseable 401 body: stays a generic HTTP failure.
			}
		}
		throw error;
	}
	const parsed = validateEndpoint(
		Type.Union([TokenExchangeWithExpiresInSchema, TokenExchangeWithExpiresAtSchema]),
		outcome.value,
	);
	if (!parsed.ok) throw new Error(`Hyper token exchange response is invalid: ${parsed.errors.join("; ")}`);
	return parsed.value as TokenExchange;
}

// ─── Credential construction ──────────────────────────────────────────────────

/**
 * Validated relative/absolute expiry with the required safety buffer: the
 * lesser of 30 seconds or half the token lifetime. A non-future expiry fails
 * the exchange and leaves any existing credential unchanged.
 */
function tokenExpiresAtMs(token: TokenExchange, now: number): number {
	const expiresAt = "expires_in" in token ? now + token.expires_in * 1000 : token.expires_at * 1000;
	if (!Number.isFinite(expiresAt) || expiresAt <= now) {
		throw new Error("Hyper token exchange response contains an expired token expiry");
	}
	return expiresAt - Math.min(TOKEN_EXPIRY_BUFFER_MS, Math.floor((expiresAt - now) / 2));
}

/** Build the stored credential, falling back to the previous refresh token when
 * the response omits rotation, and preserving login-time team metadata. */
function toCredentials(token: TokenExchange, fallbackRefresh: string, teamName: string | undefined, now: number): OAuthCredential {
	return {
		type: "oauth",
		refresh: token.refresh_token || fallbackRefresh,
		access: token.access_token,
		expires: tokenExpiresAtMs(token, now),
		...(teamName ? { teamName } : {}),
	};
}

function teamNameFromCredential(credential: OAuthCredential): string | undefined {
	const teamName = (credential as { teamName?: unknown }).teamName;
	return typeof teamName === "string" && teamName.trim() ? teamName : undefined;
}

// ─── Public flows ─────────────────────────────────────────────────────────────

/** Device-flow login for the "hypercharm" provider (/login flow). */
export async function loginHypercharm(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const signal = interaction.signal;
	const deviceAuth = await initiateDeviceAuth(signal);
	const interval = deviceAuth.interval ?? DEFAULT_POLL_INTERVAL_SECONDS;
	interaction.notify({
		type: "device_code",
		userCode: deviceAuth.user_code,
		verificationUri: deviceAuth.verification_url,
		intervalSeconds: interval,
		expiresInSeconds: deviceAuth.expires_in,
	});
	const devicePoll = await pollDeviceAuth(deviceAuth, signal);
	const token = await exchangeRefreshToken(devicePoll.refresh_token, signal);
	return toCredentials(token, devicePoll.refresh_token, devicePoll.team_name, hooks.now());
}

/** Refresh an expired HyperCharm OAuth credential via the token exchange endpoint. */
export async function refreshHypercharmToken(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> {
	let token: TokenExchange;
	try {
		token = await exchangeRefreshToken(credential.refresh, signal);
	} catch (error) {
		if (error instanceof HyperRefreshTokenRejectedError) throw error;
		throw error;
	}
	return toCredentials(token, credential.refresh, teamNameFromCredential(credential), hooks.now());
}

/** Native OAuthAuth for the complete provider (loaded lazily). */
export function hypercharmOAuthAuth(): OAuthAuth {
	return {
		name: "HyperCharm",
		login: (interaction) => loginHypercharm(interaction),
		refresh: (credential, signal) => refreshHypercharmToken(credential, signal),
		toAuth: async (credential: OAuthCredential): Promise<ModelAuth> => ({ apiKey: credential.access }),
	};
}
