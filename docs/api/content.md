# Content

## GET /api/deliverables

Tool-based deliverables (files written, commits, tests) grouped by session.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent` | string | — | Filter by agent |
| `offset` | number | 0 | Pagination offset |
| `limit` | number | 50 | Results per page (max 200) |

```bash
# All deliverables
curl http://localhost:3000/api/deliverables

# For a specific agent, page 2
curl 'http://localhost:3000/api/deliverables?agent=forge&offset=50&limit=50'
```

**Response:**
```typescript
{
  ok: boolean
  groups: {
    id: string
    agent: string
    session: string
    date: number
    main: { type: string, label: string, target: string | null }
    supporting: { type: string, label: string, target: string | null }[]
  }[]
  agents: string[]
  total: number
  hasMore: boolean
}
```

---

## GET /api/outcomes

Query tool call outcomes by type.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent` | string | — | Filter by agent |
| `type` | string | — | `"file_written"`, `"code_committed"`, `"test_run"`, `"command_run"`, `"message_sent"`, etc. |
| `since` | number | 7 days ago | Unix ms timestamp |
| `limit` | number | 200 | Max results (max 1000) |

```bash
# All file writes in the last 7 days
curl 'http://localhost:3000/api/outcomes?type=file_written'

# Commits by a specific agent
curl 'http://localhost:3000/api/outcomes?agent=forge&type=code_committed&limit=50'
```

**Response:**
```typescript
{
  ok: boolean
  outcomes: {
    id: number
    ts: number
    agent: string
    session: string
    outcomeType: string
    label: string
    target: string | null
  }[]
  total: number
  agents: string[]
}
```

---

## GET /api/agent-docs

Agent documentation and memory files.

```bash
curl http://localhost:3000/api/agent-docs
```

**Response:**
```typescript
{
  agentId: string
  agentName: string
  emoji: string
  docs: {
    name: string
    path: string
    content: string        // Secrets redacted
    modified: number
    folder: string
  }[]
  memory: { /* same shape */ }[]
}[]
```
