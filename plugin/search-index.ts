/**
 * FTS5-based full-text search index for Deck.
 *
 * Indexes events, sessions, session_analysis, deliverables, agent_activities,
 * heartbeats, config files, and markdown docs into a single FTS5 virtual table.
 * Incremental sync via high-water marks — no triggers needed.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

// Resolve the primary/workspace agent key for knowledge page deep-links.
// Falls back to first agent in config, then "agent" if config is unavailable.
const DECK_ROOT = process.env.DECK_ROOT || path.resolve(__dirname, "..");
let _workspaceAgentKey = "agent";
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(DECK_ROOT, "config/deck-agents.json"), "utf-8"));
  if (cfg.agents?.[0]?.key) _workspaceAgentKey = cfg.agents[0].key;
} catch { /* use fallback */ }

// ── Schema ──────────────────────────────────────────────────────────

export function ensureSearchIndex(db: Database.Database): void {
  // FTS5 virtual table — porter stemmer for English
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

  // High-water marks for incremental sync
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_sync_state (
      source TEXT PRIMARY KEY,
      max_id INTEGER NOT NULL DEFAULT 0,
      last_sync INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// ── Incremental Sync ────────────────────────────────────────────────

const SYNC_BATCH = 1000;
const FS_SCAN_TTL = 5 * 60 * 1000; // 5 minutes

interface SyncState {
  source: string;
  max_id: number;
  last_sync: number;
}

function getSyncState(db: Database.Database, source: string): SyncState {
  const row = db.prepare("SELECT source, max_id, last_sync FROM search_sync_state WHERE source = ?").get(source) as SyncState | undefined;
  return row ?? { source, max_id: 0, last_sync: 0 };
}

function setSyncState(db: Database.Database, source: string, maxId: number): void {
  db.prepare(
    "INSERT INTO search_sync_state (source, max_id, last_sync) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET max_id = ?, last_sync = ?"
  ).run(source, maxId, Date.now(), maxId, Date.now());
}

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const insertIdx = `INSERT INTO search_idx (title, body, source_type, source_id, source_ts, agent, click_url)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

function syncEvents(db: Database.Database): void {
  const state = getSyncState(db, "events");
  const rows = db.prepare(
    `SELECT id, ts, agent, session, type, model, tool_name, tool_query, tool_target, detail, response, thinking
     FROM events WHERE id > ? ORDER BY id LIMIT ?`
  ).all(state.max_id, SYNC_BATCH) as Array<{
    id: number; ts: number; agent: string; session: string; type: string;
    model: string; tool_name: string; tool_query: string; tool_target: string;
    detail: string; response: string; thinking: string;
  }>;

  if (rows.length === 0) return;
  const stmt = db.prepare(insertIdx);
  const tx = db.transaction(() => {
    for (const r of rows) {
      let title: string;
      let body: string;

      if (r.type === "tool_call" && r.tool_name) {
        title = r.tool_query ? `${r.tool_name}: ${truncate(r.tool_query, 100)}` : r.tool_name;
        body = truncate(r.tool_target || r.detail || "", 500);
      } else if (r.type === "llm_output") {
        title = `LLM Response: ${r.model || "unknown"}`;
        body = truncate(r.response || "", 400) + (r.thinking ? "\n" + truncate(r.thinking, 100) : "");
      } else if (r.type === "llm_input") {
        title = `LLM Input: ${r.model || "unknown"}`;
        body = ""; // prompts are very large, skip indexing body
      } else {
        // Other event types: message_received, cron_error, etc.
        title = `${r.type}: ${r.agent}`;
        let detailText = "";
        if (r.detail) {
          try { detailText = JSON.stringify(JSON.parse(r.detail)); } catch { detailText = r.detail; }
        }
        body = truncate(detailText, 500);
      }

      stmt.run(title, body, "event", String(r.id), r.ts, r.agent, `/logs?highlight=${r.id}`);
    }
    setSyncState(db, "events", rows[rows.length - 1].id);
  });
  tx();
}

function syncSessions(db: Database.Database): void {
  const state = getSyncState(db, "sessions");
  const rows = db.prepare(
    `SELECT id, session_key, agent, channel, display_name, label, model, updated_at, session_id
     FROM sessions WHERE id > ? ORDER BY id LIMIT ?`
  ).all(state.max_id, SYNC_BATCH) as Array<{
    id: number; session_key: string; agent: string; channel: string;
    display_name: string; label: string; model: string; updated_at: number; session_id: string;
  }>;

  if (rows.length === 0) return;
  const stmt = db.prepare(insertIdx);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const title = r.display_name || r.session_key;
      const body = [r.agent, r.channel, r.label, r.model].filter(Boolean).join(" · ");
      stmt.run(title, body, "session", String(r.id), r.updated_at, r.agent, `/sessions`);
    }
    setSyncState(db, "sessions", rows[rows.length - 1].id);
  });
  tx();
}

function syncAnalysis(db: Database.Database): void {
  const state = getSyncState(db, "session_analysis");
  const rows = db.prepare(
    `SELECT id, session_key, agent, computed_at, llm_summary, llm_critique
     FROM session_analysis WHERE id > ? ORDER BY id LIMIT ?`
  ).all(state.max_id, SYNC_BATCH) as Array<{
    id: number; session_key: string; agent: string; computed_at: number;
    llm_summary: string; llm_critique: string;
  }>;

  if (rows.length === 0) return;
  const stmt = db.prepare(insertIdx);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const title = `Analysis: ${r.agent}`;
      const body = truncate(r.llm_summary || "", 1500) + (r.llm_critique ? "\n" + truncate(r.llm_critique, 500) : "");
      stmt.run(title, body, "analysis", String(r.id), r.computed_at, r.agent, `/analysis`);
    }
    setSyncState(db, "session_analysis", rows[rows.length - 1].id);
  });
  tx();
}

function syncDeliverables(db: Database.Database): void {
  const state = getSyncState(db, "deliverables");
  const rows = db.prepare(
    `SELECT id, agent, main_type, main_label, main_target, last_ts
     FROM deliverables WHERE id > ? ORDER BY id LIMIT ?`
  ).all(state.max_id, SYNC_BATCH) as Array<{
    id: number; agent: string; main_type: string; main_label: string;
    main_target: string; last_ts: number;
  }>;

  if (rows.length === 0) return;
  const stmt = db.prepare(insertIdx);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const title = r.main_label;
      const body = [r.main_type, r.main_target, r.agent].filter(Boolean).join(" · ");
      stmt.run(title, body, "deliverable", String(r.id), r.last_ts, r.agent, `/analysis#deliverables`);
    }
    setSyncState(db, "deliverables", rows[rows.length - 1].id);
  });
  tx();
}

