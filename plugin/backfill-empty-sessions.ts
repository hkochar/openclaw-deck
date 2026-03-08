#!/usr/bin/env npx tsx
/**
 * Bulk backfill events for ALL sessions that have 0 events in the events table
 * but have JSONL transcript files on disk.
 *
 * Usage: npx tsx backfill-empty-sessions.ts [--dry-run]
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

const DB_PATH = process.env.DECK_USAGE_DB || path.join(os.homedir(), ".openclaw-deck", "data", "usage.db");
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");
const DRY_RUN = process.argv.includes("--dry-run");

function loadAgentConfig(): { keyToDir: Record<string, string>; dirToKey: Record<string, string> } {
  try {
    const mcRoot = process.env.DECK_ROOT || path.resolve(__dirname, "..");
    const p = path.join(mcRoot, "config/deck-agents.json");
    const config = JSON.parse(fs.readFileSync(p, "utf-8"));
    const agents = config.agents as Array<{ id: string; key: string }> | undefined;
    const keyToDir: Record<string, string> = {};
    const dirToKey: Record<string, string> = {};
    for (const a of agents ?? []) {
      keyToDir[a.key] = a.id;
      dirToKey[a.id] = a.key;
    }
    return { keyToDir, dirToKey };
  } catch { return { keyToDir: {}, dirToKey: {} }; }
}

function parseTranscript(filePath: string): Array<{
  ts: number; type: string; model: string | null;
  inputTokens: number | null; outputTokens: number | null;
  cacheRead: number | null; cacheWrite: number | null;
  cost: number | null; detail: string | null;
  prompt: string | null; response: string | null;
  thinking: string | null; resolvedModel: string | null;
  providerCost: number | null; billing: string | null;
}> {
  const events: ReturnType<typeof parseTranscript> = [];
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return events; }

  const lines = content.split("\n").filter(Boolean);
  let lastUserText = "";
  let sessionProvider = "";
  const pendingCalls = new Map<string, { name: string; args: Record<string, unknown>; ts: number }>();

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === "custom" && entry.customType === "model-snapshot") {
      const data = entry.data as Record<string, unknown> | undefined;
      sessionProvider = (data?.provider as string) || "";
      continue;
    }

    if (entry.type !== "message") continue;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const ts = entry.timestamp ? new Date(entry.timestamp as string).getTime() : 0;
    if (!ts) continue;

    if (msg.role === "user" && Array.isArray(msg.content)) {
      const parts = (msg.content as Array<Record<string, unknown>>)
        .filter(c => c.type === "text").map(c => c.text as string);
      const text = parts.join("\n");
      if (text) {
        lastUserText = text.slice(0, 10240);
        events.push({
          ts, type: "msg_in", model: null, inputTokens: null, outputTokens: null,
          cacheRead: null, cacheWrite: null, cost: null,
          detail: JSON.stringify({ content: lastUserText, source: "backfill" }),
          prompt: null, response: null, thinking: null, resolvedModel: null,
          providerCost: null, billing: null,
        });
      }
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const contentBlocks = msg.content as Array<Record<string, unknown>>;
      for (const block of contentBlocks) {
        if (block.type === "toolCall" && block.id) {
          pendingCalls.set(block.id as string, {
            name: (block.name as string) || "unknown",
            args: (block.arguments as Record<string, unknown>) || {},
            ts,
          });
        }
      }

      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage && (usage.totalTokens as number) > 0) {
        const rawModel = (msg.model as string) || "";
        const model = rawModel.includes("/") ? rawModel : (sessionProvider ? `${sessionProvider}/${rawModel}` : rawModel);
        const inputTokens = (usage.input as number) || 0;
        const outputTokens = (usage.output as number) || 0;
        const cacheRead = (usage.cacheRead as number) || 0;
        const cacheWrite = (usage.cacheWrite as number) || 0;
        const costObj = usage.cost as Record<string, number> | undefined;
        const costTotal = costObj?.total || 0;

        const textParts: string[] = [];
        const thinkParts: string[] = [];
        for (const b of contentBlocks) {
          if (b.type === "text" && b.text) textParts.push(b.text as string);
          if (b.type === "thinking" && b.thinking) thinkParts.push(b.thinking as string);
        }

        events.push({
          ts: ts - 1, type: "llm_input", model, inputTokens: null, outputTokens: null,
          cacheRead: null, cacheWrite: null, cost: null,
          detail: JSON.stringify({ promptPreview: lastUserText?.slice(0, 2000), source: "backfill" }),
          prompt: null, response: null, thinking: null, resolvedModel: null,
          providerCost: null, billing: "subscription",
        });

        events.push({
          ts, type: "llm_output", model,
          inputTokens, outputTokens, cacheRead, cacheWrite, cost: costTotal,
          detail: null, prompt: lastUserText || null,
          response: textParts.join("\n") || null,
          thinking: thinkParts.join("\n") || null,
          resolvedModel: rawModel || null,
          providerCost: costTotal || null, billing: "subscription",
        });
        lastUserText = "";
      }
    }

    if (msg.role === "toolResult" && msg.toolCallId) {
      const callId = msg.toolCallId as string;
      const call = pendingCalls.get(callId);
      if (call) {
        pendingCalls.delete(callId);
        const resultContent = Array.isArray(msg.content)
          ? (msg.content as Array<Record<string, unknown>>).filter(c => c.type === "text").map(c => c.text).join("\n")
          : typeof msg.content === "string" ? msg.content : "";
        const durationMs = (msg.duration_ms as number) || undefined;
        const isError = (msg.is_error as boolean) || false;
        events.push({
          ts, type: "tool_call", model: null, inputTokens: null, outputTokens: null,
          cacheRead: null, cacheWrite: null, cost: null,
          detail: JSON.stringify({
            tool: call.name, params: call.args,
            result: resultContent.slice(0, 5000), durationMs, isError, source: "backfill",
          }),
          prompt: null, response: null, thinking: null, resolvedModel: null,
          providerCost: null, billing: null,
        });
      }
    }
  }
  return events;
}

function main() {
  console.log(`[backfill-empty] DB: ${DB_PATH}`);
  console.log(`[backfill-empty] Agents dir: ${AGENTS_DIR}`);
  console.log(`[backfill-empty] Dry run: ${DRY_RUN}`);

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const { keyToDir, dirToKey } = loadAgentConfig();

  // Find sessions with 0 events (exclude archived)
  const emptySessions = db.prepare(`
    SELECT s.session_key, s.agent, s.session_id
    FROM sessions s
    WHERE s.session_key NOT LIKE 'archived:%'
      AND (SELECT COUNT(*) FROM events e WHERE e.session = s.session_key) = 0
    ORDER BY s.created_at DESC
  `).all() as Array<{ session_key: string; agent: string; session_id: string | null }>;

  console.log(`[backfill-empty] ${emptySessions.length} sessions with 0 events`);

  // Build sessionId → filePath map
  const transcriptMap = new Map<string, string>();
  let agentDirs: string[] = [];
  try {
    agentDirs = fs.readdirSync(AGENTS_DIR).filter(d => {
      try { return fs.statSync(path.join(AGENTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch { /* */ }

  for (const agentDir of agentDirs) {
    const sessionsDir = path.join(AGENTS_DIR, agentDir, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    let files: string[];
    try { files = fs.readdirSync(sessionsDir); } catch { continue; }
    for (const file of files) {
      // Match .jsonl, .jsonl.bak, .jsonl.gz, etc.
      if (!file.includes(".jsonl") || file.startsWith("sessions.json")) continue;
      const match = file.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (!match) continue;
      // Prefer .jsonl over .jsonl.bak — only set if not already mapped
      if (!transcriptMap.has(match[1]) || file.endsWith(".jsonl")) {
        transcriptMap.set(match[1], path.join(sessionsDir, file));
      }
    }
  }

  console.log(`[backfill-empty] ${transcriptMap.size} transcript files on disk`);

  const insertStmt = db.prepare(
    `INSERT INTO events (ts, agent, session, type, model, input_tokens, output_tokens, cache_read, cache_write, cost, detail, prompt, response, thinking, resolved_model, provider_cost, billing)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let totalInserted = 0;
  let sessionsProcessed = 0;
  let sessionsSkipped = 0;

  const txn = db.transaction(() => {
    for (const sess of emptySessions) {
      let sessionId = sess.session_id;
      if (!sessionId) {
        const match = sess.session_key.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        if (match) sessionId = match[1];
      }
      if (!sessionId) { sessionsSkipped++; continue; }

      const filePath = transcriptMap.get(sessionId);
      if (!filePath) { sessionsSkipped++; continue; }

      const agentKey = sess.agent || "unknown";

      // Use the session_key from sessions table so events match lookups
      const eventSessionKey = sess.session_key;

      // Check all possible key variants for existing events
      const agentDir = keyToDir[agentKey] || agentKey;
      const altKey = `${agentDir}/${sessionId}.jsonl`;
      const altCheck = db.prepare(
        "SELECT COUNT(*) as cnt FROM events WHERE session = ? OR session = ?"
      ).get(eventSessionKey, altKey) as { cnt: number };
      if (altCheck.cnt > 0) { sessionsSkipped++; continue; }

      const events = parseTranscript(filePath);
      if (events.length === 0) { sessionsSkipped++; continue; }

      sessionsProcessed++;
      if (!DRY_RUN) {
        for (const evt of events) {
          insertStmt.run(
            evt.ts, agentKey, eventSessionKey, evt.type, evt.model,
            evt.inputTokens, evt.outputTokens, evt.cacheRead, evt.cacheWrite, evt.cost,
            evt.detail, evt.prompt, evt.response, evt.thinking,
            evt.resolvedModel, evt.providerCost, evt.billing
          );
        }
      }
      totalInserted += events.length;
      console.log(`  ${agentKey}/${sessionId}: ${events.length} events`);
    }
  });

  txn();

  console.log(`\n[backfill-empty] Results:`);
  console.log(`  Sessions processed: ${sessionsProcessed}`);
  console.log(`  Sessions skipped: ${sessionsSkipped}`);
  console.log(`  Total events inserted: ${totalInserted}`);
  db.close();
}

main();
