# Budget, Alerts, and Session Guardrails Guide

> Complete reference for Deck's cost management, alerting, and session safety systems.
> Written for both human operators and AI/LLM agents that manage or configure these systems.

---

## Overview

Deck provides four layers of cost and safety protection:

| Layer | What it protects against | Enforcement options |
|-------|--------------------------|---------------------|
| **Global Budgets** | Total fleet spend exceeding daily/weekly/monthly limits | Block |
| **Per-Agent Budgets** | Individual agent overspend | Alert, Throttle, Block |
| **Session Cost Cap** | A single session running up a large bill | Alert, Throttle, Block |
| **Session Guardrails** | Runaway sessions (long duration, excessive tool calls, context overflow) | Alert, Throttle, Block |

All four layers share common infrastructure:
- **Alert Thresholds** — percentages (e.g. 55%, 80%, 100%) that trigger early warnings before enforcement
- **Cost View** — which cost metric to evaluate (`actual`, `api-equiv`, or `total`)
- **Alert Channel** — which Discord channel receives alerts
- **Throttle Chain** — model downgrade path when throttling (e.g. opus → sonnet → haiku)

---

## Configuration

All budget settings live in `config/deck-config.json` under the `budgets` key, and `sessionGuardrails` as a top-level key. Settings can be edited via the Deck Config dashboard (Budgets tab) or by editing the JSON directly.

### Config Structure

```jsonc
{
  "budgets": {
    // ── Global settings ──
    "costView": "total",              // "actual" | "api-equiv" | "total"
    "alertChannel": "systemStatus",   // key from systemChannels
    "alertThresholds": [55, 80, 100], // percentages — triggers early warnings

    // ── Global budget limits ──
    "global": {
      "daily": 50,           // max $ per day across all agents
      "weekly": 200,         // max $ per week
      "monthly": 500,        // max $ per month
      "dailyRequests": 1000, // max LLM calls per day
      "weeklyRequests": 5000 // max LLM calls per week
    },

    // ── Per-agent budgets ──
    "agents": {
      "jane": {
        "daily": 20,
        "dailyRequests": 500,
        "weeklyRequests": 2000,
        "action": "throttle",    // "alert" | "throttle" | "block"
        "autoRecovery": true     // override default auto-recovery
      },
      "forge": {
        "daily": 30,
        "action": "block"
      }
    },

    // ── Session Cost Cap ──
    "sessionCostCap": {
      "default": 5,          // $ cap per session (all agents)
      "action": "throttle",  // "alert" | "throttle" | "block"
      "agents": {            // per-agent overrides
        "forge": 15,         // forge gets a higher cap
        "scout": 3           // scout gets a lower cap
      }
    },

    // ── Auto-recovery ──
    "defaultAutoRecovery": "throttle-only", // "all" | "throttle-only" | "none"

    // ── Throttle chain ──
    // not inside budgets — it's a top-level key
  },

  // ── Throttle Chain (top-level) ──
  "throttleChain": ["opus", "sonnet", "haiku"],

  // ── Session Guardrails (top-level) ──
  "sessionGuardrails": {
    "enabled": true,
    "action": "alert",           // "alert" | "throttle" | "block"
    "maxSessionDuration": 60,    // minutes
    "maxToolCalls": 200,         // count
    "contextThreshold": 85       // percentage of max context window
  }
}
```

---

## Cost View

Controls which cost metric is used for **all** budget evaluations — global, per-agent, session cost cap, and alerts.

| Mode | What it measures | Best for |
|------|-----------------|----------|
| `actual` | Real provider spend (API billing only) | API/pay-per-use accounts — track what you actually pay |
| `api-equiv` | Estimated cost at standard API rates | Subscription accounts — track usage even when provider cost is $0 |
| `total` | Actual for API billing, API-equiv for subscription | Mixed setups — always has a meaningful number |

**Default:** `total`

**How it works:**
- `actual` + subscription billing → cost is $0, so budget checks are skipped (no real spend)
- `api-equiv` always returns a cost estimate, even for subscription/cached calls
- `total` picks the right one automatically based on billing type

---

## Alert Thresholds

A list of percentages that control when warnings fire. Applied globally to:
- Agent budget checks (daily/weekly/monthly cost and request limits)
- Provider rate limit checks
- Session Cost Cap
- Session Guardrails (duration, tool calls)

**Example:** `[55, 80, 100]`
- At **55%** of limit → Discord alert (warning)
- At **80%** of limit → Discord alert (warning)
- At **100%** of limit → full enforcement action (alert/throttle/block per config)

Below the lowest threshold → no action. Between thresholds → alert only (regardless of configured action). At or above 100% → the configured action fires.

**Default:** `[80, 100]`

---

## Enforcement Actions

Three actions available for per-agent budgets, session cost cap, and session guardrails:

### Alert
Send a Discord notification. No impact on the agent's operation. The LLM call proceeds normally.

### Throttle
Downgrade the agent's model to a cheaper one using the throttle chain. For example, if the chain is `["opus", "sonnet", "haiku"]` and the agent is using opus, it gets downgraded to sonnet. If already on sonnet, downgraded to haiku. If already at the cheapest model, the call proceeds as-is.

