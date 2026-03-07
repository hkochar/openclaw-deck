#!/usr/bin/env npx tsx
/**
 * Backfill v2 schema columns from JSONL session logs.
 *
 * Reads all JSONL session files, finds assistant messages with usage data,
 * and enriches corresponding llm_output events in SQLite with:
 *   - resolved_model (actual model from provider response)
 *   - provider_cost (provider-reported cost in USD)
 *   - response (full assistant text)
 *   - thinking (reasoning/thinking blocks)
 *
 * Safe to run multiple times — only updates rows where resolved_model IS NULL.
 *
 * Usage: npx tsx backfill-v2.ts [--dry-run]
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

const DB_PATH = process.env.DECK_USAGE_DB || path.join(os.homedir(), ".openclaw-deck", "data", "usage.db");
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");
const DRY_RUN = process.argv.includes("--dry-run");

// Load agent ID → key mapping from Deck config (deck-agents.json)
// Each agent has an `id` (gateway agent ID, used as session dir name)
// and a `key` (display key used in SQLite, e.g. "main" → "coordinator")
const DECK_ROOT = process.env.DECK_ROOT || path.resolve(__dirname, "..");

function loadAgentDirMap(): Record<string, string> {
  const candidates = [
    path.join(DECK_ROOT, "config/deck-agents.json"),
  ];

  for (const p of candidates) {
    try {
      const config = JSON.parse(fs.readFileSync(p, "utf-8"));
      const agents = config.agents as Array<{ id: string; key: string }> | undefined;
      if (!agents?.length) continue;

      const map: Record<string, string> = {};
      for (const a of agents) {
        map[a.id] = a.key;
        map[a.key] = a.key; // identity mapping for agents where id === key
      }
      console.log(`Loaded agent mapping from ${p} (${agents.length} agents)`);
      return map;
    } catch { /* try next */ }
  }

  // Fallback: scan AGENTS_DIR and use dir name as both id and key
  console.warn("Deck config not found — using directory names as agent keys (id=key)");
  const map: Record<string, string> = {};
  if (fs.existsSync(AGENTS_DIR)) {
    for (const dir of fs.readdirSync(AGENTS_DIR)) {
      if (fs.existsSync(path.join(AGENTS_DIR, dir, "sessions"))) {
        map[dir] = dir;
      }
    }
  }
  return map;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found: ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Ensure v2 columns exist
  const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const v2Cols: Array<[string, string]> = [
    ["prompt", "TEXT"],
    ["response", "TEXT"],
    ["thinking", "TEXT"],
    ["resolved_model", "TEXT"],
    ["provider_cost", "REAL"],
  ];
  for (const [col, type] of v2Cols) {
    if (!colNames.has(col)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
      console.log(`  Added column: ${col}`);
    }
  }

  const AGENT_DIR_MAP = loadAgentDirMap();

  // Count events needing enrichment
  const needEnrichment = db.prepare(
    "SELECT COUNT(*) as cnt FROM events WHERE type = 'llm_output' AND resolved_model IS NULL"
  ).get() as { cnt: number };
  console.log(`Events needing enrichment: ${needEnrichment.cnt}`);

  if (needEnrichment.cnt === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  // Prepared statements
  // Match by agent + model substring + timestamp proximity (no session match needed)
  const findStmt = db.prepare(`
    SELECT id, ts, model FROM events
    WHERE agent = ? AND type = 'llm_output'
      AND ts BETWEEN ? AND ?
      AND resolved_model IS NULL
    ORDER BY ABS(ts - ?)
    LIMIT 1
  `);

  const updateStmt = db.prepare(`
    UPDATE events
    SET resolved_model = ?,
        provider_cost = ?,
        response = ?,
        thinking = ?
    WHERE id = ?
  `);

  let totalFiles = 0;
  let totalMessages = 0;
  let enriched = 0;
  let skipped = 0;

  // Scan all agent session directories
  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`Agents dir not found: ${AGENTS_DIR}`);
    process.exit(1);
  }

  const agentDirs = fs.readdirSync(AGENTS_DIR);

  for (const agentDir of agentDirs) {
    const sessionsPath = path.join(AGENTS_DIR, agentDir, "sessions");
    if (!fs.existsSync(sessionsPath)) continue;

    const agentKey = AGENT_DIR_MAP[agentDir] ?? agentDir;
    const files = fs.readdirSync(sessionsPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const filePath = path.join(sessionsPath, file);
      const sessionId = file.replace(".jsonl", "");
      totalFiles++;

      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n").filter(Boolean);

      for (const line of lines) {
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        if (entry.type !== "message") continue;
        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "assistant") continue;

        const usage = msg.usage as Record<string, unknown> | undefined;
        if (!usage) continue;

        totalMessages++;

        const ts = entry.timestamp as string | undefined;
        const eventTs = ts ? new Date(ts).getTime() : 0;
        if (!eventTs) continue;

        const costObj = usage.cost as Record<string, number> | undefined;
        const providerCost = costObj?.total ?? null;
        const resolvedModel = (msg.model as string) ?? null;

        // Extract text and thinking from content blocks
        const contentBlocks = (msg.content as Array<Record<string, unknown>>) ?? [];
        const textParts: string[] = [];
        const thinkingParts: string[] = [];

        for (const block of contentBlocks) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text as string);
          } else if (block.type === "thinking" && block.thinking) {
            thinkingParts.push(block.thinking as string);
          }
        }

        const responseText = textParts.join("\n") || null;
        const thinkingText = thinkingParts.join("\n") || null;

        // Match by agent + timestamp proximity (±10s for backfill)
        const row = findStmt.get(
          agentKey,
          eventTs - 10000,
          eventTs + 10000,
          eventTs,
        ) as { id: number; ts: number; model: string } | undefined;

        if (row) {
          if (!DRY_RUN) {
            updateStmt.run(
              resolvedModel,
              providerCost,
              responseText,
              thinkingText,
              row.id,
            );
          }
          enriched++;
        } else {
          skipped++;
        }
      }
    }

    if (totalFiles % 10 === 0) {
      process.stdout.write(`\r  Processed ${totalFiles} files, ${enriched} enriched...`);
    }
  }

  console.log(`\n\nBackfill complete:`);
  console.log(`  Files scanned: ${totalFiles}`);
  console.log(`  Assistant messages found: ${totalMessages}`);
  console.log(`  Events enriched: ${enriched}`);
  console.log(`  Skipped (no match): ${skipped}`);
  console.log(`  Dry run: ${DRY_RUN}`);

  // Summary of enrichment results
  const afterCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM events WHERE type = 'llm_output' AND resolved_model IS NOT NULL"
  ).get() as { cnt: number };
  const stillNull = db.prepare(
    "SELECT COUNT(*) as cnt FROM events WHERE type = 'llm_output' AND resolved_model IS NULL"
  ).get() as { cnt: number };
  console.log(`\n  Events with resolved_model: ${afterCount.cnt}`);
  console.log(`  Events still un-enriched: ${stillNull.cnt}`);

  // Show provider cost stats
  const costStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN provider_cost IS NOT NULL THEN 1 ELSE 0 END) as with_provider_cost,
      SUM(COALESCE(provider_cost, 0)) as total_provider_cost,
      SUM(COALESCE(cost, 0)) as total_calculated_cost
    FROM events WHERE type = 'llm_output'
  `).get() as { total: number; with_provider_cost: number; total_provider_cost: number; total_calculated_cost: number };

  console.log(`\n  Dual cost comparison:`);
  console.log(`    Provider-reported total: $${costStats.total_provider_cost?.toFixed(4) ?? "0"}`);
  console.log(`    Calculated total: $${costStats.total_calculated_cost?.toFixed(4) ?? "0"}`);
  console.log(`    Events with provider cost: ${costStats.with_provider_cost}/${costStats.total}`);

  db.close();
}

main();
