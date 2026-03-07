/**
 * Unit tests for plugin/search-index.ts
 *
 * Uses an in-memory SQLite database to test FTS5 index creation,
 * incremental sync, query, and edge cases.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  ensureSearchIndex,
  syncSearchIndex,
  searchQuery,
  rebuildSearchIndex,
} from "../plugin/search-index";

// ── Helpers ──────────────────────────────────────────────────────────

/** Create an in-memory DB with search tables + source tables for testing. */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  // Create source tables matching the real schema
  db.exec(`
    CREATE TABLE events (
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

    CREATE TABLE sessions (
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

    CREATE TABLE session_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      agent TEXT NOT NULL,
      agent_type TEXT,
      computed_at INTEGER NOT NULL,
      events_max_id INTEGER NOT NULL,
      guidelines TEXT,
      guidelines_hash TEXT,
      regions TEXT NOT NULL DEFAULT '[]',
      outcomes TEXT NOT NULL DEFAULT '[]',
      activity_summary TEXT NOT NULL DEFAULT '{}',
      quality_scores TEXT NOT NULL DEFAULT '{}',
      critique TEXT NOT NULL DEFAULT '{}',
      llm_summary TEXT,
      llm_critique TEXT,
      llm_model TEXT
    );

    CREATE TABLE deliverables (
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

    CREATE TABLE agent_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      agent_key TEXT,
      agent_name TEXT,
      message TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE heartbeats (
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

  ensureSearchIndex(db);
  return db;
}

function insertEvent(db: Database.Database, overrides: Partial<{
  ts: number; agent: string; type: string; model: string; tool_name: string;
  tool_query: string; tool_target: string; detail: string; response: string; thinking: string;
}> = {}) {
  const defaults = {
    ts: Date.now(), agent: "jane", type: "tool_call", model: "claude-sonnet-4-6",
    tool_name: "", tool_query: "", tool_target: "", detail: "", response: "", thinking: "",
  };
  const r = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO events (ts, agent, type, model, tool_name, tool_query, tool_target, detail, response, thinking)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.ts, r.agent, r.type, r.model, r.tool_name, r.tool_query, r.tool_target, r.detail, r.response, r.thinking);
}

function insertSession(db: Database.Database, overrides: Partial<{
  session_key: string; agent: string; channel: string; display_name: string;
  label: string; model: string; updated_at: number;
}> = {}) {
  const defaults = {
    session_key: `jane/${Date.now()}.jsonl`, agent: "jane", channel: "discord",
    display_name: "", label: "", model: "claude-sonnet-4-6", updated_at: Date.now(),
  };
  const r = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO sessions (session_key, agent, channel, display_name, label, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.session_key, r.agent, r.channel, r.display_name, r.label, r.model, r.updated_at, r.updated_at);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ensureSearchIndex", () => {
  it("creates FTS5 table and sync state table", () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','shadow') AND name LIKE 'search%' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    assert.ok(names.includes("search_sync_state"), "search_sync_state table exists");
    // FTS5 creates several shadow tables
    assert.ok(names.some(n => n.startsWith("search_idx")), "search_idx FTS5 table exists");
    db.close();
  });

  it("is idempotent", () => {
    const db = createTestDb();
    ensureSearchIndex(db); // second call
    ensureSearchIndex(db); // third call
    // No error thrown
    db.close();
  });
});

describe("syncSearchIndex — events", () => {
  it("indexes tool_call events with tool_name and tool_query", () => {
    const db = createTestDb();
    insertEvent(db, { tool_name: "web_search", tool_query: "SQLite FTS5 tutorial", tool_target: "https://example.com" });
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "FTS5" });
    assert.equal(result.totalHits, 1);
    assert.equal(result.groups[0].type, "event");
    assert.ok(result.groups[0].results[0].title.includes("web_search"));
    db.close();
  });

  it("indexes llm_output events with response text", () => {
    const db = createTestDb();
    insertEvent(db, { type: "llm_output", response: "The budget exceeded the configured threshold of $5.00" });
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "budget exceeded" });
    assert.equal(result.totalHits, 1);
    assert.equal(result.groups[0].type, "event");
    db.close();
  });

  it("indexes other event types with detail", () => {
    const db = createTestDb();
    insertEvent(db, { type: "cron_error", detail: '{"error":"timeout connecting to openrouter"}' });
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "timeout openrouter" });
    assert.equal(result.totalHits, 1);
    db.close();
  });

  it("incremental sync only processes new rows", () => {
    const db = createTestDb();
    insertEvent(db, { tool_name: "read", tool_query: "first file" });
    syncSearchIndex(db);
    assert.equal(searchQuery(db, { query: "first" }).totalHits, 1);

    insertEvent(db, { tool_name: "write", tool_query: "second file" });
    syncSearchIndex(db);
    assert.equal(searchQuery(db, { query: "second" }).totalHits, 1);
    // Both should now be findable
    assert.equal(searchQuery(db, { query: "file" }).totalHits, 2);
    db.close();
  });
});

describe("syncSearchIndex — sessions", () => {
  it("indexes sessions by display_name", () => {
    const db = createTestDb();
    insertSession(db, { display_name: "Discord conversation about deployment", session_key: "jane/abc.jsonl" });
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "deployment" });
    assert.equal(result.totalHits, 1);
    assert.equal(result.groups[0].type, "session");
    db.close();
  });

  it("indexes sessions by agent and channel", () => {
    const db = createTestDb();
    insertSession(db, { agent: "scout", channel: "cron", session_key: "scout/xyz.jsonl" });
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "scout cron" });
    assert.equal(result.totalHits, 1);
    db.close();
  });
});

describe("syncSearchIndex — session_analysis", () => {
  it("indexes analysis summaries", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO session_analysis (session_key, agent, computed_at, events_max_id, regions, outcomes, activity_summary, quality_scores, critique, llm_summary)
       VALUES (?, ?, ?, ?, '[]', '[]', '{}', '{}', '{}', ?)`
    ).run("jane/abc.jsonl", "jane", Date.now(), 100, "Investigated a memory leak in the gateway connection pool");
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "memory leak gateway" });
    assert.equal(result.totalHits, 1);
    assert.equal(result.groups[0].type, "analysis");
    db.close();
  });
});

