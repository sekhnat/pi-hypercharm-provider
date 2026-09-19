/**
 * Shared Hyper JSON HTTP client — the one boundary every non-streaming
 * control-plane request goes through (specs/hyper-api-reliability).
 *
 * Pure module — no pi imports, no fs. Every request:
 *   - carries composed cancellation: the caller's signal plus a finite
 *     operation-specific request timeout, so caller cancellation stays
 *     distinguishable from a timeout or network failure;
 *   - bounds the response-body read with its own timeout;
 *   - classifies outcomes into typed failures (aborted / timeout / network /
 *     http / payload) instead of throwing ad-hoc Errors;
 *   - reports failures through a caller-supplied operation label — never a raw
 *     URL — so dynamic URL secrets (device codes, tokens) cannot leak;
 *   - adds server error detail only from a strictly validated OpenAI-style
 *     error envelope with safe bounded tokens.
 *
 * Authorization headers, request bodies, and OAuth tokens are structurally
 * excluded from diagnostics: the failure shape has no field for them and
 * redactSecrets() scrubs any credential-like text out of the one free-text
 * component (network error messages) that could carry it.
 */

// ─── Typed failures ───────────────────────────────────────────────────────────

/** Bounded, validated server error detail (OpenAI-style error envelope). */
export interface SafeProviderDetail {
	type?: string;
	code?: string;
	message?: string;
}

export type HttpFailure =
	| { kind: "aborted" }
	| { kind: "timeout"; phase: "request" | "body" }
	| { kind: "network"; message: string }
	| {
			kind: "http";
			status: number;
			/** Normalized server retry hint (parseRetryAfterMs), when valid. */
			retryAfterMs?: number;
			/** Safe bounded server detail, only when the envelope validates. */
			detail?: SafeProviderDetail;
			/**
			 * Raw response body (bounded, response side only) for consumers that
			 * must match an exact payload — e.g. the rejected-refresh-token check.
			 * NEVER copy this into diagnostics; use detail.
			 */
			bodyText?: string;
	  }
	| { kind: "payload"; reason: string };

/** Typed error wrapper so consumers can branch on the failure kind while
 * keeping the composed, secret-free message as the surfaced text. */
export class HyperHttpFailureError extends Error {
	constructor(
		readonly failure: HttpFailure,
		message: string,
	) {
		super(message);
		this.name = "HyperHttpFailureError";
	}
}

/** Human message for a failure. Composed from the operation label and safe
 * fields only — never URLs, headers, or request bodies. */
export function describeFailure(failure: HttpFailure, operation: string): string {
	switch (failure.kind) {
		case "aborted":
			return `${operation} was cancelled`;
		case "timeout":
			return `${operation} timed out`;
		case "network":
			return `${operation} failed: ${redactSecrets(failure.message)}`;
		case "http": {
			const base = `${operation} failed: HTTP ${failure.status}`;
			const d = failure.detail;
			if (!d) return base;
			const tag = [d.type, d.code].filter(Boolean).join(" ");
			const parts = [tag, d.message].filter((part) => typeof part === "string" && part.length > 0);
			return parts.length > 0 ? `${base}: ${parts.join(": ")}` : base;
		}
		case "payload":
			return `${operation} returned an invalid response: ${failure.reason}`;
	}
}

// ─── Credential redaction ─────────────────────────────────────────────────────

