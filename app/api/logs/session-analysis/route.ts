/**
 * GET /api/logs/session-analysis?session={sessionKey}
 *
 * Returns all stored analyses for a session. If none exist, auto-computes
 * the default analysis and stores it. Includes runSummary and feedback.
 */

import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { USAGE_DB } from "@/app/api/_lib/paths";
import {
  computeRunSummary,
  type EventRow,
  type RunSummary,
} from "@/lib/run-intelligence";
import {
  computeSessionAnalysis,
  detectAgentType,
  guidelinesHash,
  type SessionAnalysis,
  type AgentType,
} from "@/lib/session-intelligence";

// ── Agent config ─────────────────────────────────────────────────────

interface AgentConfig {
  id: string;
  key: string;
  name: string;
  role: string;
}

let agentConfigs: AgentConfig[] | null = null;

function loadAgentConfigs(): AgentConfig[] {
  if (agentConfigs) return agentConfigs;
  try {
    const configPath = require("path").join(process.cwd(), "config", "agents.json");
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    agentConfigs = data.agents ?? [];
  } catch {
    agentConfigs = [];
  }
  return agentConfigs!;
}

function getAgentType(agentId: string): AgentType {
  const configs = loadAgentConfigs();
  const agent = configs.find((a) => a.id === agentId || a.key === agentId);
  return detectAgentType(agent?.role);
}

// ── Session Key Resolution ───────────────────────────────────────────

function resolveSessionKeys(
  db: InstanceType<typeof Database>,
  session: string,
): string[] {
  const keys = new Set([session]);
  try {
    let sessionId: string | null = null;
    const uuidMatch = session.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    );
    if (uuidMatch) {
      sessionId = uuidMatch[1];
    } else {
      const row = db
        .prepare("SELECT session_id FROM sessions WHERE session_key = ?")
        .get(session) as { session_id: string | null } | undefined;
      if (row?.session_id) sessionId = row.session_id;
    }
    if (sessionId) {
      const rows = db
        .prepare("SELECT session_key FROM sessions WHERE session_id = ?")
        .all(sessionId) as Array<{ session_key: string }>;
      for (const r of rows) keys.add(r.session_key);
      const evtKeys = db
        .prepare(
          "SELECT DISTINCT session FROM events WHERE session LIKE ? LIMIT 5",
        )
        .all(`%${sessionId}%`) as Array<{ session: string }>;
      for (const r of evtKeys) keys.add(r.session);
    }
  } catch {
    /* ignore */
  }
  return [...keys];
}

// ── Shared: fetch events + compute ───────────────────────────────────

export interface AnalysisContext {
  events: EventRow[];
  agentId: string;
  agentType: AgentType;
  runSummary: RunSummary;
  costBaseline: number | null;
  maxId: number;
  sessionKeys: string[];
}

export function fetchAnalysisContext(
  db: InstanceType<typeof Database>,
  session: string,
): AnalysisContext | null {
  const sessionKeys = resolveSessionKeys(db, session);
  const sessionPlaceholders = sessionKeys.map(() => "?").join(",");
  const sessionWhere =
    sessionKeys.length === 1
      ? "session = ?"
      : `session IN (${sessionPlaceholders})`;

  const maxRow = db
    .prepare(`SELECT MAX(id) as maxId FROM events WHERE ${sessionWhere}`)
    .get(...sessionKeys) as { maxId: number | null } | undefined;

  const maxId = maxRow?.maxId;
  if (maxId == null) return null;

  const events = db
    .prepare(
      `SELECT id, ts, type, agent, session, model, resolved_model,
              cost, input_tokens, output_tokens, cache_read, cache_write,
              billing, provider_cost, detail,
              CASE WHEN thinking IS NOT NULL AND thinking != '' THEN 1 ELSE 0 END as has_thinking,
              CASE WHEN prompt IS NOT NULL AND prompt != '' THEN 1 ELSE 0 END as has_prompt,
              CASE WHEN response IS NOT NULL AND response != '' THEN 1 ELSE 0 END as has_response
       FROM events
       WHERE ${sessionWhere}
       ORDER BY ts ASC, id ASC
       LIMIT 5000`,
    )
    .all(...sessionKeys) as EventRow[];

  if (!events.length) return null;

  const agentId = events[0].agent ?? "unknown";
  const agentType = getAgentType(agentId);
  const runSummary = computeRunSummary(events);

  let costBaseline: number | null = null;
  try {
    const baselines = db
      .prepare(
        `SELECT AVG(cost_sum) as avg_cost FROM (
          SELECT SUM(CASE WHEN type = 'llm_output' THEN COALESCE(provider_cost, cost, 0) ELSE 0 END) as cost_sum
          FROM events
          WHERE agent = ? AND ts >= ?
          GROUP BY session
          HAVING COUNT(*) >= 3
          ORDER BY MIN(ts) DESC
          LIMIT 50
        )`,
      )
      .get(agentId, Date.now() - 30 * 86_400_000) as {
      avg_cost: number | null;
    } | undefined;
    costBaseline = baselines?.avg_cost ?? null;
  } catch {
    /* ignore */
  }

  return { events, agentId, agentType, runSummary, costBaseline, maxId, sessionKeys };
}

