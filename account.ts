/**
 * Credential-scoped account status runtime for Hypercredit balance, team
 * metadata, and OAuth device sessions (specs/account-status-refresh).
 *
 * Pure module — no pi imports, no fs. index.ts wires lifecycle events and
 * rendering; this runtime owns auth resolution (through an injected
 * resolver), network state, and commit safety:
 *
 *   - Credential leases: every fetch carries the resolved key plus a
 *     monotonically increasing epoch. A credential change, provider
 *     deactivation, or dispose bumps the epoch and aborts obsolete work, so a
 *     late result can never update or relabel visible state.
 *   - Coalescing: same-credential, same-epoch requests share per-endpoint
 *     in-flight work; an explicit forced refresh coalesces too.
 *   - Staged first snapshots: for a newly observed credential, credits, teams,
 *     and devices must all complete a valid sweep before anything commits —
 *     a new balance can never appear under an old team. For the already
 *     committed credential, successful endpoints update their atoms
 *     independently. Failed fetches retain the last coherent snapshot.
 *   - Bounded backoff: transient failures (network, timeout, 408, 429, 5xx)
 *     defer later automatic requests per endpoint; a valid server Retry-After
 *     wins, otherwise the delay grows exponentially from five seconds capped
 *     at five minutes. Success or a credential change resets the state, and a
 *     forced refresh bypasses the gate while still coalescing.
 *   - Lifecycle cancellation (deactivate/dispose aborts) is never surfaced as
 *     a failure warning.
 *
 * No background timers: retry gates are consulted when the next lifecycle
 * event triggers a refresh, satisfying Pi's rule against factory-time
 * background work.
 */
import { Type } from "typebox";
import { describeFailure, fetchJson, type HttpFailure } from "./http";
import { HYPER_API_URL, bearerAuth, jsonHeaders } from "./hyper";
import { NonEmptyString, validateEndpoint } from "./schema";

// ─── Endpoint contracts ───────────────────────────────────────────────────────

const CreditsPayloadSchema = Type.Union([
	Type.Object({ balance: Type.Number() }),
	Type.Object({ balance_usd: Type.Number() }),
]);

const TeamsPayloadSchema = Type.Object({
	items: Type.Array(Type.Object({ name: NonEmptyString })),
});

const DevicesPayloadSchema = Type.Object({
	items: Type.Array(Type.Object({ name: NonEmptyString, expires_at: Type.String() })),
});

/** Observed Hypercredit unit rate: 20 hypercredits = $1. */
export const HYPERCREDITS_PER_USD = 20;

/** Timeout applied to every account endpoint request. */
export const ACCOUNT_FETCH_TIMEOUT_MS = 8_000;

/** Minimum interval between automatic credits requests (drift-window cadence). */
export const CREDITS_MIN_INTERVAL_MS = 15_000;

/** Exponential backoff bounds for transient endpoint failures. */
export const RETRY_INITIAL_MS = 5_000;
export const RETRY_MAX_MS = 5 * 60_000;
const RETRY_MAX_EXPONENT = 6;

export type EndpointName = "credits" | "teams" | "devices";
const ENDPOINTS: readonly EndpointName[] = ["credits", "teams", "devices"];

export interface AccountSnapshot {
	/** Canonical balance in Hypercredits (USD converted at 20 hc/$). */
	balance: number | null;
	/** Team display name from /v1/teams. */
	teamName: string | null;
	/** Days until the OAuth device session expires, from /v1/devices. */
	authDaysLeft: number | null;
	/** Credential key (not the secret) the snapshot is attributed to. */
	key: string | undefined;
	/** Credential epoch the snapshot is attributed to. */
	epoch: number;
}

export const EMPTY_ACCOUNT_SNAPSHOT: AccountSnapshot = {
	balance: null,
	teamName: null,
	authDaysLeft: null,
	key: undefined,
	epoch: 0,
};

export interface AccountRuntimeOptions {
	/** Resolve the current provider credential's key (secret stays in memory). */
	resolveCredential: () => Promise<string | undefined>;
	/** Deduplicated warning sink for classified, sanitized failures. */
	warn: (message: string) => void;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Device session name matched against /v1/devices entries. */
	deviceName?: string;
	/** Endpoint timeouts; defaults to ACCOUNT_FETCH_TIMEOUT_MS. */
	timeoutMs?: Partial<Record<EndpointName, number>>;
}

