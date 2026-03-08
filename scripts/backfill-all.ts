#!/usr/bin/env npx tsx
/**
 * Full data backfill pipeline for Deck.
 *
 * Run this when you install Deck on a system that already has OpenClaw agents
 * running with session data on disk. It imports all historical data into SQLite
 * so the dashboard has full visibility from day one.
 *
 * Pipeline steps (in order):
 *   1. Bootstrap — ensure DB exists with current schema
 *   2. Sessions — import sessions.json + orphaned JSONL files → sessions table
 *   3. Events — parse JSONL transcripts → events table (msg_in, llm_input, llm_output, tool_call)
 *   4. Enrich — backfill resolved_model, provider_cost, response, thinking from JSONL
 *   5. Prompts — recover user input text for llm_input events
 *   6. Tools — extract tool_name, tool_query, tool_target from event detail JSON
 *   7. Sources — classify session source (agent, cron, heartbeat)
 *   8. Costs — retroactively calculate provider_cost from token counts + pricing table
 *
 * Safe to run multiple times — each step is idempotent and skips already-processed data.
 *
 * Usage:
 *   npx tsx scripts/backfill-all.ts              # full pipeline
 *   npx tsx scripts/backfill-all.ts --dry-run    # preview without writing
 *   npx tsx scripts/backfill-all.ts --step 3     # run only step 3 (events)
 *   npx tsx scripts/backfill-all.ts --from 4     # run steps 4-7
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

// ── Config ──────────────────────────────────────────────────────

const DB_PATH = process.env.DECK_USAGE_DB || path.join(os.homedir(), ".openclaw-deck", "data", "usage.db");
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");
const DECK_ROOT = process.env.DECK_ROOT || path.resolve(import.meta.dirname ?? __dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

if (!fs.existsSync(AGENTS_DIR)) {
  console.error(`\n❌ Agent data directory not found: ${AGENTS_DIR}`);
  console.error(`\nOpenClaw stores agent session data in ~/.openclaw/agents/ by default.`);
  console.error(`If your data is in a different location, set OPENCLAW_AGENTS_DIR:\n`);
  console.error(`  OPENCLAW_AGENTS_DIR=/path/to/agents pnpm backfill\n`);
  process.exit(1);
}

const stepFlag = process.argv.indexOf("--step");
const ONLY_STEP = stepFlag >= 0 ? Number(process.argv[stepFlag + 1]) : 0;
const fromFlag = process.argv.indexOf("--from");
const FROM_STEP = fromFlag >= 0 ? Number(process.argv[fromFlag + 1]) : 1;

function shouldRun(step: number): boolean {
  if (ONLY_STEP > 0) return step === ONLY_STEP;
  return step >= FROM_STEP;
}

function banner(step: number, title: string): void {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Step ${step}: ${title}`);
  console.log(`${"═".repeat(60)}\n`);
}

// ── Agent config ────────────────────────────────────────────────

interface AgentMapping {
  keyToDir: Record<string, string>;  // agent key → filesystem dir name
  dirToKey: Record<string, string>;  // filesystem dir name → agent key
}

function loadAgentConfig(): AgentMapping {
  const keyToDir: Record<string, string> = {};
  const dirToKey: Record<string, string> = {};

  try {
    const p = path.join(DECK_ROOT, "config/deck-agents.json");
    const config = JSON.parse(fs.readFileSync(p, "utf-8"));
    const agents = config.agents as Array<{ id: string; key: string }> | undefined;
    for (const a of agents ?? []) {
      keyToDir[a.key] = a.id;
      dirToKey[a.id] = a.key;
    }
    console.log(`Agent config: ${Object.keys(dirToKey).length} agents from ${p}`);
  } catch {
    // Fallback: scan agent dirs, use dir name as key
    console.warn("No deck-agents.json found — using directory names as agent keys");
    try {
      for (const dir of fs.readdirSync(AGENTS_DIR)) {
        if (fs.existsSync(path.join(AGENTS_DIR, dir, "sessions"))) {
          keyToDir[dir] = dir;
          dirToKey[dir] = dir;
        }
      }
    } catch { /* no agents dir */ }
  }

  return { keyToDir, dirToKey };
}

// ── Transcript parser ───────────────────────────────────────────

interface ParsedEvent {
  ts: number;
  type: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cost: number | null;
  detail: string | null;
  prompt: string | null;
  response: string | null;
  thinking: string | null;
  resolvedModel: string | null;
  providerCost: number | null;
  billing: string | null;
}

