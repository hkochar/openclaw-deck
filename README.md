# Deck

**The self-hosted ops dashboard for [OpenClaw](https://github.com/openclaw/openclaw) agents.**

[OpenClaw](https://github.com/openclaw/openclaw) is an open-source AI agent framework for running autonomous agents locally. Deck is its ops layer — cost enforcement, session replay, drift detection, and Discord-native controls, all in one self-hosted dashboard.

> **macOS only.** Deck runs on the same machine as your OpenClaw gateway and uses LaunchAgents for service management.

Your agent burned $200 overnight. You found out this morning. Deck would have caught it at $50.

![Budget lifecycle on Discord](docs/images/discord-full-budget-lifecycle.png)

> Agent hits budget limit → auto-paused → Discord alert on your phone → one tap to resume. No SSH. No laptop.

---

## Why Deck

### Cost Control

Your agent loops on a failing approach and burns $200 before you notice. Deck enforces budget limits per agent — daily caps, session caps, throttle chains that downgrade to cheaper models automatically. Hit the limit? Agent gets paused. You get a Discord alert with an Unpause button. Schedule automatic pauses at night so nothing burns while you sleep.

![Costs dashboard](docs/images/costs-dashboard.png)

Per-agent cost cards, broken down by model and provider. Actual cost vs API equivalent — see exactly how much your subscription billing saves you. 14 agents, 9922 requests, $2.19 actual vs ~$466 at pay-per-token rates.

### Model Drift Detection

Your provider silently routes to a more expensive model. Opus instead of Sonnet — triple the cost, and you never configured it. Deck detects the mismatch in real time, flags the agent in the Schedule view, alerts you in Discord, and lets you swap back with one click.

![Model drift in Schedule view](docs/images/schedule-model-drift.png)

![Model drift alert on Discord](docs/images/discord-model-drift.png)

### Config Safety

Your agent changes the gateway config and it doesn't restart cleanly. You don't find out for hours, and reverting is painful. Deck keeps versioned backups — FILE snapshots and GIT commits — each with Preview, Diff, and Restore. One click, gateway restarts automatically.

![Config editor with backups](docs/images/config-editor-backups.png)

![Config diff view](docs/images/config-editor-diff.png)

### Visibility Into What Agents Actually Do

Your agent says "I'm on it" but nothing happens. Deck shows every LLM call, tool invocation, file read, web search, and API call in real time — with exact token counts, cost per call, cache hit rates, and the full prompt and response inline. Extended thinking is visible too. You can see exactly what the agent was reasoning about, step by step.

![Logs live stream](docs/images/logs-live-stream.png)

Expand any LLM response to see the full reply, thinking blocks, subscription vs API cost equivalents, and a direct link to replay the full session.

![Logs with expanded thinking](docs/images/logs-expanded-thinking.png)

Tool calls show arguments, results, and duration. Multi-agent sessions show all agents interleaved in one stream — Jane delegating to Scout, Scout responding, both visible in context.

![Logs multi-agent](docs/images/logs-multi-agent.png)

### Session Replay & Analysis

Your agent finishes a task. Was it efficient? Deck shows cost, token counts, tool calls, loop depth, and anomaly flags — with comparisons against your historical baseline. Step through every prompt, response, and extended thinking block. See the exact model used at each step, gaps in activity, and where it went wrong.

![Sessions calendar](docs/images/sessions-calendar.png)

![Session replay](docs/images/session-replay.png)

Every session gets a full analysis report — graded A through F across Research Depth, Task Completion, Tool Efficiency, Error Recovery, and Cost Efficiency. Red flags surface automatically: deep tool loops, cost spikes, stuck behavior. The Detail tab shows every artifact produced, every web search made, every file touched.

![Session analysis report](docs/images/analysis-report.png)

![Session detail — artifacts and sources](docs/images/analysis-detail.png)

### Silence & Stuck Detection

Your agent goes quiet. Is it thinking or is it dead? Deck alerts you in Discord when an agent hasn't produced output in a configurable window — with a direct link to View Agents, View Logs, or View Sessions. No more guessing.

![Agent silent alert on Discord](docs/images/discord-agent-silent.png)

### Full Context Inspection

Your agent forgets something it should know. Deck tracks context window utilization in real time — alerting you when an agent is approaching its limit (83.3%, ~119 turns left) before quality degrades. See active drift events, recent activity, and what each agent knows at a glance.

![Context pressure alert and activity feed](docs/images/overview-context-pressure.png)

### Multi-Agent Overview

Running multiple agents? Deck shows all of them — status, active sessions, channels, models, costs — in one dashboard. Per-agent budget bars with Pause and Override buttons. System health sidebar with memory, CPU, disk, and service status. Spot problems across your entire fleet at a glance.

![Overview — fleet status](docs/images/overview-fleet.png)

---

## How Deck Compares

| | Deck | Langfuse | LangSmith | Helicone |
|---|---|---|---|---|
| Self-hosted | ✅ | ✅ | Enterprise | ✅ |
| Open source | ✅ | ✅ | ❌ | ✅ |
| Budget enforcement + kill switch | ✅ | ❌ | ❌ | ❌ |
| Auto-pause runaway agents | ✅ | ❌ | ❌ | ❌ |
| Discord ops (pause, restart, revert from phone) | ✅ | ❌ | ❌ | ❌ |
| Model drift detection | ✅ | ❌ | ❌ | ❌ |
| Config management + one-click revert | ✅ | ❌ | ❌ | ❌ |
| Session replay with extended thinking | ✅ | ❌ | ❌ | ❌ |
| Agent silence alerts | ✅ | ❌ | ❌ | ❌ |
| Infrastructure | SQLite | ClickHouse + Redis | Cloud | Proxy |
| Multi-framework support | OpenClaw only | ✅ | LangChain | ✅ |
| Prompt versioning / evals | ❌ | ✅ | ✅ | ❌ |

Deck doesn't try to be a general-purpose LLM observability platform. It does one thing — OpenClaw agent operations — and does it deeply. If you need multi-framework tracing or prompt eval pipelines, Langfuse is excellent. If you need budget enforcement and Discord ops at 2am, that's Deck.

---

## Quick Start

```bash
git clone https://github.com/hkochar/openclaw-deck.git
cd openclaw-deck
pnpm install
pnpm dev    # http://localhost:3000
```

**Prerequisites:**
- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- Node.js 18+
- pnpm

Config files are created automatically on first run. Open the dashboard and follow the welcome card to connect your gateway.

**New to Deck?** Read the [Getting Started guide](docs/GETTING-STARTED.md) for a walkthrough of every page and what to do first.

### Install the Gateway Plugin

The plugin hooks into your OpenClaw gateway to collect LLM calls, costs, and events:

```bash
cd plugin
npm install --omit=dev
openclaw plugins install --link ./plugin
```

Restart your gateway. Data starts flowing immediately — no SDK changes, no environment variables, no proxy latency.

---

## Dashboard

| Tab | What it does |
|-----|-------------|
| **Overview** | Agent status grid, KPI cards, active alerts |
| **Costs** | Per-agent spending, budget enforcement, timeline charts |
| **Schedule** | Cron jobs, model config, heartbeat calendar |
| **Logs** | Real-time event stream — every LLM call, tool, message |
| **Sessions** | Session list, activity timeline, step-by-step replay |
| **Analysis** | AI-powered session quality scoring |
| **Knowledge** | Agent memory files and docs browser |
| **Search** | Full-text search across all data |
| **Services** | Service management, reliability metrics, model tester |
| **OpenClaw Config** | Gateway config editor with backup/restore |
| **Deck Config** | Budgets, agents, Discord channels, providers |

---

## Configuration

| File | Purpose |
|------|---------|
| `config/deck-agents.json` | Agent registry (name, emoji, channels) |
| `config/deck-config.json` | Service URLs, budgets, provider keys |
| `.env.local` | Gateway URL, DB paths |

| Variable | Required | Default |
|----------|----------|---------|
| `OPENCLAW_GATEWAY_URL` | No | `http://127.0.0.1:5310` |
| `OPENCLAW_GATEWAY_TOKEN` | Yes | — |
| `DECK_USAGE_DB` | No | `~/.openclaw-deck/data/usage.db` |

---

## Architecture

```
openclaw-deck/
├── app/        # Next.js 14 dashboard (port 3000)
├── plugin/     # OpenClaw gateway plugin → SQLite
├── config/     # Agent registry, service URLs, budgets
└── e2e/        # End-to-end tests
```

SQLite-backed. One file. No ClickHouse, no Redis, no S3. Back it up with `cp`.

---

## Development

```bash
pnpm dev          # Dev server
pnpm build        # Production build
pnpm lint         # ESLint
pnpm typecheck    # TypeScript
pnpm test         # Unit tests
pnpm e2e          # End-to-end tests
```

---

## License

MIT — see [LICENSE](LICENSE)

## Code of Conduct

[Contributor Covenant v2.1](CODE_OF_CONDUCT.md)