interface EndpointState {
	inFlight:
		| {
				key: string;
				epoch: number;
				controller: AbortController;
				promise: Promise<void>;
		  }
		| undefined;
	/** Automatic refreshes are deferred until this time (0 = eligible). */
	retryAtMs: number;
	consecutiveFailures: number;
	/** Lease (key+epoch) whose valid result is committed for teams/devices. */
	committedLease: { key: string; epoch: number } | undefined;
	/** Last successful credits completion (throttle base). */
	lastSuccessAt: number;
}

/** A transient failure worth backing off from (specs/account-status-refresh). */
export function isTransientAccountFailure(failure: HttpFailure): boolean {
	if (failure.kind === "network" || failure.kind === "timeout") return true;
	if (failure.kind === "http") return failure.status === 408 || failure.status === 429 || (failure.status >= 500 && failure.status <= 599);
	return false;
}

// ─── Endpoint fetchers (validated before any state change) ────────────────────

export interface CreditsResult {
	balance: number;
}

/**
 * Fetch and validate /v1/credits. Accepts a finite Hypercredit `balance` or
 * converts a finite `balance_usd` at 20 hc/$; malformed or non-finite payloads
 * fail the fetch without producing a value.
 */
export async function fetchCredits(apiKey: string, signal: AbortSignal, timeoutMs = ACCOUNT_FETCH_TIMEOUT_MS): Promise<CreditsResult> {
	const outcome = await fetchJson({
		url: `${HYPER_API_URL}/credits`,
		operation: "Hypercredit balance",
		headers: { ...jsonHeaders(), ...bearerAuth(apiKey) },
		signal,
		timeoutMs,
	});
	if (!outcome.ok) throw new AccountFetchError(outcome.failure, "Hypercredit balance");
	const parsed = validateEndpoint(CreditsPayloadSchema, outcome.value);
	if (!parsed.ok) throw new AccountFetchError({ kind: "payload", reason: parsed.errors.join("; ") }, "Hypercredit balance");
	const data = parsed.value as { balance?: unknown; balance_usd?: unknown };
	const rawBalance = "balance" in data ? data.balance : (data.balance_usd as number) * HYPERCREDITS_PER_USD;
	if (typeof rawBalance !== "number" || !Number.isFinite(rawBalance)) {
		throw new AccountFetchError({ kind: "payload", reason: "balance is not a finite number" }, "Hypercredit balance");
	}
	return { balance: rawBalance };
}

export interface TeamsResult {
	/** First team name (trimmed), or undefined for a valid empty collection. */
	teamName: string | undefined;
}

/** Fetch and validate /v1/teams; an empty items list is valid and counts. */
export async function fetchTeams(apiKey: string, signal: AbortSignal, timeoutMs = ACCOUNT_FETCH_TIMEOUT_MS): Promise<TeamsResult> {
	const outcome = await fetchJson({
		url: `${HYPER_API_URL}/teams`,
		operation: "team metadata",
		headers: { ...jsonHeaders(), ...bearerAuth(apiKey) },
		signal,
		timeoutMs,
	});
	if (!outcome.ok) throw new AccountFetchError(outcome.failure, "team metadata");
	const parsed = validateEndpoint(TeamsPayloadSchema, outcome.value);
	if (!parsed.ok) throw new AccountFetchError({ kind: "payload", reason: parsed.errors.join("; ") }, "team metadata");
	const items = (parsed.value as { items: Array<{ name: string }> }).items;
	const name = items[0]?.name;
	return { teamName: typeof name === "string" && name.trim() ? name.trim() : undefined };
}

export interface DevicesResult {
	/** Days remaining for this machine's device session, when present. */
	authDaysLeft: number | undefined;
}

/**
 * Fetch and validate /v1/devices, matching the device registered as
 * `<deviceName>` (the OAuth device flow registers `Pi (<hostname>)`). API-key
 * auth legitimately yields an empty or non-matching list — valid, no value.
 */