function parseTranscript(filePath: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
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

    // User message → msg_in event
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const parts = (msg.content as Array<Record<string, unknown>>)
        .filter(c => c.type === "text").map(c => c.text as string);
      let text = parts.join("\n");
      // Strip OpenClaw conversation/sender metadata blocks (e.g. "Conversation info (untrusted metadata):\n```json\n...\n```")
      text = text.replace(/[A-Z][^\n]+ \(untrusted metadata\):\n```json\n[\s\S]*?```\n*/g, "")
        .replace(/^\[Queued messages while agent was busy\]\n+---\n+/g, "")
        .replace(/^Queued #\d+\n*/gm, "")
        .trim();
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

    // Assistant message → llm_input + llm_output events, collect tool calls
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
        let costTotal = costObj?.total || 0;
        // Validate cost: negative or absurdly large values are bad data
        if (costTotal < 0 || costTotal > 100) costTotal = 0;

        const textParts: string[] = [];
        const thinkParts: string[] = [];
        for (const b of contentBlocks) {
          if (b.type === "text" && b.text) textParts.push(b.text as string);
          if (b.type === "thinking" && b.thinking) thinkParts.push(b.thinking as string);
        }

        // Determine billing type: Anthropic models = subscription, others = metered
        const lowerModel = model.toLowerCase();
        const isAnthropic = lowerModel.includes("claude") || lowerModel.includes("opus") || lowerModel.includes("sonnet") || lowerModel.includes("haiku");
        const billing = isAnthropic ? "subscription" : "metered";

        events.push({
          ts: ts - 1, type: "llm_input", model, inputTokens: null, outputTokens: null,
          cacheRead: null, cacheWrite: null, cost: null,
          detail: JSON.stringify({ promptPreview: lastUserText?.slice(0, 2000), source: "backfill" }),
          prompt: null, response: null, thinking: null, resolvedModel: null,
          providerCost: null, billing,
        });

        events.push({
          ts, type: "llm_output", model,
          inputTokens, outputTokens, cacheRead, cacheWrite, cost: costTotal,
          detail: null, prompt: lastUserText || null,
          response: textParts.join("\n") || null,
          thinking: thinkParts.join("\n") || null,
          resolvedModel: rawModel || null,
          providerCost: costTotal || null, billing,
        });
        lastUserText = "";
      }
    }

    // Tool result → tool_call event
    if (msg.role === "toolResult" && msg.toolCallId) {
      const callId = msg.toolCallId as string;
      const call = pendingCalls.get(callId);
      if (call) {
        pendingCalls.delete(callId);
        const resultContent = Array.isArray(msg.content)
          ? (msg.content as Array<Record<string, unknown>>).filter(c => c.type === "text").map(c => c.text).join("\n")
          : typeof msg.content === "string" ? msg.content : "";
        events.push({
          ts, type: "tool_call", model: null, inputTokens: null, outputTokens: null,
          cacheRead: null, cacheWrite: null, cost: null,
          detail: JSON.stringify({
            tool: call.name, params: call.args,
            result: resultContent.slice(0, 5000),
            durationMs: (msg.duration_ms as number) || undefined,
            isError: (msg.is_error as boolean) || false,
            source: "backfill",
          }),
          prompt: null, response: null, thinking: null, resolvedModel: null,
          providerCost: null, billing: null,
        });
      }
    }
  }
  return events;
}

// ── Tool field extraction ───────────────────────────────────────

function extractToolFields(detail: string | null): { toolName: string | null; toolQuery: string | null; toolTarget: string | null } {
  if (!detail) return { toolName: null, toolQuery: null, toolTarget: null };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(detail); } catch { return { toolName: null, toolQuery: null, toolTarget: null }; }

  const toolName = (parsed.tool as string) ?? null;
  if (!toolName) return { toolName: null, toolQuery: null, toolTarget: null };

  const params = (parsed.params ?? {}) as Record<string, unknown>;
  let toolQuery: string | null = null;
  let toolTarget: string | null = null;

  switch (toolName) {
    case "web_search": case "WebSearch":
      toolQuery = (params.query as string) ?? null; break;
    case "web_fetch": case "WebFetch":
      toolQuery = (params.url as string) ?? null;
      toolTarget = (params.url as string) ?? null; break;
    case "browser":
      toolTarget = (params.targetUrl as string) ?? (params.url as string) ?? null;
      toolQuery = (params.action as string) ?? null; break;
    case "read": case "Read":
    case "write": case "Write":
    case "edit": case "Edit":
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? null;
      toolQuery = toolTarget; break;
    case "exec": case "Bash":
      toolQuery = typeof params.command === "string" ? params.command.slice(0, 500) : null; break;
    case "memory_search":
      toolQuery = (params.query as string) ?? null; break;
    case "sessions_send": case "message":
      toolTarget = (params.channel as string) ?? (params.to as string) ?? null; break;
    default:
      toolQuery = (params.query as string) ?? (params.url as string) ?? null;
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? null;
  }

  return { toolName, toolQuery, toolTarget };
}

// ── Transcript file discovery ───────────────────────────────────