/**
 * Scrub credential-like text from a diagnostic string: exact secret values the
 * caller sent, plus any "Bearer <token>" pattern. Defense in depth for the one
 * failure kind (network) whose message text originates outside this module.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
	let out = text.replace(/(Bearer\s+)[^\s,;)"']+/gi, "$1[redacted]");
	for (const secret of secrets) {
		if (typeof secret === "string" && secret.length >= 8) {
			out = out.split(secret).join("[redacted]");
		}
	}
	return out;
}

// ─── Safe OpenAI-style error extraction ───────────────────────────────────────

const MAX_DETAIL_TOKEN_CHARS = 64;
const MAX_DETAIL_MESSAGE_CHARS = 200;

function isSafeDetailText(value: string, maxChars: number): boolean {
	if (value.length === 0 || value.length > maxChars) return false;
	for (const ch of value) {
		const cp = ch.codePointAt(0) ?? 0;
		// Control characters, DEL, angle brackets, Unicode bidi/zero-width
		// formatting, line/paragraph separators, BOM, and noncharacters all
		// make server text unsafe for terminal/UI diagnostics.
		if (cp <= 0x1f || cp === 0x7f) return false;
		if (cp === 0x3c || cp === 0x3e) return false; // < >
		if (cp >= 0x200b && cp <= 0x200f) return false; // zero-width + bidi marks
		if (cp === 0x2028 || cp === 0x2029) return false; // line/paragraph separator
		if (cp >= 0x202a && cp <= 0x202e) return false; // bidi formatting
		if (cp === 0xfeff) return false; // BOM
		if (cp >= 0xfff0 && cp <= 0xffff) return false; // specials
	}
	return true;
}

function safeDetailToken(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return isSafeDetailText(trimmed, MAX_DETAIL_TOKEN_CHARS) ? trimmed : undefined;
}

/**
 * Extract server error detail only when the body matches the OpenAI-style
 * error envelope ({"error":{message,type,code}} or a flat
 * {message,type,code}) AND every surfaced field passes the safe bounded-token
 * rules. Anything oversized, markup-bearing, or control-bearing is omitted.
 */
export function safeProviderDetail(bodyText: string): SafeProviderDetail | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const envelope = parsed as Record<string, unknown>;
	const source =
		typeof envelope.error === "object" && envelope.error !== null && !Array.isArray(envelope.error)
			? (envelope.error as Record<string, unknown>)
			: envelope;
	if (source !== envelope && Object.keys(source).length === 0) return undefined;
	const detail: SafeProviderDetail = {};
	const type = safeDetailToken(source.type);
	const code = safeDetailToken(source.code);
	const message = safeDetailToken(source.message);
	if (type !== undefined) detail.type = type;
	if (code !== undefined) detail.code = code;
	// The message is additionally trimmed to 200 Unicode characters — a longer
	// valid-text message is dropped rather than truncated mid-word.
	if (message !== undefined && [...message].length <= MAX_DETAIL_MESSAGE_CHARS) detail.message = message;
	return Object.keys(detail).length > 0 ? detail : undefined;
}

// ─── Retry-After normalization ────────────────────────────────────────────────

/** Upper bound for any server-supplied retry delay (24 hours). */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const HTTP_DATE_PATTERN =
	/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Defensive Retry-After parsing. Accepts only integer delay-seconds or the
 * canonical IMF-fixdate HTTP date; everything else is ignored. The result is
 * clamped to [0, 24h] — past/current dates collapse to 0, excessive dates cap
 * at 24 hours — so callers can schedule unconditionally when defined.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	if (/^-?\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		if (!Number.isFinite(seconds)) return undefined;
		return Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_AFTER_MS);
	}
	if (!HTTP_DATE_PATTERN.test(trimmed)) return undefined;
	const when = Date.parse(trimmed);
	if (!Number.isFinite(when)) return undefined;
	return Math.min(Math.max(when - now, 0), MAX_RETRY_AFTER_MS);
}

// ─── The client ───────────────────────────────────────────────────────────────

/** Default finite operation timeout when a caller does not choose one. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/** Maximum response-body text retained on an HTTP failure (payload matching only). */
const MAX_FAILURE_BODY_CHARS = 4096;