export async function fetchDevices(
	apiKey: string,
	signal: AbortSignal,
	deviceName: string,
	now: () => number,
	timeoutMs = ACCOUNT_FETCH_TIMEOUT_MS,
): Promise<DevicesResult> {
	const outcome = await fetchJson({
		url: `${HYPER_API_URL}/devices`,
		operation: "device sessions",
		headers: { ...jsonHeaders(), ...bearerAuth(apiKey) },
		signal,
		timeoutMs,
	});
	if (!outcome.ok) throw new AccountFetchError(outcome.failure, "device sessions");
	const parsed = validateEndpoint(DevicesPayloadSchema, outcome.value);
	if (!parsed.ok) throw new AccountFetchError({ kind: "payload", reason: parsed.errors.join("; ") }, "device sessions");
	const own = (parsed.value as { items: Array<{ name: string; expires_at: string }> }).items.find(
		(device) => device.name === deviceName,
	);
	if (!own) return { authDaysLeft: undefined };
	const expiresMs = Date.parse(own.expires_at);
	if (!Number.isFinite(expiresMs)) {
		throw new AccountFetchError({ kind: "payload", reason: "device session expiry is not a valid date" }, "device sessions");
	}
	return { authDaysLeft: Math.max(0, Math.ceil((expiresMs - now()) / 86_400_000)) };
}

/** Classified account failure carrying the typed HTTP failure. */
export class AccountFetchError extends Error {
	constructor(
		readonly failure: HttpFailure,
		operation: string,
	) {
		super(describeFailure(failure, operation));
		this.name = "AccountFetchError";
	}
}

// ─── The runtime ──────────────────────────────────────────────────────────────

export interface AccountRuntime {
	/**
	 * Refresh account metadata. Automatic refreshes consult per-endpoint retry
	 * gates, credits throttling, and the teams/devices once-per-credential
	 * latch; `force` bypasses the gate while coalescing with compatible
	 * in-flight work. Resolves when this invocation's eligible work settles.
	 */
	refresh(options?: { force?: boolean }): Promise<void>;
	/** Committed, attributed snapshot (last-known data survives failures). */
	snapshot(): AccountSnapshot;
	/** Provider switch or session replacement: abort obsolete work, keep data. */
	deactivate(): void;
	/** Shutdown: abort everything; the runtime stops accepting refreshes. */
	dispose(): void;
	/** Test/inspection view of retry gates and in-flight state. */
	inspect(): {
		live: boolean;
		epoch: number;
		retryAtMs: Record<EndpointName, number>;
		inFlight: Record<EndpointName, boolean>;
	};
}

interface StagedSweep {
	key: string;
	epoch: number;
	invocation: number;
	balance: number | undefined;
	teamName: string | null | undefined;
	authDaysLeft: number | null | undefined;
}

