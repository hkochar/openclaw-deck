# Deck API Reference

## Overview

All API routes are served by the Next.js app at `http://localhost:3000/api/`.

### Authentication

Some endpoints proxy requests to the OpenClaw gateway and require a bearer token:

```
Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>
```

Set `OPENCLAW_GATEWAY_TOKEN` in your `.env` file. Read-only dashboard endpoints (e.g., `/api/services`, `/api/models-list`) do not require authentication.

### Response Format

All endpoints return JSON. Success responses include `ok: true`:

```json
{ "ok": true, "data": ... }
```

Error responses include `ok: false` and an error message:

```json
{ "ok": false, "error": "Description of what went wrong" }
```

### Response Headers

| Header | Value | Meaning |
|--------|-------|---------|
| `X-Source` | `sqlite-fallback` | Gateway was unavailable; data served directly from SQLite |

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Invalid request (missing params, bad JSON) |
| 404 | Resource not found |
| 500 | Server error |
| 502 | Gateway unavailable |

## Endpoint Groups

| Group | Endpoints | Description |
|-------|-----------|-------------|
| [Events & Logs](events.md) | `/api/usage`, `/api/logs`, `/api/search` | Event stream, log queries, full-text search |
| [Sessions](sessions.md) | `/api/agent-sessions`, `/api/logs/session-*` | Session list, summaries, analysis, feedback |
| [Costs & Budget](costs.md) | `/api/agent-costs`, `/api/provider-costs`, `/api/budget-override` | Cost tracking, provider breakdown, budget overrides |
| [Agents & Health](agents.md) | `/api/agents`, `/api/heartbeat`, `/api/activities`, `/api/drift`, `/api/agent-pause` | Agent status, heartbeats, drift detection |
| [Models](models.md) | `/api/models-list`, `/api/agent-models`, `/api/model-swap` | Model listing, per-agent config, live swapping |
| [Cron Jobs](crons.md) | `/api/crons`, `/api/cron-manage`, `/api/cron-model`, `/api/cron-schedule` | Cron listing, management, model override |
| [Configuration](configuration.md) | `/api/config`, `/api/deck-config`, `/api/config-history`, `/api/git-file` | OpenClaw config, Deck config, git history |
| [Services](services.md) | `/api/services`, `/api/service-control`, `/api/gateway-*` | Service management, gateway health |
| [Content](content.md) | `/api/deliverables`, `/api/outcomes`, `/api/agent-docs` | Tool outputs, deliverables, agent docs |
| [System](system.md) | `/api/system-log`, `/api/test-run`, `/api/sentinel-config`, `/api/dashboard-prefs` | Audit log, test runner, sentinel, preferences |
