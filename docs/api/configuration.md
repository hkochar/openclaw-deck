# Configuration

## GET /api/config

Read OpenClaw config files.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `file` | string | `"openclaw.json"` | `"openclaw.json"`, `"cron/jobs.json"`, `"exec-approvals.json"`, `"update-check.json"` |

```bash
# Read main config
curl http://localhost:3000/api/config

# Read cron jobs config
curl 'http://localhost:3000/api/config?file=cron/jobs.json'
```

**Response:**
```typescript
{
  ok: boolean
  raw: string            // JSON content (secrets redacted)
  backups: {
    id: string
    label: string
    source: "file" | "git"
    timestamp: string
    timestampMs: number
  }[]
}
```

## POST /api/config

Save or restore config files.

```bash
# Save config
curl -X POST http://localhost:3000/api/config \
  -H 'Content-Type: application/json' \
  -d '{"action":"save","content":"{...}"}'

# Restore from backup
curl -X POST http://localhost:3000/api/config \
  -H 'Content-Type: application/json' \
  -d '{"action":"restore","backupId":"abc123","source":"git"}'
```

**Body:**
```typescript
{
  action: "save" | "preview" | "restore"
  content?: string        // For "save"
  backupId?: string       // For "restore"/"preview"
  source?: "file" | "git" // For "restore"
}
```

**Response:** `{ ok: boolean, content?: string }`

---

## GET /api/deck-config

Get full Deck dashboard configuration (agents, channels, budgets, pricing).

```bash
curl http://localhost:3000/api/deck-config
```

**Response:**
```typescript
{
  agents: { id: string, key: string, name: string, role: string, emoji: string }[]
  agentKeys: string[]
  agentLabels: Record<string, string>
  systemChannels: Record<string, string>
  pluginChannels: Record<string, string>
  serviceUrls: Record<string, string>
  budgets: object
  modelPricing: object
  throttleChain: string[]
  providerKeys: object
  providerLimits: object
  sessionGuardrails: object
}
```

## POST /api/deck-config

Save Deck configuration with validation.

```bash
curl -X POST http://localhost:3000/api/deck-config \
  -H 'Content-Type: application/json' \
  -d '{"agents":[{"id":"main","key":"forge","name":"Forge","emoji":"🔨","role":"Development"}]}'
```

**Body:**
```typescript
{
  agents: object[]
  systemChannels?: object
  pluginChannels?: object
  logChannels?: object
  serviceUrls?: object
}
```

**Response:**
```typescript
{
  ok: boolean
  errors?: string[]
  changes: string[]
  restarts: string[]     // Services needing restart
  immediate: string[]    // Changes effective immediately
}
```

---

## GET /api/deck-config/env

Check environment variables and git identity.

```bash
curl http://localhost:3000/api/deck-config/env
```

**Response:**
```typescript
{
  vars: {
    key: string
    category: string
    description: string
    required: boolean
    isSet: boolean
    preview: string       // Masked: first 4 + last 3 chars
  }[]
  git: {
    workspace: { name: string, email: string, isSet: boolean }
  }
}
```

---

## GET /api/deck-config/raw

Read raw config file content.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file` | string | `"config/deck-agents.json"`, `"config/deck-config.json"`, or `"sentinel/deck-sentinel.json"` |

```bash
curl 'http://localhost:3000/api/deck-config/raw?file=config/deck-agents.json'
```

**Response:** `{ ok: boolean, content: string }`

## POST /api/deck-config/raw

Write raw config file content (restore from backup).

```bash
curl -X POST http://localhost:3000/api/deck-config/raw \
  -H 'Content-Type: application/json' \
  -d '{"file":"config/deck-agents.json","content":"{...}"}'
```

**Body:** `{ file: string, content: string }`

**Response:** `{ ok: boolean }`

---

## GET /api/config-history

Last 20 git commits touching `openclaw.json`.

```bash
curl http://localhost:3000/api/config-history
```

**Response:**
```typescript
{
  ok: boolean
  entries: {
    sha: string
    date: string
    message: string
  }[]
}
```

---

## GET /api/git-file

Git file operations: log, show, diff.

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `"log"`, `"show"`, or `"diff"` |
| `file` | string | **required** — Relative file path |
| `repo` | string | `"deck"` or omit for workspace |
| `sha` | string | For `"show"` — commit SHA |
| `from`, `to` | string | For `"diff"` — SHA range |
| `limit` | number | For `"log"` — default 30 |

```bash
# Git log for a config file
curl 'http://localhost:3000/api/git-file?action=log&file=config/deck-config.json&repo=deck&limit=10'

# Show file at a specific commit
curl 'http://localhost:3000/api/git-file?action=show&file=config/deck-config.json&sha=abc1234'

# Diff between two commits
curl 'http://localhost:3000/api/git-file?action=diff&file=config/deck-config.json&from=abc1234&to=def5678'
```

**Response (log):** `{ ok: boolean, commits: { sha, date, message, short }[] }`

**Response (show):** `{ ok: boolean, content: string }`

**Response (diff):** `{ ok: boolean, lines: { type: "context"|"add"|"remove"|"hunk", content, lineNum }[] }`

## POST /api/git-file

Restore a file from git.

```bash
curl -X POST http://localhost:3000/api/git-file \
  -H 'Content-Type: application/json' \
  -d '{"file":"config/deck-config.json","content":"{...}","repo":"deck"}'
```

**Body:** `{ file: string, content: string, repo: string }`
