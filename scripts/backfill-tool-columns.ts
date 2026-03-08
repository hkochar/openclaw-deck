#!/usr/bin/env npx tsx
/**
 * Backfill tool_name, tool_query, tool_target columns from existing detail JSON.
 *
 * Safe to run multiple times — only updates rows where tool_name IS NULL.
 * Run: npx tsx scripts/backfill-tool-columns.ts
 */

import Database from "better-sqlite3";
import path from "path";
import os from "os";

const DB_PATH = process.env.DECK_USAGE_DB || path.join(os.homedir(), ".openclaw-deck", "data", "usage.db");

function extractToolFields(detail: string | null): { toolName: string | null; toolQuery: string | null; toolTarget: string | null } {
  if (!detail) return { toolName: null, toolQuery: null, toolTarget: null };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return { toolName: null, toolQuery: null, toolTarget: null };
  }

  const toolName = (parsed.tool as string) ?? null;
  if (!toolName) return { toolName: null, toolQuery: null, toolTarget: null };

  const params = (parsed.params ?? {}) as Record<string, unknown>;
  let toolQuery: string | null = null;
  let toolTarget: string | null = null;

  switch (toolName) {
    case "web_search":
    case "WebSearch":
      toolQuery = (params.query as string) ?? null;
      break;
    case "web_fetch":
    case "WebFetch":
      toolQuery = (params.url as string) ?? null;
      toolTarget = (params.url as string) ?? null;
      break;
    case "browser":
      toolTarget = (params.targetUrl as string) ?? (params.url as string) ?? null;
      toolQuery = (params.action as string) ?? null;
      break;
    case "read":
    case "Read":
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? null;
      break;
    case "write":
    case "Write":
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? null;
      break;
    case "edit":
    case "Edit":
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? null;
      break;
    case "exec":
    case "Bash":
      toolQuery = typeof params.command === "string" ? params.command.slice(0, 500) : null;
      break;
    case "memory_search":
      toolQuery = (params.query as string) ?? null;
      break;
    case "sessions_send":
    case "message":
      toolTarget = (params.channel as string) ?? (params.to as string) ?? (params.session as string) ?? null;
      break;
    default:
      toolQuery = (params.query as string) ?? (params.url as string) ?? null;
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? (params.target as string) ?? null;
  }

  return { toolName, toolQuery, toolTarget };
}

// ── Main ──

console.log(`Opening DB: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");

// Ensure columns exist
const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
const colNames = new Set(cols.map((c) => c.name));
for (const [col, type] of [["tool_name", "TEXT"], ["tool_query", "TEXT"], ["tool_target", "TEXT"]]) {
  if (!colNames.has(col)) {
    console.log(`Adding column: ${col}`);
    db.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
  }
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_name ON events(tool_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_name_agent ON events(tool_name, agent)`);

// Count rows to backfill
const { total } = db.prepare(
  "SELECT COUNT(*) as total FROM events WHERE type = 'tool_call' AND tool_name IS NULL AND detail IS NOT NULL"
).get() as { total: number };

console.log(`Found ${total} tool_call events to backfill`);

if (total === 0) {
  console.log("Nothing to backfill — all done.");
  db.close();
  process.exit(0);
}

// Batch update
const BATCH = 1000;
const update = db.prepare(
  "UPDATE events SET tool_name = ?, tool_query = ?, tool_target = ? WHERE id = ?"
);

let processed = 0;
let updated = 0;

const selectBatch = db.prepare(
  `SELECT id, detail FROM events
   WHERE type = 'tool_call' AND tool_name IS NULL AND detail IS NOT NULL
   ORDER BY id ASC LIMIT ?`
);

while (true) {
  const rows = selectBatch.all(BATCH) as Array<{ id: number; detail: string }>;
  if (rows.length === 0) break;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const { toolName, toolQuery, toolTarget } = extractToolFields(row.detail);
      if (toolName) {
        update.run(toolName, toolQuery, toolTarget, row.id);
        updated++;
      }
      processed++;
    }
  });
  tx();

  console.log(`Processed ${processed}/${total} (${updated} updated)`);
}

console.log(`\nDone. Backfilled ${updated} of ${processed} tool_call events.`);

// Verify
const stats = db.prepare(`
  SELECT tool_name, COUNT(*) as cnt
  FROM events
  WHERE type = 'tool_call' AND tool_name IS NOT NULL
  GROUP BY tool_name
  ORDER BY cnt DESC
  LIMIT 15
`).all() as Array<{ tool_name: string; cnt: number }>;

console.log("\nTool usage summary (top 15):");
for (const s of stats) {
  console.log(`  ${s.tool_name.padEnd(20)} ${s.cnt}`);
}

const searchCount = db.prepare(
  "SELECT COUNT(*) as cnt FROM events WHERE tool_name IN ('web_search','WebSearch') AND tool_query IS NOT NULL"
).get() as { cnt: number };
console.log(`\nWeb searches with queries: ${searchCount.cnt}`);

const fetchCount = db.prepare(
  "SELECT COUNT(*) as cnt FROM events WHERE tool_name IN ('web_fetch','WebFetch') AND tool_target IS NOT NULL"
).get() as { cnt: number };
console.log(`Web fetches with URLs: ${fetchCount.cnt}`);

db.close();
