# Changelog

Deck uses [Semantic Versioning](https://semver.org/) (semver).

- **Major** (`1.0.0 → 2.0.0`) — Breaking changes: database schema changes that require migration, removed API endpoints, renamed config keys
- **Minor** (`0.1.0 → 0.2.0`) — New features, new API endpoints, new config options (backwards-compatible)
- **Patch** (`0.1.0 → 0.1.1`) — Bug fixes, documentation updates, dependency bumps

Pre-1.0 releases (`0.x.y`) may include breaking changes in minor versions. After 1.0, the semver contract is strict.

Database migrations are always automatic (the plugin and backfill script handle schema changes on startup). A major version bump means you should read the release notes before upgrading, not that you need to run manual migrations.

---

## 0.1.0 — Initial Open Source Release

### Features

- **Dashboard** — 11-page Next.js dashboard: Overview, Costs, Schedule, Logs, Knowledge, Sessions, Analysis, Search, Services, OpenClaw Config, Deck Config
- **Cost tracking** — Per-agent daily/weekly/monthly cost cards with sparkline charts, stacked timeline, and model/tool/provider breakdowns
- **Budget enforcement** — Configurable daily limits per agent with alert thresholds, auto-pause, model throttling (downgrade chain), and budget overrides
- **Session replay** — Browse all agent sessions with token usage, transcript data, and step-by-step replay
- **Activity timeline** — Calendar-style view of agent activity across days
- **Model management** — View configured models per agent, detect drift, swap models live
- **Service management** — Start/stop/restart services via macOS LaunchAgents, provider health monitoring, built-in model tester
- **Event log** — Every LLM call, tool invocation, and message — filterable by agent, type, model, session, and time range
- **Knowledge browser** — Browse agent memory files with git history and diff viewer
- **Full-text search** — Search across all events, sessions, and agent data
- **Configuration UI** — Structured form editors for all settings with git-backed history and restore
- **Session guardrails** — Alerts for long-running sessions, excessive tool calls, context window overflow, and expensive single LLM steps
- **Provider rate limits** — Configurable per-provider rate windows with weighted model pools
- **Cost reconciliation** — Automatic backfill of real costs from OpenRouter, Anthropic, and OpenAI admin APIs

### Optional Components

- **Gateway plugin** — Hooks into OpenClaw gateway to collect LLM events into SQLite
- **Ops bot** — Discord bot for operational commands (`!status`, `!doctor`, `!restart-all`)
- **Sentinel** — Automated health monitoring with configurable check intervals and Discord alerts

### Platform Support

- macOS: Full support including LaunchAgent service management
- Linux: All features except service start/stop (uses macOS LaunchAgents) and system log viewer (uses macOS unified log)