export function storeAnalysis(
  session: string,
  ctx: AnalysisContext,
  analysis: SessionAnalysis,
  guidelines: string | null,
): number {
  const wdb = new Database(USAGE_DB);
  try {
    const result = wdb
      .prepare(
        `INSERT INTO session_analysis
         (session_key, agent, agent_type, computed_at, events_max_id, guidelines, guidelines_hash,
          regions, outcomes, activity_summary, quality_scores, critique)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session,
        ctx.agentId,
        ctx.agentType,
        Date.now(),
        ctx.maxId,
        guidelines,
        guidelinesHash(guidelines),
        JSON.stringify(analysis.regions),
        JSON.stringify(analysis.outcomes),
        JSON.stringify(analysis.activitySummary),
        JSON.stringify(analysis.qualityScores),
        JSON.stringify(analysis.critique),
      );
    return Number(result.lastInsertRowid);
  } finally {
    wdb.close();
  }
}

// ── Stored analysis record type ──────────────────────────────────────

interface StoredAnalysisRow {
  id: number;
  session_key: string;
  agent: string;
  agent_type: string | null;
  computed_at: number;
  events_max_id: number;
  guidelines: string | null;
  guidelines_hash: string | null;
  regions: string;
  outcomes: string;
  activity_summary: string;
  quality_scores: string;
  critique: string;
}

interface AnalysisRecord {
  id: number;
  computedAt: number;
  guidelines: string | null;
  eventsMaxId: number;
  analysis: SessionAnalysis;
}

function rowToRecord(row: StoredAnalysisRow): AnalysisRecord {
  return {
    id: row.id,
    computedAt: row.computed_at,
    guidelines: row.guidelines,
    eventsMaxId: row.events_max_id,
    analysis: {
      agentType: (row.agent_type ?? "general") as SessionAnalysis["agentType"],
      regions: JSON.parse(row.regions),
      outcomes: JSON.parse(row.outcomes),
      activitySummary: JSON.parse(row.activity_summary),
      qualityScores: JSON.parse(row.quality_scores),
      critique: JSON.parse(row.critique),
      task: null, // not stored separately; extracted from regions
    },
  };
}

// ── Route Handler ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session");
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "missing session" },
      { status: 400 },
    );
  }

  if (!fs.existsSync(USAGE_DB)) {
    return NextResponse.json(
      { ok: false, error: "usage db not found" },
      { status: 404 },
    );
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(USAGE_DB, { readonly: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "cannot open usage db" },
      { status: 500 },
    );
  }

  try {
    // 1. Check for stored analyses
    const storedRows = db
      .prepare(
        `SELECT * FROM session_analysis WHERE session_key = ? ORDER BY computed_at DESC LIMIT 50`,
      )
      .all(session) as StoredAnalysisRow[];

    const analyses = storedRows.map(rowToRecord);

    // 2. Get context for runSummary (always needed)
    const ctx = fetchAnalysisContext(db, session);
    db.close();

    if (!ctx) {
      return NextResponse.json(
        { ok: false, error: "no events for session" },
        { status: 404 },
      );
    }

    // 3. If no stored analyses, auto-compute default and store it
    if (analyses.length === 0) {
      const analysis = computeSessionAnalysis(
        ctx.events,
        ctx.agentType,
        ctx.runSummary,
        ctx.costBaseline,
      );
      const id = storeAnalysis(session, ctx, analysis, null);
      analyses.push({
        id,
        computedAt: Date.now(),
        guidelines: null,
        eventsMaxId: ctx.maxId,
        analysis,
      });
    }

    // 4. Enrich task field from events (not stored in DB)
    for (const rec of analyses) {
      if (!rec.analysis.task) {
        for (const ev of ctx.events) {
          if (ev.type === "msg_in" || ev.type === "message_received") {
            const d = ev.detail ? JSON.parse(ev.detail) : {};
            rec.analysis.task = (d.text ?? d.message ?? "").slice(0, 500) || null;
            break;
          }
        }
      }
    }

    const feedback = getFeedback(session);

    return NextResponse.json({
      ok: true,
      analyses,
      runSummary: ctx.runSummary,
      feedback,
    });
  } catch (err) {
    try {
      db.close();
    } catch {}
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[session-analysis] Error:", errMsg);
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}

// ── Feedback helper ──────────────────────────────────────────────────

function getFeedback(
  sessionKey: string,
): Array<{
  id: number;
  rating: number | null;
  outcomeQuality: string | null;
  notes: string | null;
  tags: string | null;
  createdAt: number;
}> {
  try {
    const fdb = new Database(USAGE_DB, { readonly: true });
    const rows = fdb
      .prepare(
        `SELECT id, rating, outcome_quality as outcomeQuality, notes, tags, created_at as createdAt
         FROM session_feedback
         WHERE session_key = ?
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      .all(sessionKey) as Array<{
      id: number;
      rating: number | null;
      outcomeQuality: string | null;
      notes: string | null;
      tags: string | null;
      createdAt: number;
    }>;
    fdb.close();
    return rows;
  } catch {
    return [];
  }
}