function syncActivities(db: Database.Database): void {
  const state = getSyncState(db, "agent_activities");
  const rows = db.prepare(
    `SELECT id, type, agent_key, agent_name, message, timestamp
     FROM agent_activities WHERE id > ? ORDER BY id LIMIT ?`
  ).all(state.max_id, SYNC_BATCH) as Array<{
    id: number; type: string; agent_key: string; agent_name: string;
    message: string; timestamp: number;
  }>;

  if (rows.length === 0) return;
  const stmt = db.prepare(insertIdx);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const title = `${r.agent_name || r.agent_key}: ${r.type}`;
      stmt.run(title, r.message || "", "activity", String(r.id), r.timestamp, r.agent_key || "", `/`);
    }
    setSyncState(db, "agent_activities", rows[rows.length - 1].id);
  });
  tx();
}

function syncHeartbeats(db: Database.Database): void {
  const state = getSyncState(db, "heartbeats");
  const rows = db.prepare(
    `SELECT id, agent_key, status, model, bio, last_heartbeat
     FROM heartbeats WHERE id > ? ORDER BY id LIMIT ?`
  ).all(state.max_id, SYNC_BATCH) as Array<{
    id: number; agent_key: string; status: string; model: string;
    bio: string; last_heartbeat: number;
  }>;

  if (rows.length === 0) return;
  const stmt = db.prepare(insertIdx);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const title = r.agent_key;
      const body = [r.status, r.model, r.bio].filter(Boolean).join(" · ");
      stmt.run(title, body, "heartbeat", String(r.id), r.last_heartbeat, r.agent_key, `/`);
    }
    setSyncState(db, "heartbeats", rows[rows.length - 1].id);
  });
  tx();
}

