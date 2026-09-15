/**
 * Footer status presentation for the HyperCharm extension.
 *
 * Pure functions + a width-aware widget component — no pi runtime imports.
 * index.ts owns fetching, events, and config persistence; this module turns
 * state snapshots into terminal strings.
 *
 * Layout (below-editor widget, neuralwatt style):
 *
 *   ⚡ 1.24 hc · 7 req                ACME Team ◆ 249 hc · 996/1k/h · 29d
 *   └ left: session activity ──┘  └── right: account / quota ──────────┘
 *
 * The left side is preserved at full fidelity. The right side is rendered
 * from a tier list (most → least detailed); render() picks the first tier
 * that fits the remaining width, and as a last resort truncates the minimal
 * tier. Width math counts only terminal-visible columns (ANSI-aware, wide
 * glyphs like ◆ ⚡ ⚠ measure 2 columns).
 */

export type DisplayMode = "sidebar" | "widget" | "statusbar" | "off";

export interface StatusConfig {
	/** Session spend/request line (left side). */
	session: DisplayMode;
	/** Team/balance/rate-limit line (right side). */
	account: DisplayMode;
	/** Hide everything when the active model is not from this provider. */
	hideOnOtherProvider: boolean;
	/** Warn (⚠ + highlight) when balance drops to this many hc. null = never. */
	lowBalanceHc: number | null;
}

export const DEFAULT_STATUS_CONFIG: StatusConfig = {
	session: "sidebar",
	account: "sidebar",
	hideOnOtherProvider: true,
	lowBalanceHc: 25,
};

const VALID_MODES = new Set<string>(["sidebar", "widget", "statusbar", "off"]);

function coerceMode(value: unknown, fallback: DisplayMode): DisplayMode {
	return typeof value === "string" && VALID_MODES.has(value) ? (value as DisplayMode) : fallback;
}

/** Merge an unknown raw JSON object onto the defaults, field by field. */
export function coerceStatusConfig(raw: unknown): StatusConfig {
	const d = DEFAULT_STATUS_CONFIG;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...d };
	const r = raw as Record<string, unknown>;
	return {
		session: coerceMode(r.session, d.session),
		account: coerceMode(r.account, d.account),
		hideOnOtherProvider: typeof r.hideOnOtherProvider === "boolean" ? r.hideOnOtherProvider : d.hideOnOtherProvider,
		lowBalanceHc:
			typeof r.lowBalanceHc === "number" && Number.isFinite(r.lowBalanceHc) && r.lowBalanceHc > 0
				? r.lowBalanceHc
				: r.lowBalanceHc === null || r.lowBalanceHc === false
					? null
					: d.lowBalanceHc,
	};
}

// ─── State snapshots ──────────────────────────────────────────────────────────

export interface RateLimitState {
	limitHour: number;
	limitDay: number;
	remainingHour: number;
	remainingDay: number;
	capturedAt: number;
}

export interface AccountState {
	/** Canonical balance in hypercredits, from /v1/credits. */
	balance: number | null;
	/** Team display name, from /v1/teams (works for API-key auth too). */
	teamName: string | null;
	/** Latest x-ratelimit-* headers from a /chat/completions response. */
	rate: RateLimitState | null;
	/** Days until the OAuth device session expires (from /v1/devices). */
	authDaysLeft: number | null;
}

export const EMPTY_ACCOUNT: AccountState = {
	balance: null,
	teamName: null,
	rate: null,
	authDaysLeft: null,
};

export interface SessionStats {
	requests: number;
	spendHc: number;
}

export const EMPTY_SESSION_STATS: SessionStats = { requests: 0, spendHc: 0 };

/**
 * Optimistically deduct observed turn spend from the last polled balance.
 * Safe against double-counting only because callers overwrite (never adjust)
 * `balance` on every credits poll — the agent_settled poll reconciles drift.
 * Unknown balances stay unknown; estimates clamp at 0 (real exhaustion is
 * still signaled by the 402 path, not by an estimated zero).
 */
