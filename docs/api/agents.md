# Agents & Health

## GET /api/agents

List all agents merged with heartbeat status.

```bash
curl http://localhost:3000/api/agents
```

**Response:**
```typescript
{
  ok: boolean
  agents: {
    id: string
    key: string
    name: string
    role: string
    emoji: string
    status: string
    computed_status: string
    model: string | null
    configured_model: string | null
    session_key: string | null
    bio: string | null
    last_heartbeat: number | null
    heartbeat_age_ms: number | null
    is_stale: boolean
    is_offline: boolean
  }[]
}
```

---

## POST /api/heartbeat

Update agent health status. Called by agents themselves.

```bash
curl -X POST http://localhost:3000/api/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"agentKey":"forge","status":"active","model":"claude-sonnet-4-20250514","configuredModel":"claude-sonnet-4-20250514","sessionKey":"forge-session-1","bio":"Working on feature branch"}'
```

**Body:**
```typescript
{
  agentKey: string
  status: string
  model: string
  configuredModel: string
  sessionKey: string
  bio: string
}
```

**Response:** `{ ok: boolean }`

---

## GET /api/activities

Recent agent activity feed.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max entries |

```bash
curl 'http://localhost:3000/api/activities?limit=20'
```

**Response:**
```typescript
{
  ok: boolean
  events: {
    agent_key: string
    agent_emoji: string
    timestamp: number
    type: string
    message: string
  }[]
}
```

---

## GET /api/drift

Get unresolved model drift alerts.

```bash
curl http://localhost:3000/api/drift
```

**Response:**
```typescript
{
  ok: boolean
  events: {
    agentKey: string
    configuredModel: string
    actualModel: string
    detectedAt: number
  }[]
}
```

## POST /api/drift/report

Report a model drift event.

```bash
curl -X POST http://localhost:3000/api/drift/report \
  -H 'Content-Type: application/json' \
  -d '{"agentKey":"forge","configuredModel":"claude-sonnet-4-20250514","actualModel":"claude-haiku-3-5-20241022"}'
```

**Body:** `{ agentKey: string, configuredModel: string, actualModel: string }`

**Response:** `{ ok: boolean }`

## POST /api/drift/resolve

Resolve a drift alert.

```bash
curl -X POST http://localhost:3000/api/drift/resolve \
  -H 'Content-Type: application/json' \
  -d '{"agentKey":"forge"}'
```

**Body:** `{ agentKey: string }`

**Response:** `{ ok: boolean }`

---

## GET /api/agent-pause

Get pause status for agents.

```bash
curl http://localhost:3000/api/agent-pause
```

## POST /api/agent-pause

Toggle agent pause state.

```bash
curl -X POST http://localhost:3000/api/agent-pause \
  -H 'Content-Type: application/json' \
  -d '{"agentKey":"forge","paused":true}'
```