/** Sync all SQLite source tables into the FTS5 index. */
export function syncSearchIndex(db: Database.Database): void {
  syncEvents(db);
  syncSessions(db);
  syncAnalysis(db);
  syncDeliverables(db);
  syncActivities(db);
  syncHeartbeats(db);
}

// ── Filesystem Scan ─────────────────────────────────────────────────

const OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const WORKSPACE = path.join(OPENCLAW_HOME, "workspace");

interface FileEntry {
  filePath: string;
  relativePath: string;
  sourceType: "config" | "doc";
  clickUrl: string;
}

function collectFiles(): FileEntry[] {
  const entries: FileEntry[] = [];

  // Config files
  const configFiles = [
    { abs: path.join(OPENCLAW_HOME, "openclaw.json"), rel: "openclaw.json", url: "/config" },
    { abs: path.join(OPENCLAW_HOME, "cron", "jobs.json"), rel: "cron/jobs.json", url: "/config#crons" },
    { abs: path.join(OPENCLAW_HOME, "exec-approvals.json"), rel: "exec-approvals.json", url: "/config#exec" },
  ];
  for (const cf of configFiles) {
    if (fs.existsSync(cf.abs)) {
      entries.push({ filePath: cf.abs, relativePath: cf.rel, sourceType: "config", clickUrl: cf.url });
    }
  }

  // Deck config files
  const deckConfigDir = path.join(process.cwd(), "config");
  if (fs.existsSync(deckConfigDir)) {
    for (const f of ["agents.json", "config.json"]) {
      const abs = path.join(deckConfigDir, f);
      if (fs.existsSync(abs)) {
        entries.push({ filePath: abs, relativePath: `deck-config/${f}`, sourceType: "config", clickUrl: "/deck-config" });
      }
    }
  }

  // Markdown docs + memory under workspace
  if (fs.existsSync(WORKSPACE)) {
    walkMarkdown(WORKSPACE, entries, 0);
  }

  return entries;
}

const WALK_SKIP = new Set([
  "node_modules", "dist", "__pycache__", "test-results", "e2e", "__tests__",
  "playwright-report", ".next", ".git", "coverage",
]);

/** Map a workspace-relative path to a knowledge page deep-link.
 *  Knowledge page hash format: #docs/<agentName>/<folder>/<filename_without_ext>
 *  The page decodes the hash with decodeURIComponent, then splits on "/" and matches case-insensitively. */
function docClickUrl(rel: string): string {
  const name = path.basename(rel, path.extname(rel));
  // workspace/docs/** → shared-docs or sub-folder (visible under workspace agent)
  // readMdFilesRecursive logic: depth-0 subdirs get capitalized names (not nested under "shared-docs")
  // e.g. docs/session-logs/foo.md → folder "Session-logs", docs/foo.md → folder "shared-docs"
  if (rel.startsWith("docs/")) {
    const subPath = rel.slice("docs/".length);
    const parts = subPath.split("/");
    let folder: string;
    if (parts.length === 1) {
      // File directly in docs/ → "shared-docs" folder
      folder = "shared-docs";
    } else {
      // File in docs/subdir/... → capitalize first subdir, rest joined with /
      const topDir = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      folder = parts.length === 2 ? topDir : `${topDir}/${parts.slice(1, -1).join("/")}`;
    }
    return `/knowledge#docs/${_workspaceAgentKey}/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`;
  }
  // workspace/dashboard/<deck-dir>/research/** or audit/**
  const deckDirName = path.basename(DECK_ROOT);
  const deckPrefix = `dashboard/${deckDirName}/`;
  if (rel.startsWith(deckPrefix)) {
    const sub = rel.slice(deckPrefix.length);
    const parts = sub.split("/");
    if (parts.length >= 2 && (parts[0] === "research" || parts[0] === "audit")) {
      const folder = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      return `/knowledge#docs/${_workspaceAgentKey}/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`;
    }
  }
  // workspace root .md files → Workspace folder under Jane
  if (!rel.includes("/")) {
    return `/knowledge#docs/${_workspaceAgentKey}/${encodeURIComponent("Workspace")}/${encodeURIComponent(name)}`;
  }
  // Fallback: just go to docs tab
  return "/knowledge#docs";
}