export interface FetchJsonOptions {
	/** Absolute endpoint URL. Never appears in failure messages. */
	url: string;
	/** Human operation label used in failure messages; must contain no secrets. */
	operation: string;
	method?: "GET" | "POST";
	/** Extra headers (Authorization, Content-Type…). Never appears in failures. */
	headers?: Record<string, string>;
	/** JSON-serializable request body. Never appears in failures. */
	body?: unknown;
	/** Finite request timeout (headers + dispatch). */
	timeoutMs?: number;
	/** Response-body read timeout; defaults to timeoutMs. */
	bodyTimeoutMs?: number;
	/** Caller cancellation signal. */
	signal?: AbortSignal;
	/** Credentials to scrub from network-error text. */
	secrets?: readonly string[];
}

export type FetchJsonOutcome<T> = { ok: true; value: T } | { ok: false; failure: HttpFailure };

function isTimeoutLike(err: unknown): boolean {
	const name = (err as { name?: unknown } | null)?.name;
	return name === "TimeoutError" || name === "AbortError";
}

/** Race a body read against its own deadline, aborting the owned controller on expiry. */
async function readBodyBounded(
	response: Response,
	abortOwned: () => void,
	bodyTimeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; timedOut: boolean; error?: unknown }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			response.text().then((text) => ({ ok: true as const, text })),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					// Cancel the underlying read for real network responses; the
					// race rejection below wins regardless.
					abortOwned();
					reject(new DOMException("Response body timed out", "TimeoutError"));
				}, bodyTimeoutMs);
			}),
		]);
	} catch (err) {
		// A TimeoutError here can only be our own body deadline: the request
		// timeout has its own rejection path and the caller's signal is
		// re-checked by the caller.
		return { ok: false, timedOut: (err as { name?: unknown })?.name === "TimeoutError", error: err };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Perform one bounded JSON request. Success returns the parsed JSON body;
 * every other outcome is a typed HttpFailure. See the module docstring for
 * the guarantees.
 */
export async function fetchJson<T = unknown>(options: FetchJsonOptions): Promise<FetchJsonOutcome<T>> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
	const bodyTimeoutMs = options.bodyTimeoutMs ?? timeoutMs;
	const callerSignal = options.signal;
	const owned = new AbortController();

	if (callerSignal?.aborted) return { ok: false, failure: { kind: "aborted" } };

	const init: RequestInit = {
		method: options.method ?? "GET",
		headers: options.headers,
		signal: AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs), owned.signal].filter(Boolean) as AbortSignal[]),
	};
	if (options.body !== undefined) init.body = JSON.stringify(options.body);

	let response: Response;
	try {
		response = await globalThis.fetch(options.url, init);
	} catch (err) {
		if (callerSignal?.aborted || owned.signal.aborted) return { ok: false, failure: { kind: "aborted" } };
		if (isTimeoutLike(err)) return { ok: false, failure: { kind: "timeout", phase: "request" } };
		return {
			ok: false,
			failure: { kind: "network", message: err instanceof Error ? err.message : String(err) },
		};
	}

	if (!response.ok) {
		const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
		const read = await readBodyBounded(response, () => owned.abort(), bodyTimeoutMs);
		const bodyText = read.ok ? read.text.slice(0, MAX_FAILURE_BODY_CHARS) : undefined;
		return {
			ok: false,
			failure: {
				kind: "http",
				status: response.status,
				...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
				...(bodyText !== undefined ? { detail: safeProviderDetail(bodyText), bodyText } : {}),
			},
		};
	}

	const read = await readBodyBounded(response, () => owned.abort(), bodyTimeoutMs);
	if (!read.ok) {
		if (callerSignal?.aborted) return { ok: false, failure: { kind: "aborted" } };
		if (read.timedOut) return { ok: false, failure: { kind: "timeout", phase: "body" } };
		return {
			ok: false,
			failure: {
				kind: "network",
				message: read.error instanceof Error ? read.error.message : "response body could not be read",
			},
		};
	}
	const text = read.text.trim();
	if (text.length === 0) {
		return { ok: false, failure: { kind: "payload", reason: "response body is empty" } };
	}
	try {
		return { ok: true, value: JSON.parse(text) as T };
	} catch {
		return { ok: false, failure: { kind: "payload", reason: "response body is not valid JSON" } };
	}
}