### Block
Reject the LLM call entirely. The gateway returns a structured error (`__budget_rejected__`) with a code indicating why:
- `BUDGET_EXCEEDED` — per-agent budget limit hit
- `AGENT_PAUSED` — agent manually or auto-paused
- `SESSION_COST_EXCEEDED` — session cost cap hit
- `SESSION_GUARDRAIL_EXCEEDED` — duration or tool call limit hit

---

## Global Budgets

Fleet-wide spending limits. These are hard limits — when hit, all agents are blocked (action is always `block` for global limits).

| Setting | Description |
|---------|-------------|
| `global.daily` | Max $ per day across all agents |
| `global.weekly` | Max $ per week |
| `global.monthly` | Max $ per month |
| `global.dailyRequests` | Max total LLM calls per day |
| `global.weeklyRequests` | Max total LLM calls per week |

All are optional. If not set, no global limit is enforced for that period.

---

## Per-Agent Budgets

Individual agent spending limits with configurable enforcement action.

| Setting | Description |
|---------|-------------|
| `agents.<key>.daily` | Max $ per day for this agent |
| `agents.<key>.weekly` | Max $ per week |
| `agents.<key>.monthly` | Max $ per month |
| `agents.<key>.dailyRequests` | Max LLM calls per day |
| `agents.<key>.weeklyRequests` | Max LLM calls per week |
| `agents.<key>.action` | What to do when limit is hit: `alert`, `throttle`, or `block` |
| `agents.<key>.autoRecovery` | Override default auto-recovery for this agent |

