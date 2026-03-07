#!/usr/bin/env npx tsx
/**
 * Backfill prompt data for llm_input events that have neither
 * prompt column data nor detail.promptPreview.
 *
 * Reads JSONL session transcripts, finds user messages,
 * and updates the corresponding llm_input events in SQLite with
 * detail.promptPreview (the user's message text).
 *
 * Safe to run multiple times — only updates rows where both
 * prompt IS NULL and detail doesn't contain promptPreview.
 *
 * Usage: npx tsx backfill-prompts.ts [--dry-run]
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

const DB_PATH = process.env.DECK_USAGE_DB || path.join(os.homedir(), ".openclaw-deck", "data", "usage.db");
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");
const DRY_RUN = process.argv.includes("--dry-run");

function loadAgentDirMap(): Record<string, string> {
  const candidates = [
    path.join(process.env.DECK_ROOT || path.resolve(__dirname, ".."), "config/deck-agents.json"),
  ];
  for (const p of candidates) {
    try {
      const config = JSON.parse(fs.readFileSync(p, "utf-8"));
      const agents = config.agents as Array<{ id: string; key: string }> | undefined;
      if (!agents?.length) continue;
      const map: Record<string, string> = {};
      for (const a of agents) map[a.id] = a.key;
      return map;
    } catch { continue; }
  }
  return {};
}

interface UserMessage {
  ts: number;
  text: string;
}

/** Extract user messages from a JSONL transcript file */
function extractUserMessages(filePath: string): UserMessage[] {
  const messages: UserMessage[] = [];
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return []; }

  for (const line of content.split("\n")) {
    if (!line || !line.includes('"user"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg || msg.role !== "user") continue;
      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
      if (!ts) continue;

      // Extract text from user message content blocks
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const parts = msg.content
          .filter((c: Record<string, unknown>) => c.type === "text")
          .map((c: Record<string, unknown>) => c.text as string);
        text = parts.join("\n");
      }
      if (text) {
        // Truncate to 2KB for promptPreview
        messages.push({ ts, text: text.slice(0, 2048) });
      }
    } catch { continue; }
  }
  return messages;
}

function main() {
  console.log(`[backfill-prompts] DB: ${DB_PATH}`);
  console.log(`[backfill-prompts] Agents dir: ${AGENTS_DIR}`);
  console.log(`[backfill-prompts] Dry run: ${DRY_RUN}`);

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const agentDirMap = loadAgentDirMap();
  console.log(`[backfill-prompts] Agent map: ${JSON.stringify(agentDirMap)}`);

  // Find llm_input events that need prompt data
  const needsBackfill = db.prepare(`
    SELECT id, ts, agent, session FROM events
    WHERE type = 'llm_input'
      AND prompt IS NULL
      AND (detail IS NULL OR json_extract(detail, '$.promptPreview') IS NULL)
    ORDER BY ts ASC
  `).all() as Array<{ id: number; ts: number; agent: string; session: string | null }>;

  console.log(`[backfill-prompts] Found ${needsBackfill.length} llm_input events needing prompt data`);

  if (needsBackfill.length === 0) {
    console.log("[backfill-prompts] Nothing to do");
    db.close();
    return;
  }

  // Build session → events map
  const sessionEvents = new Map<string, Array<{ id: number; ts: number }>>();
  for (const evt of needsBackfill) {
    if (!evt.session) continue;
    if (!sessionEvents.has(evt.session)) sessionEvents.set(evt.session, []);
    sessionEvents.get(evt.session)!.push({ id: evt.id, ts: evt.ts });
  }
  console.log(`[backfill-prompts] ${sessionEvents.size} unique sessions to process`);

  // Build reverse agent key → dir map
  const keyToDir = new Map<string, string>();
  for (const [dir, key] of Object.entries(agentDirMap)) {
    keyToDir.set(key, dir);
  }

  // Also discover all agent dirs
  let agentDirs: string[] = [];
  try {
    agentDirs = fs.readdirSync(AGENTS_DIR).filter(d => {
      try { return fs.statSync(path.join(AGENTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch { /* */ }

  // Build session key → transcript file path map
  const sessionFiles = new Map<string, string>();
  for (const agentDir of agentDirs) {
    const sessionsDir = path.join(AGENTS_DIR, agentDir, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    let files: string[];
    try { files = fs.readdirSync(sessionsDir); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".jsonl") && !file.includes(".jsonl.")) continue;
      if (file.startsWith("sessions.json")) continue;

      const match = file.match(/^([0-9a-f-]+(?:-topic-[\d.]+)?)\./);
      if (!match) continue;
      const sessionId = match[1];

      // Map multiple session key formats to this file
      const agentKey = agentDirMap[agentDir] || agentDir;
      const filePath = path.join(sessionsDir, file);

      // Try various session key formats
      sessionFiles.set(`${agentDir}/${sessionId}.jsonl`, filePath);
      // Check sessions table for the original key
      try {
        const row = db.prepare("SELECT session_key, origin FROM sessions WHERE session_id = ?").get(sessionId) as { session_key: string; origin: string | null } | undefined;
        if (row) {
          sessionFiles.set(row.session_key, filePath);
          if (row.origin) sessionFiles.set(row.origin, filePath);
        }
      } catch { /* */ }
    }
  }

  console.log(`[backfill-prompts] Mapped ${sessionFiles.size} session key variants to transcript files`);

  // Process each session
  const updateStmt = db.prepare(`
    UPDATE events SET detail = CASE
      WHEN detail IS NULL THEN json_object('promptPreview', ?, 'source', 'prompt-backfill')
      ELSE json_set(detail, '$.promptPreview', ?)
    END
    WHERE id = ?
  `);

  let updated = 0;
  let sessionsProcessed = 0;
  let sessionsSkipped = 0;

  const txn = db.transaction(() => {
    for (const [sessionKey, events] of sessionEvents) {
      const filePath = sessionFiles.get(sessionKey);
      if (!filePath) {
        sessionsSkipped++;
        continue;
      }

      sessionsProcessed++;
      const userMsgs = extractUserMessages(filePath);
      if (userMsgs.length === 0) continue;

      // Match events to user messages by timestamp proximity
      // Each llm_input event should correspond to the most recent user message before it
      for (const evt of events) {
        // Find the closest user message at or before this event's timestamp
        // User message comes before the llm_input (which is the API call)
        let bestMsg: UserMessage | null = null;
        let bestDiff = Infinity;
        for (const msg of userMsgs) {
          const diff = evt.ts - msg.ts;
          // User message should be at most 60s before the llm_input
          if (diff >= 0 && diff < 60_000 && diff < bestDiff) {
            bestMsg = msg;
            bestDiff = diff;
          }
        }

        if (!bestMsg) {
          // Also try matching within 5s after (timestamp precision issues)
          for (const msg of userMsgs) {
            const diff = Math.abs(evt.ts - msg.ts);
            if (diff < 5_000 && diff < bestDiff) {
              bestMsg = msg;
              bestDiff = diff;
            }
          }
        }

        if (bestMsg && !DRY_RUN) {
          updateStmt.run(bestMsg.text, bestMsg.text, evt.id);
          updated++;
        } else if (bestMsg) {
          updated++;
        }
      }
    }
  });

  txn();

  console.log(`[backfill-prompts] Results:`);
  console.log(`  Sessions processed: ${sessionsProcessed}`);
  console.log(`  Sessions skipped (no transcript): ${sessionsSkipped}`);
  console.log(`  Events updated: ${updated}`);
  console.log(`  Events remaining: ${needsBackfill.length - updated}`);

  db.close();
}

main();
