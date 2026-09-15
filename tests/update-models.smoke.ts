/**
 * Dependency-free smoke test for scripts/update-models.js helpers.
 * Run: node tests/update-models.smoke.ts (Node ≥ 23 strips types natively).
 * The script only runs its CLI flow when executed directly (import.meta.url
 * guard), so importing it here stays side-effect free.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate pi's agent dir BEFORE importing the script (module init resolves it).
const agentDir = mkdtempSync(join(tmpdir(), "hypercharm-script-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { resolveConfigValue, resolveApiKey, updateDeprecatedModels } = await import("../scripts/update-models.js");

const savedEnv: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string | undefined): void => {
	if (!(name in savedEnv)) savedEnv[name] = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};

// ── resolveConfigValue (pi's !command / $VAR semantics) ──
assert.equal(resolveConfigValue("plain", undefined), "plain");
assert.equal(resolveConfigValue("", undefined), undefined);
setEnv("HC_RCV", "fromenv");
assert.equal(resolveConfigValue("$HC_RCV", undefined), "fromenv");
assert.equal(resolveConfigValue("${HC_RCV}", undefined), "fromenv", "braced form interpolates");
assert.equal(resolveConfigValue("$HC_RCV", { HC_RCV: "fromcred" }), "fromcred", "credential env wins over process.env");
setEnv("HC_RCV", undefined);
assert.equal(resolveConfigValue("$HC_RCV", undefined), undefined, "unset variable → undefined");
assert.equal(resolveConfigValue("$$dollar", undefined), "$dollar", "$$ escapes a literal $");
assert.equal(resolveConfigValue("$!bang", undefined), "!bang", "$! escapes a literal !");
assert.equal(resolveConfigValue("${bad-name}", undefined), "${bad-name}", "invalid env names stay literal");
assert.equal(resolveConfigValue("!echo cmdkey", undefined), "cmdkey", "!command runs via the shell");
assert.equal(resolveConfigValue("!exit 1", undefined), undefined, "failing command → undefined");

// ── resolveApiKey (auth.json precedence + env fallback) ──
setEnv("HYPERCHARM_API_KEY", undefined);
assert.equal(resolveApiKey(), undefined, "no auth.json + no env → undefined");
setEnv("HYPERCHARM_API_KEY", "envkey");
assert.equal(resolveApiKey(), "envkey", "env fallback");
setEnv("HYPERCHARM_API_KEY", undefined);
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ hypercharm: { type: "api_key", key: "literal-key" } }));
assert.equal(resolveApiKey(), "literal-key", "literal auth.json key wins");
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ hypercharm: { type: "api_key", key: "$HC_KEY_ENV" } }));
setEnv("HC_KEY_ENV", "resolved-key");
assert.equal(resolveApiKey(), "resolved-key", "env-var key resolves");
setEnv("HC_KEY_ENV", undefined);
writeFileSync(
	join(agentDir, "auth.json"),
	JSON.stringify({ hypercharm: { type: "api_key", key: "$HC_INLINE", env: { HC_INLINE: "inline-key" } } }),
);
assert.equal(resolveApiKey(), "inline-key", "credential-inline env wins");
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ hypercharm: { type: "oauth", refresh: "x" } }));
assert.equal(resolveApiKey(), undefined, "oauth credentials are not an API key");

// ── updateDeprecatedModels (file I/O wrapper around the pure reconcile) ──
{
	const DAY = 86_400_000;
	const now = Date.now();
	const dep = (id: string, ageDays: number) => ({
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
		deprecatedAt: new Date(now - ageDays * DAY).toISOString(),
	});
	const model = (id: string) => ({ ...dep(id, 0), deprecatedAt: undefined });

	const dir = mkdtempSync(join(tmpdir(), "hypercharm-deprecated-"));
	const modelsPath = join(dir, "models.json");
	const depPath = join(dir, "deprecated-models.json");
	writeFileSync(modelsPath, JSON.stringify([model("old-a"), model("gone")]));
	writeFileSync(depPath, JSON.stringify({ ancient: dep("ancient", 20), recent: dep("recent", 1) }));

	const first = updateDeprecatedModels(modelsPath, [model("old-a"), model("new-a")]);
	assert.ok(first.gone && first.recent, "delisted model enters the graveyard; within-TTL preserved");
	assert.ok(!("ancient" in first), "expired entry evicted");
	assert.match(first.gone.deprecatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/, "delisted model stamped with deprecatedAt");
	const onDisk = JSON.parse(readFileSync(depPath, "utf8"));
	assert.deepEqual(Object.keys(onDisk).sort(), ["gone", "recent"], "graveyard file persisted");

	const again = updateDeprecatedModels(modelsPath, [model("old-a"), model("new-a")]);
	assert.equal(again.gone?.deprecatedAt, first.gone?.deprecatedAt, "grace clock not reset on repeat runs");
	rmSync(dir, { recursive: true, force: true });
}

// ── cleanup ──
for (const [name, value] of Object.entries(savedEnv)) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
rmSync(agentDir, { recursive: true, force: true });

console.log("update-models.smoke: all assertions passed");