**Default action:** `alert` (notify only, don't restrict the agent)

---

## Session Cost Cap

Limits how much a single session can spend before enforcement kicks in.

| Setting | Description |
|---------|-------------|
| `sessionCostCap.default` | Default cap in $ for all agents |
| `sessionCostCap.action` | `alert`, `throttle`, or `block` |
| `sessionCostCap.agents.<key>` | Per-agent override cap in $ |

**Default:** $5, action: `alert`

**How it works:** Each LLM call's cost is tracked per-session in memory. Before each LLM call, the cumulative session cost is checked against the cap. Early warnings fire at alert threshold percentages (e.g. at 55% and 80% of the cap). At 100%, the configured action fires.

---

## Session Guardrails

Protect against runaway sessions — sessions that run too long, make too many tool calls, or consume too much context window.

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Enable/disable all guardrails | `true` |
| `action` | `alert`, `throttle`, or `block` | `alert` |
| `maxSessionDuration` | Maximum session length in minutes | `60` |
| `maxToolCalls` | Maximum tool calls per session | `200` |
| `contextThreshold` | Alert when context window usage exceeds this % | `85` |

**How it works:** Duration and tool calls are checked before each LLM call (enforced in `before_model_resolve`). Context threshold is checked after each LLM output (alert-only — can't enforce pre-call since context isn't known yet).

Alert thresholds apply here too — a session at 80% of `maxToolCalls` triggers an early warning.

---

## Auto-Recovery

Controls whether blocked/throttled agents automatically resume when their budget period resets.

| Mode | Behavior |
|------|----------|
| `throttle-only` | Auto-recover throttled agents; blocked agents stay blocked until manual resume |
| `all` | Auto-recover both throttled and blocked agents |
| `none` | Never auto-recover; all agents require manual resume |

**Default:** `throttle-only`

Per-agent overrides: set `autoRecovery: true` (always) or `autoRecovery: false` (never) on individual agents.

---

## Emergency Overrides

Time-limited bypasses that skip ALL budget enforcement for a specific agent. Useful when an agent needs to finish critical work despite being over budget.

Created via Discord buttons on budget alerts or via the dashboard. Overrides have an expiration time (typically 1h or 4h) and auto-expire.

When an override is active:
- All budget checks are skipped
- Paused agents are automatically unpaused
- Session cost cap and guardrails are also bypassed

---

## Throttle Chain

The model downgrade path used when throttling. Models are listed from most expensive to cheapest.

**Default:** `["opus", "sonnet", "haiku"]`

When an agent is throttled, its model steps down one level in the chain. For example:
- Agent using `opus` → throttled to `sonnet`
- Agent using `sonnet` → throttled to `haiku`
- Agent already on `haiku` → no further downgrade possible, call proceeds

The chain uses substring matching — `"opus"` matches `claude-opus-4-6`, `anthropic/claude-opus-4-6`, etc.

---

## Provider Rate Limits

Separate from budget limits — these track usage against provider-imposed rate limits (e.g. OpenRouter's 5-hour rolling window).

Configured via `providerLimits` in config. Alert thresholds apply here too — alerts fire when approaching a provider's rate limit. These are always alert-only (the provider itself enforces the hard limit).

---

## Alert Channel

All alerts (budget, session cost, guardrails, provider limits) are sent to the Discord channel specified by `alertChannel`. This is a key from `systemChannels` in the config.

**Default:** `"systemStatus"`

---

## Discord Alert Format

All alerts are sent to Discord with:
- Alert type and severity icon
- Agent name, measured value, and threshold
- Enforcement action taken (if throttle or block): shown as `[THROTTLE]` or `[BLOCK]` in the title
- Cost view label for cost-related alerts
- Action buttons: View Session, View Costs, View Logs, Configure (deep-links to the relevant config field)

Budget alerts also include Override and Pause buttons for quick operator action.

---

## Enforcement Flow

On every LLM call, the `before_model_resolve` hook runs these checks in order:

```
1. Emergency override? → bypass everything
2. Agent paused? → BLOCK (AGENT_PAUSED)
3. Per-agent budget check → alert / throttle / block
4. Global budget check → block (always)
5. Session cost cap check → alert / throttle / block
6. Session guardrails check → alert / throttle / block
7. Provider rate limit check → alert only
```

The first blocking action wins — if per-agent budget blocks, session checks don't run.

---

## Dashboard UI (Deck Config → Budgets Tab)

The Budgets tab is organized top-to-bottom:

1. **Alert Settings** — Cost View (radio), Alert Channel (dropdown), Alert Thresholds (comma-separated %)
2. **Global Budgets** — Daily/weekly/monthly cost and request limits
3. **Per-Agent Budgets** — (collapsible) Per-agent limits and action
4. **Session Cost Cap** — Default cap, action radio, per-agent overrides (collapsible)
5. **Session Guardrails** — Enabled toggle, action radio, duration/tool calls/context thresholds
6. **Auto-Recovery** — Default mode, per-agent overrides (collapsible)
7. **Throttle Chain** — (collapsible) Model downgrade order

---

## Config File Location

```
config/deck-config.json
```

The gateway watches this file for changes (polling every 5s) — no restart needed after editing.

---

## State Files

| File | Purpose |
|------|---------|
| `~/.openclaw-deck/state/agent-paused.json` | Pause state per agent |
| `~/.openclaw-deck/state/budget-overrides.json` | Active emergency overrides |

---

## Testing Alerts

The gateway exposes test endpoints for verifying alert delivery without triggering real budget events:

```bash
# Budget alerts (threshold, exceeded, blocked)
curl -X POST http://localhost:18789/budget/test-alert \
  -H 'Content-Type: application/json' \
  -d '{"agent":"jane","level":"threshold"}'

# Session/guardrail alerts (session-cost, step-cost, long-session, excessive-tools, context-critical)
curl -X POST http://localhost:18789/replay/test-alert \
  -H 'Content-Type: application/json' \
  -d '{"agent":"jane","type":"long-session"}'
```

---

## Quick Setup Recipes

### Minimal setup (alert only, no enforcement)
```json
{
  "budgets": {
    "global": { "daily": 100 },
    "alertThresholds": [80, 100],
    "alertChannel": "systemStatus"
  }
}
```

### Production setup (throttle at limit, block at 2x)
```json
{
  "budgets": {
    "costView": "total",
    "alertThresholds": [50, 80, 100],
    "alertChannel": "systemStatus",
    "global": { "daily": 100, "weekly": 400 },
    "agents": {
      "forge": { "daily": 30, "action": "throttle" },
      "scout": { "daily": 10, "action": "block" }
    },
    "sessionCostCap": { "default": 5, "action": "throttle" },
    "defaultAutoRecovery": "throttle-only"
  },
  "sessionGuardrails": {
    "enabled": true,
    "action": "throttle",
    "maxSessionDuration": 60,
    "maxToolCalls": 200,
    "contextThreshold": 85
  },
  "throttleChain": ["opus", "sonnet", "haiku"]
}
```

### Strict setup (block everything at limit)
```json
{
  "budgets": {
    "costView": "actual",
    "alertThresholds": [50, 75, 100],
    "global": { "daily": 50 },
    "agents": {
      "forge": { "daily": 20, "action": "block" },
      "jane": { "daily": 15, "action": "block" }
    },
    "sessionCostCap": { "default": 3, "action": "block" },
    "defaultAutoRecovery": "none"
  },
  "sessionGuardrails": {
    "enabled": true,
    "action": "block",
    "maxSessionDuration": 30,
    "maxToolCalls": 100,
    "contextThreshold": 80
  }
}
```

---

## For AI/LLM Agents

If you are an AI agent reading this to understand budget constraints:

1. **Check if you're being throttled:** If your model was downgraded (e.g. you expected opus but got sonnet), a budget or guardrail threshold was likely breached. Complete your task efficiently with the current model.

2. **If blocked:** Your call was rejected with a `__budget_rejected__` error. The `code` field tells you why. You cannot proceed until the operator intervenes (override, unpause, or budget resets).

3. **Cost awareness:** Every LLM call has a cost. Long contexts with many cache misses are expensive. Prefer focused, concise prompts. Use tools efficiently — excessive tool calls trigger guardrails.

4. **Session duration:** If your session has been running for a long time (approaching `maxSessionDuration`), consider wrapping up or starting a new session for follow-up work.

5. **Context window:** If you're approaching the context threshold, your next call may trigger a guardrail. Consider summarizing or compacting context.

6. **Emergency overrides:** If critical work is blocked by budget limits, ask the operator to grant a time-limited override via the Discord alert buttons or dashboard.
