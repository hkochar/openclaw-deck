# Common Problems Deck Solves

Real problems people hit running AI agents in production, and how Deck addresses each one.

---

## My AI agents are costing too much and I don't know why

Agents make hundreds of LLM calls per day across multiple models and providers. Without per-agent cost tracking, you only see the aggregate bill — $200 over a weekend, $1k/month, with no idea which agent or which model caused it.

**How Deck solves it:**
- Per-agent cost cards with daily, weekly, and monthly breakdowns
- Cost split by model (Claude Opus vs Sonnet vs Haiku), by tool, and by provider (Anthropic, OpenRouter, OpenAI)
- Sparkline charts show trends — spot cost spikes the day they happen
- Every LLM call is logged with its exact token count and estimated cost
- `COALESCE(provider_cost, cost)` — uses actual provider cost when available, falls back to estimate

**Setup:** Install the gateway plugin. Costs are tracked automatically from the first LLM call.

---

## How do I set budget limits on AI agents

One runaway agent loop can burn through your API budget in hours. Without automatic limits, you rely on noticing the problem manually — which often means noticing the bill.

**How Deck solves it:**
- Set daily, weekly, or monthly spending limits per agent or globally
- Three enforcement levels that escalate automatically:
  - **Alert** — Discord notification when an agent hits 50%, 80%, or 100% of budget
  - **Throttle** — Automatically downgrade to a cheaper model (e.g., Opus → Sonnet → Haiku)
  - **Block** — Pause the agent entirely and reject further LLM requests
- Session-level guardrails catch individual runaway sessions: max duration, max tool calls, step cost threshold
- Stuck loop detection — if an agent calls the same tool with the same params 5+ times in 20 calls, Deck alerts immediately

**Setup:** Add budget config to `config/deck-config.json`:
```json
{
  "budgets": {
    "global": { "daily": 100 },
    "agents": {
      "my-agent": { "daily": 20, "action": "throttle" }
    },
    "alertThresholds": [50, 80, 100]
  }
}
```

---

## How do I track per-agent per-model AI costs

When agents silently fall back to expensive models (Opus instead of configured Sonnet), costs spike with no explanation. You need to see not just how much each agent spent, but on which model.

**How Deck solves it:**
- Cost breakdown by agent and model on the Costs page
- Billing classification: "subscription" (Anthropic API) vs "metered" (OpenRouter, OpenAI, etc.)
- Provider cost reconciliation — fetches actual costs from Anthropic, OpenRouter, and OpenAI APIs
- Timeline chart shows cost trends per agent over days/weeks
- Every event in the log shows which model was requested vs which model was actually used

---

## My AI agent gateway keeps crashing and I don't know

Gateway crashes from config corruption, compaction hangs, or bundler errors are silent. Without monitoring, the gateway can be dead for hours while you assume everything is running.

**How Deck solves it:**
- Sentinel health monitor pings the gateway `/health` endpoint on a schedule
- Discord alert fires within seconds of a gateway failure
- Gateway health dashboard shows uptime, memory usage, dropped events, and active stuck loops
- Safe config apply — writes new config, restarts gateway, checks health, auto-rolls back if the health check fails

**Setup:** Sentinel runs as a standalone Python script (stdlib only, no pip dependencies):
```bash
cd sentinel
cp deck-sentinel.example.json deck-sentinel.json
# Single run (check once and exit):
python3 sentinel_loop.py --config deck-sentinel.json --once
# Continuous monitoring loop:
python3 sentinel_loop.py --config deck-sentinel.json
# Dry run (check but don't send alerts):
python3 sentinel_loop.py --config deck-sentinel.json --dry-run
```

---

## AI agent config changes break everything

Agents modify their own config files. A bad edit breaks the gateway restart. No error is shown — the system just stops working silently.

