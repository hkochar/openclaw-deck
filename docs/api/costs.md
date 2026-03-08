# Costs & Budget

## GET /api/agent-costs

Agent cost summary based on token usage.

```bash
curl http://localhost:3000/api/agent-costs
```

**Response:**
```typescript
{
  ok: boolean
  usage: {
    agentId: string
    agentName: string
    model: string
    cronCount: number
    estimatedCost: number
    lastActive: string | null
  }[]
}
```

---

## GET /api/agent-costs/timeline

Cost breakdown over time for an agent.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent` | string | — | Filter by agent |
| `days` | number | 7 | Number of days to include |

```bash
# All agents, last 7 days
curl http://localhost:3000/api/agent-costs/timeline

# Specific agent, last 30 days
curl 'http://localhost:3000/api/agent-costs/timeline?agent=forge&days=30'
```

**Response:** Array of daily/hourly cost data points.

---

## GET /api/provider-costs

Provider-level cost data (OpenRouter, Anthropic, OpenAI).

```bash
curl http://localhost:3000/api/provider-costs
```

**Response:** Provider-specific cost structure with daily breakdowns.

---

## GET /api/budget-override

Get current budget overrides for agents.

```bash
curl http://localhost:3000/api/budget-override
```

**Response:** Budget override data per agent.

## POST /api/budget-override

Set an emergency budget override for an agent.

```bash
curl -X POST http://localhost:3000/api/budget-override \
  -H 'Content-Type: application/json' \
  -d '{"agent":"forge","limit":10,"duration":"daily"}'
```

**Body:** Override configuration (agent, limit, duration).

**Response:** `{ ok: boolean }`

## DELETE /api/budget-override

Remove a budget override.

```bash
curl -X DELETE http://localhost:3000/api/budget-override \
  -H 'Content-Type: application/json' \
  -d '{"agentKey":"forge"}'
```

**Body:** `{ agentKey: string }`

**Response:** `{ ok: boolean }`
