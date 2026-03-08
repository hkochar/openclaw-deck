/**
 * GET /api/deliverables/[id]
 *
 * Returns a single deliverable with:
 * - All tool call events from the deliverable's work window
 * - Session-wide research context (searches, fetches, reads, edits up to this deliverable)
 * - Cost/token summary
 * - Sibling deliverables in the same session for navigation
 *
 * Work window: from previous deliverable's end (or session start) to current end.
 * Research context: all research events from session start to current end,
 * so the full story of what informed this deliverable is visible.
 *
 * Param: id = URL-encoded group_key
 */

import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { USAGE_DB } from "@/app/api/_lib/paths";
import { shortPath } from "@/lib/deliverable-classifier";

// ── Types ────────────────────────────────────────────────────────────

interface DeliverableRow {
  id: number;
  agent: string;
  session: string;
  group_key: string;
  main_type: string;
  main_label: string;
  main_target: string | null;
  supporting: string;
  item_count: number;
  first_ts: number;
  last_ts: number;
  events_max_id: number;
}

interface RawEvent {
  id: number;
  ts: number;
  type: string;
  tool_name: string | null;
  tool_query: string | null;
  tool_target: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  billing: string | null;
  detail: string | null;
}

/** Strip workspace prefix for readable display */
function workspaceRelative(p: string): string {
  const wsIdx = p.indexOf("/.openclaw/workspace/");
  if (wsIdx >= 0) return p.slice(wsIdx + "/.openclaw/workspace/".length);
  return shortPath(p);
}

