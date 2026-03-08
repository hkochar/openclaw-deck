import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import { ensureSearchIndex } from "../search-index";
import { getLogger } from "../logger";
import { loadBillingMap, getBillingMode } from "./billing";
import {
  type ToolEvent as DelToolEvent,
  type DeliverableGroup as DelGroup,
  buildDeliverableGroups,
  ruleToolNames,
} from "../../lib/deliverable-classifier";

// ── Constants ────────────────────────────────────────────────────────

export const DB_PATH = process.env.DECK_USAGE_DB || path.join(os.homedir(), ".openclaw-deck", "data", "usage.db");
export const RETENTION_DAYS = 30;
export const MAX_BACKUPS = 3;
export const DEMO_MARKER = path.join(os.homedir(), ".openclaw-deck", "data", ".demo");

// ── Module state ─────────────────────────────────────────────────────

let db: Database.Database | null = null;
let droppedEventCount = 0;
let demoMarkerCleaned = false;

/** Returns count of events that failed to write to SQLite (DB locked, corrupt, etc.) */
export function getDroppedEventCount(): number { return droppedEventCount; }

/** Increment dropped event count (called by event-logging when writes fail). */
export function incrementDroppedCount(): void { droppedEventCount++; }

/** Check and clear the demo marker file (one-time). Returns true if marker was present. */
export function checkAndClearDemoMarker(): boolean {
  if (demoMarkerCleaned) return false;
  demoMarkerCleaned = true;
  if (fs.existsSync(DEMO_MARKER)) {
    try { fs.unlinkSync(DEMO_MARKER); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/** Whether the demo marker has already been cleaned this process. */
export function isDemoMarkerCleaned(): boolean { return demoMarkerCleaned; }

// ── Backup ───────────────────────────────────────────────────────────

/** Back up the DB file before opening, keeping at most MAX_BACKUPS copies. */
function backupDb(): void {
  if (!fs.existsSync(DB_PATH)) return;
  try {
    const dir = path.dirname(DB_PATH);
    const base = path.basename(DB_PATH);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dir, `${base}.backup-${ts}`);
    fs.copyFileSync(DB_PATH, backupPath);
    getLogger().info(`[deck-sync] DB backup: ${backupPath}`);

    // Prune old backups beyond MAX_BACKUPS
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(`${base}.backup-`))
      .sort()
      .reverse();
    for (const old of backups.slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(dir, old));
      getLogger().info(`[deck-sync] Pruned old backup: ${old}`);
    }
  } catch (err) {
    getLogger().warn(`[deck-sync] DB backup failed: ${(err as Error).message}`);
  }
}

// ── DB Init ──────────────────────────────────────────────────────────