describe("syncSearchIndex — deliverables", () => {
  it("indexes deliverables by label and target", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO deliverables (agent, session, group_key, main_type, main_label, main_target, first_ts, last_ts, events_max_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("forge", "forge/abc.jsonl", "forge:abc:1", "file_written", "search-index.ts", "plugin/search-index.ts",
      Date.now(), Date.now(), 50, Date.now(), Date.now());
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "search-index" });
    assert.equal(result.totalHits, 1);
    assert.equal(result.groups[0].type, "deliverable");
    db.close();
  });
});

describe("syncSearchIndex — activities", () => {
  it("indexes activity feed messages", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO agent_activities (type, agent_key, agent_name, message, timestamp) VALUES (?, ?, ?, ?, ?)"
    ).run("status_change", "jane", "Jane", "Agent resumed after budget pause", Date.now());
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "budget pause" });
    assert.equal(result.totalHits, 1);
    assert.equal(result.groups[0].type, "activity");
    db.close();
  });
});

describe("syncSearchIndex — heartbeats", () => {
  it("indexes agent heartbeats with bio", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO heartbeats (agent_key, status, model, bio, last_heartbeat, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("scout", "active", "claude-sonnet-4-6", "Research specialist for competitive analysis", Date.now(), Date.now());
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "competitive analysis" });
    assert.equal(result.totalHits, 1);
    assert.equal(result.groups[0].type, "heartbeat");
    db.close();
  });
});

