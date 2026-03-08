# Deck Architecture

## Overview

Deck is a self-hosted observability dashboard for [OpenClaw](https://github.com/openclaw/openclaw) AI agents. It captures every LLM call, tool invocation, and user message, stores them in SQLite, and presents them through a Next.js dashboard.

The system has four layers:

```
┌─────────────────────────────────────────────────────┐
│                   React Dashboard                    │
│         (Next.js pages — logs, costs, agents)        │
├─────────────────────────────────────────────────────┤
│                   API Routes                         │
│          (Next.js route handlers — /api/*)            │
├─────────────────────────────────────────────────────┤
│                   SQLite Database                    │
│     (usage.db — 11 tables + FTS5 search index)       │
├──────────────────────┬──────────────────────────────┤
│   Gateway Plugin     │      Backfill Script          │
│  (real-time hooks)   │  (historical JSONL import)    │
└──────────┬───────────┴──────────┬───────────────────┘
           │                      │
     OpenClaw Gateway      JSONL Transcript Files
     (port 18789)          (~/.openclaw/agents/*/sessions/)
```

## Data Pipeline

Data enters the database through two independent paths:

### Live Plugin (real-time)

The gateway plugin (`plugin/index.ts`) registers hooks with the OpenClaw gateway. As agents process messages, the plugin captures events and writes them to SQLite immediately.

```
User message → Gateway → Plugin hooks fire → logEvent() → SQLite
```

**What it captures:** All LLM calls with full token counts, tool invocations with arguments and results, user messages, cost data, model drift alerts, heartbeats, agent activity.

**What it uniquely provides:** Real-time session channel info, prompt text via gateway context, heartbeats, drift/silence/loop alerts, FTS5 search index updates. (During backfill, user prompts are also recovered from JSONL transcripts using last-preceding-message matching — stored as `promptPreview` in the event detail JSON.)

### Backfill Script (historical)

The backfill script (`scripts/backfill-all.ts`) parses JSONL transcript files from disk to recover events from sessions that occurred before the plugin was installed.

```
JSONL files on disk → Parse transcripts → Insert events → Enrich metadata → SQLite
```

**10-step pipeline:** Bootstrap schema → Import sessions → Parse events → Enrich model data → Recover prompts → Extract tool metadata → Classify sources → Calculate costs → Enrich sessions → Backfill billing.

**Key properties:** Fully idempotent (safe to re-run), creates the complete 16-table schema, calculates provider costs from token counts.

### Overlap Handling

When both paths capture the same session, the backfill skips it (checks for existing events by session key). The live plugin's data takes priority because it has richer context from the gateway.

## Plugin Hook Lifecycle

The plugin registers 6 hooks with the OpenClaw gateway, fired in this order during a typical LLM call:

```
1. message_received     →  Log inbound message, update heartbeat
2. before_model_resolve →  Check budget, enforce throttling/blocking
3. before_prompt_build  →  Inject enforcement context (explain throttle to agent)
4. llm_input            →  Log prompt, system prompt size, history count, flags
5. llm_output           →  Log tokens, cost, response text, thinking blocks
6. message_sent         →  Log outbound message
```

### Hook Details

| Hook | Purpose | Modifying? |
|------|---------|-----------|
| `message_received` | Logs user messages, updates agent heartbeat | No |
| `before_model_resolve` | Budget enforcement — can block, throttle (downgrade model), or pause agent | **Yes** — returns model override |
| `before_prompt_build` | Injects system message explaining why model was throttled/blocked | **Yes** — modifies prompt |
| `llm_input` | Logs the full prompt with metadata (token estimate, compaction flag, tool count, image count) | No |
| `llm_output` | Logs response with tokens, cost, resolved model, response text, thinking content | No |
| `message_sent` | Logs outbound messages to channels | No |

### Agent Identity Resolution

The plugin resolves agent identity through a 3-step fallback chain:

1. `ctx.accountId` (from gateway)
2. Extract from `ctx.sessionKey` (parse `agent:{ID}:discord:channel:...` format)
3. `ctx.agentId` (gateway-assigned)

This maps internal gateway IDs to human-readable agent names defined in `config/deck-agents.json`.

## Database Schema

SQLite database at `~/.openclaw-deck/data/usage.db` (configurable via `DECK_USAGE_DB`).

### Core Tables

```
events ─────────── session ──────────── sessions
  │                                        │
  │ agent                            agent │
  │                                        │
  └── tool_name, tool_query,         heartbeats
      tool_target                      │
                                  agent_key
                                       │
                                  drift_events
```

**events** (primary telemetry — 22 columns)
- Identity: `id`, `ts`, `agent`, `session`, `type`
- LLM data: `model`, `resolved_model`, `input_tokens`, `output_tokens`, `cache_read`, `cache_write`
- Cost: `cost` (estimated), `provider_cost` (actual), `billing` (subscription/metered)
- Content: `prompt`, `response`, `thinking`, `detail` (JSON)
- Tool metadata: `tool_name`, `tool_query` (the primary input — search query, file path, URL, or command), `tool_target` (the target resource — file path or URL)
- Correlation: `run_id`

**sessions** (conversation tracking — 22 columns)
- Identity: `session_key`, `agent`, `session_id`, `channel`
- Metrics: `total_tokens`, `input_tokens`, `output_tokens`, `context_tokens`
- Metadata: `model`, `display_name`, `label`, `source` (agent/cron/heartbeat)
- Lifecycle: `status`, `created_at`, `updated_at`, `archived_at`

### Supporting Tables

| Table | Purpose | Populated By |
|-------|---------|-------------|
| `heartbeats` | Agent health status (model, bio, last seen) | Live plugin |
| `drift_events` | Model configuration mismatches | Live plugin |
| `agent_activities` | Activity feed (started, paused, errors) | Live plugin |
| `deliverables` | Grouped tool outputs (files, commits, tests) | Live plugin |
| `session_analysis` | LLM-generated session quality analysis | API on demand |
| `session_feedback` | User ratings and notes per session | API on demand |
| `backfill_meta` | Migration/backfill completion tracking | Backfill script |
| `search_idx` | FTS5 full-text search index | Live plugin |
| `search_sync_state` | FTS5 sync cursor per agent | Live plugin |

### Cost Model

Events track cost through two columns:

- **`cost`** — Estimated at capture time from token counts and a pricing table
- **`provider_cost`** — Actual cost from provider APIs (when available via reconciliation)

All queries use `COALESCE(provider_cost, cost, 0)` to prefer actual over estimated.

Billing classification:
- **subscription** — Anthropic models (Claude Opus/Sonnet/Haiku) on API subscription
- **metered** — Third-party providers (OpenRouter, GPT, DeepSeek, Gemini, etc.)

## Budget and Safety Systems

### Budget Enforcement

The `before_model_resolve` hook enforces spending limits. Escalation path:

```
Usage check → OK          → No action
            → > alert %   → Discord notification
            → > throttle % → Downgrade model one tier + alert
            → > block %   → Auto-pause agent + alert + reject request
```

Budget periods: daily, weekly, monthly. Configurable per-agent and globally in `config/deck-config.json`.

Session-level guardrails also enforce: max cost per session, max duration, max tool calls.

### Model Drift Detection

On every `llm_output`, the plugin compares the resolved model against the configured model:

- **Expected:** Matches primary or configured fallback → no action
- **Session override:** Matches a temporary override → tagged, no alert
- **Unexpected:** Unknown model → drift alert + Discord notification

Drift events are tracked in `drift_events` and surfaced in the dashboard.

### Stuck Loop Detection

The plugin maintains a circular buffer of the last 20 tool calls per agent. If the same tool+params signature appears 5+ times, it fires a `loop_detected` alert.

### Agent Silence Monitoring

A 5-minute interval check detects agents that haven't produced any LLM output in 30+ minutes. Fires `agent_silence` alerts.

## Frontend Architecture

### Next.js App (app/)

| Page | Purpose |
|------|---------|
| `/logs` | Event stream viewer with filters (agent, type, model, session) |
| `/sessions` | Session browser — metadata, transcript, cost breakdown |
| `/costs` | Cost tracking — daily/weekly/monthly by agent, provider breakdown |
| `/agents` | Agent status grid — health, model, last active, heartbeat |
| `/schedule` | Schedule — cron jobs, model assignments, drift detection |
| `/deck-config` | Dashboard settings — budgets, alerts, model pricing, overrides |
| `/analysis` | Session analysis — LLM-generated quality scores and critique |

### API Routes (app/api/)

API routes are thin wrappers over SQLite queries. They:
- Read from `usage.db` directly (no ORM)
- Fall back to direct SQLite when the gateway is unavailable (header: `X-Source: sqlite-fallback`)
- Return `{ ok: boolean, error?: string, ...data }` format
- Use parameterized queries for all user input

See [API.md](API.md) for the complete endpoint reference.

### Data Refresh

The dashboard uses **polling-based updates** (not WebSocket):
- Event stream: polls `/api/usage` with `since` cursor
- Session list: polls `/api/agent-sessions`
- Agent status: polls `/api/agents` (merged with heartbeat data)

## Key Files

| File | Purpose | LOC |
|------|---------|-----|
| `plugin/index.ts` | Plugin entry — hook registration, startup backfill, session poller | ~2,800 |
| `plugin/event-log.ts` | SQLite schema, queries, event logging, cost reconciliation | ~4,400 |
| `plugin/budget.ts` | Budget enforcement, throttling, drift detection, loop detection | ~1,500 |
| `scripts/backfill-all.ts` | 10-step historical data recovery pipeline | ~1,300 |
| `scripts/bootstrap-config.mjs` | First-run config file creation from examples | ~100 |
| `lib/agent-config.ts` | Agent metadata resolution from config files | ~250 |
| `app/api/*/route.ts` | API route handlers (30+ endpoints) | ~50-150 each |
| `config/deck-config.example.json` | Default dashboard configuration template | ~50 |
| `config/deck-agents.example.json` | Default agent registry template | ~55 |

## Configuration

### Runtime Config Files

| File | Purpose | Created By |
|------|---------|-----------|
| `config/deck-agents.json` | Agent roster (name, key, emoji, Discord channels) | `bootstrap-config.mjs` from example |
| `config/deck-config.json` | Service URLs, budgets, model pricing, provider keys | `bootstrap-config.mjs` from example |
| `.env` | Environment variables (gateway URL, tokens, DB paths) | Manual from `.env.example` |

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENCLAW_GATEWAY_URL` | Yes | `http://127.0.0.1:18789` | Gateway connection |
| `OPENCLAW_GATEWAY_TOKEN` | No | — | Bearer token for gateway auth |
| `DECK_USAGE_DB` | No | `~/.openclaw-deck/data/usage.db` | SQLite database path |
| `DECK_ROOT` | No | Auto-detected | Plugin config lookup path |

See `.env.example` for the full list.
