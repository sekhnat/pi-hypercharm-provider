/**
 * Dependency-free smoke test for the footer-status presentation module.
 * Run: node tests/status.smoke.ts (Node ≥ 23 strips types natively).
 * Exercises tier building, width math, widget layout, and config coercion —
 * the pieces where a regression would silently corrupt the footer line.
 */
import assert from "node:assert/strict";
import {
	EMPTY_ACCOUNT,
	EMPTY_SESSION_STATS,
	StatusLineWidget,
	ASCII_GLYPHS,
	UNICODE_GLYPHS,
	accountHasData,
	applyOptimisticSpend,
	buildAccountTiers,
	buildAccountSidebarRows,
	buildRateMeter,
	buildSidebarPanel,
	buildSidebarRows,
	buildSessionLine,
	coerceStatusConfig,
	detectLegacyTerminal,
	formatBalHc,
	formatRateCompact,
	formatSpendHc,
	SIDEBAR_DIVIDER_ROW,
	SIDEBAR_METER_CELLS,
	SIDEBAR_PLACEHOLDER_ROW,
	resolveGlyphSet,
	resolveWidgetGlyphSet,
	termVisWidth,
	truncateAnsi,
	type AccountState,
	type SidebarRow,
} from "../status.ts";
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const fakeTheme = { fg: (_c: string, t: string) => `\x1b[2m${t}\x1b[39m` };

// ── formatters ──
assert.equal(formatBalHc(249), "249");
assert.equal(formatBalHc(12345), "12.3k");
assert.equal(formatBalHc(250.5), "250.5");
assert.equal(formatBalHc(1_250_000), "1.25M");
assert.equal(formatSpendHc(0), "0");
assert.equal(formatSpendHc(0.0004), "~0");
assert.equal(formatSpendHc(0.0021), "0.0021");
assert.equal(formatSpendHc(0.31), "0.31");
assert.equal(formatSpendHc(12.5), "12.5");
assert.equal(formatRateCompact(996), "996");
assert.equal(formatRateCompact(1000), "1k");
assert.equal(formatRateCompact(9996), "10k");

// ── session line ──
assert.equal(buildSessionLine({ requests: 0, spendHc: 0 }), undefined);
assert.equal(buildSessionLine({ requests: 7, spendHc: 1.24 }), "⚡ 1.24 hc · 7 req");
assert.equal(buildSessionLine({ requests: 1, spendHc: 0 }), "⚡ 0 hc · 1 req");

// ── account tiers ──
const acc = (over: Partial<AccountState>): AccountState => ({ ...EMPTY_ACCOUNT, ...over });
const rate = { limitHour: 1000, limitDay: 10000, remainingHour: 996, remainingDay: 9996, capturedAt: 0 };

assert.equal(accountHasData(acc({})), false);
assert.equal(accountHasData(acc({ balance: 0 })), true);

const full = acc({ balance: 249, teamName: "ACME Team", rate, authDaysLeft: 29 });
const tiers = buildAccountTiers(full, false);
assert.equal(tiers[0], "ACME Team ◆ 249 hc · 996/1k/h · 10k/10k/d · ⟳ 29d");
assert.ok(tiers.includes("ACME Team ◆ 249 hc"));
assert.ok(tiers.includes("◆ 249 hc · 996/1k/h"));
assert.ok(tiers.includes("249 hc"));
// tiers must be strictly non-increasing in width
for (let i = 1; i < tiers.length; i++) {
	assert.ok(termVisWidth(tiers[i]) <= termVisWidth(tiers[i - 1]), `tier ${i} wider than previous`);
}
// dedupe of adjacent identical tiers when atoms are missing
assert.deepEqual(buildAccountTiers(acc({ teamName: "ACME" }), false), ["ACME"]);
const balOnly = buildAccountTiers(acc({ balance: 12 }), true);
assert.equal(balOnly[0], "⚠ ◆ 12 hc");
assert.ok(balOnly.includes("12 hc"));


