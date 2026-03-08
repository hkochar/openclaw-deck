/**
 * GET /api/deliverables/[id]/analysis
 *
 * Computes session intelligence analysis for a deliverable's work window.
 * Uses the same pure functions as session analysis but scoped to the
 * deliverable's event window (previous deliverable end → this deliverable end).
 */

import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { USAGE_DB } from "@/app/api/_lib/paths";
import {
  computeRunSummary,
  type EventRow,
} from "@/lib/run-intelligence";
import {
  computeSessionAnalysis,
  detectAgentType,
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
    const configPath = path.join(process.cwd(), "config", "agents.json");
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

// ── Types ────────────────────────────────────────────────────────────

interface DeliverableRow {
  id: number;
  agent: string;
  session: string;
  first_ts: number;
  last_ts: number;
}

// ── Route handler ────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: groupKey } = await params;

  if (!groupKey) {
    return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
  }

  if (!fs.existsSync(USAGE_DB)) {
    return NextResponse.json({ ok: false, error: "usage db not found" }, { status: 404 });
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(USAGE_DB, { readonly: true });
  } catch {
    return NextResponse.json({ ok: false, error: "cannot open usage db" }, { status: 500 });
  }

  try {
    const row = db.prepare(
      `SELECT id, agent, session, first_ts, last_ts
       FROM deliverables WHERE group_key = ?`,
    ).get(groupKey) as DeliverableRow | undefined;

    if (!row) {
      db.close();
      return NextResponse.json({ ok: false, error: "deliverable not found" }, { status: 404 });
    }

    // Find the start of the "work batch" — walk backwards through this agent's
    // deliverables until there's a gap > 6h between consecutive ones.
    // This scopes analysis to the current task, not the entire agent lifetime.
    const GAP_THRESHOLD = 6 * 3_600_000; // 6 hours
    const priorDeliverables = db.prepare(
      `SELECT first_ts, last_ts FROM deliverables
       WHERE agent = ? AND first_ts <= ?
       ORDER BY first_ts DESC LIMIT 50`,
    ).all(row.agent, row.first_ts) as Array<{ first_ts: number; last_ts: number }>;

    let batchStart = row.first_ts;
    for (let i = 0; i < priorDeliverables.length - 1; i++) {
      const curr = priorDeliverables[i];
      const prev = priorDeliverables[i + 1];
      if (curr.first_ts - prev.last_ts > GAP_THRESHOLD) break;
      batchStart = prev.first_ts;
    }
    // Include some lead-in time before first deliverable (agent starts working before first output)
    const windowStart = batchStart - 3_600_000; // 1h before first deliverable in batch

    const events = db.prepare(
      `SELECT id, ts, type, agent, session, model, resolved_model,
              cost, input_tokens, output_tokens, cache_read, cache_write,
              billing, provider_cost, detail,
              CASE WHEN thinking IS NOT NULL AND thinking != '' THEN 1 ELSE 0 END as has_thinking,
              CASE WHEN prompt IS NOT NULL AND prompt != '' THEN 1 ELSE 0 END as has_prompt,
              CASE WHEN response IS NOT NULL AND response != '' THEN 1 ELSE 0 END as has_response
       FROM events
       WHERE agent = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC, id ASC
       LIMIT 5000`,
    ).all(row.agent, windowStart, row.last_ts) as EventRow[];

    // Cost baseline from last 30 days
    let costBaseline: number | null = null;
    try {
      const baselines = db.prepare(
        `SELECT AVG(cost_sum) as avg_cost FROM (
          SELECT SUM(CASE WHEN type = 'llm_output' AND billing = 'subscription' THEN COALESCE(cost, 0)
                        WHEN type = 'llm_output' THEN COALESCE(provider_cost, cost, 0) ELSE 0 END) as cost_sum
          FROM events
          WHERE agent = ? AND ts >= ?
          GROUP BY session
          HAVING COUNT(*) >= 3
          ORDER BY MIN(ts) DESC
          LIMIT 50
        )`,
      ).get(row.agent, Date.now() - 30 * 86_400_000) as { avg_cost: number | null } | undefined;
      costBaseline = baselines?.avg_cost ?? null;
    } catch { /* ignore */ }

    // Also pull source details (searches, fetches) from the same window
    const sourceEvents = db.prepare(
      `SELECT tool_name, tool_query, tool_target FROM events
       WHERE agent = ? AND ts >= ? AND ts <= ? AND type = 'tool_call'
         AND tool_name IN ('web_search', 'web_fetch', 'read', 'edit')
       ORDER BY ts ASC`,
    ).all(row.agent, windowStart, row.last_ts) as Array<{
      tool_name: string; tool_query: string | null; tool_target: string | null;
    }>;

    db.close();

    if (!events.length) {
      return NextResponse.json({ ok: false, error: "no events in work window" }, { status: 404 });
    }

    // Build source lists
    const rawSearches: string[] = [];
    const rawFetches: string[] = [];
    const rawReads: string[] = [];
    const rawEdits: string[] = [];
    for (const e of sourceEvents) {
      if (e.tool_name === "web_search" && e.tool_query) rawSearches.push(e.tool_query);
      else if (e.tool_name === "web_fetch" && e.tool_target) rawFetches.push(e.tool_target);
      else if (e.tool_name === "read" && e.tool_target) rawReads.push(e.tool_target);
      else if (e.tool_name === "edit" && e.tool_target) rawEdits.push(e.tool_target);
    }
    const searches = [...new Set(rawSearches)];
    const fetchUrls = [...new Set(rawFetches)];
    const filesRead = [...new Set(rawReads)];
    const filesEdited = [...new Set(rawEdits)];

    const agentType = getAgentType(row.agent);
    const runSummary = computeRunSummary(events);
    const analysis = computeSessionAnalysis(events, agentType, runSummary, costBaseline);

    // Extract task from first message event
    if (!analysis.task) {
      for (const ev of events) {
        if (ev.type === "msg_in" || ev.type === "message_received") {
          const d = ev.detail ? JSON.parse(ev.detail) : {};
          analysis.task = (d.text ?? d.message ?? "").slice(0, 500) || null;
          break;
        }
      }
    }

    // Extract hostname from URL
    function urlHostname(url: string): string {
      try { return new URL(url).hostname; } catch { return url.slice(0, 60); }
    }

    return NextResponse.json({
      ok: true,
      analysis,
      runSummary: {
        startedTs: runSummary.startedTs,
        endedTs: runSummary.endedTs,
        durationMs: runSummary.durationMs,
        status: runSummary.status,
        totalCostUsd: runSummary.totalCostUsd,
        totalTokensIn: runSummary.totalTokensIn,
        totalTokensOut: runSummary.totalTokensOut,
        toolCallCount: runSummary.toolCallCount,
      },
      agentType,
      sources: {
        searches,
        urlsFetched: fetchUrls.map((u) => ({ url: u, hostname: urlHostname(u) })),
        searchCount: rawSearches.length,
        fetchCount: rawFetches.length,
        uniqueDomains: new Set(fetchUrls.map(urlHostname)).size,
        filesRead: filesRead.length,
        filesEdited: filesEdited.length,
      },
    });
  } catch (err) {
    try { db.close(); } catch {}
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[deliverables/[id]/analysis] Error:", errMsg);
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
