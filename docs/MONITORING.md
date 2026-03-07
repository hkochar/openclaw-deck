# Deck — Monitoring Guide

Built-in monitoring, alerting, and health checking for your Deck installation.

## Overview

Deck provides layered monitoring out of the box:

```
┌──────────────────────────────────────────────────┐
│  Discord Alerts (budget, drift, silence, limits)  │
├──────────────────────────────────────────────────┤
│  Dashboard UI (costs, agents, drift, activities)  │
├──────────────────────────────────────────────────┤
│  Sentinel (external health checks — Python)       │
├──────────────────────────────────────────────────┤
│  Ops Bot (Discord commands — Python)              │
├──────────────────────────────────────────────────┤
│  Plugin (real-time event capture + detection)     │
└──────────────────────────────────────────────────┘
```

## Built-In Detection

These run automatically in the gateway plugin with no additional setup.

### Agent Heartbeats

Tracks when each agent last made an LLM call.

- **Storage:** `heartbeats` table (1 row per agent, upserted)
- **Throttle:** Max one heartbeat per 60 seconds per agent
- **Fields:** agent key, status, model, configured model, session key, bio
- **Endpoint:** `POST /api/heartbeat`

### Agent Silence Detection

Detects agents that stop producing LLM output.

- **Threshold:** 30 minutes of no activity (configurable)
- **Check interval:** Every 5 minutes
- **Alert:** Fires once per silent period, clears when activity resumes
- **Cooldown:** 10 minutes between re-alerts per agent

### Model Drift Detection

Alerts when an agent uses a different model than configured.

- **Trigger:** Every `llm_output` event compares actual vs configured model
- **Storage:** `drift_events` table
- **Deduplication:** 60-second window prevents duplicate reports
- **Endpoints:** `GET /api/drift` (query), `POST /api/drift/report` (report), `POST /api/drift/resolve` (mark resolved)

### Stuck Loop Detection

Detects agents repeatedly calling the same tool with the same parameters.

- **Window:** Last 20 tool calls per agent
- **Threshold:** 5 identical tool+params signatures = stuck
- **Cooldown:** 5 minutes between alerts
- **Auto-clears:** When activity drops below threshold within 2 minutes

### Provider Health Tracking

Monitors reliability of each LLM provider (Anthropic, OpenRouter, OpenAI, etc.).

- **Tracks:** Success/failure counts, error rate, last error message, average latency
- **Backfill:** Reconstructed from historical events on startup
- **Endpoint:** Included in `GET /api/gateway-health` response

## Budget Alerts

The budget system sends Discord alerts at configurable thresholds.

### Escalation Path

```
Spending → OK             → No action
        → > alert %      → Discord notification
        → > throttle %   → Downgrade model + alert
        → > block %      → Pause agent + alert + reject requests
```

### Configuration

In `config/deck-config.json`:

```json
{
  "budgets": {
    "global": {
      "daily": 100,
      "weekly": 500,
      "monthly": 2000
    },
    "agents": {
      "scout": { "daily": 20, "action": "throttle" },
      "forge": { "daily": 50, "action": "block" }
    },
    "alertThresholds": [50, 80, 100],
    "alertChannel": "systemStatus",
    "defaultAutoRecovery": "all",
    "costView": "actual"
  }
}
```

| Field | Purpose |
|-------|---------|
| `global` | Aggregate limits across all agents |
| `agents` | Per-agent limits and actions |
| `alertThresholds` | Percentage milestones that trigger Discord alerts |
| `alertChannel` | Key in `systemChannels` for alert destination |
| `defaultAutoRecovery` | Restore throttled agents after budget resets (`all`, `throttle-only`, `none`) |
| `costView` | What counts toward budgets: `actual` (metered), `api-equiv` (subscription), `total` |

### Session Guardrails

Per-session safety limits:

```json
{
  "sessionGuardrails": {
    "enabled": true,
    "action": "alert",
    "maxSessionDuration": 60,
    "maxToolCalls": 200,
    "contextThreshold": 85,
    "stepCostThreshold": 1
  }
}
```

| Guardrail | Triggers When |
|-----------|--------------|
| `maxSessionDuration` | Session exceeds N minutes |
| `maxToolCalls` | Session exceeds N tool invocations |
| `contextThreshold` | Context window usage exceeds N% |
| `stepCostThreshold` | A single LLM call costs more than $N |

### Provider Rate Limits

Track usage against provider quotas:

```json
{
  "providerLimits": {
    "anthropic": {
      "windows": [
        {
          "id": "5h-rolling",
          "duration": 18000,
          "rolling": true,
          "shared": true,
          "weights": { "opus": 1.0, "sonnet": 0.5, "haiku": 0.25 },
          "limit": 45
        }
      ]
    }
  }
}
```

Alerts at 80% (warning) and 100% (error) of each window's limit.

## Discord Alert Channels

Configure where alerts are sent in `config/deck-config.json`:

```json
{
  "systemChannels": {
    "systemStatus": "DISCORD_CHANNEL_ID"
  },
  "pluginChannels": {
    "model-drift": "DISCORD_CHANNEL_ID"
  }
}
```

