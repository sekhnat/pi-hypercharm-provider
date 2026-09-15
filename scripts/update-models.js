#!/usr/bin/env node

/**
 * Update HyperCharm models from Charm's official typed provider catalog
 *
 * Fetches models from https://hyper.charm.land/v1/provider and updates:
 * - models.json: canonical API-owned metadata used by @charmland/pi-hyper-provider
 * - README.md: model table with patch.json overrides applied
 *
 * The endpoint provides canonical names, $/M pricing, context/output limits,
 * can_reason, optional reasoning levels, and attachment support. models.json is
 * pure API data. patch.json is reserved for verified endpoint regressions; it
 * currently restores Pi's max thinking level on the DeepSeek V4 models whose
 * catalog reasoning_levels no longer publish it. Patch entries replace
 * thinkingLevelMap wholesale, so each one carries the model's full level map.
 *
 * Merge order for README: models.json → apply patch.json → merge custom-models.json
 *
 * The transform/merge/deprecation helpers are shared with the runtime via
 * ../model-catalog.ts — edit that module, not local copies.
 *
 * API key: the stored `hypercharm` credential in ~/.pi/agent/auth.json wins, then
 * the HYPERCHARM_API_KEY environment variable. The script refuses to run without one.
 */

import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildModels, reconcileDeprecated, transformApiModel } from '../model-catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// pi's agent directory: PI_CODING_AGENT_DIR (with ~ expansion) or ~/.pi/agent.
function piAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith('~/') || envDir === '~'
      ? path.join(os.homedir(), envDir.slice(1))
      : envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

const AUTH_JSON_PATH = path.join(piAgentDir(), 'auth.json');

/**
 * Resolve a configured value using pi's semantics (resolve-config-value.ts in
 * pi-mono): "!command" runs via the shell (10s timeout) and uses trimmed
 * stdout; "$VAR" / "${VAR}" interpolate environment variables ("$$" escapes a
 * literal "$", "$!" a literal "!"); anything else is a literal. Returns
 * undefined when a referenced env var is unset or a command fails.
 */
