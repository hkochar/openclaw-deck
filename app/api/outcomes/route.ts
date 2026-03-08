/**
 * GET /api/outcomes
 *
 * Returns outcomes (file writes, commits, tests, searches, etc.) across all
 * sessions, queried from the events table using indexed tool_name column.
 *
 * Query params:
 *   agent  — filter by agent name
 *   type   — outcome type (file_written, code_committed, test_run, etc.)
 *   since  — Unix ms timestamp (default: 7 days ago)
 *   limit  — max results (default: 200, max: 1000)
 */

import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { USAGE_DB } from "@/app/api/_lib/paths";
import { safeErrorMessage } from "@/app/api/_lib/security";
import { shortPath, shortUrl } from "@/lib/session-intelligence";

// Tool names that produce meaningful outcomes
const OUTCOME_TOOL_NAMES = [
  "write", "edit", "web_search", "web_fetch",
  "exec", "sessions_send", "message",
];

// Map tool_name → outcome type (exec needs further classification)
function classifyOutcome(
  toolName: string,
  toolQuery: string | null,
): string | null {
  switch (toolName) {
    case "write":
      return "file_written";
    case "edit":
      return "file_edited";
    case "web_search":
      return "search_performed";
    case "web_fetch":
      return "url_fetched";
    case "sessions_send":
    case "message":
      return "message_sent";
    case "exec": {
      const q = toolQuery ?? "";
      if (/git\s+commit/.test(q)) return "code_committed";
      if (/\b(vitest|jest|pytest|cargo\s+test|npm\s+test|pnpm\s+test|bun\s+test)\b/.test(q))
        return "test_run";
      return "command_run";
    }
    default:
      return null;
  }
}

// Outcome type → which tool_names to query
const TYPE_TO_TOOLS: Record<string, string[]> = {
  file_written: ["write"],
  file_edited: ["edit"],
  search_performed: ["web_search"],
  url_fetched: ["web_fetch"],
  code_committed: ["exec"],
  test_run: ["exec"],
  command_run: ["exec"],
  message_sent: ["sessions_send", "message"],
};

function outcomeLabel(
  outcomeType: string,
  toolTarget: string | null,
  toolQuery: string | null,
): string {
  switch (outcomeType) {
    case "file_written":
    case "file_edited":
      return shortPath(toolTarget);
    case "search_performed":
      return toolQuery ?? "search";
    case "url_fetched":
      return shortUrl(toolTarget ?? toolQuery);
    case "code_committed":
    case "test_run":
    case "command_run":
      return (toolQuery ?? "").slice(0, 120) || "command";
    case "message_sent":
      return toolTarget ?? "message";
    default:
      return toolQuery ?? toolTarget ?? "unknown";
  }
}

const DAY = 86_400_000;

export async function GET(req: NextRequest) {
  const agent = req.nextUrl.searchParams.get("agent") || null;
  const outcomeType = req.nextUrl.searchParams.get("type") || null;
  const sinceParam = req.nextUrl.searchParams.get("since");
  const limitParam = req.nextUrl.searchParams.get("limit");

  const since = sinceParam ? Number(sinceParam) : Date.now() - 7 * DAY;
  const limit = Math.min(Math.max(Number(limitParam) || 200, 1), 1000);

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
    // Build tool_name filter
    let toolNames = OUTCOME_TOOL_NAMES;
    if (outcomeType && TYPE_TO_TOOLS[outcomeType]) {
      toolNames = TYPE_TO_TOOLS[outcomeType];
    }
    const toolPlaceholders = toolNames.map(() => "?").join(",");

    // Build WHERE clause
    const conditions = [
      "type = 'tool_call'",
      `tool_name IN (${toolPlaceholders})`,
      "ts >= ?",
    ];
    const params: (string | number)[] = [...toolNames, since];

    if (agent) {
      conditions.push("agent = ?");
      params.push(agent);
    }

    const where = conditions.join(" AND ");

    // Count total
    const countRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM events WHERE ${where}`)
      .get(...params) as { cnt: number };

    // Fetch rows
    const queryParams = [...params, limit];
    const rows = db
      .prepare(
        `SELECT id, ts, agent, session, tool_name, tool_query, tool_target
         FROM events
         WHERE ${where}
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(...queryParams) as Array<{
      id: number;
      ts: number;
      agent: string;
      session: string;
      tool_name: string;
      tool_query: string | null;
      tool_target: string | null;
    }>;

    // Distinct agents in range
    const agentRows = db
      .prepare(
        `SELECT DISTINCT agent FROM events WHERE type = 'tool_call' AND ts >= ? ORDER BY agent`,
      )
      .all(since) as Array<{ agent: string }>;

    db.close();

    // Classify and filter
    const outcomes: Array<{
      id: number;
      ts: number;
      agent: string;
      session: string;
      outcomeType: string;
      label: string;
      target: string | null;
      detail: string | null;
    }> = [];

    for (const row of rows) {
      const ot = classifyOutcome(row.tool_name, row.tool_query);
      if (!ot) continue;
      // Post-filter for specific outcome type (exec can be commit/test/command)
      if (outcomeType && ot !== outcomeType) continue;

      outcomes.push({
        id: row.id,
        ts: row.ts,
        agent: row.agent,
        session: row.session,
        outcomeType: ot,
        label: outcomeLabel(ot, row.tool_target, row.tool_query),
        target: row.tool_target,
        detail: row.tool_query,
      });
    }

    return NextResponse.json({
      ok: true,
      outcomes,
      total: countRow.cnt,
      agents: agentRows.map((r) => r.agent),
    });
  } catch (err) {
    try { db.close(); } catch {}
    console.error("[outcomes] Error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: safeErrorMessage(err) }, { status: 500 });
  }
}
