# Sessions

## GET /api/agent-sessions

List all sessions grouped by agent, including active and archived sessions.

```bash
curl http://localhost:3000/api/agent-sessions
```

**Response:**
```typescript
{
  ok: boolean
  agents: {
    key: string
    name: string
    emoji: string
    agentId: string
    sessionCount: number
    totalTokens: number
    lastActive: number | null
    sessions: {
      key: string
      fullKey: string
      sessionId: string
      displayName: string
      channel: string
      model: string
      totalTokens: number
      inputTokens: number
      outputTokens: number
      contextTokens: number
      updatedAt: number | null
      status: "active" | "deleted" | "compacted" | "reset"
      transcriptSizeKB: number
      hasTranscript: boolean
    }[]
    archived: {
      filename: string
      sessionId: string
      archiveType: "deleted" | "compacted" | "reset"
      archivedAt: string
      sizeKB: number
    }[]
  }[]
}
```

---

## GET /api/logs/session-summary

Compute an on-demand cost and performance summary for a session.

| Parameter | Type | Description |
|-----------|------|-------------|
| `session` | string | **required** — Session key |

```bash
curl 'http://localhost:3000/api/logs/session-summary?session=agent:main:discord:channel:123'
```

**Response:**
```typescript
{
  ok: boolean
  summary: {
    status: string
    durationMs: number
    tokensSummary: { input: number, output: number, cached: number }
    cost: number
  }
  comparison: {
    costPercentile: number
    agentAvgCost: number
    globalAvgCost: number
  }
}
```

---

## GET /api/logs/session-analysis

Get or auto-compute LLM-generated session analysis with quality scores.

| Parameter | Type | Description |
|-----------|------|-------------|
| `session` | string | **required** — Session key |

```bash
curl 'http://localhost:3000/api/logs/session-analysis?session=agent:main:discord:channel:123'
```

**Response:**
```typescript
{
  ok: boolean
  analyses: {
    id: number
    computedAt: number
    analysis: {
      agentType: string
      regions: object[]
      outcomes: object[]
      activitySummary: object
      qualityScores: object
      critique: object
      task: string | null
    }
  }[]
  runSummary: object
  feedback: {
    id: number
    rating: number | null
    outcomeQuality: string | null
    notes: string | null
    tags: string | null
    createdAt: number
  }[]
}
```

---

## POST /api/logs/session-analysis/feedback

Save user feedback for a session.

```bash
curl -X POST http://localhost:3000/api/logs/session-analysis/feedback \
  -H 'Content-Type: application/json' \
  -d '{"sessionKey":"agent:main:discord:channel:123","rating":4,"outcomeQuality":"good","notes":"Completed task efficiently","tags":"productive"}'
```

**Body:**
```typescript
{
  sessionKey: string
  rating: number          // 1-5
  outcomeQuality: string
  notes: string
  tags: string
}
```

**Response:** `{ ok: boolean }`
