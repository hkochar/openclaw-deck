# Deck Gateway Plugin

Hooks into the OpenClaw gateway to collect LLM events, enforce budgets, and monitor agent activity.

## What it does

- **Event logging** — Records every LLM call, tool invocation, and message to SQLite
- **Cost tracking** — Estimates per-call costs using model pricing tables, reconciles with provider APIs
- **Budget enforcement** — Checks agent spend against configured limits before each LLM call (alert, throttle, or block)
- **Session guardrails** — Detects runaway sessions (long duration, excessive tool calls, context overflow, expensive steps)
- **Model drift detection** — Alerts when an agent's model changes unexpectedly
- **Provider health** — Tracks error rates and latency per provider
- **Discord alerts** — Sends budget warnings, session alerts, and drift notifications to Discord

## Install

```bash
cd plugin
npm install --omit=dev
openclaw plugins install --link ./plugin
openclaw gateway restart
```

Verify: `openclaw plugins list` should show `openclaw-deck-sync`.

## Configuration

The plugin reads configuration from `config/deck-config.json` in the Deck repo root. Key sections:

- **`budgets`** — Global and per-agent daily/weekly/monthly limits, alert thresholds
- **`sessionGuardrails`** — Max session duration, tool call limits, context threshold, step cost threshold
- **`modelPricing`** — Cost per million tokens for each model family
- **`providerKeys`** — Management/admin API keys for cost reconciliation (OpenRouter, Anthropic, OpenAI)
- **`providerLimits`** — Rate limit windows per provider

All settings are editable via the Deck Config page in the dashboard.

## Data

Events are stored in two SQLite databases:

| Database | Default Path | Contents |
|----------|-------------|----------|
| Usage DB | `~/.openclaw-deck/data/usage.db` | LLM events, sessions, costs, heartbeats, drift |
| System DB | `./data/deck-system.db` | Audit log (config changes, alerts, cron results) |

Override paths with `DECK_USAGE_DB` and `DECK_SYSTEM_LOG_DB` environment variables.
