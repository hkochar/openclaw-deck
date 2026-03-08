# Services

## GET /api/services

List all `ai.openclaw.*` LaunchAgent services with running status.

```bash
curl http://localhost:3000/api/services
```

**Response:**
```typescript
{
  ok: boolean
  services: {
    label: string
    name: string
    comment: string
    running: boolean
    status: "running" | "stopped" | "scheduled"
    pid: number | null
    port: string | null
    version: string | null
    logPath: string | null
    keepAlive: boolean
  }[]
}
```

---

## GET /api/service-control

Tail service log files.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service` | string | **required** | Service label |
| `lines` | number | 50 | Lines to return (max 500) |

```bash
curl 'http://localhost:3000/api/service-control?service=ai.openclaw.deck&lines=100'
```

**Response:** `{ ok: boolean, logPath: string, lines: string }`

## POST /api/service-control

Control services.

```bash
# Restart a service
curl -X POST http://localhost:3000/api/service-control \
  -H 'Content-Type: application/json' \
  -d '{"action":"restart","service":"ai.openclaw.deck"}'

# Restart all services
curl -X POST http://localhost:3000/api/service-control \
  -H 'Content-Type: application/json' \
  -d '{"action":"restart-all"}'

# Run diagnostics
curl -X POST http://localhost:3000/api/service-control \
  -H 'Content-Type: application/json' \
  -d '{"action":"doctor"}'
```

**Body:**
```typescript
{
  action: "start" | "stop" | "restart" | "doctor" | "restart-all" | "apply-config-safely"
  service?: string           // For start/stop/restart
  includeGateway?: boolean   // For restart-all
  content?: string           // For apply-config-safely
  reason?: string            // For apply-config-safely
}
```

**Response:** `{ ok: boolean, output: string }`

---

## GET /api/gateway-health

Gateway health and memory status.

```bash
curl http://localhost:3000/api/gateway-health
```

**Response:**
```typescript
{
  ok: boolean
  status: number
  uptime: number           // Milliseconds
  droppedEvents: number
  activeLoops: number
  memoryMB: number
}
```

---

## GET /api/gateway-control

Gateway service status.

```bash
curl http://localhost:3000/api/gateway-control
```

## POST /api/gateway-control

Gateway actions.

```bash
curl -X POST http://localhost:3000/api/gateway-control \
  -H 'Content-Type: application/json' \
  -d '{"action":"restart"}'
```

**Body:** `{ action: "start" | "stop" | "restart" }`

**Response:** `{ ok: boolean, output: string }`
