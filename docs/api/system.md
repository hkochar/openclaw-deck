# System

## GET /api/system-log

System audit log (config changes, gateway actions, cron errors).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since` | number | — | Unix ms timestamp |
| `limit` | number | 200 | Max entries |
| `categories` | string | — | Comma-separated: `config`, `gateway`, `cron`, `model`, `services`, `testing` |

```bash
# Recent audit log
curl http://localhost:3000/api/system-log

# Filter by category
curl 'http://localhost:3000/api/system-log?categories=config,budget&limit=50'

# Events since a timestamp
curl 'http://localhost:3000/api/system-log?since=1709600000000'
```

**Response:**
```typescript
{
  ok: boolean
  events: {
    id: number
    ts: number
    category: string
    action: string
    summary: string
    detail: object | null
    status: "ok" | "error" | "warning" | "rollback"
  }[]
}
```

## POST /api/system-log

Write an audit log entry.

```bash
curl -X POST http://localhost:3000/api/system-log \
  -H 'Content-Type: application/json' \
  -d '{"category":"config","action":"update","summary":"Updated budget limits","status":"ok"}'
```

**Body:** `{ category: string, action: string, summary: string, detail?: object, status: "ok" | "error" }`

**Response:** `{ ok: boolean }`

---

## GET /api/test-run

Get cached test suite results.

| Parameter | Type | Description |
|-----------|------|-------------|
| `suite` | string | Suite name filter |

```bash
curl http://localhost:3000/api/test-run
```

**Response:**
```typescript
{
  ok: boolean
  suites: Record<string, {
    pass: number
    fail: number
    total: number
    ok: boolean
    output: string
    ranAt: string
  }>
}
```

## POST /api/test-run

Run a test suite.

```bash
curl -X POST http://localhost:3000/api/test-run \
  -H 'Content-Type: application/json' \
  -d '{"suite":"all"}'
```

**Body:** `{ suite: "all" | "cron-parser" | "integration:gateway" | ... }`

---

## GET /api/sentinel-config

Read sentinel health monitor configuration.

```bash
curl http://localhost:3000/api/sentinel-config
```

## POST /api/sentinel-config

Save sentinel configuration with validation.

```bash
curl -X POST http://localhost:3000/api/sentinel-config \
  -H 'Content-Type: application/json' \
  -d '{"checks":{"gateway_health":{"enabled":true},"cron_health":{"enabled":false}}}'
```

**Body:** Sentinel config object.

**Response:** `{ ok: boolean, errors?: string[] }`

---

## GET /api/dashboard-prefs

Get dashboard UI preferences (hidden tabs).

```bash
curl http://localhost:3000/api/dashboard-prefs
```

**Response:** `{ hiddenTabs: string[] }`

---

## POST /api/parse-provider-usage

Parse provider usage dashboard text using Claude.

```bash
curl -X POST http://localhost:3000/api/parse-provider-usage \
  -H 'Content-Type: application/json' \
  -d '{"text":"Usage: 45/50 messages remaining. Resets in 3h 22m.","provider":"anthropic"}'
```

**Body:** `{ text: string, provider?: string }`

**Response:**
```typescript
{
  ok: boolean
  parsed: {
    plan: "Max" | "Pro" | "Free" | "Team" | null
    windows: {
      id: "5h-rolling" | "daily" | "weekly" | "monthly"
      pct: number
      resetIn: string | null
    }[]
  }
}
```
