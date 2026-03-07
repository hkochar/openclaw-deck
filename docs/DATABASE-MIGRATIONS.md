# Deck — Database Migrations

How Deck manages SQLite schema changes across versions.

## Approach

Deck uses an **implicit, idempotent migration system** — not a formal version-numbered framework. Schema changes are applied automatically on every plugin startup via `CREATE TABLE IF NOT EXISTS` and `PRAGMA table_info()` checks.

This means:
- No manual migration steps when upgrading
- No migration files to maintain
- Safe to interrupt and restart at any point
- Fresh installs get the full schema in one step

## How It Works

### On Plugin Startup

When the gateway plugin starts, `getDb()` runs this sequence:

```
1. CREATE TABLE IF NOT EXISTS (all 16 tables)
2. PRAGMA table_info() checks for missing columns
3. Conditional ALTER TABLE ADD COLUMN for each missing column
4. Complex schema rewrites (rename → recreate → copy → drop)
5. One-time backfills tracked via backfill_meta
```

Every step is idempotent — running it twice produces the same result.

### Migration Patterns

**Pattern 1: Column Addition**

Used when adding new columns to existing tables. Safe and non-destructive.

```sql
-- Check if column exists
PRAGMA table_info(events);

-- Add if missing
ALTER TABLE events ADD COLUMN prompt TEXT;
ALTER TABLE events ADD COLUMN response TEXT;
ALTER TABLE events ADD COLUMN thinking TEXT;
```

The plugin checks `PRAGMA table_info()` results and only runs `ALTER TABLE` for columns that don't exist yet.

**Pattern 2: Table Restructure**

Used when a table's constraints or structure need to change (e.g., removing a UNIQUE constraint).

```sql
-- 1. Rename old table
ALTER TABLE session_analysis RENAME TO session_analysis_old;

-- 2. Create new table with updated schema
CREATE TABLE session_analysis (...);

-- 3. Copy data
INSERT INTO session_analysis (...) SELECT ... FROM session_analysis_old;

-- 4. Drop old table
DROP TABLE session_analysis_old;

-- 5. Recreate indexes
CREATE INDEX IF NOT EXISTS ...;
```

Detection: checks `sqlite_master` for the old schema signature, then verifies the presence of new columns.

**Pattern 3: One-Time Backfills**

Used for data transformations that should run exactly once.

```sql
-- Track completion in backfill_meta
INSERT OR REPLACE INTO backfill_meta (key, value, ts)
VALUES ('targeted_msg_in', '25 sessions', 1709654321000);
```

Before running, the plugin checks if the key exists in `backfill_meta`. If present, the backfill is skipped.

## backfill_meta Table

Tracks completion of one-time data operations:

```sql
CREATE TABLE backfill_meta (
  key   TEXT PRIMARY KEY,  -- Operation identifier
  value TEXT,              -- Completion summary
  ts    INTEGER NOT NULL   -- Unix timestamp (ms)
);
```

New operations add their own key. Checking is a simple `SELECT` before running.

## Schema Versions (Historical)

| Version | Changes | Detection |
|---------|---------|-----------|
| v1 | Base schema (events, sessions, heartbeats, etc.) | `CREATE TABLE IF NOT EXISTS` |
| v2 | Added `prompt`, `response`, `thinking`, `resolved_model`, `provider_cost`, `billing` to events | `PRAGMA table_info` check |
| v3 | Added `tool_name`, `tool_query`, `tool_target` to events + indexes | `PRAGMA table_info` check |
| v4 | `session_analysis` table with UNIQUE constraint | `CREATE TABLE IF NOT EXISTS` |
| v4.1 | Removed UNIQUE constraint from `session_analysis`, added `guidelines` column | `sqlite_master` schema check |

## Backfill Script

The standalone backfill script (`scripts/backfill-all.ts`) creates the same schema as the plugin. It's used for importing historical data from JSONL transcripts.

```bash
pnpm backfill              # Full 10-step pipeline
pnpm backfill:dry          # Preview (no writes)
pnpm backfill --step 3     # Run a single step
pnpm backfill --from 4     # Run steps 4-10
```

The backfill script and plugin share the same schema — running either first is safe.

## Upgrading Deck

1. `git pull` the latest code
2. `pnpm install` to update dependencies
3. `pnpm build` to rebuild
4. Restart the gateway (plugin applies migrations on startup)

No manual database steps required. The plugin detects the current schema state and applies any missing changes.

## Backup

Before major upgrades, back up the SQLite database:

```bash
cp ~/.openclaw-deck/data/usage.db ~/.openclaw-deck/data/usage.db.bak
```

SQLite databases are single files — a file copy while the gateway is stopped is a complete backup.

**While the gateway is running**, use SQLite's backup API or the `.backup` command to get a consistent snapshot:

```bash
sqlite3 ~/.openclaw-deck/data/usage.db ".backup /tmp/usage-backup.db"
```

## Limitations

- **No version number** — The schema version is implicit (detected from table/column presence), not stored explicitly
- **No rollback** — Migrations are forward-only. Restore from backup if needed
- **No audit trail** — Migration history isn't recorded (only `backfill_meta` tracks one-time operations)
- **No downgrade path** — Older plugin versions may not understand newer columns (but won't break — SQLite ignores unknown columns in `SELECT *`)

## Database Location

| Database | Default Path | Override |
|----------|-------------|---------|
| Usage DB | `~/.openclaw-deck/data/usage.db` | `DECK_USAGE_DB` env var |
| System DB | `./data/deck-system.db` | `DECK_SYSTEM_LOG_DB` env var |

## Full Table List

| Table | Purpose |
|-------|---------|
| `events` | LLM calls, tool invocations, messages (22 columns) |
| `sessions` | Conversation tracking (22 columns) |
| `heartbeats` | Agent health status |
| `drift_events` | Model configuration mismatches |
| `agent_activities` | Activity feed |
| `deliverables` | Grouped tool outputs |
| `session_analysis` | LLM-generated session summaries |
| `session_feedback` | User ratings and notes |
| `backfill_meta` | Migration/backfill tracking |
| `search_idx` | FTS5 full-text search index |
| `search_idx_content` | FTS5 content table |
| `search_idx_data` | FTS5 data table |
| `search_idx_docsize` | FTS5 docsize table |
| `search_idx_idx` | FTS5 index table |
| `search_idx_config` | FTS5 config table |
| `search_sync_state` | FTS5 sync cursor per source |