/** Extract hostname from URL */
function urlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 60);
  }
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
      `SELECT id, agent, session, group_key, main_type, main_label, main_target,
              supporting, item_count, first_ts, last_ts, events_max_id
       FROM deliverables WHERE group_key = ?`,
    ).get(groupKey) as DeliverableRow | undefined;

    if (!row) {
      db.close();
      return NextResponse.json({ ok: false, error: "deliverable not found" }, { status: 404 });
    }

    // Find previous deliverable for this agent (across all sessions) for work window boundary
    const prevRow = db.prepare(
      `SELECT last_ts FROM deliverables
       WHERE agent = ? AND last_ts < ?
       ORDER BY last_ts DESC LIMIT 1`,
    ).get(row.agent, row.first_ts) as { last_ts: number } | undefined;

    const workWindowStart = prevRow?.last_ts ?? 0;

    // Sibling deliverables for navigation (same agent, within ±24h)
    const DAY_MS = 86_400_000;
    const siblings = db.prepare(
      `SELECT group_key, main_type, main_label, first_ts, last_ts, item_count
       FROM deliverables WHERE agent = ? AND first_ts >= ? AND first_ts <= ?
       ORDER BY first_ts ASC`,
    ).all(row.agent, row.first_ts - DAY_MS, row.first_ts + DAY_MS) as Array<{
      group_key: string; main_type: string; main_label: string;
      first_ts: number; last_ts: number; item_count: number;
    }>;

    // Query by agent + time window (not session) because the same agent's work
    // may span multiple session keys (discord channel, cron, JSONL transcript)
    // ── Work window events (tool calls for this deliverable's specific work) ──
    const workEvents = db.prepare(
      `SELECT id, ts, type, tool_name, tool_query, tool_target,
              model, input_tokens, output_tokens, cost, billing, detail
       FROM events
       WHERE agent = ? AND ts > ? AND ts <= ? AND type = 'tool_call'
       ORDER BY ts ASC`,
    ).all(row.agent, workWindowStart, row.last_ts) as RawEvent[];

    // ── Session-wide research context (all research events up to this deliverable) ──
    const researchEvents = db.prepare(
      `SELECT tool_name, tool_query, tool_target
       FROM events
       WHERE agent = ? AND ts <= ? AND type = 'tool_call'
         AND tool_name IN ('web_search', 'web_fetch', 'read', 'edit')
       ORDER BY ts ASC`,
    ).all(row.agent, row.last_ts) as Array<{
      tool_name: string; tool_query: string | null; tool_target: string | null;
    }>;

    // ── LLM/cost events from work window ──
    const costEvents = db.prepare(
      `SELECT type, model, input_tokens, output_tokens, cost, billing
       FROM events
       WHERE agent = ? AND ts > ? AND ts <= ?
         AND type IN ('llm_input', 'llm_output')`,
    ).all(row.agent, workWindowStart, row.last_ts) as Array<{
      type: string; model: string | null; input_tokens: number | null;
      output_tokens: number | null; cost: number | null; billing: string | null;
    }>;

    db.close();

    // Build research summary from session-wide events
    const rawSearches: string[] = [];
    const rawFetches: string[] = [];
    const rawReads: string[] = [];
    const rawEdits: string[] = [];

    for (const e of researchEvents) {
      if (e.tool_name === "web_search" && e.tool_query) rawSearches.push(e.tool_query);
      else if (e.tool_name === "web_fetch" && e.tool_target) rawFetches.push(e.tool_target);
      else if (e.tool_name === "read" && e.tool_target) rawReads.push(e.tool_target);
      else if (e.tool_name === "edit" && e.tool_target) rawEdits.push(e.tool_target);
    }

    // Build cost summary
    let llmCalls = 0;
    let totalCost: number | null = null;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    const models = new Set<string>();
    let billing: string | null = null;

    for (const e of costEvents) {
      if (e.type === "llm_input") {
        llmCalls++;
        if (e.model) models.add(e.model);
        if (e.billing) billing = e.billing;
      }
      if (e.type === "llm_output") {
        if (e.input_tokens) totalTokensIn += e.input_tokens;
        if (e.output_tokens) totalTokensOut += e.output_tokens;
        if (e.cost != null) totalCost = (totalCost ?? 0) + e.cost;
      }
    }

    // Deduplicate
    const searches = [...new Set(rawSearches)];
    const fetchesFull = [...new Set(rawFetches)];
    const readsFull = [...new Set(rawReads)];
    const editsFull = [...new Set(rawEdits)];

    const durationMs = row.last_ts - row.first_ts;

    // Parse supporting items
    const supporting = JSON.parse(row.supporting) as Array<{
      type: string; label: string; target: string | null; ts: number;
    }>;

    // Build response events for timeline
    const responseEvents = workEvents.map((e) => {
      let success: boolean | null = null;
      let eventDuration: number | null = null;
      if (e.detail) {
        try {
          const d = JSON.parse(e.detail);
          if (typeof d.success === "boolean") success = d.success;
          if (typeof d.durationMs === "number") eventDuration = d.durationMs;
        } catch {}
      }
      return {
        id: e.id,
        ts: e.ts,
        toolName: e.tool_name,
        toolQuery: e.tool_query,
        toolTarget: e.tool_target ? workspaceRelative(e.tool_target) : null,
        toolTargetFull: e.tool_target,
        success,
        durationMs: eventDuration,
      };
    });

    return NextResponse.json({
      ok: true,
      deliverable: {
        id: row.group_key,
        agent: row.agent,
        session: row.session,
        groupKey: row.group_key,
        main: {
          type: row.main_type,
          label: row.main_label,
          target: row.main_target,
          ts: row.last_ts,
        },
        supporting,
        firstTs: row.first_ts,
        lastTs: row.last_ts,
        itemCount: row.item_count,
      },
      events: responseEvents,
      siblings: siblings.map((s) => ({
        groupKey: s.group_key,
        type: s.main_type,
        label: s.main_label.slice(0, 80),
        firstTs: s.first_ts,
        lastTs: s.last_ts,
        itemCount: s.item_count,
        isCurrent: s.group_key === row.group_key,
      })),
      summary: {
        durationMs,
        llmCalls,
        toolCalls: workEvents.length,
        totalCost,
        totalTokensIn,
        totalTokensOut,
        model: models.size > 0 ? [...models].join(", ") : null,
        billing,
      },
      sources: {
        searches,
        urlsFetched: fetchesFull.map((u) => ({ url: u, hostname: urlHostname(u) })),
        filesRead: readsFull.map((f) => ({ path: workspaceRelative(f), full: f })),
        filesEdited: editsFull.map((f) => ({ path: workspaceRelative(f), full: f })),
        searchCount: rawSearches.length,
        fetchCount: rawFetches.length,
        readCount: rawReads.length,
        editCount: rawEdits.length,
      },
    });
  } catch (err) {
    try { db.close(); } catch {}
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[deliverables/[id]] Error:", errMsg);
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
