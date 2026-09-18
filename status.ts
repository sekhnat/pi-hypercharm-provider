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
 *
 * Terminal safety (legacy terminals, mintty/Cygwin):
 *   - Glyphs degrade to ASCII when auto-detection matches a legacy terminal
 *     or when the glyphs config asks for it (see GlyphMode). Older mintty
 *     builds measure these glyphs with cell tables that disagree with the
 *     ones above; the statusbar absorbs that (its lines are not edge-padded)
 *     but the full-width widget line wraps, which desyncs pi's row
 *     bookkeeping and leaves ghost rows behind.
 *   - render() budgets width − 1, so the widget never paints the terminal's
 *     last column (the classic pending-wrap hazard).
 */

export type DisplayMode = "sidebar" | "widget" | "statusbar" | "off";

export type GlyphMode = "auto" | "unicode" | "ascii";

export interface GlyphSet {
	bolt: string;
	gem: string;
	warn: string;
	auth: string;
	sep: string;
	ellipsis: string;
}

export const UNICODE_GLYPHS: GlyphSet = { bolt: "⚡", gem: "◆", warn: "⚠", auth: "⟳", sep: "·", ellipsis: "…" };
export const ASCII_GLYPHS: GlyphSet = { bolt: "*", gem: "+", warn: "!", auth: "~", sep: "-", ellipsis: "..." };

/** True for terminals whose cell-width tables are known to disagree with the
 * width math below (older mintty/Cygwin builds). */
export function detectLegacyTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
	const termProgram = env.TERM_PROGRAM ?? "";
	const term = env.TERM ?? "";
	return (
		termProgram === "mintty" ||
		termProgram === "cygwin" ||
		termProgram === "msys" ||
		term.startsWith("cygwin") ||
		term.startsWith("msys")
	);
}

