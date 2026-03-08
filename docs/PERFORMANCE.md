# Deck — Performance Guide

SQLite tuning, indexing, data retention, and scaling characteristics.

## SQLite Configuration

The plugin configures SQLite for concurrent read/write performance on startup:

| Pragma | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | `WAL` | Write-Ahead Logging — concurrent reads during writes |
| `synchronous` | `NORMAL` | Balanced durability vs write speed |
| `busy_timeout` | `5000` | 5-second retry on database lock |

**WAL mode** is critical — it allows the dashboard API to read while the plugin writes events, without blocking either side.

## Connection Model

- **Plugin:** Single shared `better-sqlite3` connection (lazy-initialized, cached)
- **API routes:** Fresh read-only connections per request (`new Database(path, { readonly: true })`)
- **Concurrency:** WAL mode supports N concurrent readers + 1 writer

Read-only API connections prevent lock contention with the plugin's writes.

## Indexes

### Events Table (highest volume)

| Index | Columns | Used By |
|-------|---------|---------|
| `idx_events_ts` | `ts` | Time-range queries, log viewer |
| `idx_events_agent_ts` | `agent, ts` | Per-agent filtering |
| `idx_events_run_id` | `run_id` | Linking llm_input ↔ llm_output |
| `idx_events_tool_name` | `tool_name` | Tool usage queries |
| `idx_events_tool_agent` | `tool_name, agent` | Per-agent tool breakdown |

### Sessions Table

| Index | Columns | Used By |
|-------|---------|---------|
| `idx_sessions_agent` | `agent` | Agent session list |
| `idx_sessions_status` | `status` | Active/archived filtering |
| `idx_sessions_updated` | `updated_at` | Recent sessions |
| `idx_sessions_source` | `source` | Agent vs cron classification |

### Other Tables

| Table | Index | Columns |
|-------|-------|---------|
| `session_analysis` | `idx_sa_session` | `session_key` |
| `session_analysis` | `idx_sa_agent` | `agent` |
| `session_analysis` | `idx_sa_guidelines` | `session_key, guidelines_hash` |
| `deliverables` | `idx_del_agent` | `agent` |
| `deliverables` | `idx_del_ts` | `last_ts` |
| `drift_events` | `idx_drift_agent` | `agent_key, timestamp` |
| `drift_events` | `idx_drift_resolved` | `resolved, timestamp` |

## Full-Text Search (FTS5)

The `search_idx` virtual table provides full-text search across events, sessions, docs, and config:

- **Tokenizer:** `porter unicode61` (English stemming + Unicode support)
- **Sync batch size:** 1,000 rows per cycle
- **Sync interval:** Incremental via high-water marks in `search_sync_state`
- **FS scan TTL:** 5 minutes (caches markdown doc filesystem walks)

Sources indexed: events (tool calls, LLM I/O), sessions, session analysis, deliverables, agent activities, heartbeats, config files, markdown documentation.

## Data Retention

Automatic pruning runs on every gateway startup:

| Data | Retention | Action |
|------|-----------|--------|
| Events | 30 days | Deleted |
| Archived sessions | 90 days | Deleted |
| Active sessions | Indefinite | Kept |
| Heartbeats | Indefinite | 1 per agent (upserted) |
| Drift events | Indefinite | Kept (low volume) |

No manual cleanup is needed. The retention periods are hardcoded in the plugin.

## Pagination

API routes use LIMIT/OFFSET pagination:

| Endpoint | Default Limit | Max |
|----------|--------------|-----|
| `/api/deliverables` | 50 | 200 |
| `/api/logs` | 5,000 | — |
| `/api/logs/session-analysis` | 50 | — |
| `/api/outcomes` | Caller-specified | — |

Results are ordered by `ts DESC, id DESC` (newest first) for log-style queries, or `ts ASC` for session transcript replay.

## Polling Intervals

| Component | Interval | Purpose |
|-----------|----------|---------|
| Session JSONL poller | 15 seconds | Import new transcript data |
| Session source reclassification | 5 minutes | Re-categorize sources |
| Agent silence check | 5 minutes | Detect stalled agents |
| Pricing history learning | 24 hours | Learn costs from history |
| Provider key/usage refresh | 1 minute | Sync provider API data |
| OpenRouter cost reconciliation | 1 hour | Fetch actual costs |
| Anthropic cost reconciliation | 1 hour | Fetch actual costs |

Dashboard frontend polling (configured in the UI):
- Event stream: polls `/api/usage` with `since` cursor
- Session list: polls `/api/agent-sessions`
- Agent status: polls `/api/agents`

## Latency Profile

**Write path:**
- Event insertion: O(1) prepared statement
- Session upsert: O(log N) on unique `session_key` index
- Backfill batches: ~1,000 rows per transaction

**Read path:**
- Recent logs (indexed time range): ~5-50ms
- Per-agent cost aggregation: ~10-100ms depending on date range
- FTS5 search: O(log N) inverted index lookup

**Concurrency:**
- WAL mode: N readers + 1 writer, no blocking
- Busy timeout: 5 seconds handles occasional contention
- Read-only API connections avoid write locks entirely

## Scaling Characteristics

Deck is designed for **single-operator, self-hosted** use. Typical scale:

| Metric | Typical Range |
|--------|--------------|
| Agents | 1-20 |
| Events per day | 1,000-20,000 |
| Sessions | 100s-1,000s per agent |
| Database size | 50-500 MB |
| FTS5 index size | 10-100 MB |

### When Performance Matters

**High event volume (20k+/day):** The 30-day retention window keeps the events table manageable. Indexes on `(agent, ts)` ensure queries stay fast regardless of total row count.

**Large transcript backfills:** The backfill script processes transcripts in batches. For very large imports (100k+ events), use `--from` to run individual steps if memory is a concern.

**Many concurrent dashboard users:** Each API request opens a read-only SQLite connection. WAL mode handles concurrent reads well, but dozens of simultaneous users on a slow disk may notice latency.

## Database Size Management

Check current size:

```bash
ls -lh ~/.openclaw-deck/data/usage.db
```

If the database grows unexpectedly:

1. **Check retention** — Events older than 30 days should be auto-pruned on restart
2. **VACUUM** — Reclaim space after large deletes:
   ```bash
   sqlite3 ~/.openclaw-deck/data/usage.db "VACUUM;"
   ```
3. **WAL checkpoint** — Force WAL file merge:
   ```bash
   sqlite3 ~/.openclaw-deck/data/usage.db "PRAGMA wal_checkpoint(TRUNCATE);"
   ```

The WAL file (`usage.db-wal`) can grow temporarily during heavy writes. It's automatically checkpointed, but a manual checkpoint reclaims disk space immediately.

## Configuration Knobs

| Setting | Location | Effect |
|---------|----------|--------|
| `DECK_USAGE_DB` | `.env` | Custom database path (e.g., faster SSD) |
| Session poller interval | Plugin code | Frequency of transcript imports |
| Dashboard refresh rate | UI preferences | Frontend polling frequency |
| FTS5 batch size | `search-index.ts` | Rows per search index sync cycle |