describe("searchQuery — filtering", () => {
  let db: Database.Database;

  before(() => {
    db = createTestDb();
    insertEvent(db, { agent: "jane", tool_name: "web_search", tool_query: "kubernetes deployment" });
    insertEvent(db, { agent: "scout", tool_name: "web_search", tool_query: "kubernetes monitoring" });
    insertSession(db, { agent: "jane", display_name: "kubernetes discussion", session_key: "jane/k8s.jsonl" });
    syncSearchIndex(db);
  });

  it("filters by source type", () => {
    const result = searchQuery(db, { query: "kubernetes", types: ["event"] });
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].type, "event");
    assert.equal(result.groups[0].count, 2);
  });

  it("filters by agent", () => {
    const result = searchQuery(db, { query: "kubernetes", agent: "scout" });
    assert.equal(result.totalHits, 1);
    assert.equal(result.groups[0].results[0].agent, "scout");
  });

  it("filters by multiple types", () => {
    const result = searchQuery(db, { query: "kubernetes", types: ["event", "session"] });
    assert.equal(result.totalHits, 3); // 2 events + 1 session
    assert.equal(result.groups.length, 2);
  });

  it("filters by date range", () => {
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    const result = searchQuery(db, { query: "kubernetes", from: hourAgo, to: now + 1000 });
    assert.ok(result.totalHits > 0);
  });

  it("limits results per group", () => {
    const result = searchQuery(db, { query: "kubernetes", limit: 1 });
    for (const group of result.groups) {
      assert.ok(group.results.length <= 1);
    }
  });
});

describe("searchQuery — FTS5 features", () => {
  let db: Database.Database;

  before(() => {
    db = createTestDb();
    insertEvent(db, { tool_name: "web_search", tool_query: "running performance benchmarks" });
    insertEvent(db, { tool_name: "read", tool_query: "config.json", tool_target: "/home/user/.openclaw/openclaw.json" });
    insertEvent(db, { type: "llm_output", response: "The session cost exceeded the threshold" });
    syncSearchIndex(db);
  });

  it("porter stemming matches related forms", () => {
    // "running" should match "run" via porter stemmer
    const result = searchQuery(db, { query: "run" });
    assert.ok(result.totalHits >= 1, "porter stemmer matches 'running' for query 'run'");
  });

  it("returns snippets with <mark> tags", () => {
    // Search for a term that appears in the body (response text), not just the title
    const result = searchQuery(db, { query: "threshold" });
    assert.ok(result.totalHits >= 1);
    const snippet = result.groups[0].results[0].snippet;
    assert.ok(snippet.includes("<mark>"), `snippet should contain <mark>: ${snippet}`);
  });

  it("handles dotted terms without syntax error", () => {
    // This was a real bug — dots caused FTS5 syntax errors
    assert.doesNotThrow(() => {
      searchQuery(db, { query: "compaction.memoryFlush.enabled" });
    });
  });

  it("handles special characters without syntax error", () => {
    const specialQueries = [
      "file:///path/to/thing",
      "user@example.com",
      "cost > $5.00",
      "error: connection refused",
      "src/components/*.tsx",
      "#edit.budgets.stepCostThreshold",
      "search-index.ts",
      "plugin/search-index",
    ];
    for (const q of specialQueries) {
      assert.doesNotThrow(() => {
        searchQuery(db, { query: q });
      }, `query should not throw: ${q}`);
    }
  });

  it("handles empty query", () => {
    const result = searchQuery(db, { query: "" });
    assert.equal(result.totalHits, 0);
  });

  it("handles quoted phrase search", () => {
    const result = searchQuery(db, { query: '"session cost exceeded"' });
    assert.ok(result.totalHits >= 1);
  });
});