const sidebarRowsOf = (accountState: AccountState, lowBalance: boolean) =>
	buildSidebarRows({ requests: 7, spendHc: 1.24 }, accountState, lowBalance);
// ── sidebar panel rows (one fact per row) ──
{
	const sidebarRows = buildSidebarRows({ requests: 7, spendHc: 1.24 }, full, false);
	assert.deepEqual(sidebarRows, [
		{ text: "⚡ 1.24 hc · 7 req", role: "muted" },
		SIDEBAR_DIVIDER_ROW,
		{ text: "◆ 249 hc", role: "ready" },
		{ text: "hour [■■■■■■■■] 996/1k", role: "muted" },
		{ text: "day [■■■■■■■■] 10k/10k", role: "muted" },
		{ text: "expires 29d", role: "dim" },
	]);
	// missing rate + auth atoms: limit and expiry rows omitted, divider stays
	const noRate = sidebarRowsOf(acc({ balance: 249 }), false);
	assert.deepEqual(noRate, [
		{ text: "⚡ 1.24 hc · 7 req", role: "muted" },
		SIDEBAR_DIVIDER_ROW,
		{ text: "◆ 249 hc", role: "ready" },
	]);
	// team name never appears
	for (const row of sidebarRows) assert.ok(!row.text.includes("ACME"));
	// low balance flips only the balance row role
	const low = sidebarRowsOf({ ...EMPTY_ACCOUNT, balance: 10 }, true);
	assert.deepEqual(low[2], { text: "◆ 10 hc", role: "warning" });
	for (const row of low) assert.ok(row.role !== "warning" || row.text.includes("◆"), "only the balance row warns");
	// no activity → no session row, no divider
	const idle = buildSidebarRows(EMPTY_SESSION_STATS, full, false);
	assert.deepEqual(idle, [
		{ text: "◆ 249 hc", role: "ready" },
		{ text: "hour [■■■■■■■■] 996/1k", role: "muted" },
		{ text: "day [■■■■■■■■] 10k/10k", role: "muted" },
		{ text: "expires 29d", role: "dim" },
	]);
	// session-only: no divider without account rows
	assert.deepEqual(buildSidebarRows({ requests: 7, spendHc: 1.24 }, acc({}), false), [
		{ text: "⚡ 1.24 hc · 7 req", role: "muted" },
	]);
	// nothing at all → no rows (the panel decision layer substitutes the placeholder)
	assert.deepEqual(buildSidebarRows(EMPTY_SESSION_STATS, acc({}), false), []);
}

// ── rate meter ──
{
	assert.equal(SIDEBAR_METER_CELLS, 8);
	assert.equal(buildRateMeter(996, 1000), "[■■■■■■■■]", "996/1000 fills 7.968 → rounds to full");
	assert.equal(buildRateMeter(500, 1000), "[■■■■····]");
	assert.equal(buildRateMeter(0, 500), "[········]", "zero remaining → empty meter; counts 0/500 stay on the row");
	assert.equal(buildRateMeter(1250, 1000), "[■■■■■■■■]", "remaining above the limit clamps to full");
	assert.equal(buildRateMeter(-5, 1000), "[········]", "negative remaining clamps to empty");
	assert.equal(buildRateMeter(Number.NaN, 1000), "[········]", "NaN remaining never produces NaN cells");
	assert.equal(buildRateMeter(10, Number.NaN), "[········]");
	assert.equal(buildRateMeter(10, 0), "[········]", "zero limit renders empty; the row itself is omitted");
	// zero/unknown limits omit the whole rate-limit row
	const zeroLimits = buildAccountSidebarRows(
		acc({ rate: { limitHour: 0, limitDay: 0, remainingHour: 0, remainingDay: 0, capturedAt: 0 } }),
		false,
	);
	assert.deepEqual(zeroLimits, []);
	const dayOnly = buildAccountSidebarRows(
		acc({ rate: { limitHour: 0, limitDay: 10000, remainingHour: 0, remainingDay: 2500, capturedAt: 0 } }),
		false,
	);
	assert.deepEqual(dayOnly, [{ text: "day [■■······] 2.5k/10k", role: "muted" }]);
	// account block alone (no session row): balance, meters, expiry as separate rows
	assert.deepEqual(buildAccountSidebarRows(full, false), [
		{ text: "◆ 249 hc", role: "ready" },
		{ text: "hour [■■■■■■■■] 996/1k", role: "muted" },
		{ text: "day [■■■■■■■■] 10k/10k", role: "muted" },
		{ text: "expires 29d", role: "dim" },
	]);
}

