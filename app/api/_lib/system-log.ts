import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { SYSTEM_LOG_DB } from "./paths";
import { stripSecrets } from "./security";

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const dir = path.dirname(SYSTEM_LOG_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  _db = new Database(SYSTEM_LOG_DB);
  _db.pragma("journal_mode = WAL");
  try { fs.chmodSync(SYSTEM_LOG_DB, 0o600); } catch { /* non-fatal */ }
  _db.exec(`
    CREATE TABLE IF NOT EXISTS system_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_syslog_ts ON system_log(ts);
    CREATE INDEX IF NOT EXISTS idx_syslog_cat ON system_log(category, ts);
  `);
  return _db;
}

export function logSystemEvent(entry: {
  category: string;
  action: string;
  summary: string;
  detail?: Record<string, unknown>;
  status: "ok" | "error" | "rollback" | "warning";
}): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO system_log (ts, category, action, summary, detail, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      Date.now(),
      entry.category,
      entry.action,
      entry.summary,
      entry.detail ? stripSecrets(JSON.stringify(entry.detail)) : null,
      entry.status
    );
  } catch {
    // Fire-and-forget — never throw from logging
  }
}

export interface SystemLogRow {
  id: number;
  ts: number;
  category: string;
  action: string;
  summary: string;
  detail: string | null;
  status: string;
}

export function querySystemLog(opts: {
  since?: number;
  limit?: number;
  categories?: string[];
}): SystemLogRow[] {
  try {
    const db = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.since) {
      conditions.push("ts >= ?");
      params.push(opts.since);
    }
    if (opts.categories && opts.categories.length > 0) {
      const placeholders = opts.categories.map(() => "?").join(",");
      conditions.push(`category IN (${placeholders})`);
      params.push(...opts.categories);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 200;
    params.push(limit);

    return db.prepare(
      `SELECT id, ts, category, action, summary, detail, status FROM system_log ${where} ORDER BY ts DESC LIMIT ?`
    ).all(...params) as SystemLogRow[];
  } catch {
    return [];
  }
}