export function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  backupDb();

  db = new Database(DB_PATH);

  // Set restrictive permissions on DB files (contains session data)
  try {
    for (const ext of ["", "-wal", "-shm"]) {
      const f = DB_PATH + ext;
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    }
  } catch { /* non-fatal on platforms that don't support chmod */ }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      agent TEXT NOT NULL,
      session TEXT,
      type TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read INTEGER,
      cache_write INTEGER,
      cost REAL,
      detail TEXT,
      run_id TEXT,
      -- v2: full payload columns (Langfuse-inspired dual-cost pattern)
      prompt TEXT,
      response TEXT,
      thinking TEXT,
      resolved_model TEXT,
      provider_cost REAL,
      billing TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_agent_ts ON events(agent, ts);
    CREATE INDEX IF NOT EXISTS idx_run ON events(run_id);
  `);

  // v2 migration: add columns if missing (safe no-op on fresh DB)
  const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const v2Cols: Array<[string, string]> = [
    ["prompt", "TEXT"],
    ["response", "TEXT"],
    ["thinking", "TEXT"],
    ["resolved_model", "TEXT"],
    ["provider_cost", "REAL"],
    ["billing", "TEXT"],
  ];
  for (const [col, type] of v2Cols) {
    if (!colNames.has(col)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
    }
  }

  // v3 migration: indexed tool columns for fast research/audit queries
  const v3Cols: Array<[string, string]> = [
    ["tool_name", "TEXT"],     // e.g. "web_search", "read", "write"
    ["tool_query", "TEXT"],    // search query, URL fetched, or command run
    ["tool_target", "TEXT"],   // file path, URL target, or other primary arg
  ];
  for (const [col, type] of v3Cols) {
    if (!colNames.has(col)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
    }
  }
  // Indexes for the new columns
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_name ON events(tool_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_name_agent ON events(tool_name, agent)`);

  // Backfill billing column from model provider prefix (one-time, safe no-op when done)
  const nullBilling = db.prepare("SELECT COUNT(*) as cnt FROM events WHERE billing IS NULL").get() as { cnt: number };
  if (nullBilling.cnt > 0) {
    try {
      loadBillingMap();
      // Group by provider prefix and set billing based on auth config
      const providers = db.prepare("SELECT DISTINCT SUBSTR(model, 1, INSTR(model, '/') - 1) as provider FROM events WHERE billing IS NULL AND model LIKE '%/%'").all() as Array<{ provider: string }>;
      for (const { provider } of providers) {
        const mode = getBillingMode(provider) ?? "metered";
        db.prepare("UPDATE events SET billing = ? WHERE billing IS NULL AND model LIKE ?").run(mode, `${provider}/%`);
      }
      // Remaining nulls (no slash in model) default to metered
      db.prepare("UPDATE events SET billing = 'metered' WHERE billing IS NULL").run();
    } catch { /* ignore — will retry next restart */ }
  }

  // Backfill hasCompaction/hasToolUse flags in llm_input detail from prompt data (one-time, safe no-op)
  try {
    const needsBackfill = db.prepare(
      `SELECT COUNT(*) as cnt FROM events
       WHERE type = 'llm_input' AND prompt IS NOT NULL
         AND json_extract(detail, '$.hasCompaction') IS NULL
         AND prompt LIKE '%compactionSummary%'`
    ).get() as { cnt: number };
    if (needsBackfill.cnt > 0) {
      db.prepare(
        `UPDATE events SET detail = json_set(detail, '$.hasCompaction', 1)
         WHERE type = 'llm_input' AND prompt IS NOT NULL
           AND json_extract(detail, '$.hasCompaction') IS NULL
           AND prompt LIKE '%compactionSummary%'`
      ).run();
      db.prepare(
        `UPDATE events SET detail = json_set(detail, '$.hasToolUse', 1)
         WHERE type = 'llm_input' AND prompt IS NOT NULL
           AND json_extract(detail, '$.hasToolUse') IS NULL
           AND prompt LIKE '%toolResult%'`
      ).run();
    }
    // Also backfill hasCompaction from JSONL compaction events for llm_input rows missing prompt data.
    // Cross-reference: find the first llm_input after each compaction timestamp in the same session.
    backfillCompactionFromJsonl(db);
  } catch { /* ignore — will retry next restart */ }

  // ── Backfill metadata table (tracks completed one-time backfills) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS backfill_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      ts INTEGER NOT NULL
    );
  `);

  // ── Sessions table ────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL UNIQUE,
      agent TEXT NOT NULL,
      session_id TEXT,
      channel TEXT,
      model TEXT,
      total_tokens INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      context_tokens INTEGER DEFAULT 0,
      display_name TEXT,
      label TEXT,
      group_channel TEXT,
      origin TEXT,
      compaction_count INTEGER DEFAULT 0,
      transcript_size_kb INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      archived_at INTEGER,
      archive_file TEXT,
      source TEXT DEFAULT 'agent'
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
  `);

  // Migration: add source column to existing sessions table
  const sessCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const sessColNames = new Set(sessCols.map((c) => c.name));
  if (!sessColNames.has("source")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'agent'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source)`);
    // Backfill: cron sessions from channel
    db.exec(`UPDATE sessions SET source = 'cron' WHERE channel = 'cron'`);
  }

  // ── Session Analysis table (v4, updated v4.1: multi-analysis per session + guidelines) ──
  // v4 had UNIQUE on session_key — v4.1 removes it to support multiple analyses per session.
  // Migration: detect old schema and recreate.
  const saExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_analysis'").get();
  if (saExists) {
    // Check if old UNIQUE constraint exists (has guidelines column = already migrated)
    const saCols = db.prepare("PRAGMA table_info(session_analysis)").all() as Array<{ name: string }>;
    const saColNames = new Set(saCols.map((c) => c.name));
    if (!saColNames.has("guidelines")) {
      // v4 → v4.1 migration: recreate without UNIQUE, add guidelines columns
      db.exec(`ALTER TABLE session_analysis RENAME TO session_analysis_old`);
      db.exec(`
        CREATE TABLE session_analysis (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_key TEXT NOT NULL,
          agent TEXT NOT NULL,
          agent_type TEXT,
          computed_at INTEGER NOT NULL,
          events_max_id INTEGER NOT NULL,
          guidelines TEXT,
          guidelines_hash TEXT,
          regions TEXT NOT NULL,
          outcomes TEXT NOT NULL,
          activity_summary TEXT NOT NULL,
          quality_scores TEXT NOT NULL,
          critique TEXT NOT NULL,
          llm_summary TEXT,
          llm_critique TEXT,
          llm_model TEXT
        );
      `);
      db.exec(`
        INSERT INTO session_analysis (id, session_key, agent, agent_type, computed_at, events_max_id,
          regions, outcomes, activity_summary, quality_scores, critique, llm_summary, llm_critique, llm_model)
        SELECT id, session_key, agent, agent_type, computed_at, events_max_id,
          regions, outcomes, activity_summary, quality_scores, critique, llm_summary, llm_critique, llm_model
        FROM session_analysis_old
      `);
      db.exec(`DROP TABLE session_analysis_old`);
    }
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        agent_type TEXT,
        computed_at INTEGER NOT NULL,
        events_max_id INTEGER NOT NULL,
        guidelines TEXT,
        guidelines_hash TEXT,
        regions TEXT NOT NULL,
        outcomes TEXT NOT NULL,
        activity_summary TEXT NOT NULL,
        quality_scores TEXT NOT NULL,
        critique TEXT NOT NULL,
        llm_summary TEXT,
        llm_critique TEXT,
        llm_model TEXT
      );
    `);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sa_session ON session_analysis(session_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sa_agent ON session_analysis(agent)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sa_guidelines ON session_analysis(session_key, guidelines_hash)`);

  // ── Session Feedback table (v4) ───────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rating INTEGER,
      outcome_quality TEXT,
      notes TEXT,
      tags TEXT,
      flagged INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sf_session ON session_feedback(session_key);
  `);

  // ── Deliverables table (v5) ─────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliverables (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent           TEXT NOT NULL,
      session         TEXT NOT NULL,
      group_key       TEXT NOT NULL UNIQUE,
      main_type       TEXT NOT NULL,
      main_label      TEXT NOT NULL,
      main_target     TEXT,
      supporting      TEXT NOT NULL DEFAULT '[]',
      item_count      INTEGER NOT NULL DEFAULT 1,
      first_ts        INTEGER NOT NULL,
      last_ts         INTEGER NOT NULL,
      events_max_id   INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_del_agent     ON deliverables(agent);
    CREATE INDEX IF NOT EXISTS idx_del_last_ts   ON deliverables(last_ts);
    CREATE INDEX IF NOT EXISTS idx_del_group_key ON deliverables(group_key);
  `);

  // Backfill deliverables from events on first run (table empty)
  const delCount = (db.prepare("SELECT COUNT(*) as cnt FROM deliverables").get() as { cnt: number }).cnt;
  if (delCount === 0) {
    backfillDeliverables(db);
  }

  // ── Agent heartbeats ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      model TEXT,
      configured_model TEXT,
      session_key TEXT,
      cron_model TEXT,
      cron_model_updated_at INTEGER,
      bio TEXT,
      last_heartbeat INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // ── Model drift events ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS drift_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_key TEXT NOT NULL,
      configured_model TEXT NOT NULL,
      actual_model TEXT NOT NULL,
      tag TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_drift_agent_ts ON drift_events(agent_key, timestamp);
    CREATE INDEX IF NOT EXISTS idx_drift_resolved ON drift_events(resolved, timestamp);
  `);

  // ── Activity feed ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      agent_key TEXT,
      agent_name TEXT,
      message TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aa_ts ON agent_activities(timestamp);
  `);

  // Cleanup old events
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);

  // Cleanup old archived sessions (90 day retention for non-active)
  const archiveCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM sessions WHERE status != 'active' AND updated_at < ?").run(archiveCutoff);

  // ── FTS5 search index ──
  ensureSearchIndex(db);

  return db;
}

// ── Init-only backfill helpers ───────────────────────────────────────

function backfillCompactionFromJsonl(db: Database.Database): void {
  const agentsDir = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");
  if (!fs.existsSync(agentsDir)) return;

  // Check if any llm_input events need compaction flagging
  const unflagged = db.prepare(
    `SELECT COUNT(*) as cnt FROM events
     WHERE type = 'llm_input' AND json_extract(detail, '$.hasCompaction') IS NULL`
  ).get() as { cnt: number };
  if (unflagged.cnt === 0) return;

  // Collect compaction timestamps from all JSONL files
  const compactionTimestamps: number[] = [];
  let agentIds: string[];
  try { agentIds = fs.readdirSync(agentsDir).filter(d => { try { return fs.statSync(path.join(agentsDir, d)).isDirectory(); } catch { return false; } }); } catch { return; }

  for (const agentId of agentIds) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    let files: string[];
    try { files = fs.readdirSync(sessionsDir); } catch { continue; }

    for (const file of files) {
      if (!file.includes(".jsonl")) continue;
      const filePath = path.join(sessionsDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        for (const line of content.split("\n")) {
          if (!line) continue;
          // Fast pre-check before JSON.parse
          if (!line.includes('"compaction"')) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "compaction" && entry.timestamp) {
              const ts = new Date(entry.timestamp).getTime();
              if (ts > 0) compactionTimestamps.push(ts);
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* skip unreadable files */ }
    }
  }

  if (compactionTimestamps.length === 0) return;
  compactionTimestamps.sort((a, b) => a - b);

  // For each compaction timestamp, mark the first llm_input event within 60s after it
  const updateStmt = db.prepare(
    `UPDATE events SET detail = json_set(detail, '$.hasCompaction', 1)
     WHERE id = (
       SELECT id FROM events
       WHERE type = 'llm_input' AND ts >= ? AND ts <= ?
         AND json_extract(detail, '$.hasCompaction') IS NULL
       ORDER BY ts ASC LIMIT 1
     )`
  );

  let marked = 0;
  for (const compTs of compactionTimestamps) {
    const result = updateStmt.run(compTs, compTs + 60_000);
    if (result.changes > 0) marked++;
  }

  if (marked > 0) {
    getLogger().info(`[deck-sync] backfilled hasCompaction flag for ${marked} llm_input events from JSONL transcripts`);
  }
}

function backfillDeliverables(db: Database.Database): void {
  const toolNames = ruleToolNames();
  const toolPlaceholders = toolNames.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, ts, agent, session, tool_name, tool_query, tool_target, detail
     FROM events
     WHERE type = 'tool_call' AND tool_name IN (${toolPlaceholders})
     ORDER BY ts ASC`
  ).all(...toolNames) as DelToolEvent[];

  const groups = buildDeliverableGroups(rows);
  insertDelGroups(db, groups);
  getLogger().info(`[deliverables] Backfilled ${groups.length} deliverable groups from ${rows.length} events`);
}

function insertDelGroups(db: Database.Database, groups: DelGroup[]): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO deliverables
      (agent, session, group_key, main_type, main_label, main_target, supporting,
       item_count, first_ts, last_ts, events_max_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const g of groups) {
      stmt.run(
        g.agent, g.session, g.groupKey,
        g.main.type, g.main.label, g.main.target,
        JSON.stringify(g.supporting),
        g.itemCount, g.firstTs, g.lastTs, g.eventsMaxId,
        now, now,
      );
    }
  });
  tx();
}