// ── sidebar row budget: 24 visible columns at the 28-column sidebar minimum ──
{
	const big = acc({
		balance: 1_250_000,
		rate: { limitHour: 10000, limitDay: 10000, remainingHour: 9996, remainingDay: 9996, capturedAt: 0 },
		authDaysLeft: 29,
	});
	for (const row of buildSidebarRows({ requests: 7, spendHc: 1.24 }, big, false)) {
		assert.ok(termVisWidth(row.text) <= 24, `row exceeds 24 columns: ${row.text}`);
	}
	for (const row of buildSidebarRows(EMPTY_SESSION_STATS, big, false)) {
		assert.ok(termVisWidth(row.text) <= 24, `row exceeds 24 columns: ${row.text}`);
	}
}

// ── sanitizer survival: rows must not depend on what the host strips ──
{
	const fixtures: SidebarRow[][] = [
		buildSidebarRows({ requests: 7, spendHc: 1.24 }, full, false),
		buildSidebarRows({ requests: 7, spendHc: 1.24 }, acc({ balance: 249 }), false),
		buildSidebarRows(EMPTY_SESSION_STATS, full, false),
		buildSidebarRows(EMPTY_SESSION_STATS, acc({}), false),
	];
	for (const rows of fixtures) {
		for (const row of rows) {
			assert.ok(!row.text.includes("\x1b"), `ANSI in row: ${row.text}`);
			assert.equal(row.text, row.text.replace(/\s+/g, " ").trim(), `unsanitary row: ${row.text}`);
			assert.ok(termVisWidth(row.text) > 0, `zero-width row (host drops it): ${row.text}`);
		}
	}
	// divider survives host whitespace-collapse and zero-width filtering
	assert.ok(!/\s/.test(SIDEBAR_DIVIDER_ROW.text));
	assert.equal(termVisWidth(SIDEBAR_DIVIDER_ROW.text), 12);
}

// optimistic spend deduction
{
	const opt = acc({ balance: 249 });
	applyOptimisticSpend(opt, 0.5);
	assert.equal(opt.balance, 248.5);
	applyOptimisticSpend(opt, 0); // zero spend is a no-op
	assert.equal(opt.balance, 248.5);
	applyOptimisticSpend(opt, 300); // clamps at 0, never negative
	assert.equal(opt.balance, 0);
	const unknown = acc({ balance: null });
	applyOptimisticSpend(unknown, 1); // unknown balance stays unknown
	assert.equal(unknown.balance, null);
}

// ── width math ──
assert.equal(termVisWidth("abc"), 3);
assert.equal(termVisWidth(""), 0);
assert.equal(termVisWidth(fakeTheme.fg("dim", "abc")), 3, "ANSI is zero-width");
assert.equal(termVisWidth("◆"), 1, "◆ counts as narrow in this terminal");
assert.equal(termVisWidth("⚡"), 2);
assert.equal(truncateAnsi("hello world", 8), "hello w…");
assert.equal(termVisWidth(truncateAnsi(fakeTheme.fg("x", "hello world"), 8)), 8);
assert.equal(truncateAnsi("abc", 5), "abc");
assert.equal(truncateAnsi("abc", 0), "");

// ── widget render ──
const left = buildSessionLine({ requests: 7, spendHc: 1.24 })!;
assert.ok(left.startsWith("\u26A1 "), "unicode glyph set is the default");
const widget = new StatusLineWidget(fakeTheme, left, tiers, false);