function walkMarkdown(dir: string, entries: FileEntry[], depth: number): void {
  if (depth > 4) return; // limit depth
  let items: string[];
  try { items = fs.readdirSync(dir); } catch { return; }
  for (const item of items) {
    if (item.startsWith(".") || WALK_SKIP.has(item)) continue;
    const abs = path.join(dir, item);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) {
      walkMarkdown(abs, entries, depth + 1);
    } else if (item.endsWith(".md") || item.endsWith(".mdx")) {
      const rel = path.relative(WORKSPACE, abs);
      entries.push({ filePath: abs, relativePath: rel, sourceType: "doc", clickUrl: docClickUrl(rel) });
    }
  }
}

/** Sync filesystem content (config + docs) into search index. Respects TTL. */
export function syncFilesystemContent(db: Database.Database): void {
  const state = getSyncState(db, "filesystem");
  if (Date.now() - state.last_sync < FS_SCAN_TTL && state.max_id > 0) return;

  const files = collectFiles();
  // Delete old filesystem entries and re-insert (simpler than mtime tracking)
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM search_idx WHERE source_type IN ('config', 'doc')").run();
    const stmt = db.prepare(insertIdx);
    for (const f of files) {
      let content: string;
      try { content = fs.readFileSync(f.filePath, "utf-8"); } catch { continue; }
      const title = path.basename(f.filePath);
      const maxLen = f.sourceType === "config" ? 20000 : 5000;
      const body = truncate(content, maxLen);
      let mtime: number;
      try { mtime = fs.statSync(f.filePath).mtimeMs; } catch { mtime = Date.now(); }
      stmt.run(title, body, f.sourceType, f.relativePath, Math.floor(mtime), "", f.clickUrl);
    }
    setSyncState(db, "filesystem", files.length);
  });
  tx();
}

// ── Query ───────────────────────────────────────────────────────────

export interface SearchParams {
  query: string;
  types?: string[];        // filter by source_type
  agent?: string;          // filter by agent
  from?: number;           // epoch ms
  to?: number;             // epoch ms
  limit?: number;          // per group
}

export interface SearchResult {
  title: string;
  snippet: string;
  sourceType: string;
  sourceId: string;
  timestamp: number;
  agent: string;
  clickUrl: string;
}

export interface SearchGroup {
  type: string;
  label: string;
  count: number;
  results: SearchResult[];
}

export interface SearchResponse {
  query: string;
  totalHits: number;
  groups: SearchGroup[];
}

const TYPE_LABELS: Record<string, string> = {
  event: "Events",
  session: "Sessions",
  analysis: "Analysis",
  deliverable: "Deliverables",
  activity: "Activities",
  heartbeat: "Agents",
  config: "Config",
  doc: "Docs",
};