export function applyOptimisticSpend(acc: AccountState, spendHc: number): void {
	if (spendHc > 0 && acc.balance !== null) {
		acc.balance = Math.max(0, acc.balance - spendHc);
	}
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function trimZeros(text: string): string {
	return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** Balance in hypercredits: integers get group separators, large values compact. */
export function formatBalHc(n: number): string {
	if (!Number.isFinite(n)) return "?";
	const abs = Math.abs(n);
	if (abs >= 1_000_000) return `${trimZeros((n / 1_000_000).toFixed(2))}M`;
	if (abs >= 10_000) return `${trimZeros((n / 1_000).toFixed(1))}k`;
	return Number.isInteger(n) ? n.toLocaleString("en-US") : trimZeros(n.toFixed(2));
}

/** Session-cumulative spend: meaningful at small magnitudes, so keep precision. */
export function formatSpendHc(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 0.001) return "~0";
	if (n < 0.01) return trimZeros(n.toFixed(4));
	if (n < 1000) return trimZeros(n.toFixed(2));
	return Math.round(n).toLocaleString("en-US");
}

/** Rate-limit counts: exact when small, compact k when ≥ 1000. */
export function formatRateCompact(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (n >= 1000) return `${trimZeros((n / 1000).toFixed(1))}k`;
	return String(Math.max(0, Math.round(n)));
}

// ─── Line builders ────────────────────────────────────────────────────────────

/** Left side: what this session has spent/requested through HyperCharm. */
export function buildSessionLine(stats: SessionStats): string | undefined {
	if (stats.requests <= 0 && stats.spendHc <= 0) return undefined;
	return `⚡ ${formatSpendHc(stats.spendHc)} hc · ${stats.requests} req`;
}

export function accountHasData(acc: AccountState): boolean {
	return acc.balance !== null || acc.teamName !== null || acc.rate !== null;
}

/**
 * Right side as progressive tiers — entries share no summary separator;
 * atoms are joined with " · ". Render picks the first that fits.
 */
export function buildAccountTiers(acc: AccountState, lowBalance: boolean): string[] {
	const gem = lowBalance ? "⚠ ◆" : "◆";
	const bal = acc.balance !== null ? `${gem} ${formatBalHc(acc.balance)} hc` : undefined;
	const hourRate =
		acc.rate !== null ? `${formatRateCompact(acc.rate.remainingHour)}/${formatRateCompact(acc.rate.limitHour)}/h` : undefined;
	const dayRate =
		acc.rate !== null ? `${formatRateCompact(acc.rate.remainingDay)}/${formatRateCompact(acc.rate.limitDay)}/d` : undefined;
	const auth = acc.authDaysLeft !== null ? `⟳ ${acc.authDaysLeft}d` : undefined;
	const team = acc.teamName?.trim() || undefined;
	// Team and gem form one identity unit (space-separated, no middot);
	// rate-limit and auth atoms trail it separated by " · ".
	const head = [team, bal].filter((p): p is string => !!p).join(" ") || undefined;
	const numOnly = acc.balance !== null ? `${formatBalHc(acc.balance)} hc` : undefined;

	const join = (parts: (string | undefined)[]) => parts.filter((p): p is string => !!p).join(" · ");

	const tiers: string[] = [
		join([head, hourRate, dayRate, auth]),
		join([head, hourRate, auth]),
		join([head, hourRate]),
		join([bal, hourRate]),
		join([head]),
		join([team]),
		join([hourRate]),
		join([numOnly]),
	];

	// Dedupe adjacent identical tiers (happens when atoms are missing).
	const out: string[] = [];
	for (const t of tiers) {
		if (t && t !== out[out.length - 1]) out.push(t);
	}
	return out;
}

// ─── Sidebar panel rows (layout C) ────────────────────────────────────────────

export type SidebarRowRole = "primary" | "accent" | "muted" | "dim" | "ready" | "working" | "warning" | "error";

export interface SidebarRow {
	text: string;
	role?: SidebarRowRole;
}

/**
 * Structured rows for the Pi Atelier sidebar panel (no theme dependency):
 *   1. session spend/requests (subdued role),
 *   2. balance (warning role at/below the threshold),
 *   3. remaining hourly/daily rate limits and OAuth days remaining.
 *
 * Missing account atoms are omitted rather than replaced with placeholders,
 * and the team name is never included (Atelier owns panel identity).
 */
export function buildSidebarRows(stats: SessionStats, acc: AccountState, lowBalance: boolean): SidebarRow[] {
	const rows: SidebarRow[] = [];
	const sessionLine = buildSessionLine(stats);
	if (sessionLine) rows.push({ text: sessionLine, role: "muted" });
	if (acc.balance !== null) {
		rows.push({ text: `◆ ${formatBalHc(acc.balance)} hc`, role: lowBalance ? "warning" : "ready" });
	}
	const hourRate =
		acc.rate !== null
			? `${formatRateCompact(acc.rate.remainingHour)}/${formatRateCompact(acc.rate.limitHour)}/h`
			: undefined;
	const dayRate =
		acc.rate !== null
			? `${formatRateCompact(acc.rate.remainingDay)}/${formatRateCompact(acc.rate.limitDay)}/d`
			: undefined;
	const auth = acc.authDaysLeft !== null ? `${acc.authDaysLeft}d` : undefined;
	const parts = [hourRate, dayRate, auth].filter((p): p is string => p !== undefined);
	if (parts.length > 0) rows.push({ text: parts.join(" · "), role: "muted" });
	return rows;
}

// ─── Terminal width math ──────────────────────────────────────────────────────
// Adapted from pi-neuralwatt-provider: ANSI-aware, wide-glyph-aware column
// counting. ◆ is ambiguous-width but this terminal class renders it wide.

const EMOJI_RE = /\p{Emoji_Presentation}/u;
// East-Asian-Ambiguous glyphs some terminals render as 2 columns. ◆ is NOT
// listed: pi widths it as 1 here, and counting it wide leaves a trailing gap
// before the right edge.
const AMBIGUOUS_WIDE = new Set(["■", "▲", "◉"]);

export function termVisWidth(str: string): number {
	let width = 0;
	let i = 0;
	while (i < str.length) {
		const code = str.charCodeAt(i);
		if (code === 0x1b && i + 1 < str.length) {
			const next = str.charCodeAt(i + 1);
			if (next === 0x5b) {
				i += 2;
				while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i++;
				while (i < str.length && str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x3f) i++;
				if (i < str.length) i++;
				continue;
			}
		}
		const cp = str.codePointAt(i)!;
		const char = cp > 0xffff ? str.slice(i, i + 2) : str[i];
		if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
			width += 1;
		} else if (EMOJI_RE.test(char)) {
			width += 2;
		} else if (AMBIGUOUS_WIDE.has(char)) {
			width += 2;
		} else {
			width += 1;
		}
		i += cp > 0xffff ? 2 : 1;
	}
	return width;
}