// Wide: full tier, left-right justified at width − 1 (the widget never
// paints the terminal's last column — legacy terminals treat that cell as a
// pending wrap).
const wide = widget.render(80);
assert.equal(wide.length, 1);
assert.equal(termVisWidth(wide[0]), 79);
assert.ok(stripAnsi(wide[0]).startsWith("⚡ 1.24 hc"));
assert.ok(stripAnsi(wide[0]).endsWith("⟳ 29d"));

// Medium: drops to a compressed tier, still exactly width − 1
const med = widget.render(52);
assert.equal(termVisWidth(med[0]), 51);
assert.ok(!stripAnsi(med[0]).includes("⟳"), "compressed tiers drop auth first");

// Narrow: no tier fits → left only, padded
const narrow = widget.render(termVisWidth(left) + 3);
assert.equal(termVisWidth(narrow[0]), termVisWidth(left) + 2);
assert.ok(stripAnsi(narrow[0]).startsWith("⚡"));
assert.ok(!stripAnsi(narrow[0]).includes("◆"));

// Narrower than left itself: truncation never overflows (crash guard)
const tiny = widget.render(10);
assert.equal(termVisWidth(tiny[0]), 9);

// Left empty (session gated) → right-aligned account line
const rightOnly = new StatusLineWidget(fakeTheme, "", tiers, false);
const ro = rightOnly.render(70);
assert.equal(termVisWidth(ro[0]), 69);
assert.ok(stripAnsi(ro[0]).endsWith("⟳ 29d"));

// No data at all
assert.deepEqual(new StatusLineWidget(fakeTheme, "", [], false).render(40), [fakeTheme.fg("dim", "") + " ".repeat(39)]);

// Warning color wired through
const warn = new StatusLineWidget(fakeTheme, "", buildAccountTiers(acc({ balance: 10 }), true), true);
const warnLine = warn.render(60)[0];
assert.ok(stripAnsi(warnLine).includes("⚠ ◆ 10 hc"));
assert.ok(warnLine.includes("warning") || true); // fakeTheme ignores color names
const markTheme = { fg: (c: string, t: string) => `<${c}>${t}</>` };
assert.ok(new StatusLineWidget(markTheme, "", buildAccountTiers(acc({ balance: 10 }), true), true).render(60)[0].includes("<warning>"));
assert.ok(new StatusLineWidget(markTheme, "", buildAccountTiers(acc({ balance: 10 }), true), false).render(60)[0].includes("<dim>"));

// ── config coercion ──
assert.deepEqual(coerceStatusConfig(undefined), {
	session: "sidebar",
	account: "sidebar",
	hideOnOtherProvider: true,
	lowBalanceHc: 25,
	glyphs: "auto",
});
assert.deepEqual(coerceStatusConfig({ session: "bogus", lowBalanceHc: -3 }), {
	session: "sidebar",
	account: "sidebar",
	hideOnOtherProvider: true,
	lowBalanceHc: 25,
	glyphs: "auto",
});
assert.deepEqual(coerceStatusConfig({ session: "statusbar", account: "off", hideOnOtherProvider: false, lowBalanceHc: null }), {
	session: "statusbar",
	account: "off",
	hideOnOtherProvider: false,
	lowBalanceHc: null,
	glyphs: "auto",
});
assert.deepEqual(coerceStatusConfig({ session: "widget", account: "widget" }), {
	session: "widget",
	account: "widget",
	hideOnOtherProvider: true,
	lowBalanceHc: 25,
	glyphs: "auto",
});
assert.equal(coerceStatusConfig({ lowBalanceHc: 42 }).lowBalanceHc, 42);
assert.equal(coerceStatusConfig({ lowBalanceHc: false }).lowBalanceHc, null);
assert.deepEqual(coerceStatusConfig(null).session, "sidebar");
assert.deepEqual(coerceStatusConfig({ session: "sidebar", account: "sidebar" }).session, "sidebar");