export function createAccountRuntime(options: AccountRuntimeOptions): AccountRuntime {
	const now = options.now ?? (() => Date.now());
	const deviceName = options.deviceName ?? "";
	const resolveCredential = options.resolveCredential;
	const timeoutFor = (endpoint: EndpointName) => options.timeoutMs?.[endpoint] ?? ACCOUNT_FETCH_TIMEOUT_MS;

	const endpoints: Record<EndpointName, EndpointState> = {
		credits: { inFlight: undefined, retryAtMs: 0, consecutiveFailures: 0, committedLease: undefined, lastSuccessAt: 0 },
		teams: { inFlight: undefined, retryAtMs: 0, consecutiveFailures: 0, committedLease: undefined, lastSuccessAt: 0 },
		devices: { inFlight: undefined, retryAtMs: 0, consecutiveFailures: 0, committedLease: undefined, lastSuccessAt: 0 },
	};

	let live = true;
	let epoch = 0;
	let currentKey: string | undefined;
	let invocationSequence = 0;
	let committedInvocation = 0;
	let snapshot: AccountSnapshot = { ...EMPTY_ACCOUNT_SNAPSHOT };
	let staged: StagedSweep | undefined;
	const activeControllers = new Set<AbortController>();

	function resetRetryState(state: EndpointState): void {
		state.retryAtMs = 0;
		state.consecutiveFailures = 0;
	}

	function noteTransientFailure(state: EndpointState, failure: HttpFailure): void {
		state.consecutiveFailures += 1;
		const delay =
			failure.kind === "http" && failure.retryAfterMs !== undefined
				? failure.retryAfterMs
				: Math.min(RETRY_INITIAL_MS * 2 ** Math.min(state.consecutiveFailures - 1, RETRY_MAX_EXPONENT), RETRY_MAX_MS);
		state.retryAtMs = now() + delay;
	}

	function invalidateCredential(): void {
		epoch += 1;
		staged = undefined;
		for (const controller of activeControllers) controller.abort();
	}

	function ownsLease(key: string, leaseEpoch: number): boolean {
		return live && key === currentKey && leaseEpoch === epoch;
	}

	function applyCommittedAtom(name: EndpointName, value: CreditsResult | TeamsResult | DevicesResult): void {
		if (name === "credits") snapshot = { ...snapshot, balance: (value as CreditsResult).balance };
		else if (name === "teams") {
			const teamName = (value as TeamsResult).teamName;
			// A valid empty list never blanks a known team name.
			if (teamName !== undefined) snapshot = { ...snapshot, teamName };
		} else {
			const authDaysLeft = (value as DevicesResult).authDaysLeft;
			if (authDaysLeft !== undefined) snapshot = { ...snapshot, authDaysLeft };
		}
	}

	function commitEndpointResult(
		name: EndpointName,
		key: string,
		leaseEpoch: number,
		invocation: number,
		value: CreditsResult | TeamsResult | DevicesResult,
	): void {
		if (!live) return;
		if (invocation < committedInvocation) return; // superseded by newer work
		if (!ownsLease(key, leaseEpoch)) return; // obsolete credential work
		const committedLease = { key, epoch: leaseEpoch };
		if (snapshot.key === key && snapshot.epoch === leaseEpoch) {
			// Already-committed credential: atoms update independently.
			applyCommittedAtom(name, value);
			endpoints[name].committedLease = committedLease;
			endpoints[name].lastSuccessAt = now();
			committedInvocation = Math.max(committedInvocation, invocation);
			return;
		}
		// New credential: stage until one valid sweep completes.
		if (!staged || staged.key !== key || staged.epoch !== leaseEpoch) {
			staged = { key, epoch: leaseEpoch, invocation, balance: undefined, teamName: undefined, authDaysLeft: undefined };
		}
		if (invocation < staged.invocation) return; // only the latest sweep wins
		staged.invocation = invocation;
		if (name === "credits") staged.balance = (value as CreditsResult).balance;
		else if (name === "teams") staged.teamName = (value as TeamsResult).teamName ?? null;
		else staged.authDaysLeft = (value as DevicesResult).authDaysLeft ?? null;
		if (staged.balance !== undefined && staged.teamName !== undefined && staged.authDaysLeft !== undefined) {
			snapshot = {
				balance: staged.balance,
				teamName: staged.teamName,
				authDaysLeft: staged.authDaysLeft,
				key,
				epoch: leaseEpoch,
			};
			staged = undefined;
			for (const endpointName of ENDPOINTS) {
				endpoints[endpointName].committedLease = committedLease;
				endpoints[endpointName].lastSuccessAt = now();
			}
			committedInvocation = Math.max(committedInvocation, invocation);
		}
	}

	function isEligible(name: EndpointName, key: string, leaseEpoch: number, force: boolean): boolean {
		const state = endpoints[name];
		const existing = state.inFlight;
		if (existing && existing.key === key && existing.epoch === leaseEpoch) {
			// Compatible in-flight work is always shared.
			return true;
		}
		// Incompatible in-flight work (a stale lease) does not block this
		// refresh: it was aborted by the lease change and its commits are
		// dropped by the lease check, so issue fresh work subject to the gates.
		if (!force && now() < state.retryAtMs) return false;
		if (name === "credits") {
			if (!force && now() - state.lastSuccessAt < CREDITS_MIN_INTERVAL_MS) return false;
			return true;
		}
		// Teams/devices: once per credential lease unless forced.
		const latch = state.committedLease;
		if (!force && latch && latch.key === key && latch.epoch === leaseEpoch) return false;
		return true;
	}

	async function runEndpoint(name: EndpointName, key: string, leaseEpoch: number, invocation: number): Promise<void> {
		const state = endpoints[name];
		const existing = state.inFlight;
		if (existing && existing.key === key && existing.epoch === leaseEpoch) {
			await existing.promise;
			return;
		}
		const controller = new AbortController();
		activeControllers.add(controller);
		const operation = (async () => {
			try {
				let value: CreditsResult | TeamsResult | DevicesResult;
				if (name === "credits") value = await fetchCredits(key, controller.signal, timeoutFor(name));
				else if (name === "teams") value = await fetchTeams(key, controller.signal, timeoutFor(name));
				else value = await fetchDevices(key, controller.signal, deviceName, now, timeoutFor(name));
				commitEndpointResult(name, key, leaseEpoch, invocation, value);
				resetRetryState(state);
			} catch (error) {
				if (error instanceof AccountFetchError) {
					const aborted = error.failure.kind === "aborted";
					// Lifecycle cancellation (deactivate/dispose/key change) is
					// never a failure; everything else warns and may back off.
					if (!aborted && ownsLease(key, leaseEpoch) && invocation >= committedInvocation) {
						options.warn(error.message);
						if (isTransientAccountFailure(error.failure)) noteTransientFailure(state, error.failure);
						else resetRetryState(state);
					}
				} else if (ownsLease(key, leaseEpoch)) {
					// Unexpected programming error: surface through the sink too.
					options.warn(error instanceof Error ? error.message : String(error));
				}
			} finally {
				activeControllers.delete(controller);
				if (state.inFlight?.controller === controller) state.inFlight = undefined;
			}
		})();
		state.inFlight = { key, epoch: leaseEpoch, controller, promise: operation };
		await operation;
	}

	return {
		async refresh(refreshOptions) {
			if (!live) return;
			const force = refreshOptions?.force === true;
			const invocation = ++invocationSequence;
			let key: string | undefined;
			try {
				key = await resolveCredential();
			} catch (error) {
				if (invocation >= committedInvocation) {
					options.warn(`Unable to resolve HyperCharm credentials: ${error instanceof Error ? error.message : String(error)}.`);
				}
				return;
			}
			if (!live) return; // disposed or deactivated while auth resolved
			if (invocation < committedInvocation) return; // a newer invocation superseded this one
			if (!key) {
				// No resolvable credential: retain the last-known snapshot with
				// its original attribution; nothing is fetched.
				committedInvocation = Math.max(committedInvocation, invocation);
				return;
			}
			if (currentKey !== key) {
				currentKey = key;
				invalidateCredential();
				for (const name of ENDPOINTS) resetRetryState(endpoints[name]);
			}
			const leaseEpoch = epoch;
			const work: Array<Promise<void>> = [];
			for (const name of ENDPOINTS) {
				if (isEligible(name, key, leaseEpoch, force)) {
					work.push(runEndpoint(name, key, leaseEpoch, invocation));
				}
			}
			await Promise.all(work);
			if (invocation >= committedInvocation) committedInvocation = Math.max(committedInvocation, invocation);
		},

		snapshot: () => snapshot,

		deactivate() {
			// Provider switch / session replacement: abort obsolete work and
			// invalidate leases, but keep the last-known snapshot attributed to
			// its original credential so a switch back can reuse it.
			invalidateCredential();
		},

		dispose() {
			if (!live) return;
			live = false;
			invalidateCredential();
			currentKey = undefined;
		},

		inspect() {
			return {
				live,
				epoch,
				retryAtMs: {
					credits: endpoints.credits.retryAtMs,
					teams: endpoints.teams.retryAtMs,
					devices: endpoints.devices.retryAtMs,
				},
				inFlight: {
					credits: endpoints.credits.inFlight !== undefined,
					teams: endpoints.teams.inFlight !== undefined,
					devices: endpoints.devices.inFlight !== undefined,
				},
			};
		},
	};
}
