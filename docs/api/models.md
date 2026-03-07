# Models

## GET /api/models-list

List all available models from config.

```bash
curl http://localhost:3000/api/models-list
```

**Response:**
```typescript
{
  ok: boolean
  models: {
    id: string          // "provider/modelId"
    name: string        // Human-readable name
    provider: string
  }[]
}
```

---

## GET /api/agent-models

Get configured models per agent with actual running model from heartbeat.

```bash
curl http://localhost:3000/api/agent-models
```

**Response:**
```typescript
{
  ok: boolean
  models: Record<string, {
    primary: string
    fallbacks: string[]
    sessionModel: string
    actualModel: string
  }>
}
```

---

## POST /api/model-swap

Test or swap an agent's model.

```bash
# Smoke test a model
curl -X POST http://localhost:3000/api/model-swap \
  -H 'Content-Type: application/json' \
  -d '{"action":"test","model":"claude-sonnet-4-20250514","agentId":"forge"}'

# Override model for current session only
curl -X POST http://localhost:3000/api/model-swap \
  -H 'Content-Type: application/json' \
  -d '{"action":"session","model":"claude-haiku-3-5-20241022","agentId":"forge"}'

# Full swap with fallbacks
curl -X POST http://localhost:3000/api/model-swap \
  -H 'Content-Type: application/json' \
  -d '{"action":"swap","model":"claude-sonnet-4-20250514","agentId":"forge","fallbacks":["claude-haiku-3-5-20241022"]}'
```

**Body:**
```typescript
{
  action: "test" | "session" | "swap"
  model: string
  agentId: string
  fallbacks?: string[]  // For "swap" action
}
```

- `"test"` — Smoke test: calls provider API to verify model works
- `"session"` — Override model for current session only (no restart)
- `"swap"` — Full swap: smoke test, patch config, restart gateway, resolve drift

**Response:**
```typescript
{
  ok: boolean
  stage: string          // Which phase failed (if error)
  error?: string
  response?: string
  durationMs: number
  usage?: { promptTokens: number, completionTokens: number, totalTokens: number }
}
```
