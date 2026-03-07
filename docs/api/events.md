# Events & Logs

## GET /api/usage

Query events from the usage database.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `endpoint` | string | `"stream"` | `"stream"`, `"summary"`, or `"poller-status"` |
| `since` | number | — | Unix ms timestamp — return events after this time |
| `limit` | number | 500 | Max results |
| `source` | string | — | Filter: `"agent"`, `"heartbeat"`, or `"cron"` |
| `session` | string | — | Filter by session key |

```bash
# Stream recent events
curl 'http://localhost:3000/api/usage?endpoint=stream&limit=10'

# Events since a timestamp
curl 'http://localhost:3000/api/usage?since=1709600000000&limit=50'

# Cost summary
curl 'http://localhost:3000/api/usage?endpoint=summary'

# Filter by agent source
curl 'http://localhost:3000/api/usage?source=agent&limit=20'
```

**Response** (stream):
```typescript
{
  id: number
  ts: number              // Unix ms
  agent: string
  session: string
  type: "llm_input" | "llm_output" | "tool_call" | "msg_in" | ...
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read: number | null
  cache_write: number | null
  cost: number | null
  detail: string | null   // JSON string
  run_id: string | null
  resolved_model: string | null
  provider_cost: number | null
  billing: "subscription" | "metered" | null
  has_thinking: 0 | 1
  has_prompt: 0 | 1
  has_response: 0 | 1
}[]
```

**Response** (summary): Aggregated cost and token totals by agent and time period.

**Response** (poller-status): Session JSONL poller health and cursor positions.

---

## GET /api/logs

Alias for `/api/usage` with the same parameters. Falls back to direct SQLite queries when the gateway is unavailable.

```bash
curl 'http://localhost:3000/api/logs?limit=20'
```

---

## GET /api/search

Full-text search across events and file content.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | **required** | Search query |
| `type` | string | — | Comma-separated types to filter |
| `agent` | string | — | Filter by agent |
| `from` | number | — | Unix ms start timestamp |
| `to` | number | — | Unix ms end timestamp |
| `limit` | number | — | Max results |

```bash
# Search for "error" in all events
curl 'http://localhost:3000/api/search?q=error&limit=20'

# Search within a specific agent
curl 'http://localhost:3000/api/search?q=database&agent=forge'

# Search with date range
curl 'http://localhost:3000/api/search?q=deploy&from=1709500000000&to=1709600000000'
```

**Response:**
```typescript
{
  ok: boolean
  results: {
    type: string
    id: string
    title: string
    snippet: string
    timestamp: number
    score: number
  }[]
  total: number
}
```

## POST /api/search

Rebuild the FTS5 search index.

```bash
curl -X POST http://localhost:3000/api/search
```

**Response:** `{ ok: boolean, message: string }`
