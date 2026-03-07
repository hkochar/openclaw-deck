/**
 * seed-demo-db.ts — Extract and anonymize real data into a demo SQLite database.
 *
 * Reads from the live usage DB (~/.openclaw-deck/data/usage.db) and produces
 * data/demo-usage.db with ~500 events across 5 anonymized agents.
 *
 * Usage: bun scripts/seed-demo-db.ts
 */

import Database from "better-sqlite3";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LIVE_DB = process.env.DECK_USAGE_DB || join(homedir(), ".openclaw-deck", "data", "usage.db");
const DEMO_DB = join(ROOT, "data", "demo-usage.db");

// ── Agent mapping (real → demo) ──────────────────────────────────────
const AGENT_MAP: Record<string, string> = {
  jane: "alpha",
  forge: "bravo",
  scout: "charlie",
  maya: "delta",
  vigil: "echo",
};

const AGENT_NAME_MAP: Record<string, string> = {
  Jane: "Alpha",
  Forge: "Bravo",
  Scout: "Charlie",
  Maya: "Delta",
  Vigil: "Echo",
  jane: "alpha",
  forge: "bravo",
  scout: "charlie",
  maya: "delta",
  vigil: "echo",
};

// Fake Discord channel IDs for anonymization
const CHANNEL_MAP: Record<string, string> = {};
let channelCounter = 1;
function anonChannel(id: string): string {
  if (!id) return id;
  if (!CHANNEL_MAP[id]) {
    CHANNEL_MAP[id] = `90000000000000000${String(channelCounter++).padStart(2, "0")}`;
  }
  return CHANNEL_MAP[id];
}

// ── Anonymization helpers ────────────────────────────────────────────

