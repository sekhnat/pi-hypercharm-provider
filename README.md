<div align="center">

# ✨ pi-hypercharm-provider

**17+ models through [Charm Hyper](https://hyper.charm.land/)**

_Hyperoptimized coding models — DeepSeek, GLM, Kimi, Qwen, MiniMax, Gemma, GPT-OSS, and Llama for [pi](https://github.com/earendil-works/pi-coding-agent)._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Features

- **34+ AI Models** including DeepSeek V4 Flash/Pro, GLM 5/5.1, Kimi K2.5/K2.6, Qwen3.6/3.7, MiniMax M2.7, Gemma 4, GPT-OSS, and Llama
- **DeepSeek Native Thinking** — Uses the `deepseek` thinking format for Charm Hyper requests, with native `reasoning_effort` on models that publish levels
- **OpenAI-compatible API** via Charm Hyper's `/v1/chat/completions` endpoint
- **OAuth Device Flow** — sign in with `/login` under the `hypercharm` provider (independent of the official provider's `hyper` registration)
- **Official Catalog Sync** from Charm's typed `/v1/provider` endpoint, matching `@charmland/pi-hyper-provider`
- **Reasoning Models** with provider-published on/off states and exact effort levels
- **Attachment Support** for models the official catalog marks as attachment-capable

## Available Models

| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
| DeepSeek V4 Flash | Text | 1.0M | 384K | $0.20 | $0.40 |
| DeepSeek V4 Flash 0731 | Text | 1.0M | 384K | $0.44 | $1.32 |
| DeepSeek V4 Pro | Text | 1.0M | 384K | $2.40 | $4.80 |
| DeepSeek V4 Pro 0813 | Text | 1.0M | 262K | $1.44 | $4.31 |
| DeepSeek V4.1 Flash | Text + Image | 1.0M | 26K | $0.30 | $1.20 |
| Gemma 4 26B A4B | Text | 256K | 26K | $0.10 | $0.36 |
| GLM 5.3 | Text + Image | 1.0M | 262K | $1.52 | $4.79 |
| GLM 5.3 Flash | Text + Image | 1.0M | 131K | $0.16 | $0.54 |
| GLM-5 | Text | 203K | 20K | $0.86 | $2.75 |
| GLM-5.1 | Text | 203K | 3K | $1.32 | $4.31 |
| GLM-5.2 | Text | 1.0M | 33K | $1.52 | $4.79 |
| gpt-oss-120b | Text | 128K | 13K | $0.17 | $0.66 |
| Inkling | Text + Image | 1.0M | 33K | $1.09 | $4.41 |
| Kimi K2 Thinking | Text | 262K | 26K | $0.60 | $2.50 |
| Kimi K2.5 | Text | 262K | 26K | $0.56 | $2.94 |
| Kimi K2.6 | Text + Image | 262K | 26K | $1.03 | $4.36 |
| Kimi K2.7 Code | Text + Image | 262K | 16K | $1.03 | $4.36 |
| Kimi K3 | Text + Image | 1.0M | 16K | $3.27 | $16.33 |
| Llama 3.3 70B Instruct | Text | 128K | 13K | $0.61 | $1.04 |
| Llama 4 Maverick 17B 128E Instruct FP8 | Text | 430K | 43K | $0.26 | $0.84 |
| MiniMax M2.7 | Text | 262K | 7K | $0.40 | $1.46 |
| MiniMax M3 | Text + Image | 512K | 512K | $0.33 | $1.31 |
| Qwen3 Coder 480B A35B Instruct INT4 Mixed AR | Text | 106K | 11K | $0.45 | $2.15 |
| Qwen3 Next 80B A3B Instruct | Text | 262K | 26K | $0.12 | $1.14 |
| Qwen3.6-Flash | Text + Image | 1.0M | 64K | $1.00 | $4.00 |
| Qwen3.6-Max | Text | 256K | 64K | $2.00 | $12.00 |
| Qwen3.6-Plus | Text + Image | 1.0M | 64K | $2.00 | $6.00 |
| Qwen3.7-Flash | Text + Image | 1.0M | 64K | $0.20 | $0.80 |
| Qwen3.7-Max | Text | 1.0M | 64K | $2.50 | $7.50 |
| Qwen3.7-Plus | Text + Image | 1.0M | 64K | $1.20 | $4.80 |
| Qwen3.8-2.4T-A95B | Text | 1.0M | 128K | $2.00 | $6.00 |
| Qwen3.8-27B | Text + Image | 1.0M | 128K | $0.50 | $3.00 |
| Qwen3.8-Flash | Text + Image | 1.0M | 128K | $0.15 | $0.47 |
| Qwen3.8-Max | Text + Image | 1.0M | 66K | $2.00 | $6.00 |
*Costs are per million tokens. Prices subject to change — check [hyper.charm.land](https://hyper.charm.land) for current pricing.*

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install https://github.com/monotykamary/pi-hypercharm-provider
```

Then set your API key and run pi:
```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export HYPERCHARM_API_KEY=your-api-key-here

pi
```

Get your API key from [hyper.charm.land](https://hyper.charm.land).

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/monotykamary/pi-hypercharm-provider.git
   cd pi-hypercharm-provider
   ```

2. Set your HyperCharm API key:
   ```bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export HYPERCHARM_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-hypercharm-provider
   ```

## Usage

After loading the extension, select a model with:

```
/model hypercharm deepseek-v4-pro
```

Or start pi directly with a HyperCharm model:

```bash
pi --provider hypercharm --model deepseek-v4-pro
```

### Reasoning Effort

For reasoning models that support `reasoning_effort`, control thinking depth:

```bash
pi --provider hypercharm --model deepseek-v4-pro --reasoning-effort max
```

Supported levels are model-specific and come from Charm's `/v1/provider` catalog (for example `low`/`medium`/`high` on Kimi K2.6). Models with no published levels support the Hyper thinking on state through Pi's `max` level.

### Thinking Mode

DeepSeek V4 models use the `deepseek` thinking format — the same native format as the [pi-deepseek-provider](https://github.com/monotykamary/pi-deepseek-provider). This sends `thinking: {type: "enabled/disabled"}` plus `reasoning_effort` mapped via `thinkingLevelMap` (`high` → `"high"`, `max` → `"max"`). Replayed assistant messages include empty `reasoning_content` as required by DeepSeek's API.

## Footer Status

A Neuralwatt-style status line sits below the editor. It appears after the
session's first HyperCharm turn completes (never before — no half-empty line
on fresh sessions or other providers), refreshes its balance when the agent
run fully settles, and makes no status-related API calls in sessions that
never use HyperCharm:

```
⚡ 1.24 hc · 7 req                       Xu's Team ◆ 249 hc · 996/1k/h · 29d
└─ session spend+requests ─┘           └─ team · balance · rate limits ──┘
```

The left side tracks what the current session has sent/spent, read from
Hyper's `usage.cost.hypercredits` extension on each response (no polling).
The right side shows the team name (`/v1/teams` — works for API-key auth),
the Hypercredit balance (`/v1/credits`), the per-hour and per-day request
rate limits captured from response headers, and days until the OAuth device
session expires when signed in with OAuth. The right side compresses
progressively as the terminal narrows, and turns to a warning color at/below
the `lowBalanceHc` threshold.

### Configuration

Edit `~/.pi/agent/extensions/hypercharm.json` or run `/hypercharm-status`:

| Setting | Values | Default |
|---------|--------|---------|
| `session` | `sidebar` \| `widget` \| `statusbar` \| `off` | `sidebar` |
| `account` | `sidebar` \| `widget` \| `statusbar` \| `off` | `sidebar` |
| `hideOnOtherProvider` | `true` \| `false` | `true` |
| `lowBalanceHc` | number \| `null` | `25` |

The `sidebar` mode publishes a structured panel (`HyperCharm`) to the
[Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier) sidebar — visible by
default right after Atelier's built-in Usage panel. Sidebar contributions are
always limited to the active HyperCharm provider (the `hideOnOtherProvider`
option governs only the widget/statusbar destinations). Without a compatible
Atelier host, `sidebar` parts fall back to the below-editor widget. The same
metric never appears in two destinations; the team name never appears in the
sidebar.

Non-interactive toggles:

```
/hypercharm-status session sidebar|widget|statusbar|off
/hypercharm-status account sidebar|widget|statusbar|off
/hypercharm-status hide true|false
/hypercharm-status lowBalance 50|off
/hypercharm-status refresh
/hypercharm-status reset
```


## Authentication

The HyperCharm API key can be configured in multiple ways (resolved in this order):

1. **OAuth** — Run `pi`, send `/login`, and pick **HyperCharm**. This uses Hyper's device flow (open the verification URL, enter the code) and stores a refreshable OAuth credential under the `hypercharm` provider — fully independent of the official `@charmland/pi-hyper-provider` (`hyper`) registration, so both extensions can be installed side by side.
2. **`auth.json`** (recommended for API keys) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "hypercharm": { "type": "api_key", "key": "your-api-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
3. **Runtime override** — Use the `--api-key` CLI flag
4. **Environment variable** — Set `HYPERCHARM_API_KEY`

Get your API key from [hyper.charm.land](https://hyper.charm.land).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HYPERCHARM_API_KEY` | No | Your Charm Hyper API key (fallback if not in auth.json) |

## Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-hypercharm-provider"
  ]
}
```

### Catalog and Compat Settings

Model metadata matches Charm's official [`@charmland/pi-hyper-provider`](https://github.com/charmbracelet/pi-hyper-provider) transform:

- canonical `/v1/provider` names, prices, context windows, output caps, attachment flags, and `can_reason`
- `thinkingFormat: "deepseek"`, which maps Pi thinking levels onto Hyper's `thinking` envelope
- `reasoning_effort` only when the catalog publishes concrete level names
- `maxTokensField: "max_tokens"` and `supportsStore: false`
- `cacheRead` from `cost_per_1m_out_cached` (discounted cached-output price) and `cacheWrite` from `cost_per_1m_in_cached`, exactly as the official provider maps them
- `/v1/credits` balance accepted in either hypercredits (`balance`) or USD (`balance_usd`, converted at the observed 20 hc = $1 rate)

`patch.json` is reserved for verified provider regressions. It currently re-exposes Pi's `max` thinking level on the DeepSeek V4 models whose catalog `reasoning_levels` dropped it (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4.1-flash`), matching the levels their pinned snapshots still publish.

### Patch Overrides

`patch.json` is applied on top of `models.json` only for verified endpoint corrections; every other live field comes from Charm's canonical provider catalog.

| Model | Override | Why |
|-------|----------|-----|
| `deepseek-v4-flash`, `deepseek-v4-pro` | `thinkingLevelMap.max = "max"` | The catalog now publishes only `high,xhigh`, while the pinned `-0731`/`-0813` snapshots publish `max`. |
| `deepseek-v4.1-flash` | `thinkingLevelMap.max = "max"` | The catalog publishes `low,high,xhigh`; `max` mirrors the sibling DeepSeek V4 entries. |

Each entry carries the model's full level map, because `patch.json` replaces `thinkingLevelMap` wholesale rather than merging it.

## Updating Models

Run the update script to fetch the latest models from the HyperCharm API:

```bash
export HYPERCHARM_API_KEY=your-api-key
node scripts/update-models.js
```

This will:
1. Fetch models from `https://hyper.charm.land/v1/models`
2. Regenerate `models.json` as pure metadata from Charm's typed `/v1/provider` catalog
3. Apply overrides from `patch.json` only when building the README
4. Remove custom models now available upstream from `custom-models.json`
5. Reconcile delisted models through the 14-day `deprecated-models.json` grace layer
6. Update `models.json` and the README model table

A GitHub Actions workflow runs this daily and creates a PR if models have changed.

## License

MIT
