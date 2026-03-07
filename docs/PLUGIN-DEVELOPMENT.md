# Deck — Plugin Development Guide

How the Deck gateway plugin works, the hook API, and how to extend it.

## Overview

The Deck plugin (`plugin/index.ts`) integrates with the OpenClaw gateway via the plugin SDK. It registers hooks that fire during the LLM call lifecycle, capturing events to SQLite in real time.

```
Gateway receives message
  → message_received hook
  → before_model_resolve hook (can override model)
  → before_prompt_build hook (can inject context)
  → llm_input hook
  → LLM provider call
  → llm_output hook
  → message_sent hook
```

## Plugin Structure

```
plugin/
├── index.ts              # Entry point — hook registration, startup backfills
├── event-log.ts          # SQLite schema, event logging, queries
├── budget.ts             # Budget enforcement, drift detection, loop detection
├── openclaw.plugin.json  # Plugin manifest
├── package.json          # Plugin dependencies
└── README.md
```

### Manifest (`openclaw.plugin.json`)

```json
{
  "kind": "integration",
  "configSchema": {}
}
```

### Installation

```bash
cd plugin
npm install --omit=dev
openclaw plugins install --link ./plugin
openclaw gateway restart
```

Verify: `openclaw plugins list` should show `openclaw-deck-sync`.

## Hook API

Hooks are registered in the `register()` function via `api.on(hookName, callback)`:

```typescript
const plugin = {
  id: "openclaw-deck-sync",
  name: "Deck Sync",
  description: "Observability and budget enforcement for OpenClaw agents",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.on("message_received", async (event, ctx) => { ... });
    api.on("before_model_resolve", async (event, ctx) => { ... });
    // ...
  }
};

export default plugin;
```

### Context Object

Every hook receives a `ctx` object with session identity:

```typescript
interface HookContext {
  accountId?: string;    // Agent account ID (primary identity)
  agentId?: string;      // Gateway-assigned agent ID
  sessionKey?: string;   // Session identifier, e.g. "agent:scout:discord:channel:123"
  channelId?: string;    // Channel ID (message hooks only)
}
```

**Agent identity resolution** uses a 3-step fallback: `ctx.accountId` → parse from `ctx.sessionKey` → `ctx.agentId`.

### Hook Reference

#### `message_received`

Fires when the gateway receives an inbound message.

| Property | Type | Description |
|----------|------|-------------|
| `event.content` | `string?` | Message text |
| `event.sender` | `string?` | Sender info |

**Modifying:** No. Return value ignored.

**Deck usage:** Logs inbound messages, updates agent heartbeat timestamp.

---

#### `before_model_resolve`

Fires before the gateway resolves which model to use. **This is the only hook that can change the model.**

| Property | Type | Description |
|----------|------|-------------|
| `event.model` | `string?` | Configured/requested model |

**Modifying:** Yes. Return `{ modelOverride?, providerOverride? }` to change the model.

```typescript
api.on("before_model_resolve", async (event, ctx) => {
  // Check budget
  const result = checkBudget(agentKey);
  if (result.action === "throttle") {
    return { modelOverride: "claude-haiku-4-5-20251001" };
  }
  if (result.action === "block") {
    return { modelOverride: "__budget_rejected__" + JSON.stringify(result) };
  }
  // No override — use configured model
});
```

**Deck usage:** Budget enforcement — checks spending limits and either allows, throttles (downgrades model), or blocks the request.

---

#### `before_prompt_build`

Fires before the system prompt is assembled.

| Property | Type | Description |
|----------|------|-------------|
| (none) | — | No event properties used |

**Modifying:** Yes. Return `{ prependContext? }` to inject text into the system prompt.

```typescript
api.on("before_prompt_build", async (event, ctx) => {
  return {
    prependContext: "[THROTTLED] Your model was downgraded due to budget limits."
  };
});
```

**Deck usage:** Injects enforcement messages explaining why the model was throttled or blocked, so the agent understands the constraint.

---

#### `llm_input`

Fires just before sending the request to the LLM provider.

| Property | Type | Description |
|----------|------|-------------|
| `event.model` | `string` | Model identifier |
| `event.provider` | `string` | Provider name (anthropic, openrouter, etc.) |
| `event.runId` | `string` | Unique ID for this LLM call |
| `event.systemPrompt` | `string?` | System prompt text |
| `event.historyMessages` | `Message[]?` | Conversation history |
| `event.prompt` | `string?` | Current user prompt |
| `event.imagesCount` | `number?` | Images in the prompt |

**Modifying:** No. Return value ignored.

**Deck usage:** Logs the full prompt with metadata (token estimate, tool count, compaction flag). Stores the prompt JSON for later replay.

---

#### `llm_output`

Fires after receiving the LLM response.

| Property | Type | Description |
|----------|------|-------------|
| `event.model` | `string` | Model that was actually used |
| `event.provider` | `string` | Provider |
| `event.runId` | `string` | Matches the `llm_input` runId |
| `event.usage.input` | `number?` | Input tokens |
| `event.usage.output` | `number?` | Output tokens |
| `event.usage.cacheRead` | `number?` | Cache read tokens |
| `event.usage.cacheWrite` | `number?` | Cache write tokens |
| `event.assistantTexts` | `string[]?` | Response text |
| `event.assistantThinking` | `string?` | Extended thinking content |