/** Sanitize user query for FTS5 — escape special chars that could cause syntax errors. */
function sanitizeFts5Query(raw: string): string {
  // If the user explicitly uses quotes, pass through as-is
  if (/^".*"$/.test(raw.trim())) return raw;
  // Split on whitespace, then expand dotted terms (e.g. "a.b.c" → "a b c")
  // so they match across JSON structure where keys are on separate lines
  const rawTerms = raw.trim().split(/\s+/).filter(Boolean);
  if (rawTerms.length === 0) return '""';
  const terms: string[] = [];
  for (const t of rawTerms) {
    if (/^[\w]+(?:\.[\w]+)+$/.test(t)) {
      // Pure dotted path like "compaction.memoryFlush.enabled" — split into words
      terms.push(...t.split("."));
    } else if (/[.*^:{}[\]\\()/<>!@#$%&=+,;\-]/.test(t) || /\b(AND|OR|NOT|NEAR)\b/.test(t)) {
      // Quote terms with special chars
      terms.push(`"${t.replace(/"/g, '""')}"`);
    } else {
      terms.push(t);
    }
  }
  return terms.join(" ");
}

export function searchQuery(db: Database.Database, params: SearchParams): SearchResponse {
  const ftsQuery = sanitizeFts5Query(params.query);
  const limit = params.limit ?? 10;

  // Build WHERE clauses
  const conditions: string[] = ["search_idx MATCH ?"];
  const bindValues: (string | number)[] = [ftsQuery];

  if (params.types && params.types.length > 0) {
    conditions.push(`source_type IN (${params.types.map(() => "?").join(",")})`);
    bindValues.push(...params.types);
  }
  if (params.agent) {
    conditions.push("agent = ?");
    bindValues.push(params.agent);
  }
  if (params.from) {
    conditions.push("CAST(source_ts AS INTEGER) >= ?");
    bindValues.push(params.from);
  }
  if (params.to) {
    conditions.push("CAST(source_ts AS INTEGER) <= ?");
    bindValues.push(params.to);
  }

  const where = conditions.join(" AND ");

  // Count total hits
  const countSql = `SELECT source_type, COUNT(*) as cnt FROM search_idx WHERE ${where} GROUP BY source_type`;
  const counts = db.prepare(countSql).all(...bindValues) as Array<{ source_type: string; cnt: number }>;

  const totalHits = counts.reduce((sum, c) => sum + c.cnt, 0);

  // Fetch results per group
  const groups: SearchGroup[] = [];
  for (const { source_type, cnt } of counts) {
    const resultSql = `
      SELECT
        title,
        snippet(search_idx, 1, '<mark>', '</mark>', '…', 40) as snippet,
        source_type,
        source_id,
        source_ts,
        agent,
        click_url
      FROM search_idx
      WHERE ${where} AND source_type = ?
      ORDER BY CAST(source_ts AS INTEGER) DESC
      LIMIT ?
    `;
    const rows = db.prepare(resultSql).all(...bindValues, source_type, limit) as Array<{
      title: string; snippet: string; source_type: string; source_id: string;
      source_ts: string; agent: string; click_url: string;
    }>;

    groups.push({
      type: source_type,
      label: TYPE_LABELS[source_type] || source_type,
      count: cnt,
      results: rows.map(r => ({
        title: r.title,
        snippet: r.snippet,
        sourceType: r.source_type,
        sourceId: r.source_id,
        timestamp: Number(r.source_ts),
        agent: r.agent,
        // Deep-link config results: append ?search= so the config page can highlight the match
        clickUrl: r.source_type === "config" && r.click_url
          ? `${r.click_url}${r.click_url.includes("?") ? "&" : "?"}search=${encodeURIComponent(params.query)}`
          : r.click_url,
      })),
    });
  }

  // Sort groups by total count descending
  groups.sort((a, b) => b.count - a.count);

  return { query: params.query, totalHits, groups };
}

// ── Rebuild ─────────────────────────────────────────────────────────

/** Full reindex: drop and recreate the FTS5 table and sync state. */
export function rebuildSearchIndex(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS search_idx");
  db.exec("DROP TABLE IF EXISTS search_sync_state");
  ensureSearchIndex(db);
  syncSearchIndex(db);
  syncFilesystemContent(db);
}
