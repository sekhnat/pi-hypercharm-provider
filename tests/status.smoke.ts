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
	accountHasData,
	applyOptimisticSpend,
	buildAccountTiers,
	buildSidebarRows,
	buildSessionLine,
	coerceStatusConfig,
	formatBalHc,
	formatRateCompact,
	formatSpendHc,
	termVisWidth,
	truncateAnsi,
	type AccountState,
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
// ── sidebar panel rows (layout C) ──
{
	const sidebarRows = buildSidebarRows({ requests: 7, spendHc: 1.24 }, full, false);
	assert.deepEqual(sidebarRows, [
		{ text: "⚡ 1.24 hc · 7 req", role: "muted" },
		{ text: "◆ 249 hc", role: "ready" },
		{ text: "996/1k/h · 10k/10k/d · 29d", role: "muted" },
	]);
	// missing rate + auth atoms: limits row omitted entirely
	const noRate = sidebarRowsOf(acc({ balance: 249 }), false);
	assert.deepEqual(noRate, [
		{ text: "⚡ 1.24 hc · 7 req", role: "muted" },
		{ text: "◆ 249 hc", role: "ready" },
	]);
	// team name never appears
	for (const row of sidebarRows) assert.ok(!row.text.includes("ACME"));
	// low balance flips the balance row role
	const low = sidebarRowsOf({ ...EMPTY_ACCOUNT, balance: 10 }, true);
	assert.deepEqual(low[1], { text: "◆ 10 hc", role: "warning" });
	// no activity → no session row
	const idle = buildSidebarRows(EMPTY_SESSION_STATS, full, false);
	assert.deepEqual(idle, [
		{ text: "◆ 249 hc", role: "ready" },
		{ text: "996/1k/h · 10k/10k/d · 29d", role: "muted" },
	]);
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
const widget = new StatusLineWidget(fakeTheme, left, tiers, false);

// Wide: full tier, left-right justified, exactly width columns
const wide = widget.render(80);
assert.equal(wide.length, 1);
assert.equal(termVisWidth(wide[0]), 80);
assert.ok(stripAnsi(wide[0]).startsWith("⚡ 1.24 hc"));
assert.ok(stripAnsi(wide[0]).endsWith("⟳ 29d"));

// Medium: drops to a compressed tier, still exactly width
const med = widget.render(52);
assert.equal(termVisWidth(med[0]), 52);
assert.ok(!stripAnsi(med[0]).includes("⟳"), "compressed tiers drop auth first");

// Narrow: no tier fits → left only, padded
const narrow = widget.render(termVisWidth(left) + 3);
assert.equal(termVisWidth(narrow[0]), termVisWidth(left) + 3);
assert.ok(stripAnsi(narrow[0]).startsWith("⚡"));
assert.ok(!stripAnsi(narrow[0]).includes("◆"));

// Narrower than left itself: truncation never overflows (crash guard)
const tiny = widget.render(10);
assert.equal(termVisWidth(tiny[0]), 10);

// Left empty (session gated) → right-aligned account line
const rightOnly = new StatusLineWidget(fakeTheme, "", tiers, false);
const ro = rightOnly.render(70);
assert.equal(termVisWidth(ro[0]), 70);
assert.ok(stripAnsi(ro[0]).endsWith("⟳ 29d"));

// No data at all
assert.deepEqual(new StatusLineWidget(fakeTheme, "", [], false).render(40), [fakeTheme.fg("dim", "") + " ".repeat(40)]);

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
});
assert.deepEqual(coerceStatusConfig({ session: "bogus", lowBalanceHc: -3 }), {
	session: "sidebar",
	account: "sidebar",
	hideOnOtherProvider: true,
	lowBalanceHc: 25,
});
assert.deepEqual(coerceStatusConfig({ session: "statusbar", account: "off", hideOnOtherProvider: false, lowBalanceHc: null }), {
	session: "statusbar",
	account: "off",
	hideOnOtherProvider: false,
	lowBalanceHc: null,
});
assert.deepEqual(coerceStatusConfig({ session: "widget", account: "widget" }), {
	session: "widget",
	account: "widget",
	hideOnOtherProvider: true,
	lowBalanceHc: 25,
});
assert.equal(coerceStatusConfig({ lowBalanceHc: 42 }).lowBalanceHc, 42);
assert.equal(coerceStatusConfig({ lowBalanceHc: false }).lowBalanceHc, null);
assert.deepEqual(coerceStatusConfig(null).session, "sidebar");
assert.deepEqual(coerceStatusConfig({ session: "sidebar", account: "sidebar" }).session, "sidebar");

console.log("status.smoke: all assertions passed");