**Modifying:** No. Return value ignored.

**Deck usage:** Logs tokens, cost, and response. Checks for model drift (actual vs configured model). Runs session guardrail checks (duration, tool calls, step cost).

---

#### `message_sent`

Fires after a message is sent to a channel.

| Property | Type | Description |
|----------|------|-------------|
| `event.success` | `boolean` | Delivery status |
| `event.content` | `string?` | Message text |

**Modifying:** No. Return value ignored.

**Deck usage:** Sends heartbeat indicating agent activity.

---

#### `agent_end`

Fires when an agent session completes.

| Property | Type | Description |
|----------|------|-------------|
| `event.messages` | `Message[]?` | Final messages |
| `event.status` | `string?` | Completion status |

**Modifying:** No. Return value ignored.

**Deck usage:** Detects cron job failures (consecutive error tracking), sends Discord alerts.

## Event Logging

The `logEvent()` function writes telemetry to SQLite:

```typescript
logEvent({
  agent: "scout",             // Required: agent key
  session: "agent:scout:...", // Session identifier
  type: "llm_output",        // Event type
  model: "claude-sonnet-4-20250514",
  inputTokens: 1500,
  outputTokens: 800,
  cacheRead: 500,
  cost: 0.012,               // Estimated cost (USD)
  providerCost: 0.011,       // Actual provider cost (when available)
  billing: "subscription",   // "subscription" or "metered"
  runId: "run_abc123",       // Links llm_input ↔ llm_output
  prompt: '{"system":"..."}',
  response: "The answer is...",
  thinking: "Let me think...",
  resolvedModel: "claude-sonnet-4-20250514",
  detail: { tool: "Read", params: { file: "src/main.ts" } }
});
```

### Event Types

| Type | When | Key Fields |
|------|------|------------|
| `llm_input` | Before LLM call | model, prompt, runId |
| `llm_output` | After LLM response | tokens, cost, response, thinking, runId |
| `tool_call` | Tool invocation | tool_name, tool_query, tool_target (in detail) |
| `msg_in` | Inbound message | content in detail |
| `msg_out` | Outbound message | content in detail |
| `heartbeat` | Agent pulse | model, status in detail |

## Budget Checking

The `checkBudget()` function evaluates spending against configured limits:

```typescript
const result = checkBudget("scout");
// result.action: "ok" | "alert" | "throttle" | "block"
// result.trigger: "agent" | "global"
// result.period: "daily" | "weekly" | "monthly"
// result.ratio: 0.0 - 1.0+ (spending / limit)
```

### Escalation Path

```
Spending check → OK             → No action
              → > alert %      → Discord notification
              → > throttle %   → Downgrade model + alert
              → > block %      → Pause agent + alert + reject
```

Budget config is in `config/deck-config.json` under `budgets`:

```json
{
  "budgets": {
    "global": { "daily": 50, "weekly": 200, "monthly": 500 },
    "agents": {
      "scout": { "daily": 10 }
    },
    "alertThresholds": [50, 80, 100]
  }
}
```

## HTTP Route Registration

Register custom HTTP endpoints on the gateway:

```typescript
api.registerHttpRoute({
  path: "/my-route",
  handler: (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const param = url.searchParams.get("key");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, data: param }));
  }
});
```

Deck registers routes under `/logs/*`, `/activity/*`, `/budget/*`, and `/sessions` on the gateway.

## Safety Systems

### Model Drift Detection

On every `llm_output`, the plugin compares the resolved model against the agent's configured model. Unexpected models trigger a `drift_event` record and Discord alert.

### Stuck Loop Detection

A circular buffer tracks the last 20 tool calls per agent. If the same tool+params signature appears 5+ times, a `loop_detected` alert fires.

### Agent Silence Monitoring

A 5-minute interval checks for agents with no LLM output in 30+ minutes. Fires `agent_silence` alerts.

### Session Guardrails

Per-session limits configured in `config/deck-config.json` under `sessionGuardrails`:

| Guardrail | Default | Action |
|-----------|---------|--------|
| Max duration | Configurable (minutes) | Alert, throttle, or block |
| Max tool calls | Configurable (count) | Alert, throttle, or block |
| Context threshold | 85% of window | Alert |
| Step cost threshold | Configurable (USD) | Alert |

## Plugin Lifecycle

1. **Gateway starts** → calls `register(api)`
2. **Initialization** → Plugin creates SQLite schema, loads config, starts file watchers
3. **Startup backfills** → Recovers missed data from filesystem transcripts
4. **Hooks active** → All registered hooks fire on gateway events
5. **Polling** → Session poller syncs transcript files every 15 seconds
6. **Interval tasks** → Config reload, silence checks, drift monitoring

## Key Files

| File | LOC | Purpose |
|------|-----|---------|
| `plugin/index.ts` | ~3,900 | Hook registration, startup backfills, session poller |
| `plugin/event-log.ts` | ~5,800 | SQLite schema, queries, event logging, cost reconciliation |
| `plugin/budget.ts` | ~1,200 | Budget enforcement, throttling, drift, loop detection |