function resolveConfigValue(config, env) {
  if (typeof config !== 'string' || config.length === 0) return undefined;
  if (config.startsWith('!')) {
    try {
      const out = execSync(config.slice(1), {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let resolved = '';
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf('$', index);
    if (dollar < 0) {
      resolved += config.slice(index);
      break;
    }
    resolved += config.slice(index, dollar);
    const next = config[dollar + 1];
    let name;
    if (next === '$' || next === '!') {
      resolved += next;
      index = dollar + 2;
      continue;
    } else if (next === '{') {
      const end = config.indexOf('}', dollar + 2);
      if (end < 0) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      const inner = config.slice(dollar + 2, end);
      if (!ENV_NAME_RE.test(inner)) {
        resolved += config.slice(dollar, end + 1);
        index = end + 1;
        continue;
      }
      name = inner;
      index = end + 1;
    } else {
      const match = config.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      name = match[0];
      index = dollar + 1 + name.length;
    }
    const value = (env && env[name]) || process.env[name] || undefined;
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

/**
 * The API key, resolved the way pi itself resolves it for this provider: the
 * stored `hypercharm` credential in ~/.pi/agent/auth.json wins, then
 * the HYPERCHARM_API_KEY environment variable.
 */
function resolveApiKey() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_JSON_PATH, 'utf8'));
    const credential = auth?.hypercharm;
    if (credential && credential.type === 'api_key' && typeof credential.key === 'string') {
      const key = resolveConfigValue(credential.key, credential.env);
      if (key) return key;
    }
  } catch {
    // Missing or unparseable auth.json: fall through to the env var.
  }
  return process.env.HYPERCHARM_API_KEY || undefined;
}

const MODELS_API_URL = 'https://hyper.charm.land/v1/provider';
const MODELS_JSON_PATH = path.join(__dirname, '..', 'models.json');
const PATCH_JSON_PATH = path.join(__dirname, '..', 'patch.json');
const CUSTOM_MODELS_JSON_PATH = path.join(__dirname, '..', 'custom-models.json');
const README_PATH = path.join(__dirname, '..', 'README.md');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// ─── README generation ────────────────────────────────────────────────────────

function formatCost(cost) {
  if (cost === 0) return '—';
  if (cost === null || cost === undefined) return '—';
  return '$' + cost.toFixed(2);
}

function formatNumber(num) {
  if (num === null || num === undefined) return '-';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${Math.round(num / 1000)}K`;
  return num.toString();
}

function getInputTypes(inputTypes) {
  const types = inputTypes || ['text'];
  if (types.includes('image') && types.includes('text')) return 'Text + Image';
  if (types.includes('image')) return 'Image';
  return 'Text';
}

function generateReadmeRow(model) {
  const cost = model.cost || {};
  return `| ${model.name} | ${getInputTypes(model.input)} | ${formatNumber(model.contextWindow)} | ${formatNumber(model.maxTokens)} | ${formatCost(cost.input)} | ${formatCost(cost.output)} |`;
}

function updateReadme(models) {
  let readme = fs.readFileSync(README_PATH, 'utf8');

  const sortedModels = [...models].sort((a, b) => a.name.localeCompare(b.name));
  const tableRows = sortedModels.map(generateReadmeRow).join('\n');
  const newTable = `| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
${tableRows}`;

  const tableRegex = /\| Model \| Type \| Context \| Max Tokens \| Input Cost \| Output Cost \|[\s\S]*?(?=\n\*Costs are per million)/;
  readme = readme.replace(tableRegex, newTable);

  readme = readme.replace(/\*\*\d+\+ AI Models\*\*/, `**${models.length}+ AI Models**`);

  fs.writeFileSync(README_PATH, readme);
  console.log(`✓ Updated README.md with ${models.length} models`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Reconcile deprecated-models.json against the freshly fetched model list.
 * - in old models.json but not the API: moved into the deprecated file
 *   (deprecatedAt = now; preserved on repeat runs so the grace clock is not reset)
 * - back in the API: resurrected (dropped from the deprecated file)
 * - deprecatedAt older than 14 days: evicted permanently
 * Must run BEFORE the new models.json is written; it reads the old file itself.
 */
/**
 * Reconcile deprecated-models.json against the freshly fetched model list.
 * - in old models.json but not the API: moved into the deprecated file
 *   (deprecatedAt = now; preserved on repeat runs so the grace clock is not reset)
 * - back in the API: resurrected (dropped from the deprecated file)
 * - deprecatedAt older than 14 days: evicted permanently
 * Must run BEFORE the new models.json is written; it reads the old file itself.
 * Returns the reconciled graveyard for the README merge.
 */
function updateDeprecatedModels(modelsJsonPath, newModels) {
  const deprecatedPath = path.join(path.dirname(modelsJsonPath), 'deprecated-models.json');

  let oldModels = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
    if (Array.isArray(parsed)) oldModels = parsed;
  } catch { /* first run: no previous models.json */ }

  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }

  const { deprecated: reconciled, added, resurrected, evicted } = reconcileDeprecated(oldModels, newModels, deprecated, Date.now());

  if (added.length > 0 || resurrected.length > 0 || evicted.length > 0) {
    fs.writeFileSync(deprecatedPath, JSON.stringify(reconciled, null, 2) + '\n');
    console.log('Updated deprecated-models.json ' + JSON.stringify({ added, resurrected, evicted }));
  }
  return reconciled;
}
async function main() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error('Error: No API key found: no `hypercharm` credential resolved from ' + AUTH_JSON_PATH + ' and HYPERCHARM_API_KEY is not set');
    console.error('Usage: HYPERCHARM_API_KEY=your-key node scripts/update-models.js');
    process.exit(1);
  }

  console.log(`Fetching models from ${MODELS_API_URL}...`);

  try {
    const response = await fetch(MODELS_API_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const apiResponse = await response.json();
    const apiModels = Array.isArray(apiResponse)
      ? apiResponse
      : (apiResponse.models || apiResponse.data || []);

    if (!Array.isArray(apiModels)) {
      throw new Error('API response does not contain an array of models');
    }

    console.log(`✓ Fetched ${apiModels.length} models from API`);

    // Load existing models.json — source of truth for curated specs
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));
    } catch {
      // File might not exist yet
    }
    const existingModelsMap = {};
    for (const m of existingModels) {
      existingModelsMap[m.id] = m;
    }

    // Transform models from API, preserving existing curated data
    let apiTransformed = apiModels.map(transformApiModel).filter((m) => m !== null);
    apiTransformed.sort((a, b) => a.name.localeCompare(b.name));

    // Load patch overrides for README rendering. Canonical metadata already
    // comes from /v1/provider, so new models do not require a patch entry.
    const patch = loadJson(PATCH_JSON_PATH);

    // Update models.json — curated API data
    // Move delisted models to deprecated-models.json BEFORE models.json is overwritten
    const graveyard = updateDeprecatedModels(MODELS_JSON_PATH, apiTransformed);
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(apiTransformed, null, 2) + '\n');
    console.log(`✓ Updated models.json (${apiTransformed.length} models)`);

    // Load custom-models.json
    const customModels = Array.isArray(loadJson(CUSTOM_MODELS_JSON_PATH))
      ? loadJson(CUSTOM_MODELS_JSON_PATH)
      : [];

    // Check for custom models now available upstream (remove duplicates)
    const upstreamIds = new Set(apiTransformed.map(m => m.id));
    const duplicates = customModels.filter(m => upstreamIds.has(m.id));
    if (duplicates.length > 0) {
      console.log(`\nFound ${duplicates.length} custom model(s) now available upstream:`);
      for (const dup of duplicates) {
        console.log(`  - ${dup.id} (${dup.name})`);
      }
      const cleaned = customModels.filter(m => !upstreamIds.has(m.id));
      saveJson(CUSTOM_MODELS_JSON_PATH, cleaned);
      console.log(`✓ Removed ${duplicates.length} duplicate(s) from custom-models.json`);
      customModels.length = 0;
      customModels.push(...cleaned);
    }

    // Build merged models with patches for README
    const readmeModels = buildModels(apiTransformed, customModels, patch, graveyard);
    readmeModels.sort((a, b) => a.name.localeCompare(b.name));

    // Update README
    updateReadme(readmeModels);

    // Summary
    console.log('\n--- Summary ---');
    console.log(`Total models: ${readmeModels.length}`);
    console.log(`Reasoning models: ${readmeModels.filter(m => m.reasoning).length}`);
    console.log(`Vision models: ${readmeModels.filter(m => m.input.includes('image')).length}`);

    const newIds = new Set(apiTransformed.map(m => m.id));
    const oldIds = new Set(existingModels.map(m => m.id));

    const added = [...newIds].filter(id => !oldIds.has(id));
    const removed = [...oldIds].filter(id => !newIds.has(id));

    if (added.length > 0) console.log(`\nNew models: ${added.join(', ')}`);
    if (removed.length > 0) console.log(`\nRemoved models: ${removed.join(', ')}`);

    // Show pricing changes
    for (const model of apiTransformed) {
      const oldModel = existingModels.find(m => m.id === model.id);
      if (oldModel) {
        const oldInput = oldModel.cost?.input || 0;
        const oldOutput = oldModel.cost?.output || 0;
        if (oldInput !== model.cost.input || oldOutput !== model.cost.output) {
          console.log(`\nPricing change for ${model.id}:`);
          if (oldInput !== model.cost.input) {
            console.log(`  Input: $${oldInput}/M → $${model.cost.input}/M`);
          }
          if (oldOutput !== model.cost.output) {
            console.log(`  Output: $${oldOutput}/M → $${model.cost.output}/M`);
          }
        }
      }
    }

    console.log('\nDone!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