function discoverTranscripts(agents: AgentMapping): Map<string, { filePath: string; agentKey: string; sessionId: string }> {
  const results = new Map<string, { filePath: string; agentKey: string; sessionId: string }>();

  let agentDirs: string[] = [];
  try {
    agentDirs = fs.readdirSync(AGENTS_DIR).filter(d => {
      try { return fs.statSync(path.join(AGENTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch { return results; }

  for (const agentDir of agentDirs) {
    const sessionsDir = path.join(AGENTS_DIR, agentDir, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;

    let files: string[];
    try { files = fs.readdirSync(sessionsDir); } catch { continue; }

    const agentKey = agents.dirToKey[agentDir] || agentDir;

    for (const file of files) {
      if (!file.includes(".jsonl") || file.startsWith("sessions.json")) continue;
      const match = file.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (!match) continue;
      const sessionId = match[1];
      // Prefer .jsonl over .jsonl.bak
      if (!results.has(sessionId) || file.endsWith(".jsonl")) {
        results.set(sessionId, {
          filePath: path.join(sessionsDir, file),
          agentKey,
          sessionId,
        });
      }
    }
  }

  return results;
}

// ── Step 1: Bootstrap ───────────────────────────────────────────

function step1Bootstrap(db: Database.Database): void {
  banner(1, "Bootstrap DB schema");

  // ── Events table + indexes (matches plugin/event-log.ts getDb()) ──
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
      prompt TEXT,
      response TEXT,
      thinking TEXT,
      resolved_model TEXT,
      provider_cost REAL,
      billing TEXT,
      tool_name TEXT,
      tool_query TEXT,
      tool_target TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_agent_ts ON events(agent, ts);
    CREATE INDEX IF NOT EXISTS idx_run ON events(run_id);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_tool_name ON events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_name_agent ON events(tool_name, agent);
  `);

  // Ensure v2/v3 columns exist on pre-existing DBs
  const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  const extraCols: Array<[string, string]> = [
    ["prompt", "TEXT"], ["response", "TEXT"], ["thinking", "TEXT"],
    ["resolved_model", "TEXT"], ["provider_cost", "REAL"], ["billing", "TEXT"],
    ["tool_name", "TEXT"], ["tool_query", "TEXT"], ["tool_target", "TEXT"],
  ];
  for (const [col, type] of extraCols) {
    if (!colNames.has(col)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
      console.log(`  Added column: events.${col}`);
    }
  }

  // ── Backfill metadata table ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS backfill_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      ts INTEGER NOT NULL
    );
  `);

  // ── Sessions table + indexes ──
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

  // ── Session Analysis table ──
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
    CREATE INDEX IF NOT EXISTS idx_sa_session ON session_analysis(session_key);
    CREATE INDEX IF NOT EXISTS idx_sa_agent ON session_analysis(agent);
    CREATE INDEX IF NOT EXISTS idx_sa_guidelines ON session_analysis(session_key, guidelines_hash);
  `);

  // ── Session Feedback table ──
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

  // ── Deliverables table ──
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

  // ── FTS5 search index ──
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5(
      title,
      body,
      source_type UNINDEXED,
      source_id UNINDEXED,
      source_ts UNINDEXED,
      agent UNINDEXED,
      click_url UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_sync_state (
      source TEXT PRIMARY KEY,
      max_id INTEGER NOT NULL DEFAULT 0,
      last_sync INTEGER NOT NULL DEFAULT 0
    );
  `);

  const eventCount = (db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }).cnt;
  const sessionCount = (db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number }).cnt;
  console.log(`  Existing: ${sessionCount} sessions, ${eventCount} events`);
}

// ── Step 2: Import sessions ─────────────────────────────────────

function step2Sessions(db: Database.Database, agents: AgentMapping): void {
  banner(2, "Import sessions from filesystem");

  const upsertSession = db.prepare(`
    INSERT INTO sessions (session_key, agent, session_id, origin, channel, created_at, updated_at, total_tokens, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      updated_at = MAX(excluded.updated_at, sessions.updated_at),
      total_tokens = MAX(excluded.total_tokens, sessions.total_tokens)
  `);

  let imported = 0;
  let skipped = 0;

  // 2a: Read sessions.json files
  let agentDirs: string[] = [];
  try {
    agentDirs = fs.readdirSync(AGENTS_DIR).filter(d => {
      try { return fs.statSync(path.join(AGENTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch { /* */ }

  for (const agentDir of agentDirs) {
    const sessionsJsonPath = path.join(AGENTS_DIR, agentDir, "sessions", "sessions.json");
    if (!fs.existsSync(sessionsJsonPath)) continue;

    const agentKey = agents.dirToKey[agentDir] || agentDir;
    let sessions: Array<Record<string, unknown>>;
    try {
      const raw = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8"));
      sessions = Array.isArray(raw) ? raw : [];
    } catch { continue; }

    for (const s of sessions) {
      const sessionId = (s.id as string) || (s.sessionId as string) || "";
      if (!sessionId) { skipped++; continue; }

      const sessionKey = `agent:${agentKey}:${(s.channel as string) || "unknown"}:${sessionId}`;
      const origin = `${agentDir}/${sessionId}.jsonl`;

      if (!DRY_RUN) {
        upsertSession.run(
          sessionKey, agentKey, sessionId, origin,
          (s.channel as string) || null,
          s.created_at || s.createdAt || Date.now(),
          s.updated_at || s.updatedAt || Date.now(),
          (s.total_tokens as number) || 0,
          (s.model as string) || null,
        );
      }
      imported++;
    }
  }

  // 2b: Discover orphaned JSONL files (no sessions.json entry)
  const transcripts = discoverTranscripts(agents);
  let orphans = 0;

  for (const [sessionId, info] of transcripts) {
    const exists = db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(sessionId);
    if (exists) continue;

    orphans++;
    const sessionKey = `${info.agentKey}/${sessionId}.jsonl`;

    // Get file stats for timestamps
    let created = Date.now();
    try {
      const stat = fs.statSync(info.filePath);
      created = stat.birthtimeMs || stat.mtimeMs;
    } catch { /* */ }

    if (!DRY_RUN) {
      upsertSession.run(
        sessionKey, info.agentKey, sessionId, sessionKey, null,
        created, created, 0, null,
      );
    }
  }

  console.log(`  Sessions imported: ${imported}`);
  console.log(`  Orphaned transcripts recovered: ${orphans}`);
  console.log(`  Skipped (no ID): ${skipped}`);
}

// ── Step 3: Parse events from transcripts ───────────────────────

function step3Events(db: Database.Database, agents: AgentMapping): void {
  banner(3, "Parse events from JSONL transcripts");

  const transcripts = discoverTranscripts(agents);
  console.log(`  Transcript files on disk: ${transcripts.size}`);

  const insertStmt = db.prepare(
    `INSERT INTO events (ts, agent, session, type, model, input_tokens, output_tokens, cache_read, cache_write, cost, detail, prompt, response, thinking, resolved_model, provider_cost, billing)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let totalInserted = 0;
  let sessionsProcessed = 0;
  let sessionsSkipped = 0;

  const txn = db.transaction(() => {
    for (const [sessionId, info] of transcripts) {
      // Find the session key used in the DB
      const sessionRow = db.prepare("SELECT session_key FROM sessions WHERE session_id = ?").get(sessionId) as { session_key: string } | undefined;
      const sessionKey = sessionRow?.session_key || `${info.agentKey}/${sessionId}.jsonl`;

      // Check if events already exist for this session
      const existing = db.prepare("SELECT COUNT(*) as cnt FROM events WHERE session = ?").get(sessionKey) as { cnt: number };
      if (existing.cnt > 0) { sessionsSkipped++; continue; }

      // Also check alternate key format
      const altKey = `${info.agentKey}/${sessionId}.jsonl`;
      if (altKey !== sessionKey) {
        const altExisting = db.prepare("SELECT COUNT(*) as cnt FROM events WHERE session = ?").get(altKey) as { cnt: number };
        if (altExisting.cnt > 0) { sessionsSkipped++; continue; }
      }

      const events = parseTranscript(info.filePath);
      if (events.length === 0) { sessionsSkipped++; continue; }

      sessionsProcessed++;
      if (!DRY_RUN) {
        for (const evt of events) {
          insertStmt.run(
            evt.ts, info.agentKey, sessionKey, evt.type, evt.model,
            evt.inputTokens, evt.outputTokens, evt.cacheRead, evt.cacheWrite, evt.cost,
            evt.detail, evt.prompt, evt.response, evt.thinking,
            evt.resolvedModel, evt.providerCost, evt.billing,
          );
        }
      }
      totalInserted += events.length;

      if (sessionsProcessed % 50 === 0) {
        process.stdout.write(`\r  Processed ${sessionsProcessed} sessions, ${totalInserted} events...`);
      }
    }
  });

  txn();

  console.log(`\n  Sessions processed: ${sessionsProcessed}`);
  console.log(`  Sessions skipped (already have events): ${sessionsSkipped}`);
  console.log(`  Events inserted: ${totalInserted}`);
}

// ── Step 4: Enrich with v2 data ─────────────────────────────────

function step4Enrich(db: Database.Database, agents: AgentMapping): void {
  banner(4, "Enrich events with model/cost/response data");

  const needEnrichment = (db.prepare(
    "SELECT COUNT(*) as cnt FROM events WHERE type = 'llm_output' AND resolved_model IS NULL"
  ).get() as { cnt: number }).cnt;

  console.log(`  Events needing enrichment: ${needEnrichment}`);
  if (needEnrichment === 0) { console.log("  Nothing to do."); return; }

  const findStmt = db.prepare(`
    SELECT id, ts, model FROM events
    WHERE agent = ? AND type = 'llm_output'
      AND ts BETWEEN ? AND ?
      AND resolved_model IS NULL
    ORDER BY ABS(ts - ?)
    LIMIT 1
  `);

  const updateStmt = db.prepare(`
    UPDATE events SET resolved_model = ?, provider_cost = ?, response = ?, thinking = ?
    WHERE id = ?
  `);

  let enriched = 0;
  let filesScanned = 0;

  let agentDirs: string[] = [];
  try {
    agentDirs = fs.readdirSync(AGENTS_DIR).filter(d => {
      try { return fs.statSync(path.join(AGENTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch { /* */ }

  for (const agentDir of agentDirs) {
    const sessionsPath = path.join(AGENTS_DIR, agentDir, "sessions");
    if (!fs.existsSync(sessionsPath)) continue;

    const agentKey = agents.dirToKey[agentDir] ?? agentDir;
    const files = fs.readdirSync(sessionsPath).filter(f => f.endsWith(".jsonl") && !f.startsWith("sessions.json"));

    for (const file of files) {
      filesScanned++;
      let content: string;
      try { content = fs.readFileSync(path.join(sessionsPath, file), "utf-8"); } catch { continue; }

      for (const line of content.split("\n").filter(Boolean)) {
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== "message") continue;
        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "assistant" || !msg.usage) continue;

        const ts = entry.timestamp ? new Date(entry.timestamp as string).getTime() : 0;
        if (!ts) continue;

        const contentBlocks = (msg.content as Array<Record<string, unknown>>) ?? [];
        const textParts = contentBlocks.filter(b => b.type === "text" && b.text).map(b => b.text as string);
        const thinkParts = contentBlocks.filter(b => b.type === "thinking" && b.thinking).map(b => b.thinking as string);
        const costObj = (msg.usage as Record<string, unknown>).cost as Record<string, number> | undefined;

        const row = findStmt.get(agentKey, ts - 10000, ts + 10000, ts) as { id: number } | undefined;
        if (row && !DRY_RUN) {
          updateStmt.run(
            (msg.model as string) ?? null,
            costObj?.total ?? null,
            textParts.join("\n") || null,
            thinkParts.join("\n") || null,
            row.id,
          );
          enriched++;
        }
      }

      if (filesScanned % 50 === 0) {
        process.stdout.write(`\r  Scanned ${filesScanned} files, ${enriched} enriched...`);
      }
    }
  }

  console.log(`\n  Files scanned: ${filesScanned}`);
  console.log(`  Events enriched: ${enriched}`);
}

// ── Step 5: Backfill prompts ────────────────────────────────────

function step5Prompts(db: Database.Database, agents: AgentMapping): void {
  banner(5, "Recover user input text for llm_input events");

  const needsBackfill = db.prepare(`
    SELECT id, ts, agent, session FROM events
    WHERE type = 'llm_input'
      AND prompt IS NULL
      AND (detail IS NULL OR json_extract(detail, '$.promptPreview') IS NULL)
    ORDER BY ts ASC
  `).all() as Array<{ id: number; ts: number; agent: string; session: string | null }>;

  console.log(`  Events needing prompt data: ${needsBackfill.length}`);
  if (needsBackfill.length === 0) { console.log("  Nothing to do."); return; }

  // Group by session
  const sessionEvents = new Map<string, Array<{ id: number; ts: number }>>();
  for (const evt of needsBackfill) {
    if (!evt.session) continue;
    if (!sessionEvents.has(evt.session)) sessionEvents.set(evt.session, []);
    sessionEvents.get(evt.session)!.push({ id: evt.id, ts: evt.ts });
  }

  // Build session key → transcript path(s) map
  const transcripts = discoverTranscripts(agents);
  const sessionToFile = new Map<string, string>();
  // Also build agent → all transcript paths for fallback matching
  const agentToFiles = new Map<string, string[]>();
  for (const [sessionId, info] of transcripts) {
    sessionToFile.set(`${info.agentKey}/${sessionId}.jsonl`, info.filePath);
    if (!agentToFiles.has(info.agentKey)) agentToFiles.set(info.agentKey, []);
    agentToFiles.get(info.agentKey)!.push(info.filePath);
    // Also map DB session keys
    const row = db.prepare("SELECT session_key, origin FROM sessions WHERE session_id = ?").get(sessionId) as { session_key: string; origin: string | null } | undefined;
    if (row) {
      sessionToFile.set(row.session_key, info.filePath);
      if (row.origin) sessionToFile.set(row.origin, info.filePath);
    }
  }

  // Resolve orphan session keys: "main/UUID.jsonl" format
  for (const sessionKey of sessionEvents.keys()) {
    if (sessionToFile.has(sessionKey)) continue;
    const fsMatch = sessionKey.match(/^([\w][\w-]*)\/([0-9a-f-]{36})\.jsonl$/);
    if (fsMatch) {
      const info = transcripts.get(fsMatch[2]);
      if (info) sessionToFile.set(sessionKey, info.filePath);
    }
  }

  const updateStmt = db.prepare(`
    UPDATE events SET detail = CASE
      WHEN detail IS NULL THEN json_object('promptPreview', ?, 'source', 'prompt-backfill')
      ELSE json_set(detail, '$.promptPreview', ?)
    END
    WHERE id = ?
  `);

  let updated = 0;
  let resolvedViaAgent = 0;

  // Extract user messages from a transcript file
  function extractUserMsgs(filePath: string): Array<{ ts: number; text: string }> {
    let content: string;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { return []; }
    const msgs: Array<{ ts: number; text: string }> = [];
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (!msg || msg.role !== "user") continue;
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        if (!ts) continue;
        let text = "";
        if (typeof msg.content === "string") text = msg.content;
        else if (Array.isArray(msg.content)) {
          text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        }
        if (text) msgs.push({ ts, text: text.slice(0, 2048) });
      } catch { continue; }
    }
    msgs.sort((a, b) => a.ts - b.ts);
    return msgs;
  }

  // Cache of agent → merged user messages (for agent:*:main fallback)
  const agentMsgCache = new Map<string, Array<{ ts: number; text: string }>>();

  function getAgentMsgs(agentKey: string): Array<{ ts: number; text: string }> {
    if (agentMsgCache.has(agentKey)) return agentMsgCache.get(agentKey)!;
    const files = agentToFiles.get(agentKey) ?? [];
    const allMsgs: Array<{ ts: number; text: string }> = [];
    for (const f of files) allMsgs.push(...extractUserMsgs(f));
    allMsgs.sort((a, b) => a.ts - b.ts);
    agentMsgCache.set(agentKey, allMsgs);
    return allMsgs;
  }

  const txn = db.transaction(() => {
    for (const [sessionKey, events] of sessionEvents) {
      const filePath = sessionToFile.get(sessionKey);
      let userMsgs: Array<{ ts: number; text: string }>;

      if (filePath) {
        userMsgs = extractUserMsgs(filePath);
      } else {
        // Fallback: for "agent:{key}:main" or unresolved keys, search all agent transcripts
        const agentMatch = sessionKey.match(/^agent:([^:]+):/);
        if (agentMatch) {
          userMsgs = getAgentMsgs(agentMatch[1]);
          if (userMsgs.length > 0) resolvedViaAgent++;
        } else {
          continue;
        }
      }

      if (userMsgs.length === 0) continue;

      // Match each llm_input to the last preceding user message
      for (const evt of events) {
        let best: { ts: number; text: string } | null = null;
        for (const msg of userMsgs) {
          if (msg.ts <= evt.ts) best = msg;
          else break;
        }
        if (best && !DRY_RUN) {
          updateStmt.run(best.text, best.text, evt.id);
          updated++;
        }
      }
    }
  });

  txn();
  console.log(`  Events updated with prompt data: ${updated}`);
  if (resolvedViaAgent > 0) console.log(`  Sessions resolved via agent-level transcript scan: ${resolvedViaAgent}`);
}

// ── Step 6: Extract tool columns ────────────────────────────────

function step6Tools(db: Database.Database): void {
  banner(6, "Extract tool metadata from event detail JSON");

  const total = (db.prepare(
    "SELECT COUNT(*) as total FROM events WHERE type = 'tool_call' AND tool_name IS NULL AND detail IS NOT NULL"
  ).get() as { total: number }).total;

  console.log(`  Tool events to process: ${total}`);
  if (total === 0) { console.log("  Nothing to do."); return; }

  const BATCH = 1000;
  const selectBatch = db.prepare(
    `SELECT id, detail FROM events WHERE type = 'tool_call' AND tool_name IS NULL AND detail IS NOT NULL ORDER BY id ASC LIMIT ?`
  );
  const update = db.prepare(
    "UPDATE events SET tool_name = ?, tool_query = ?, tool_target = ? WHERE id = ?"
  );

  let processed = 0;
  let updated = 0;
  let lastId = 0;

  const selectBatchAfter = db.prepare(
    `SELECT id, detail FROM events WHERE type = 'tool_call' AND tool_name IS NULL AND detail IS NOT NULL AND id > ? ORDER BY id ASC LIMIT ?`
  );

  while (true) {
    const rows = (DRY_RUN ? selectBatchAfter.all(lastId, BATCH) : selectBatch.all(BATCH)) as Array<{ id: number; detail: string }>;
    if (rows.length === 0) break;

    const tx = db.transaction(() => {
      for (const row of rows) {
        const { toolName, toolQuery, toolTarget } = extractToolFields(row.detail);
        if (toolName && !DRY_RUN) {
          update.run(toolName, toolQuery, toolTarget, row.id);
          updated++;
        }
        processed++;
        if (row.id > lastId) lastId = row.id;
      }
    });
    tx();
    process.stdout.write(`\r  Processed ${processed}/${total} (${updated} updated)`);
  }

  console.log(`\n  Tool events updated: ${updated}`);
}

// ── Step 7: Classify session sources ────────────────────────────

function step7Sources(db: Database.Database): void {
  banner(7, "Classify session sources");

  const unclassified = db.prepare(
    "SELECT session_key, agent, session_id, origin, channel FROM sessions WHERE source IS NULL"
  ).all() as Array<{ session_key: string; agent: string; session_id: string | null; origin: string | null; channel: string | null }>;

  console.log(`  Sessions needing source classification: ${unclassified.length}`);
  if (unclassified.length === 0) { console.log("  Nothing to do."); return; }

  const updateSource = db.prepare("UPDATE sessions SET source = ? WHERE session_key = ?");

  let classified = 0;

  const txn = db.transaction(() => {
    for (const s of unclassified) {
      let source = "agent"; // default

      const key = (s.session_key + (s.origin || "") + (s.channel || "")).toLowerCase();

      // Heuristic classification
      if (key.includes("heartbeat") || key.includes("health-check")) {
        source = "heartbeat";
      } else if (key.includes("cron") || key.includes("scheduled")) {
        source = "cron";
      } else if (key.includes("webchat") || key.includes("web:")) {
        source = "agent"; // web sessions are agent-driven
      }

      if (!DRY_RUN) {
        updateSource.run(source, s.session_key);
      }
      classified++;
    }
  });

  txn();
  console.log(`  Sessions classified: ${classified}`);
}

// ── Step 8: Retroactive cost calculation ─────────────────────────

interface ModelPricing {
  input: number;   // $/1M tokens
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  opus:      { input: 15,    output: 75,    cacheRead: 1.5,   cacheWrite: 18.75 },
  sonnet:    { input: 3,     output: 15,    cacheRead: 0.3,   cacheWrite: 3.75 },
  haiku:     { input: 0.25,  output: 1.25,  cacheRead: 0.025, cacheWrite: 0.3125 },
  "gpt-4o":  { input: 2.5,   output: 10,    cacheRead: 1.25,  cacheWrite: 0 },
  "gpt-4":   { input: 30,    output: 60,    cacheRead: 0,     cacheWrite: 0 },
  deepseek:  { input: 0.27,  output: 1.10,  cacheRead: 0.07,  cacheWrite: 0 },
  gemini:    { input: 0.15,  output: 0.60,  cacheRead: 0.04,  cacheWrite: 0 },
  llama:     { input: 0.20,  output: 0.80,  cacheRead: 0,     cacheWrite: 0 },
  qwen:      { input: 0.15,  output: 0.60,  cacheRead: 0,     cacheWrite: 0 },
  nemotron:  { input: 0.20,  output: 0.80,  cacheRead: 0,     cacheWrite: 0 },
};
const FALLBACK_PRICING: ModelPricing = { input: 1.0, output: 4.0, cacheRead: 0.25, cacheWrite: 0 };
const OPENROUTER_AUTO_PRICING: ModelPricing = { input: 0.10, output: 0.40, cacheRead: 0.025, cacheWrite: 0 };

function estimateCost(model: string, inputTokens: number, outputTokens: number, cacheRead: number, cacheWrite: number): number {
  const lower = model.toLowerCase();
  let pricing: ModelPricing | undefined;

  // Longest-key-first substring match
  const keys = Object.keys(PRICING_TABLE).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key.toLowerCase())) { pricing = PRICING_TABLE[key]; break; }
  }

  if (!pricing && lower.includes("openrouter/")) {
    pricing = (lower.includes("/auto") || lower.includes("/free")) ? OPENROUTER_AUTO_PRICING : FALLBACK_PRICING;
  }
  if (!pricing) pricing = FALLBACK_PRICING;

  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    (cacheWrite / 1_000_000) * pricing.cacheWrite
  );
}

function step8Costs(db: Database.Database): void {
  banner(8, "Retroactive cost calculation from token counts");

  // Find llm_output events missing provider_cost but having token data
  const total = (db.prepare(`
    SELECT COUNT(*) as cnt FROM events
    WHERE type = 'llm_output'
      AND provider_cost IS NULL
      AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
      AND COALESCE(resolved_model, model) IS NOT NULL
  `).get() as { cnt: number }).cnt;

  console.log(`  Events needing cost calculation: ${total}`);
  if (total === 0) { console.log("  Nothing to do."); return; }

  const BATCH = 1000;
  const selectBatch = db.prepare(`
    SELECT id, COALESCE(resolved_model, model) as model,
           COALESCE(input_tokens, 0) as input_tokens,
           COALESCE(output_tokens, 0) as output_tokens,
           COALESCE(cache_read, 0) as cache_read,
           COALESCE(cache_write, 0) as cache_write,
           cost
    FROM events
    WHERE type = 'llm_output'
      AND provider_cost IS NULL
      AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
      AND COALESCE(resolved_model, model) IS NOT NULL
      AND id > ?
    ORDER BY id ASC LIMIT ?
  `);

  const updateStmt = db.prepare("UPDATE events SET provider_cost = ?, cost = COALESCE(cost, ?) WHERE id = ?");

  let processed = 0;
  let updated = 0;
  let lastId = 0;

  while (true) {
    const rows = selectBatch.all(lastId, BATCH) as Array<{
      id: number; model: string;
      input_tokens: number; output_tokens: number;
      cache_read: number; cache_write: number;
      cost: number | null;
    }>;
    if (rows.length === 0) break;

    const tx = db.transaction(() => {
      for (const row of rows) {
        const est = estimateCost(row.model, row.input_tokens, row.output_tokens, row.cache_read, row.cache_write);
        if (est > 0 && !DRY_RUN) {
          updateStmt.run(est, est, row.id);
          updated++;
        }
        processed++;
        if (row.id > lastId) lastId = row.id;
      }
    });
    tx();
    process.stdout.write(`\r  Processed ${processed}/${total} (${updated} updated)`);
  }

  console.log(`\n  Events with cost calculated: ${updated}`);
}

// ── Step 9: Enrich sessions from event data ─────────────────────

function step9SessionEnrich(db: Database.Database): void {
  banner(9, "Enrich sessions from event data");

  // Find sessions missing channel (primary enrichment indicator) or model
  const sessions = db.prepare(`
    SELECT s.session_key,
           COALESCE(s.total_tokens, 0) as total_tokens,
           s.channel, s.model
    FROM sessions s
    WHERE s.channel IS NULL
       OR s.model IS NULL
  `).all() as Array<{
    session_key: string;
    total_tokens: number;
    channel: string | null;
    model: string | null;
  }>;

  console.log(`  Sessions needing enrichment: ${sessions.length}`);
  if (sessions.length === 0) { console.log("  Nothing to do."); return; }

  const getEventAgg = db.prepare(`
    SELECT
      SUM(COALESCE(input_tokens, 0)) as total_input,
      SUM(COALESCE(output_tokens, 0)) as total_output,
      SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens
    FROM events WHERE session = ? AND type = 'llm_output'
  `);

  const getTopModel = db.prepare(`
    SELECT COALESCE(resolved_model, model) as m, COUNT(*) as n
    FROM events
    WHERE session = ? AND type = 'llm_output' AND COALESCE(resolved_model, model) IS NOT NULL
    GROUP BY m ORDER BY n DESC LIMIT 1
  `);

  const updateSession = db.prepare(`
    UPDATE sessions SET
      total_tokens = ?,
      input_tokens = ?,
      output_tokens = ?,
      channel = COALESCE(channel, ?),
      model = COALESCE(model, ?)
    WHERE session_key = ?
  `);

  let enriched = 0;
  const txn = db.transaction(() => {
    for (const s of sessions) {
      const agg = getEventAgg.get(s.session_key) as {
        total_input: number; total_output: number; total_tokens: number;
      } | undefined;

      const topModel = getTopModel.get(s.session_key) as { m: string; n: number } | undefined;

      // Derive channel from session_key pattern
      let channel: string | null = s.channel;
      if (!channel) {
        const key = s.session_key.toLowerCase();
        if (key.includes(":discord:")) channel = "discord";
        else if (key.includes(":slack:")) channel = "slack";
        else if (key.includes(":cron:")) channel = "cron";
        else if (key.includes(":webchat:") || key.includes(":web:")) channel = "webchat";
        else if (key.includes(":telegram:")) channel = "telegram";
        else if (key.includes(":signal:")) channel = "signal";
        else channel = "main"; // default for agent sessions
      }

      if (!DRY_RUN) {
        updateSession.run(
          agg?.total_tokens || 0,
          agg?.total_input || 0,
          agg?.total_output || 0,
          channel,
          topModel?.m || "unknown",
          s.session_key,
        );
      }
      enriched++;
    }
  });
  txn();
  console.log(`  Sessions enriched: ${enriched}`);
}

// ── Step 10: Enrich billing column ──────────────────────────────

function step10Billing(db: Database.Database): void {
  banner(10, "Backfill billing column for events");

  const total = (db.prepare(`
    SELECT COUNT(*) as cnt FROM events WHERE billing IS NULL
  `).get() as { cnt: number }).cnt;

  console.log(`  Events needing billing: ${total}`);
  if (total === 0) { console.log("  Nothing to do."); return; }

  // Set billing based on model: metered models get "metered", rest get "subscription"
  const metered_patterns = ["openrouter/", "gpt-", "deepseek", "gemini", "llama", "qwen", "nemotron", "mistral"];

  if (!DRY_RUN) {
    // Events with llm_output/llm_input types get billing based on model
    let updated = 0;

    // First: set "subscription" for all Anthropic models (default)
    const r1 = db.prepare(`
      UPDATE events SET billing = 'subscription'
      WHERE billing IS NULL
        AND (type = 'llm_input' OR type = 'llm_output')
        AND (COALESCE(resolved_model, model) LIKE '%claude%'
          OR COALESCE(resolved_model, model) LIKE '%opus%'
          OR COALESCE(resolved_model, model) LIKE '%sonnet%'
          OR COALESCE(resolved_model, model) LIKE '%haiku%')
    `).run();
    updated += r1.changes;

    // Second: set "metered" for non-Anthropic models
    const r2 = db.prepare(`
      UPDATE events SET billing = 'metered'
      WHERE billing IS NULL
        AND (type = 'llm_input' OR type = 'llm_output')
        AND COALESCE(resolved_model, model) IS NOT NULL
    `).run();
    updated += r2.changes;

    // Third: set "subscription" for tool_call and msg_in (non-billable)
    const r3 = db.prepare(`
      UPDATE events SET billing = 'subscription'
      WHERE billing IS NULL
        AND type IN ('tool_call', 'msg_in', 'agent_silence', 'model_drift', 'loop_detected')
    `).run();
    updated += r3.changes;

    console.log(`  Events updated: ${updated}`);
  } else {
    console.log(`  Would update: ${total} events`);
  }
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║              Deck — Full Data Backfill Pipeline           ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`  DB:         ${DB_PATH}`);
  console.log(`  Agents dir: ${AGENTS_DIR}`);
  console.log(`  Deck root:  ${DECK_ROOT}`);
  console.log(`  Dry run:    ${DRY_RUN}`);
  if (ONLY_STEP) console.log(`  Running:    step ${ONLY_STEP} only`);
  else if (FROM_STEP > 1) console.log(`  Running:    steps ${FROM_STEP}-10`);

  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`\nNo agents directory found at ${AGENTS_DIR}`);
    console.error("This means OpenClaw hasn't created any agent sessions yet.");
    console.error("Start OpenClaw and run at least one agent session, then try again.");
    process.exit(1);
  }

  // Ensure DB directory exists
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`  Created DB directory: ${dbDir}`);
  }

  // Auto-backup before writing (keep max 3)
  if (!DRY_RUN && fs.existsSync(DB_PATH)) {
    const base = path.basename(DB_PATH);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dbDir, `${base}.backup-${ts}`);
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`  Backup: ${backupPath}`);
    const backups = fs.readdirSync(dbDir)
      .filter(f => f.startsWith(`${base}.backup-`))
      .sort()
      .reverse();
    for (const old of backups.slice(3)) {
      fs.unlinkSync(path.join(dbDir, old));
      console.log(`  Pruned old backup: ${old}`);
    }
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 10000");

  const agents = loadAgentConfig();

  const startTime = Date.now();

  if (shouldRun(1)) step1Bootstrap(db);
  if (shouldRun(2)) step2Sessions(db, agents);
  if (shouldRun(3)) step3Events(db, agents);
  if (shouldRun(4)) step4Enrich(db, agents);
  if (shouldRun(5)) step5Prompts(db, agents);
  if (shouldRun(6)) step6Tools(db);
  if (shouldRun(7)) step7Sources(db);
  if (shouldRun(8)) step8Costs(db);
  if (shouldRun(9)) step9SessionEnrich(db);
  if (shouldRun(10)) step10Billing(db);

  // Final summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const eventCount = (db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }).cnt;
  const sessionCount = (db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number }).cnt;
  const enrichedCount = (db.prepare("SELECT COUNT(*) as cnt FROM events WHERE type = 'llm_output' AND resolved_model IS NOT NULL").get() as { cnt: number }).cnt;
  const toolCount = (db.prepare("SELECT COUNT(*) as cnt FROM events WHERE tool_name IS NOT NULL").get() as { cnt: number }).cnt;
  const costCount = (db.prepare("SELECT COUNT(*) as cnt FROM events WHERE provider_cost IS NOT NULL AND provider_cost > 0").get() as { cnt: number }).cnt;
  const promptCount = (db.prepare("SELECT COUNT(*) as cnt FROM events WHERE detail LIKE '%promptPreview%'").get() as { cnt: number }).cnt;

  console.log(`\n${"═".repeat(60)}`);
  console.log("  Backfill complete!");
  console.log(`${"═".repeat(60)}`);
  console.log(`  Time:       ${elapsed}s`);
  console.log(`  Sessions:   ${sessionCount}`);
  console.log(`  Events:     ${eventCount}`);
  console.log(`  Enriched:   ${enrichedCount} llm_output events with model data`);
  console.log(`  Costed:     ${costCount} events with provider_cost`);
  console.log(`  Prompts:    ${promptCount} events with prompt preview`);
  console.log(`  Tools:      ${toolCount} events with tool metadata`);
  console.log(`  DB:         ${DB_PATH}`);
  if (DRY_RUN) console.log("\n  ⚠  DRY RUN — no data was written. Run without --dry-run to apply.");
  console.log();

  db.close();
}

main();