// ── sidebar panel publication decision ──
{
	const base = {
		compatible: true,
		isProviderActive: true,
		sessionMode: "sidebar" as const,
		accountMode: "sidebar" as const,
		sessionStats: EMPTY_SESSION_STATS,
		account: acc({}),
		lowBalance: false,
	};
	// idle session, no data: placeholder keeps the panel visible
	const idle = buildSidebarPanel(base);
	assert.equal(idle.publish, true);
	assert.deepEqual(idle.rows, [{ text: SIDEBAR_PLACEHOLDER_ROW, role: "muted" }]);

	// account rows land after the prefetch without any turn (no divider: no session row)
	const prefetched = buildSidebarPanel({ ...base, account: full });
	assert.deepEqual(prefetched.rows, [
		{ text: "◆ 249 hc", role: "ready" },
		{ text: "hour [■■■■■■■■] 996/1k", role: "muted" },
		{ text: "day [■■■■■■■■] 10k/10k", role: "muted" },
		{ text: "expires 29d", role: "dim" },
	]);

	// session row appears once activity exists, with the divider between blocks
	const active = buildSidebarPanel({ ...base, sessionStats: { requests: 7, spendHc: 1.24 }, account: full });
	assert.deepEqual(active.rows, [
		{ text: "⚡ 1.24 hc · 7 req", role: "muted" },
		SIDEBAR_DIVIDER_ROW,
		{ text: "◆ 249 hc", role: "ready" },
		{ text: "hour [■■■■■■■■] 996/1k", role: "muted" },
		{ text: "day [■■■■■■■■] 10k/10k", role: "muted" },
		{ text: "expires 29d", role: "dim" },
	]);

	// withdraw while another provider is active or the host is incompatible
	assert.deepEqual(buildSidebarPanel({ ...base, isProviderActive: false }), { publish: false, rows: [] });
	assert.deepEqual(buildSidebarPanel({ ...base, compatible: false }), { publish: false, rows: [] });

	// no panel when neither part targets the sidebar
	assert.equal(buildSidebarPanel({ ...base, sessionMode: "widget", accountMode: "widget" }).publish, false);
	assert.equal(buildSidebarPanel({ ...base, sessionMode: "statusbar", accountMode: "off" }).publish, false);

	// session part off-sidebar: account-only panel, no duplicated session row
	const accountOnly = buildSidebarPanel({ ...base, sessionMode: "widget", account: full });
	assert.deepEqual(accountOnly.rows, [
		{ text: "◆ 249 hc", role: "ready" },
		{ text: "hour [■■■■■■■■] 996/1k", role: "muted" },
		{ text: "day [■■■■■■■■] 10k/10k", role: "muted" },
		{ text: "expires 29d", role: "dim" },
	]);

	// low balance flips the account row role
	const lowBal = buildSidebarPanel({ ...base, account: { ...EMPTY_ACCOUNT, balance: 10 }, lowBalance: true });
	assert.deepEqual(lowBal.rows, [{ text: "◆ 10 hc", role: "warning" }]);
}

// ── legacy-terminal glyph policy ──
const mintty = { TERM_PROGRAM: "mintty", TERM: "xterm" } as NodeJS.ProcessEnv;
const cygwin = { TERM: "cygwin" } as NodeJS.ProcessEnv;
const wt = { TERM_PROGRAM: "Windows_Terminal", TERM: "xterm-256color" } as NodeJS.ProcessEnv;
assert.equal(detectLegacyTerminal(mintty), true);
assert.equal(detectLegacyTerminal(cygwin), true);
assert.equal(detectLegacyTerminal(wt), false);
assert.equal(detectLegacyTerminal({} as NodeJS.ProcessEnv), false);

assert.equal(resolveGlyphSet("auto", wt), UNICODE_GLYPHS);
assert.equal(resolveGlyphSet("auto", mintty), ASCII_GLYPHS);
assert.equal(resolveGlyphSet("unicode", mintty), UNICODE_GLYPHS);
assert.equal(resolveGlyphSet("ascii", wt), ASCII_GLYPHS);
// An explicit unicode choice is clamped for widget content on legacy terminals
assert.equal(resolveWidgetGlyphSet("unicode", mintty), ASCII_GLYPHS);
assert.equal(resolveWidgetGlyphSet("unicode", wt), UNICODE_GLYPHS);
assert.equal(resolveWidgetGlyphSet("auto", mintty), ASCII_GLYPHS);
assert.equal(resolveWidgetGlyphSet("ascii", wt), ASCII_GLYPHS);

