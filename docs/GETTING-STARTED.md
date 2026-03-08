# Getting Started with Deck

You've installed Deck, the dashboard loads, and data is flowing. Now what?

This guide walks you through each page — what it shows, what to look for, and what actions you can take. Read it once, then use the dashboard table in the README as a quick reference.

---

## 1. Overview (home page)

**What it shows:** A single-screen summary of your entire agent fleet.

- **KPI cards** at the top: active agents, today's cost, gateway uptime, alert count
- **Agent status grid**: each agent's current state (running, idle, paused), model, and daily cost
- **System health sidebar**: CPU, memory, disk, service status, channel connections
- **Active alerts**: model drift, cron failures, budget warnings, context pressure
- **Activity feed**: recent events across all agents

**What to do first:** Check that your agents appear in the status grid and the gateway indicator (top-right) shows "Connected". If you see a welcome card instead, follow its setup steps.

**Key actions:**
- Click any agent name to jump to their filtered Logs
- Click an alert to go directly to the relevant page

---

## 2. Costs

**What it shows:** Where your money goes.

- **Agent cost cards**: per-agent daily/weekly/monthly spend with budget gauges
- **Cost timeline**: spending over time as a chart
- **Provider spend**: breakdown by provider (Anthropic, OpenRouter, etc.) with rate limit usage
- **Model breakdown**: cost per model within each agent

**What to look for:**
- Any agent significantly over budget (red gauge)
- The "Actual" vs "API Equiv" toggle — if you're on Anthropic's subscription, Actual shows $0 but API Equiv shows what it *would* cost at pay-per-token rates
- Use the time range pills (Today, 7d, MTD, etc.) to zoom in or out

**Key actions:**
- Click any agent card to jump to their cost-filtered Logs
- Click a model row to see those specific LLM calls in Logs

---

## 3. Logs

**What it shows:** Every LLM call, tool invocation, and message — in real time.

This is your debugging Swiss Army knife. Each row is one event: an LLM response, a tool call, a user message, or a system event.

- **Event stream**: newest first, auto-refreshes
- **Filters**: by agent, type (LLM Response, Tool Call, etc.), billing (API/Sub), time range
- **Expanded view**: click any event to see full details — token counts, cost, model, prompt text, response, extended thinking

**What to look for:**
- High-cost events (sort by cost to surface expensive calls)
- Tool loops (many consecutive tool calls by the same agent)
- The "sub" label on events means subscription billing — actual cost is $0

**Key actions:**
- Click "Show surrounding context" on any event to see what happened around it
- Click "Replay full session" to jump to the Session Replay view
- Use sub-type filters (e.g., LLM Input > Compaction) to find specific patterns
- Expand All / Collapse All to scan multiple events quickly

---

## 4. Sessions

**What it shows:** All agent sessions — active and archived.

- **Session list**: agent, channel, model, context utilization %, token count, last active time
- **Activity calendar**: a day/week/month view showing when each agent worked and what it cost

**What to look for:**
- Context % column — sessions above 80% are approaching the context window limit
- Sessions with high token counts relative to their output (potential inefficiency)

**Key actions:**
- Click "Logs" on any session to see its full event stream
- Click the play button to open Session Replay
- Click "Analysis" to see quality scores
- Switch to the Activity tab for the calendar view

---

## 5. Session Replay

**What it shows:** A step-by-step walkthrough of a single session.

Every prompt, response, tool call, and thinking block — in order. Like a video replay but for agent work.

- **Timeline**: visual progress bar with step icons
- **Anomaly badges**: cost spikes, errors, slow tools (>5s), warnings
- **Cost progress**: running cost total as you step through
- **Extended thinking**: expandable blocks showing the agent's reasoning

**What to do:** Pick any session from the Sessions page and hit play. Step through it to understand what the agent did and where it got stuck.

---

## 6. Analysis

**What it shows:** Automated quality scoring for completed sessions.

Each session gets graded A-F across five dimensions:
- **Research Depth**: how thoroughly did it search and gather sources?
- **Task Completion**: did it finish what was asked?
- **Tool Efficiency**: ratio of successful tool calls to total
- **Error Recovery**: how well did it handle failures?
- **Cost Efficiency**: cost relative to output produced

The Detail tab shows artifacts produced, web searches made, and files touched. The Report tab shows research methodology — queries, sources, domain diversity.

**What to look for:**
- Sessions graded D or F — these need investigation
- High "Tool Efficiency" failures — often indicate a tool loop or misconfigured tool
- The baseline comparison (appears after 10+ sessions) shows if this session is normal or anomalous

---

## 7. Schedule

**What it shows:** Cron jobs, model configuration, and heartbeat history.

- **Cron schedule**: which jobs run when, success/failure status, consecutive error counts
- **Model config**: what model each agent is configured to use vs. what it's actually using

**What to look for:**
- Cron jobs with consecutive failures (orange/red badges)
- Model drift — where the configured model differs from the actual model being used

---

## 8. Knowledge

**What it shows:** Agent memory files and documentation.

Browse what your agents "know" — their memory files, daily notes, and any docs they reference. Useful for understanding why an agent made a decision.

---

## 9. Services

**What it shows:** All running services and their health.

- **Service list**: Deck, Gateway, Sentinel, Ops Bot — with PID, port, status
- **Reliability tab**: provider success rates, error rates, average latency
- **Context % tab**: real-time context window utilization per active session

**Key actions:**
- Stop/Restart any service directly from the UI
- Check the Model Tester to verify a model is responding correctly

---

## 10. Deck Config

**What it shows:** Your Deck configuration — budgets, agents, Discord, providers, sentinel rules.

This is where you set up:
- **Budgets**: daily/weekly/monthly caps per agent, session cost caps, enforcement actions (alert/throttle/block)
- **Agents**: names, emojis, Discord channels, roles
- **Sentinel**: health check thresholds (silence detection, event freshness, system resources)
- **Dashboard**: which tabs to show/hide, test mode toggle

**First thing to configure:** Set a daily budget for your most active agent. Start with "Alert Only" action so you get notifications without blocking.

---

## Recommended first-day workflow

1. **Overview** — confirm agents are connected, gateway is healthy
2. **Logs** — watch the live stream for a few minutes, expand some events, get a feel for the data
3. **Costs** — check today's spend, click into an agent to see the model breakdown
4. **Sessions** — find a recent completed session, click Replay, step through it
5. **Deck Config > Budgets** — set a daily cap for your main agent (start with Alert Only)
6. **Deck Config > Agents** — give your agents friendly names and assign Discord channels (if using Discord)

After that, Deck runs itself. You'll get Discord alerts when something needs attention, and the Overview page is your daily check-in.

---

## Quick links

| I want to... | Go to... |
|--------------|----------|
| See what my agents are doing right now | Overview |
| Find out why my bill spiked | Costs > click agent > Logs |
| Debug a specific agent run | Sessions > click Replay |
| Set up budget alerts | Deck Config > Budgets |
| Check if services are healthy | Services |
| Read what an agent was thinking | Logs > expand LLM Response > Thinking |
| See if a model was silently swapped | Schedule (model drift section) |
| Browse agent memory | Knowledge |
