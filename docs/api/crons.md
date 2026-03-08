# Cron Jobs

## GET /api/crons

List all cron jobs with error tracking.

```bash
curl http://localhost:3000/api/crons
```

**Response:**
```typescript
{
  ok: boolean
  crons: {
    id: string
    name: string
    agentId: string
    enabled: boolean
    model: string | null
    schedule: string
    lastStatus: string | null
    lastError: string | null
    consecutiveErrors: number
  }[]
}
```

---

## GET /api/cron-schedule

Cron schedule with human-readable labels and next run times.

```bash
curl http://localhost:3000/api/cron-schedule
```

**Response:**
```typescript
{
  id: string
  name: string
  schedule: string       // Human-readable (e.g., "every 5 min")
  nextRun: string        // ISO timestamp
  lastRun: string | null
  enabled: boolean
}[]
```

---

## POST /api/cron-manage

Manage cron jobs.

```bash
# Toggle a cron job
curl -X POST http://localhost:3000/api/cron-manage \
  -H 'Content-Type: application/json' \
  -d '{"action":"toggle","jobId":"daily-report","enabled":false}'

# Create a new cron job
curl -X POST http://localhost:3000/api/cron-manage \
  -H 'Content-Type: application/json' \
  -d '{"action":"create","name":"hourly-check","agentId":"scout","schedule":"every 1h","model":"claude-haiku-3-5-20241022","message":"Check system status"}'
```

**Body:**
```typescript
{
  action: "toggle" | "update" | "create" | "restart-gateway"
  jobId?: string          // For toggle/update
  enabled?: boolean       // For toggle
  patch?: object          // For update
  // For create:
  name?: string
  agentId?: string
  schedule?: string       // "0 0 * * *" or "every 5m"
  model?: string
  message?: string
}
```

**Response:** `{ ok: boolean, job?: object, jobId?: string }`

---

## POST /api/cron-model

Update the cron-specific model for an agent.

```bash
curl -X POST http://localhost:3000/api/cron-model \
  -H 'Content-Type: application/json' \
  -d '{"agentKey":"scout","cronModel":"claude-haiku-3-5-20241022"}'
```

**Body:** `{ agentKey: string, cronModel: string }`

**Response:** `{ ok: boolean }`