// ASCII mode emits no non-ASCII codepoints at all
const asciiLine = buildSessionLine({ requests: 7, spendHc: 1.24 }, ASCII_GLYPHS)!;
assert.equal(asciiLine, "* 1.24 hc - 7 req");
const asciiTiers = buildAccountTiers(acc({ balance: 10, authDaysLeft: 29 }), true, ASCII_GLYPHS);
assert.ok(asciiTiers[0].startsWith("! + 10 hc"), `got ${asciiTiers[0]}`);
assert.ok(asciiTiers[0].endsWith("~ 29d"), `got ${asciiTiers[0]}`);
const asciiWidget = new StatusLineWidget(fakeTheme, asciiLine, asciiTiers, true, ASCII_GLYPHS).render(60)[0];
assert.equal([...stripAnsi(asciiWidget)].every((c) => c.charCodeAt(0) < 128), true);

// Sidebar glyph rows honor the caller's glyph set; structural rows (the
// divider rule, meter cells) are panel furniture outside the glyph set.
const asciiSidebar = buildSidebarRows({ requests: 7, spendHc: 1.24 }, acc({ balance: 249, authDaysLeft: 29 }), false, ASCII_GLYPHS);
assert.ok(asciiSidebar.includes(SIDEBAR_DIVIDER_ROW), "the structural divider is glyph-independent");
assert.ok(asciiSidebar.some((r) => r.text.startsWith("* ")), `session row uses ASCII bolt, got ${JSON.stringify(asciiSidebar[0])}`);
assert.ok(asciiSidebar.some((r) => r.text === "+ 249 hc"), `balance row uses ASCII gem, got ${JSON.stringify(asciiSidebar)}`);
for (const row of asciiSidebar) {
	if (row === SIDEBAR_DIVIDER_ROW) continue;
	assert.equal([...row.text].every((c) => c.charCodeAt(0) < 128), true, `non-ASCII glyph row: ${row.text}`);
}
// meter cells stay structural under ASCII (outside the glyph set)
const asciiMeters = buildAccountSidebarRows(acc({ balance: 249, rate }), false, ASCII_GLYPHS);
assert.ok(asciiMeters.some((r) => r.text.includes("■")), "meter cells are structural, outside the glyph set");
assert.ok(asciiMeters.some((r) => r.text.startsWith("+ 249 hc")), `balance row uses ASCII gem, got ${JSON.stringify(asciiMeters[0])}`);
const asciiPanel = buildSidebarPanel(
	{
		compatible: true,
		isProviderActive: true,
		sessionMode: "sidebar" as const,
		accountMode: "sidebar" as const,
		sessionStats: { requests: 7, spendHc: 1.24 },
		account: acc({ balance: 249 }),
		lowBalance: false,
	},
	ASCII_GLYPHS,
);
assert.equal(asciiPanel.publish, true);
for (const row of asciiPanel.rows) {
	if (row === SIDEBAR_DIVIDER_ROW) continue;
	assert.equal([...row.text].every((c) => c.charCodeAt(0) < 128), true, `non-ASCII glyph row: ${row.text}`);
}

// Unicode mode keeps the glyphs (regression guard for the default path)
assert.ok(buildAccountTiers(acc({ balance: 10 }), true)[0].includes("\u26A0 \u25C6"));

// Truncation takes the caller's ellipsis so ASCII mode stays ASCII
assert.equal(truncateAnsi("abcdefghij", 5, "..."), "abcd...");
assert.ok(truncateAnsi("abcdefghij", 5).endsWith("\u2026"));

assert.equal(coerceStatusConfig({ glyphs: "bogus" }).glyphs, "auto");
assert.equal(coerceStatusConfig({ glyphs: "ascii" }).glyphs, "ascii");
console.log("status.smoke: all assertions passed");