**How Deck solves it:**
- Every config change is auto-committed to git before gateway restart
- If restart fails, Deck auto-reverts to the last working config and retries
- Visual diff viewer shows exactly what changed between versions
- One-click restore to any previous config from the dashboard
- Config validation catches syntax errors before they reach the gateway
- Full git history browser with last 20 commits

---

## How do I know if my AI agents are still running

With multiple agents running on schedules, it's hard to tell which ones are active, which are stale, and which have silently stopped.

**How Deck solves it:**
- Agent heartbeats — each agent reports its status, model, and session every 60 seconds
- Fleet status grid shows all agents with computed status: active, stale, or offline
- Silence detection — if an agent produces no LLM output for 30+ minutes, Deck fires an alert
- Activity feed shows agent lifecycle events: started, paused, errors, model changes

---

## My AI agent was down for hours and nobody noticed

Without proactive alerting, agent failures are only discovered when someone checks manually or notices missing output.

**How Deck solves it:**
- Discord alerts for: budget exceeded, agent silent, gateway down, model drift, cron failures
- Configurable alert thresholds with cooldowns (no alert spam)
- Service dashboard with start/stop/restart controls
- LaunchAgent integration keeps services running across reboots
- Ops bot lets you check status and restart services from Discord

---

## I can't see what my AI agent is doing

Agents run autonomously. When output is wrong, you have no visibility into why — was the right context loaded? Did it call the right tools? How many tokens did it use?

**How Deck solves it:**
- Every LLM call logged with: full prompt (system + history + user), response text, extended thinking blocks
- Every tool call logged with: tool name, arguments, target file/resource
- Token breakdown per call: input, output, cache read, cache write
- Cost per call with model and provider
- Filter by agent, event type, model, session, or time range
- Expandable rows show full event detail JSON

**Setup:** Install the gateway plugin. All events are captured automatically — no agent code changes needed.

---

## How do I debug AI agent behavior

When an agent produces unexpected results, you need to trace exactly what happened — what it was told, what it thought, what tools it called, and what it returned.

**How Deck solves it:**
- Run ID links every `llm_input` to its corresponding `llm_output` — see exactly what was sent and received
- Full prompt capture includes system prompt, conversation history, and user message
- Extended thinking blocks (Claude 3.5+) are captured and viewable
- Tool call trace shows the sequence of tools called within a session
- Session replay walks through the entire conversation step by step
- Cache hit rates reveal whether context was loaded from cache or rebuilt

---

## How do I replay an AI agent session

After an agent finishes a task, you want to review what it did — the full conversation flow, decisions, tool calls, and outcomes.

**How Deck solves it:**
- Session browser lists all sessions per agent with token usage, cost, and status
- Click any session to see the full event timeline in chronological order
- Every prompt, response, tool call, and thinking block is preserved
- AI-powered session analysis scores quality and generates critique automatically
- Cost comparison shows how this session compares to agent and global averages
- Activity timeline shows a calendar view of when each agent was active

---

## My AI agent is using the wrong model and costing me money

Providers sometimes route to a different model than configured. An agent configured for Sonnet silently runs on Opus, tripling costs with no visible error.

**How Deck solves it:**
- Model drift detection on every LLM call — compares actual model vs configured model
- Instant Discord alert when drift is detected
- Models page shows configured vs actual model for each agent side by side
- Drift classification: session override (intentional), fallback (expected), or unexpected drift
- One-click model swap — smoke-tests the new model, patches config, restarts gateway, resolves drift automatically
- Drift history tracked in the database for auditing

---

## Quick Start

All of these features work out of the box with a single gateway plugin install:

```bash
git clone https://github.com/openclaw/openclaw-deck.git
cd openclaw-deck
pnpm install
pnpm dev          # Dashboard at http://localhost:3000

# Install the gateway plugin
cd plugin
npm install --omit=dev
openclaw plugins install --link ./plugin
openclaw gateway restart
```

Budget limits, alerts, and guardrails are configured in `config/deck-config.json` — editable from the dashboard UI.