export function resolveGlyphSet(mode: GlyphMode, env: NodeJS.ProcessEnv = process.env): GlyphSet {
	if (mode === "unicode") return UNICODE_GLYPHS;
	if (mode === "ascii") return ASCII_GLYPHS;
	return detectLegacyTerminal(env) ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/** Widget content is edge-padded to the terminal width, so a glyph the
 * terminal measures wider than termVisWidth() does wraps the line and
 * corrupts pi's differential renderer. An explicit "unicode" choice is
 * therefore clamped to ASCII for widget content on legacy terminals;
 * statusbar content is not edge-padded and keeps the caller's choice. */
export function resolveWidgetGlyphSet(mode: GlyphMode, env: NodeJS.ProcessEnv = process.env): GlyphSet {
	if (mode === "unicode" && detectLegacyTerminal(env)) return ASCII_GLYPHS;
	return resolveGlyphSet(mode, env);
}

export interface StatusConfig {
	/** Session spend/request line (left side). */
	session: DisplayMode;
	/** Team/balance/rate-limit line (right side). */
	account: DisplayMode;
	/** Hide everything when the active model is not from this provider. */
	hideOnOtherProvider: boolean;
	/** Omit the OAuth device-session expiry atom ("expires Nd" / "⟳ Nd") from every status surface. */
	hideAuthExpiry: boolean;
	/** Warn (warn glyph + highlight) when balance drops to this many hc. null = never. */
	lowBalanceHc: number | null;
	/** Footer glyph set; auto degrades to ASCII on legacy terminals. */
	glyphs: GlyphMode;
}

export const DEFAULT_STATUS_CONFIG: StatusConfig = {
	session: "sidebar",
	account: "sidebar",
	hideOnOtherProvider: true,
	hideAuthExpiry: false,
	lowBalanceHc: 25,
	glyphs: "auto",
};

const VALID_MODES = new Set<string>(["sidebar", "widget", "statusbar", "off"]);
const VALID_GLYPH_MODES = new Set<string>(["auto", "unicode", "ascii"]);

function coerceMode(value: unknown, fallback: DisplayMode): DisplayMode {
	return typeof value === "string" && VALID_MODES.has(value) ? (value as DisplayMode) : fallback;
}

function coerceGlyphMode(value: unknown, fallback: GlyphMode): GlyphMode {
	return typeof value === "string" && VALID_GLYPH_MODES.has(value) ? (value as GlyphMode) : fallback;
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
		hideAuthExpiry: typeof r.hideAuthExpiry === "boolean" ? r.hideAuthExpiry : d.hideAuthExpiry,
		lowBalanceHc:
			typeof r.lowBalanceHc === "number" && Number.isFinite(r.lowBalanceHc) && r.lowBalanceHc > 0
				? r.lowBalanceHc
				: r.lowBalanceHc === null || r.lowBalanceHc === false
					? null
					: d.lowBalanceHc,
		glyphs: coerceGlyphMode(r.glyphs, d.glyphs),
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
export function buildSessionLine(stats: SessionStats, glyphs: GlyphSet = UNICODE_GLYPHS): string | undefined {
	if (stats.requests <= 0 && stats.spendHc <= 0) return undefined;
	return `${glyphs.bolt} ${formatSpendHc(stats.spendHc)} hc ${glyphs.sep} ${stats.requests} req`;
}

export function accountHasData(acc: AccountState): boolean {
	return acc.balance !== null || acc.teamName !== null || acc.rate !== null;
}

/** Optional render knobs threaded from the status config into the account builders. */
export interface AccountRenderOptions {
	/** Omit the OAuth device-session expiry atom from the rendered account. */
	hideAuthExpiry?: boolean;
}

/**
 * Right side as progressive tiers — entries share no summary separator;
 * atoms are joined with " · ". Render picks the first that fits.
 */
export function buildAccountTiers(
	acc: AccountState,
	lowBalance: boolean,
	glyphs: GlyphSet = UNICODE_GLYPHS,
	opts: AccountRenderOptions = {},
): string[] {
	const gem = lowBalance ? `${glyphs.warn} ${glyphs.gem}` : glyphs.gem;
	const bal = acc.balance !== null ? `${gem} ${formatBalHc(acc.balance)} hc` : undefined;
	const hourRate =
		acc.rate !== null ? `${formatRateCompact(acc.rate.remainingHour)}/${formatRateCompact(acc.rate.limitHour)}/h` : undefined;
	const dayRate =
		acc.rate !== null ? `${formatRateCompact(acc.rate.remainingDay)}/${formatRateCompact(acc.rate.limitDay)}/d` : undefined;
	const auth = !opts.hideAuthExpiry && acc.authDaysLeft !== null ? `${glyphs.auth} ${acc.authDaysLeft}d` : undefined;
	const team = acc.teamName?.trim() || undefined;
	// Team and gem form one identity unit (space-separated, no middot);
	// rate-limit and auth atoms trail it separated by " · ".
	const head = [team, bal].filter((p): p is string => !!p).join(" ") || undefined;
	const numOnly = acc.balance !== null ? `${formatBalHc(acc.balance)} hc` : undefined;

	const join = (parts: (string | undefined)[]) => parts.filter((p): p is string => !!p).join(` ${glyphs.sep} `);

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

// ─── Sidebar panel rows (one fact per row) ───────────────────────────────────

export type SidebarRowRole = "primary" | "accent" | "muted" | "dim" | "ready" | "working" | "warning" | "error";

export interface SidebarRow {
	text: string;
	role?: SidebarRowRole;
}

/**
 * Rule between the session block and the account block. Non-whitespace by
 * construction: the host sanitizes panel text (whitespace runs collapse to a
 * single space) and drops zero-width rows, so only a glyph rule survives.
 */
export const SIDEBAR_DIVIDER_ROW: SidebarRow = Object.freeze({ text: "─".repeat(12), role: "dim" });

/**
 * Fixed meter cell count: 8 keeps the widest meter row (4-char label, bracketed
 * meter, worst-case compact counts) within the ~24 usable columns of the
 * 28-column sidebar minimum, measured the way the host measures it.
 */
export const SIDEBAR_METER_CELLS = 8;

/**
 * Proportional rate meter: ■ marks the remaining fraction of the limit
 * (clamped to [0,1]), · the used fraction — the same glyph vocabulary as
 * Atelier's built-in context panel. Non-finite inputs and non-positive limits
 * render an empty meter; callers omit those rows entirely.
 */
export function buildRateMeter(remaining: number, limit: number): string {
	const frac =
		Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0
			? Math.min(1, Math.max(0, remaining / limit))
			: 0;
	const filled = Math.round(frac * SIDEBAR_METER_CELLS);
	return `[${"■".repeat(filled)}${"·".repeat(SIDEBAR_METER_CELLS - filled)}]`;
}

/**
 * Account block, one fact per row: balance (warning role at/below the
 * threshold), hourly and daily meters with compact remaining/limit counts
 * (omitted when the limit is unknown or zero), and OAuth days remaining.
 * Missing atoms are omitted rather than replaced with placeholders, and the
 * team name is never included (Atelier owns panel identity).
 */
export function buildAccountSidebarRows(
	acc: AccountState,
	lowBalance: boolean,
	glyphs: GlyphSet = UNICODE_GLYPHS,
	opts: AccountRenderOptions = {},
): SidebarRow[] {
	const rows: SidebarRow[] = [];
	if (acc.balance !== null) {
		rows.push({ text: `${glyphs.gem} ${formatBalHc(acc.balance)} hc`, role: lowBalance ? "warning" : "ready" });
	}
	if (acc.rate !== null) {
		if (acc.rate.limitHour > 0) {
			rows.push({
				text: `hour ${buildRateMeter(acc.rate.remainingHour, acc.rate.limitHour)} ${formatRateCompact(acc.rate.remainingHour)}/${formatRateCompact(acc.rate.limitHour)}`,
				role: "muted",
			});
		}
		if (acc.rate.limitDay > 0) {
			rows.push({
				text: `day ${buildRateMeter(acc.rate.remainingDay, acc.rate.limitDay)} ${formatRateCompact(acc.rate.remainingDay)}/${formatRateCompact(acc.rate.limitDay)}`,
				role: "muted",
			});
		}
	}
	if (!opts.hideAuthExpiry && acc.authDaysLeft !== null) {
		rows.push({ text: `expires ${acc.authDaysLeft}d`, role: "dim" });
	}
	return rows;
}

/**
 * Full panel body: session row, a divider only when both blocks have content,
 * then the account rows. Every row is single-space separated and glyph-only —
 * the host sanitizes panel text (strips ANSI, collapses whitespace runs), so
 * layout must not depend on padding or escape codes. Rows render with the
 * caller's glyph set (auto degrades to ASCII on legacy terminals).
 */
export function buildSidebarRows(
	stats: SessionStats,
	acc: AccountState,
	lowBalance: boolean,
	glyphs: GlyphSet = UNICODE_GLYPHS,
	opts: AccountRenderOptions = {},
): SidebarRow[] {
	const rows: SidebarRow[] = [];
	const sessionLine = buildSessionLine(stats, glyphs);
	if (sessionLine) rows.push({ text: sessionLine, role: "muted" });
	const accountRows = buildAccountSidebarRows(acc, lowBalance, glyphs, opts);
	if (sessionLine && accountRows.length > 0) rows.push(SIDEBAR_DIVIDER_ROW);
	rows.push(...accountRows);
	return rows;
}

// ─── Sidebar panel publication decision ───────────────────────────────────────

/** Muted row shown when the panel publishes before any usage data exists. */
export const SIDEBAR_PLACEHOLDER_ROW = "no usage yet this session";

export interface SidebarPanelOptions {
	/** A defaults-capable Atelier host has been discovered. */
	compatible: boolean;
	/** A HyperCharm model is the active model (an unreadable provider counts as active). */
	isProviderActive: boolean;
	/** Display mode of the session spend/requests part. */
	sessionMode: DisplayMode;
	/** Display mode of the account balance/limits part. */
	accountMode: DisplayMode;
	sessionStats: SessionStats;
	account: AccountState;
	/** Balance is at/below the low-balance threshold (drives the row role). */
	lowBalance: boolean;
	/** Omit the OAuth device-session expiry atom from the account rows. */
	hideAuthExpiry?: boolean;
}

export interface SidebarPanelDecision {
	/** Whether the panel should be published; false means withdraw. */
	publish: boolean;
	/** Rows for the published panel; never empty when publish is true. */
	rows: SidebarRow[];
}

/**
 * Decide the sidebar panel for one render. Visibility follows the active
 * model, not session activity: an idle session still publishes (a placeholder
 * row when nothing has landed yet), so the panel appears at selection time
 * rather than after the first turn. The widget/statusbar activity gates live
 * in index.ts and are unaffected. Each metric lands in exactly one
 * destination: parts not targeting the sidebar contribute empty snapshots to
 * buildSidebarRows, so their metrics never render here.
 */
export function buildSidebarPanel(options: SidebarPanelOptions, glyphs: GlyphSet = UNICODE_GLYPHS): SidebarPanelDecision {
	const { compatible, isProviderActive, sessionMode, accountMode, sessionStats, account, lowBalance, hideAuthExpiry } =
		options;
	if (!compatible || !isProviderActive) return { publish: false, rows: [] };
	if (sessionMode !== "sidebar" && accountMode !== "sidebar") return { publish: false, rows: [] };
	const rows = buildSidebarRows(
		sessionMode === "sidebar" ? sessionStats : EMPTY_SESSION_STATS,
		accountMode === "sidebar" ? account : EMPTY_ACCOUNT,
		lowBalance,
		glyphs,
		{ hideAuthExpiry },
	);
	if (rows.length === 0) {
		rows.push({ text: SIDEBAR_PLACEHOLDER_ROW, role: "muted" });
	}
	return { publish: true, rows };
}

// ─── Terminal width math ──────────────────────────────────────────────────────
// Adapted from pi-neuralwatt-provider: ANSI-aware, wide-glyph-aware column
// counting. ◆ is ambiguous-width but this terminal class renders it wide.

const EMOJI_RE = /\p{Emoji_Presentation}/u;
// East-Asian-Ambiguous glyphs some terminals render as 2 columns. ◆ and ■ are
// NOT listed: pi-tui — the sidebar host's width authority, which decides
// padding and truncation — counts both as 1 column (get-east-asian-width), and
// meter-row budget checks must agree with the host's truncation math.
const AMBIGUOUS_WIDE = new Set(["▲", "◉"]);

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
export function truncateAnsi(str: string, maxCols: number, ellipsis = "…"): string {
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
	return result + ellipsis;
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
	private glyphs: GlyphSet;

	constructor(theme: LineTheme, leftRaw: string, rightTiers: string[] = [], rightWarn = false, glyphs: GlyphSet = UNICODE_GLYPHS) {
		this.theme = theme;
		this.leftRaw = leftRaw;
		this.rightTiers = rightTiers;
		this.rightWarn = rightWarn;
		this.glyphs = glyphs;
	}

	invalidate(): void {}

	render(width: number): string[] {
		// Never paint the terminal's last column: writing the final cell marks a
		// pending wrap on legacy terminals, and any real-vs-table width
		// disagreement then scrolls the frame and desyncs pi's row bookkeeping.
		const w = Math.max(1, width - 1);
		const leftVis = termVisWidth(this.leftRaw);
		if (leftVis > w) {
			return [this.theme.fg("dim", truncateAnsi(this.leftRaw, w, this.glyphs.ellipsis))];
		}

		const rightColor = this.rightWarn ? "warning" : "dim";
		const themedLeft = this.theme.fg("dim", this.leftRaw);
		const budget = w - leftVis - 1;

		for (const tier of this.rightTiers) {
			if (termVisWidth(tier) <= budget) {
				const themedRight = this.theme.fg(rightColor, tier);
				const pad = w - termVisWidth(themedLeft) - termVisWidth(themedRight);
				return [themedLeft + " ".repeat(Math.max(1, pad)) + themedRight];
			}
		}

		const pad = w - termVisWidth(themedLeft);
		return [themedLeft + " ".repeat(Math.max(0, pad))];
	}
}