describe("searchQuery — result shape", () => {
  it("returns correct fields on each result", () => {
    const db = createTestDb();
    insertEvent(db, { agent: "jane", tool_name: "web_search", tool_query: "test query", ts: 1700000000000 });
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "test" });
    assert.equal(result.query, "test");
    assert.ok(result.totalHits > 0);
    assert.ok(result.groups.length > 0);

    const r = result.groups[0].results[0];
    assert.ok(typeof r.title === "string");
    assert.ok(typeof r.snippet === "string");
    assert.ok(typeof r.sourceType === "string");
    assert.ok(typeof r.sourceId === "string");
    assert.ok(typeof r.timestamp === "number");
    assert.ok(typeof r.agent === "string");
    assert.ok(typeof r.clickUrl === "string");
    assert.ok(r.clickUrl.startsWith("/logs?highlight="));
    db.close();
  });

  it("groups are sorted by count descending", () => {
    const db = createTestDb();
    // Insert 3 events and 1 session, all matching "alpha"
    insertEvent(db, { tool_name: "read", tool_query: "alpha one" });
    insertEvent(db, { tool_name: "read", tool_query: "alpha two" });
    insertEvent(db, { tool_name: "read", tool_query: "alpha three" });
    insertSession(db, { display_name: "alpha session", session_key: "jane/alpha.jsonl" });
    syncSearchIndex(db);

    const result = searchQuery(db, { query: "alpha" });
    assert.equal(result.groups.length, 2);
    assert.ok(result.groups[0].count >= result.groups[1].count, "first group has more results");
    db.close();
  });
});

describe("rebuildSearchIndex", () => {
  it("drops and recreates index, resyncs all data", () => {
    const db = createTestDb();
    insertEvent(db, { tool_name: "write", tool_query: "rebuilduniq test" });
    syncSearchIndex(db);
    assert.equal(searchQuery(db, { query: "rebuilduniq" }).totalHits, 1);

    // Add more data
    insertEvent(db, { tool_name: "read", tool_query: "rebuilduniq second" });

    // Rebuild re-indexes everything from scratch (also scans filesystem, which may add docs)
    rebuildSearchIndex(db);
    const result = searchQuery(db, { query: "rebuilduniq" });
    assert.equal(result.totalHits, 2, "both events should be re-indexed after rebuild");
    db.close();
  });
});

describe("cross-source search", () => {
  it("finds matches across all source types", () => {
    const db = createTestDb();
    const now = Date.now();

    // Insert data across all source tables with a common term
    insertEvent(db, { tool_name: "web_search", tool_query: "openrouter pricing" });
    insertSession(db, { display_name: "openrouter configuration", session_key: "jane/or.jsonl" });
    db.prepare(
      `INSERT INTO session_analysis (session_key, agent, computed_at, events_max_id, regions, outcomes, activity_summary, quality_scores, critique, llm_summary)
       VALUES (?, ?, ?, ?, '[]', '[]', '{}', '{}', '{}', ?)`
    ).run("jane/or.jsonl", "jane", now, 100, "Analyzed openrouter cost patterns");
    db.prepare(
      `INSERT INTO deliverables (agent, session, group_key, main_type, main_label, main_target, first_ts, last_ts, events_max_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("forge", "forge/or.jsonl", "forge:or:1", "file_written", "openrouter-config.ts", "src/openrouter.ts",
      now, now, 50, now, now);
    db.prepare(
      "INSERT INTO agent_activities (type, agent_key, agent_name, message, timestamp) VALUES (?, ?, ?, ?, ?)"
    ).run("alert", "jane", "Jane", "openrouter rate limit exceeded", now);
    db.prepare(
      "INSERT INTO heartbeats (agent_key, status, model, bio, last_heartbeat, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pulse", "active", "openrouter/free", "Monitors openrouter usage", now, now);

    syncSearchIndex(db);

    const result = searchQuery(db, { query: "openrouter" });
    assert.ok(result.totalHits >= 5, `expected >= 5 hits, got ${result.totalHits}`);

    const types = result.groups.map(g => g.type).sort();
    assert.ok(types.includes("event"), "event results found");
    assert.ok(types.includes("session"), "session results found");
    assert.ok(types.includes("analysis"), "analysis results found");
    assert.ok(types.includes("deliverable"), "deliverable results found");
    assert.ok(types.includes("activity"), "activity results found");
    assert.ok(types.includes("heartbeat"), "heartbeat results found");
    db.close();
  });
});