/** Cut a (possibly ANSI-containing) string to fit maxCols visible columns. */
export function truncateAnsi(str: string, maxCols: number): string {
	if (maxCols <= 0) return "";
	if (termVisWidth(str) <= maxCols) return str;
	let result = "";
	let visWidth = 0;
	let i = 0;
	const target = maxCols - 1;
	while (i < str.length) {
		const code = str.charCodeAt(i);
		if (code === 0x1b && i + 1 < str.length && str.charCodeAt(i + 1) === 0x5b) {
			const start = i;
			i += 2;
			while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i++;
			while (i < str.length && str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x3f) i++;
			if (i < str.length) i++;
			result += str.slice(start, i);
			continue;
		}
		const cp = str.codePointAt(i)!;
		const char = cp > 0xffff ? str.slice(i, i + 2) : str[i];
		let charWidth: number;
		if (cp >= 0x1f1e6 && cp <= 0x1f1ff) charWidth = 1;
		else if (EMOJI_RE.test(char)) charWidth = 2;
		else if (AMBIGUOUS_WIDE.has(char)) charWidth = 2;
		else charWidth = 1;
		if (visWidth + charWidth > target) break;
		result += char;
		visWidth += charWidth;
		i += cp > 0xffff ? 2 : 1;
	}
	return result + "…";
}

// ─── Widget component ─────────────────────────────────────────────────────────

export interface LineTheme {
	fg(color: string, text: string): string;
}

/**
 * Width-aware two-zone line. Left (session) is preserved verbatim and
 * truncated only if it alone exceeds the terminal width. Right (account)
 * selects progressively more compact tiers as space tightens; when no tier
 * fits, the line degrades to left-only. The right side flips to the theme's
 * warning color while the balance is at/below the configured threshold.
 */
export class StatusLineWidget {
	private theme: LineTheme;
	private leftRaw: string;
	private rightTiers: string[];
	private rightWarn: boolean;

	constructor(theme: LineTheme, leftRaw: string, rightTiers: string[] = [], rightWarn = false) {
		this.theme = theme;
		this.leftRaw = leftRaw;
		this.rightTiers = rightTiers;
		this.rightWarn = rightWarn;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const leftVis = termVisWidth(this.leftRaw);
		if (leftVis > width) {
			return [this.theme.fg("dim", truncateAnsi(this.leftRaw, width))];
		}

		const rightColor = this.rightWarn ? "warning" : "dim";
		const themedLeft = this.theme.fg("dim", this.leftRaw);
		const budget = width - leftVis - 1;

		for (const tier of this.rightTiers) {
			if (termVisWidth(tier) <= budget) {
				const themedRight = this.theme.fg(rightColor, tier);
				const pad = width - termVisWidth(themedLeft) - termVisWidth(themedRight);
				return [themedLeft + " ".repeat(Math.max(1, pad)) + themedRight];
			}
		}

		const pad = width - termVisWidth(themedLeft);
		return [themedLeft + " ".repeat(Math.max(0, pad))];
	}
}
