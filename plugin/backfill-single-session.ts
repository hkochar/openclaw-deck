#!/usr/bin/env npx tsx
/**
 * Backfill events for a single session from its JSONL transcript.
 * Usage: npx tsx backfill-single-session.ts <agentKey> <sessionId>
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

const DB_PATH = process.env.DECK_USAGE_DB || path.join(os.homedir(), ".openclaw-deck", "data", "usage.db");
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");

function loadAgentDirMap(): Record<string, string> {
  try {
    const mcRoot = process.env.DECK_ROOT || path.resolve(__dirname, "..");
    const p = path.join(mcRoot, "config/deck-agents.json");
    const config = JSON.parse(fs.readFileSync(p, "utf-8"));
    const agents = config.agents as Array<{ id: string; key: string }> | undefined;
    const map: Record<string, string> = {};
    for (const a of agents ?? []) map[a.key] = a.id;
    return map;
  } catch { return {}; }
}

const agentKey = process.argv[2];
const sessionId = process.argv[3];

if (!agentKey || !sessionId) {
  console.error("Usage: npx tsx backfill-single-session.ts <agentKey> <sessionId>");
  process.exit(1);
}

const keyToDir = loadAgentDirMap();
const agentDir = keyToDir[agentKey] || agentKey;
const jsonlPath = path.join(AGENTS_DIR, agentDir, "sessions", `${sessionId}.jsonl`);
const sessionKey = `${agentDir}/${sessionId}.jsonl`;

console.log(`Agent: ${agentKey} (dir: ${agentDir})`);
console.log(`Session: ${sessionId}`);
console.log(`JSONL: ${jsonlPath}`);
console.log(`Session key: ${sessionKey}`);

if (!fs.existsSync(jsonlPath)) {
  // Try archived variants
  const sessDir = path.join(AGENTS_DIR, agentDir, "sessions");
  const files = fs.readdirSync(sessDir).filter(f => f.startsWith(sessionId));
  if (files.length === 0) {
    console.error("No transcript file found");
    process.exit(1);
  }
  console.log("Found archived files:", files);
}

const db = new Database(DB_PATH);

// Check existing events
const existing = db.prepare("SELECT COUNT(*) as cnt FROM events WHERE session = ?").get(sessionKey) as { cnt: number };
console.log(`Existing events for ${sessionKey}: ${existing.cnt}`);

if (existing.cnt > 0) {
  console.log("Session already has events, skipping");
  db.close();
  process.exit(0);
}

const content = fs.readFileSync(jsonlPath, "utf-8");
const lines = content.split("\n").filter(Boolean);
console.log(`Transcript lines: ${lines.length}`);

const insertStmt = db.prepare(
  `INSERT INTO events (ts, agent, session, type, model, input_tokens, output_tokens, cache_read, cache_write, cost, detail, prompt, response, thinking, resolved_model, provider_cost, billing)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

let lastUserText = "";
let sessionProvider = "";
let count = 0;
const pendingCalls = new Map<string, { name: string; args: Record<string, unknown>; ts: number }>();

const txn = db.transaction(() => {
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

    // User messages → msg_in
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const parts = (msg.content as Array<Record<string, unknown>>)
        .filter(c => c.type === "text")
        .map(c => c.text as string);
      const text = parts.join("\n");
      if (text) {
        lastUserText = text.slice(0, 10240);
        insertStmt.run(ts, agentKey, sessionKey, "msg_in", null, null, null, null, null, null,
          JSON.stringify({ content: lastUserText, source: "backfill" }), null, null, null, null, null, null);
        count++;
      }
    }

    // Assistant messages → llm_input + llm_output + tool_call events
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const contentBlocks = msg.content as Array<Record<string, unknown>>;

      // Collect tool calls
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

        // llm_input
        insertStmt.run(ts - 1, agentKey, sessionKey, "llm_input", model, null, null, null, null, null,
          JSON.stringify({ promptPreview: lastUserText?.slice(0, 2000), source: "backfill" }),
          null, null, null, null, null, "subscription");
        count++;

        // llm_output
        insertStmt.run(ts, agentKey, sessionKey, "llm_output", model,
          inputTokens, outputTokens, cacheRead, cacheWrite, costTotal,
          null,
          lastUserText || null,
          textParts.join("\n") || null,
          thinkParts.join("\n") || null,
          rawModel || null,
          costTotal || null,
          "subscription");
        count++;

        lastUserText = "";
      }
    }

    // Tool results → tool_call events (paired with pending calls)
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

        insertStmt.run(ts, agentKey, sessionKey, "tool_call", null, null, null, null, null, null,
          JSON.stringify({
            tool: call.name,
            params: call.args,
            result: resultContent.slice(0, 5000),
            durationMs,
            isError,
            source: "backfill",
          }),
          null, null, null, null, null, null);
        count++;
      }
    }
  }
});

txn();
console.log(`Inserted ${count} events`);

// Verify
const verify = db.prepare("SELECT type, COUNT(*) as cnt FROM events WHERE session = ? GROUP BY type").all(sessionKey) as Array<{ type: string; cnt: number }>;
console.log("Event counts:", verify);

db.close();