| Channel | Receives |
|---------|---------|
| `systemStatus` | Budget alerts, silence alerts, service restarts, config changes |
| `agentMonitoring` | Agent activity, provider health |
| `model-drift` | Model drift events |

**Requires:** `DISCORD_BOT_TOKEN_DECK` environment variable set.

## Health Endpoints

### Gateway Health

`GET /api/gateway-health`

Returns comprehensive health data:

```json
{
  "ok": true,
  "status": 200,
  "uptime": 86400,
  "droppedEvents": 0,
  "activeLoops": 0,
  "loops": [],
  "memoryMB": 128,
  "providers": [
    {
      "provider": "anthropic",
      "successes": 1200,
      "failures": 3,
      "errorRate": 0.0025,
      "avgLatencyMs": 2400
    }
  ],
  "silentAgents": 0,
  "poller": { "status": "running" }
}
```

### Service Status

`GET /api/services` — Lists all managed LaunchAgent services with running status.

`POST /api/service-control` — Start, stop, or restart services:

```json
{ "service": "ai.openclaw.deck", "action": "restart" }
```

Special actions:
- `restart-all` — Restart all non-gateway services
- `doctor` — Run `openclaw doctor` diagnostics
- `revert-config` — Revert config to last git commit
- `apply-config-safely` — Atomic config deploy with health-check rollback

### System Event Log

`GET /api/system-log` — Audit trail of operational events:

| Category | Events |
|----------|--------|
| `services` | Start/stop/restart actions |
| `config` | Config changes, rollbacks |
| `budget` | Budget alerts and actions |
| `drift` | Model drift events |
| `providers` | Provider limit violations |

Query with: `?since=<unix_ms>&limit=200&categories=config,budget`

## Sentinel (External Health Monitor)

Sentinel is an optional Python health checker that runs independently of the gateway.

### Setup

```bash
cd sentinel
cp deck-sentinel.example.json deck-sentinel.json
# Edit deck-sentinel.json — enable desired checks
python3 sentinel_loop.py --config deck-sentinel.json --once       # Single run
python3 sentinel_loop.py --config deck-sentinel.json              # Continuous loop
python3 sentinel_loop.py --config deck-sentinel.json --dry-run    # Preview (no side effects)
```

**Requirements:** Python 3.10+ (stdlib only, no pip dependencies).

### Available Checks

| Check | What It Monitors | Config Key |
|-------|-----------------|------------|
| `gateway_health` | Gateway `/health` endpoint | `gateway_url` |
| `dashboard_health` | Dashboard HTTP health | `checks.dashboard_health.url` |
| `cron_health` | Cron job error counters | `cron_consecutive_error_threshold` |
| `ghost_crons` | Orphaned cron processes | — |
| `port_conflicts` | Port binding conflicts | `checks.port_conflicts.ports` |
| `security_audit` | World-writable files | `security_scan_paths` |
| `working_md` | `WORKING.md` freshness | `working_md_max_age_hours` |

### Incident Output

Sentinel writes structured incidents to `sentinel_runs.jsonl`:

```json
{
  "id": "INC-20260304-143022-A3F1",
  "check": "gateway_health",
  "severity": "critical",
  "message": "Gateway health endpoint unreachable",
  "details": { "url": "http://127.0.0.1:18789/health", "error": "Connection refused" }
}
```

Severity levels: `critical`, `high`, `medium`, `low`, `info`.

## Ops Bot (Discord Commands)

Optional Discord bot for remote operational commands.

### Setup

```bash
cd ops-bot
# Set DISCORD_BOT_TOKEN_DECK and DECK_OPS_CHANNEL_ID env vars
python3 ops-bot.py
```

**Requirements:** Python 3.10+ (stdlib only).

### Commands

| Command | Action |
|---------|--------|
| `!status` | Show all LaunchAgent service statuses |
| `!doctor` | Run `openclaw doctor` diagnostics |
| `!restart-all` | Restart all services |
| `!openclaw-gw` | Restart gateway |
| `!nextjs` | Restart Deck dashboard |
| `!ops-bot` | Restart ops bot |
| `!revert-config` | Revert to last git-committed config |
| `!help` | List commands |

Commands can be enabled/disabled in `config/deck-agents.json` under `opsBotCommands`.

## Quick Setup Checklist

1. **Budget alerts** — Set `budgets.alertChannel` in `deck-config.json`, configure thresholds
2. **Discord channels** — Map `systemChannels` and `pluginChannels` to Discord channel IDs
3. **Discord bot token** — Set `DISCORD_BOT_TOKEN_DECK` in `.env`
4. **Session guardrails** — Enable in `deck-config.json` → `sessionGuardrails`
5. **Provider limits** — Define in `deck-config.json` → `providerLimits`
6. **Sentinel** (optional) — Copy and configure `sentinel/deck-sentinel.json`
7. **Ops bot** (optional) — Set `DECK_OPS_CHANNEL_ID` and run `ops-bot.py`

All built-in detection (heartbeats, silence, drift, loops, provider health) runs automatically once the plugin is installed — no configuration needed.