/** Replace agent names and personal identifiers in text */
function anonText(text: string | null): string | null {
  if (!text) return text;
  let result = text;

  // Replace agent names
  for (const [real, demo] of Object.entries(AGENT_NAME_MAP)) {
    result = result.replaceAll(real, demo);
  }

  // Replace personal identifiers
  result = result.replace(/Harman|harman|hkochar|Kochar|kochar/gi, "the operator");
  result = result.replace(/\b1472\d{15}\b/g, (m) => anonChannel(m));
  result = result.replace(/\b1473\d{15}\b/g, (m) => anonChannel(m));
  result = result.replace(/\b1474\d{15}\b/g, (m) => anonChannel(m));
  result = result.replace(/\b1478\d{15}\b/g, (m) => anonChannel(m));
  // Scrub real file paths
  result = result.replace(/\/Users\/dev\//g, "/home/user/");
  result = result.replace(/\/Users\/\w+\//g, "/home/user/");
  // Scrub email addresses
  result = result.replace(/[\w.-]+@[\w.-]+\.\w+/g, "user@example.com");
  // Scrub Discord tokens
  result = result.replace(/[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, "REDACTED_TOKEN");

  return result;
}

/** Truncate text to keep demo DB small */
function truncateText(text: string | null, maxLen: number = 500): string | null {
  if (!text) return text;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

/** Anonymize a session key */
function anonSession(session: string | null): string | null {
  if (!session) return session;
  let result = session;
  // Replace agent prefix
  for (const [real, demo] of Object.entries(AGENT_MAP)) {
    result = result.replaceAll(`:${real}:`, `:${demo}:`);
    if (result.startsWith(`${real}/`)) result = `${demo}/${result.slice(real.length + 1)}`;
    if (result.startsWith(`agent:${real}:`)) result = result.replace(`agent:${real}:`, `agent:${demo}:`);
    if (result.startsWith(`archived:${real}:`)) result = result.replace(`archived:${real}:`, `archived:${demo}:`);
    if (result.startsWith(`channel:`)) {
      const chanId = result.slice(8);
      result = `channel:${anonChannel(chanId)}`;
    }
  }
  // Replace Discord channel IDs in session keys
  result = result.replace(/\b(1472|1473|1474|1478)\d{15}\b/g, (m) => anonChannel(m));
  // Slack channel IDs
  result = result.replace(/c0[a-z0-9]{9}/gi, "c0demo00001");
  return result;
}

/** Anonymize agent key */
function anonAgent(agent: string): string {
  return AGENT_MAP[agent] || agent;
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(LIVE_DB)) {
    console.error(`Live DB not found: ${LIVE_DB}`);
    process.exit(1);
  }

  // Ensure data/ dir exists
  const dataDir = dirname(DEMO_DB);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Remove old demo DB
  if (existsSync(DEMO_DB)) unlinkSync(DEMO_DB);
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    const f = DEMO_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }

  const src = new Database(LIVE_DB, { readonly: true });
  const dst = new Database(DEMO_DB);
  dst.pragma("journal_mode = WAL");
  dst.pragma("synchronous = NORMAL");

  console.log("Creating demo DB schema...");
  createSchema(dst);

  // ── Select sessions to include ───────────────────────────────────
  // Pick medium-sized sessions with good diversity per agent
  const targetAgents = Object.keys(AGENT_MAP);
  const sessionPicks: Array<{ session: string; agent: string; cnt: number }> = [];

  // Target ~100 events per agent, max 4 sessions each
  const MAX_SESSIONS_PER_AGENT = 4;

  for (const agent of targetAgents) {
    // First: sessions with alert events (most valuable for demo)
    const alertSessions = src.prepare(`
      SELECT DISTINCT session FROM events
      WHERE agent = ? AND type IN ('agent_paused','agent_resumed','loop_detected','model_drift','provider_limit_warning','agent_silence','cron_error')
        AND session IS NOT NULL AND session != ''
    `).all(agent) as Array<{ session: string }>;

    // Then: medium-sized sessions with event diversity (20-80 events)
    const goodSessions = src.prepare(`
      SELECT session, agent, COUNT(*) as cnt, COUNT(DISTINCT type) as types
      FROM events
      WHERE agent = ? AND session IS NOT NULL AND session != ''
      GROUP BY session
      HAVING cnt BETWEEN 15 AND 80
      ORDER BY types DESC, cnt DESC
      LIMIT 6
    `).all(agent) as Array<{ session: string; agent: string; cnt: number; types: number }>;

    // Merge unique sessions, cap at MAX_SESSIONS_PER_AGENT
    const seen = new Set<string>();
    for (const s of alertSessions) {
      if (seen.size >= MAX_SESSIONS_PER_AGENT) break;
      if (!seen.has(s.session)) {
        seen.add(s.session);
        sessionPicks.push({ session: s.session, agent, cnt: 0 });
      }
    }
    for (const s of goodSessions) {
      if (seen.size >= MAX_SESSIONS_PER_AGENT) break;
      if (!seen.has(s.session)) {
        seen.add(s.session);
        sessionPicks.push({ session: s.session, agent, cnt: s.cnt });
      }
    }
  }

  // Also grab events without session (alert events at the global level)
  const globalAlertSessions = src.prepare(`
    SELECT DISTINCT agent FROM events
    WHERE (session IS NULL OR session = '')
      AND agent IN (${targetAgents.map(() => "?").join(",")})
      AND type IN ('agent_silence','loop_detected','model_drift','agent_paused','agent_resumed')
  `).all(...targetAgents) as Array<{ agent: string }>;

  const pickedSessions = sessionPicks.map((s) => s.session);
  console.log(`Selected ${pickedSessions.length} sessions across ${targetAgents.length} agents`);

  // ── Calculate timestamp shift ──────────────────────────────────
  // Shift all timestamps so the most recent event is "now"
  const maxTs = (src.prepare(`
    SELECT MAX(ts) as max_ts FROM events
    WHERE agent IN (${targetAgents.map(() => "?").join(",")})
  `).get(...targetAgents) as { max_ts: number }).max_ts;
  const tsShift = Date.now() - maxTs;

  // ── Copy events ────────────────────────────────────────────────
  const insertEvent = dst.prepare(`
    INSERT INTO events (ts, agent, session, type, model, input_tokens, output_tokens,
      cache_read, cache_write, cost, detail, run_id, prompt, response, thinking,
      resolved_model, provider_cost, billing, tool_name, tool_query, tool_target)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let eventCount = 0;
  const insertEvents = dst.transaction(() => {
    // Events from picked sessions
    const MAX_EVENTS_PER_SESSION = 80;
    for (const session of pickedSessions) {
      const events = src.prepare(`
        SELECT * FROM events WHERE session = ? ORDER BY ts LIMIT ?
      `).all(session, MAX_EVENTS_PER_SESSION) as Array<Record<string, unknown>>;

      for (const e of events) {
        insertEvent.run(
          (e.ts as number) + tsShift,
          anonAgent(e.agent as string),
          anonSession(e.session as string),
          e.type,
          e.model,
          e.input_tokens,
          e.output_tokens,
          e.cache_read,
          e.cache_write,
          e.cost,
          anonText(e.detail as string),
          e.run_id,
          truncateText(anonText(e.prompt as string), 800),
          truncateText(anonText(e.response as string), 800),
          truncateText(anonText(e.thinking as string), 400),
          e.resolved_model,
          e.provider_cost,
          e.billing,
          e.tool_name,
          anonText(e.tool_query as string),
          anonText(e.tool_target as string),
        );
        eventCount++;
      }
    }

    // Global alert events (no session)
    for (const { agent } of globalAlertSessions) {
      const events = src.prepare(`
        SELECT * FROM events
        WHERE agent = ? AND (session IS NULL OR session = '')
        ORDER BY ts
      `).all(agent) as Array<Record<string, unknown>>;

      for (const e of events) {
        insertEvent.run(
          (e.ts as number) + tsShift,
          anonAgent(e.agent as string),
          anonSession(e.session as string),
          e.type,
          e.model,
          e.input_tokens,
          e.output_tokens,
          e.cache_read,
          e.cache_write,
          e.cost,
          anonText(e.detail as string),
          e.run_id,
          truncateText(anonText(e.prompt as string), 800),
          truncateText(anonText(e.response as string), 800),
          truncateText(anonText(e.thinking as string), 400),
          e.resolved_model,
          e.provider_cost,
          e.billing,
          e.tool_name,
          anonText(e.tool_query as string),
          anonText(e.tool_target as string),
        );
        eventCount++;
      }
    }
  });
  insertEvents();
  console.log(`Copied ${eventCount} events`);

  // ── Copy sessions ──────────────────────────────────────────────
  const insertSession = dst.prepare(`
    INSERT INTO sessions (session_key, agent, session_id, channel, model,
      total_tokens, input_tokens, output_tokens, context_tokens,
      display_name, label, group_channel, origin, compaction_count,
      transcript_size_kb, created_at, updated_at, status, archived_at,
      archive_file, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let sessionCount = 0;
  const insertSessions = dst.transaction(() => {
    for (const sessionKey of pickedSessions) {
      const s = src.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as Record<string, unknown> | undefined;
      if (!s) continue;
      insertSession.run(
        anonSession(s.session_key as string),
        anonAgent(s.agent as string),
        s.session_id,
        anonText(s.channel as string),
        s.model,
        s.total_tokens,
        s.input_tokens,
        s.output_tokens,
        s.context_tokens,
        anonText(s.display_name as string),
        anonText(s.label as string),
        anonText(s.group_channel as string),
        anonText(s.origin as string),
        s.compaction_count,
        s.transcript_size_kb,
        (s.created_at as number) + tsShift,
        (s.updated_at as number) + tsShift,
        s.status,
        s.archived_at ? (s.archived_at as number) + tsShift : null,
        s.archive_file,
        s.source,
      );
      sessionCount++;
    }
  });
  insertSessions();
  console.log(`Copied ${sessionCount} sessions`);

  // ── Copy heartbeats ────────────────────────────────────────────
  const heartbeats = src.prepare(`
    SELECT * FROM heartbeats WHERE agent_key IN (${targetAgents.map(() => "?").join(",")})
  `).all(...targetAgents) as Array<Record<string, unknown>>;

  const insertHb = dst.prepare(`
    INSERT INTO heartbeats (agent_key, status, model, configured_model, session_key,
      cron_model, cron_model_updated_at, bio, last_heartbeat, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const h of heartbeats) {
    insertHb.run(
      anonAgent(h.agent_key as string),
      h.status,
      h.model,
      h.configured_model,
      anonSession(h.session_key as string),
      h.cron_model,
      h.cron_model_updated_at ? (h.cron_model_updated_at as number) + tsShift : null,
      anonText(h.bio as string),
      (h.last_heartbeat as number) + tsShift,
      (h.updated_at as number) + tsShift,
    );
  }
  console.log(`Copied ${heartbeats.length} heartbeats`);

  // ── Copy drift events ──────────────────────────────────────────
  const drifts = src.prepare(`
    SELECT * FROM drift_events WHERE agent_key IN (${targetAgents.map(() => "?").join(",")})
  `).all(...targetAgents) as Array<Record<string, unknown>>;

  const insertDrift = dst.prepare(`
    INSERT INTO drift_events (agent_key, configured_model, actual_model, tag, timestamp, resolved, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of drifts) {
    insertDrift.run(
      anonAgent(d.agent_key as string),
      d.configured_model,
      d.actual_model,
      d.tag,
      (d.timestamp as number) + tsShift,
      d.resolved,
      d.resolved_at ? (d.resolved_at as number) + tsShift : null,
    );
  }
  console.log(`Copied ${drifts.length} drift events`);

  // ── Copy agent activities ──────────────────────────────────────
  const activities = src.prepare(`
    SELECT * FROM agent_activities WHERE agent_key IN (${targetAgents.map(() => "?").join(",")})
  `).all(...targetAgents) as Array<Record<string, unknown>>;

  const insertAct = dst.prepare(`
    INSERT INTO agent_activities (type, agent_key, agent_name, message, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const a of activities) {
    insertAct.run(
      a.type,
      anonAgent(a.agent_key as string),
      anonText(a.agent_name as string),
      anonText(a.message as string),
      (a.timestamp as number) + tsShift,
    );
  }
  console.log(`Copied ${activities.length} agent activities`);

  // ── Copy session analysis ──────────────────────────────────────
  const analyses = src.prepare(`
    SELECT * FROM session_analysis WHERE agent IN (${targetAgents.map(() => "?").join(",")})
  `).all(...targetAgents) as Array<Record<string, unknown>>;

  const insertSa = dst.prepare(`
    INSERT INTO session_analysis (session_key, agent, agent_type, computed_at, events_max_id,
      guidelines, guidelines_hash, regions, outcomes, activity_summary, quality_scores,
      critique, llm_summary, llm_critique, llm_model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let saCount = 0;
  for (const sa of analyses) {
    // Only include analyses for sessions we picked
    const anonKey = anonSession(sa.session_key as string);
    insertSa.run(
      anonKey,
      anonAgent(sa.agent as string),
      sa.agent_type,
      (sa.computed_at as number) + tsShift,
      sa.events_max_id,
      anonText(sa.guidelines as string),
      sa.guidelines_hash,
      anonText(sa.regions as string),
      anonText(sa.outcomes as string),
      anonText(sa.activity_summary as string),
      sa.quality_scores,
      anonText(sa.critique as string),
      anonText(sa.llm_summary as string),
      anonText(sa.llm_critique as string),
      sa.llm_model,
    );
    saCount++;
  }
  console.log(`Copied ${saCount} session analyses`);

  // ── Copy deliverables for picked sessions ──────────────────────
  const insertDel = dst.prepare(`
    INSERT INTO deliverables (agent, session, group_key, main_type, main_label, main_target,
      supporting, item_count, first_ts, last_ts, events_max_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let delCount = 0;
  const insertDels = dst.transaction(() => {
    for (const sessionKey of pickedSessions) {
      const dels = src.prepare("SELECT * FROM deliverables WHERE session = ?").all(sessionKey) as Array<Record<string, unknown>>;
      for (const d of dels) {
        insertDel.run(
          anonAgent(d.agent as string),
          anonSession(d.session as string),
          anonText(d.group_key as string),
          d.main_type,
          anonText(d.main_label as string),
          anonText(d.main_target as string),
          anonText(d.supporting as string),
          d.item_count,
          (d.first_ts as number) + tsShift,
          (d.last_ts as number) + tsShift,
          d.events_max_id,
          (d.created_at as number) + tsShift,
          (d.updated_at as number) + tsShift,
        );
        delCount++;
      }
    }
  });
  insertDels();
  console.log(`Copied ${delCount} deliverables`);

  // ── Summary ────────────────────────────────────────────────────
  src.close();
  dst.close();

  const sizeKb = Math.round(require("fs").statSync(DEMO_DB).size / 1024);
  console.log(`\nDemo DB created: ${DEMO_DB} (${sizeKb} KB)`);
  console.log(`  Events: ${eventCount}`);
  console.log(`  Sessions: ${sessionCount}`);
  console.log(`  Heartbeats: ${heartbeats.length}`);
  console.log(`  Drift events: ${drifts.length}`);
  console.log(`  Activities: ${activities.length}`);
  console.log(`  Analyses: ${saCount}`);
  console.log(`  Deliverables: ${delCount}`);
}

// ── Schema creation (mirrors plugin/event-log.ts getDb()) ────────────
function createSchema(db: Database.Database) {
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
    CREATE INDEX IF NOT EXISTS idx_tool_name ON events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_name_agent ON events(tool_name, agent);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS backfill_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      ts INTEGER NOT NULL
    );
  `);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS deliverables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      session TEXT NOT NULL,
      group_key TEXT NOT NULL UNIQUE,
      main_type TEXT NOT NULL,
      main_label TEXT NOT NULL,
      main_target TEXT,
      supporting TEXT NOT NULL DEFAULT '[]',
      item_count INTEGER NOT NULL DEFAULT 1,
      first_ts INTEGER NOT NULL,
      last_ts INTEGER NOT NULL,
      events_max_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_del_agent ON deliverables(agent);
    CREATE INDEX IF NOT EXISTS idx_del_last_ts ON deliverables(last_ts);
    CREATE INDEX IF NOT EXISTS idx_del_group_key ON deliverables(group_key);
  `);

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
}

main();
