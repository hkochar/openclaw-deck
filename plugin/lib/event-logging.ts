import type Database from "better-sqlite3";
import { getDb, checkAndClearDemoMarker, incrementDroppedCount } from "./db-core";
import { checkForLoop } from "./loop-detection";
import { getLogger } from "../logger";

// Prepared statements (lazy-initialized)
let insertStmt: Database.Statement | null = null;

function getInsertStmt(): Database.Statement {
  if (insertStmt) return insertStmt;
  insertStmt = getDb().prepare(`
    INSERT INTO events (ts, agent, session, type, model, input_tokens, output_tokens, cache_read, cache_write, cost, detail, run_id, prompt, response, thinking, resolved_model, provider_cost, billing, tool_name, tool_query, tool_target)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return insertStmt;
}

/** Extract indexed tool fields from detail for fast querying */
export function extractToolFields(detail?: Record<string, unknown>): { toolName: string | null; toolQuery: string | null; toolTarget: string | null } {
  if (!detail) return { toolName: null, toolQuery: null, toolTarget: null };
  const toolName = (detail.tool as string) ?? null;
  if (!toolName) return { toolName: null, toolQuery: null, toolTarget: null };

  const params = (detail.params ?? {}) as Record<string, unknown>;
  let toolQuery: string | null = null;
  let toolTarget: string | null = null;

  switch (toolName) {
    case "web_search":
    case "WebSearch":
      toolQuery = (params.query as string) ?? null;
      break;
    case "web_fetch":
    case "WebFetch":
      toolQuery = (params.url as string) ?? null;
      toolTarget = (params.url as string) ?? null;
      break;
    case "browser":
      toolTarget = (params.targetUrl as string) ?? (params.url as string) ?? null;
      toolQuery = (params.action as string) ?? null;
      break;
    case "read":
    case "Read":
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? null;
      break;
    case "write":
    case "Write":
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? null;
      break;
    case "edit":
    case "Edit":
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? null;
      break;
    case "exec":
    case "Bash":
      toolQuery = typeof params.command === "string" ? params.command.slice(0, 500) : null;
      break;
    case "memory_search":
      toolQuery = (params.query as string) ?? null;
      break;
    case "sessions_send":
    case "message":
      toolTarget = (params.channel as string) ?? (params.to as string) ?? (params.session as string) ?? null;
      break;
    default:
      // For unknown tools, try common param names
      toolQuery = (params.query as string) ?? (params.url as string) ?? null;
      toolTarget = (params.file_path as string) ?? (params.path as string) ?? (params.target as string) ?? null;
  }

  return { toolName, toolQuery, toolTarget };
}

export interface EventData {
  agent: string;
  session?: string;
  type: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  detail?: Record<string, unknown>;
  runId?: string;
  prompt?: string;
  response?: string;
  thinking?: string;
  resolvedModel?: string;
  providerCost?: number;
  billing?: "metered" | "subscription";
}

export function logEvent(data: EventData): void {
  // Remove demo marker on first real event (one-time)
  checkAndClearDemoMarker();

  // Check for stuck tool-call loops
  if (data.type === "tool_call" && data.detail) {
    checkForLoop(data.agent, data.detail);
  }

  try {
    const { toolName, toolQuery, toolTarget } = data.type === "tool_call" ? extractToolFields(data.detail) : { toolName: null, toolQuery: null, toolTarget: null };
    getInsertStmt().run(
      Date.now(),
      data.agent,
      data.session ?? null,
      data.type,
      data.model ?? null,
      data.inputTokens ?? null,
      data.outputTokens ?? null,
      data.cacheRead ?? null,
      data.cacheWrite ?? null,
      data.cost ?? null,
      data.detail ? JSON.stringify(data.detail) : null,
      data.runId ?? null,
      data.prompt ?? null,
      data.response ?? null,
      data.thinking ?? null,
      data.resolvedModel ?? null,
      data.providerCost ?? null,
      data.billing ?? null,
      toolName,
      toolQuery,
      toolTarget,
    );
  } catch (err) {
    // Don't crash the gateway for logging — but DO log the failure
    getLogger().warn(`[deck-sync] logEvent failed: ${(err as Error).message ?? err}`);
    incrementDroppedCount();
  }
}

/**
 * Enrich an existing llm_output event with data from the JSONL session log.
 * Matches by agent + session + timestamp proximity (±5s).
 * Used by the JSONL poller to backfill provider_cost, resolved_model, response, thinking.
 */
export function enrichEvent(opts: {
  agent: string;
  session?: string;
  tsApprox: number;
  resolvedModel?: string;
  providerCost?: number;
  response?: string;
  thinking?: string;
}): boolean {
  try {
    // Find closest matching event by agent + timestamp (session keys differ between
    // hooks and JSONL poller, so we match by agent + time proximity only)
    const row = getDb()
      .prepare(`
        SELECT id, billing FROM events
        WHERE agent = ? AND type = 'llm_output'
          AND ts BETWEEN ? AND ?
          AND resolved_model IS NULL
        ORDER BY ABS(ts - ?)
        LIMIT 1
      `)
      .get(
        opts.agent,
        opts.tsApprox - 5000, opts.tsApprox + 5000,
        opts.tsApprox,
      ) as { id: number; billing: string | null } | undefined;

    if (!row) return false;

    // Don't overwrite provider_cost on subscription events (subscription = $0 actual spend)
    const effectiveProviderCost = row.billing === "subscription" ? null : (opts.providerCost ?? null);

    const result = getDb()
      .prepare(`
        UPDATE events
        SET resolved_model = COALESCE(?, resolved_model),
            provider_cost = COALESCE(?, provider_cost),
            response = COALESCE(response, ?),
            thinking = COALESCE(thinking, ?)
        WHERE id = ?
      `)
      .run(
        opts.resolvedModel ?? null,
        effectiveProviderCost,
        opts.response ?? null,
        opts.thinking ?? null,
        row.id,
      );
    return (result.changes ?? 0) > 0;
  } catch {
    return false;
  }
}
