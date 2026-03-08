import { getDb } from "./db-core";

// ── Query helpers for HTTP routes ──────────────────────────────────

export interface StreamQuery {
  agent?: string;
  type?: string;
  since?: number;
  until?: number;
  limit?: number;
  runId?: string;
  session?: string;
  subFilters?: string; // comma-separated sub-filter keys (e.g. "has-compaction,has-tool-use")
  types?: string; // comma-separated type filters (e.g. "llm_input,tool_call")
  source?: string; // "agent" | "heartbeat" | "cron" — filter events by session source
}

// Maps sub-filter keys to SQL conditions applied to the events query
const SUB_FILTER_SQL: Record<string, string> = {
  "thinking": "thinking IS NOT NULL",
  "cached": "cache_read > 0",
  "no-cache": "(cache_read IS NULL OR cache_read = 0)",
  "sub-billing": "billing = 'subscription'",
  "metered-billing": "billing = 'metered'",
  "has-compaction": "json_extract(detail, '$.hasCompaction') = 1",
  "has-tool-use": "json_extract(detail, '$.hasToolUse') = 1",
  "has-images": "json_extract(detail, '$.imagesCount') > 0",
  "large-context": "json_extract(detail, '$.systemPromptLen') >= 10000",
  "tool-read": `json_extract(detail, '$.tool') IN ('read','sessions_list','session_status','web_search','image','gateway')`,
  "tool-write": `json_extract(detail, '$.tool') IN ('exec','edit','write','sessions_send','message','process')`,
  "tool-failed": "json_extract(detail, '$.success') = 0",
  "tool-cron": "json_extract(detail, '$.tool') = 'cron'",
  "msg-discord": "session LIKE '%discord%'",
  "msg-hook": "session LIKE '%hook%'",
};

export function queryStream(q: StreamQuery): unknown[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (q.since) { conditions.push("ts >= ?"); params.push(q.since); }
  if (q.until) { conditions.push("ts <= ?"); params.push(q.until); }
  if (q.agent) { conditions.push("agent = ?"); params.push(q.agent); }
  if (q.type) { conditions.push("type = ?"); params.push(q.type); }
  if (q.runId) { conditions.push("run_id = ?"); params.push(q.runId); }

  // Multiple type filters (OR)
  if (q.types) {
    const typeList = q.types.split(",").map(t => t.trim()).filter(Boolean);
    if (typeList.length === 1) {
      conditions.push("type = ?"); params.push(typeList[0]);
    } else if (typeList.length > 1) {
      conditions.push(`type IN (${typeList.map(() => "?").join(",")})`);
      params.push(...typeList);
    }
  }

  // Sub-filters: each maps to a SQL condition (AND logic)
  if (q.subFilters) {
    const subs = q.subFilters.split(",").map(s => s.trim()).filter(Boolean);
    for (const sub of subs) {
      // Handle "tool:toolname" pattern for individual tools
      if (sub.startsWith("tool:")) {
        const toolName = sub.slice(5);
        conditions.push("json_extract(detail, '$.tool') = ?");
        params.push(toolName);
      } else if (SUB_FILTER_SQL[sub]) {
        conditions.push(SUB_FILTER_SQL[sub]);
      }
    }
  }
  if (q.session) {
    // Session keys have multiple formats in the DB for the same logical session:
    //   "agent:main:discord:channel:123..." (gateway hooks)
    //   "main/9de7d054-....jsonl" (JSONL poller)
    //   "channel:123..." (legacy format)
    // Accept comma-separated list to match all variants.
    // Auto-resolve: extract session_id from any key format, then find all
    // variant keys from the sessions table so events stored under any format match.
    let variants = q.session.split(",").map(s => s.trim()).filter(Boolean);

    // Auto-resolve session variants via session_id lookup.
    // Given any session key format, find the session_id, then discover all
    // variant keys so events stored under any format are returned.
    if (variants.length <= 3) {
      const resolved = new Set(variants);
      for (const v of variants) {
        try {
          // Step 1: Find session_id — either embedded in the key or via DB lookup
          let sessionId: string | null = null;
          const uuidMatch = v.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
          if (uuidMatch) {
            sessionId = uuidMatch[1];
          } else {
            // Look up session_id from session_key (handles agent:...:channel:... format)
            const row = db.prepare(
              "SELECT session_id FROM sessions WHERE session_key = ?"
            ).get(v) as { session_id: string | null } | undefined;
            if (row?.session_id) sessionId = row.session_id;
          }

          if (sessionId) {
            // Step 2: Find all session_keys for this session_id
            const rows = db.prepare(
              "SELECT session_key FROM sessions WHERE session_id = ?"
            ).all(sessionId) as Array<{ session_key: string }>;
            for (const r of rows) resolved.add(r.session_key);

            // Step 3: Also check common event key formats
            // Events from JSONL backfill are stored as {agentDir}/{sessionId}.jsonl
            const evtKeys = db.prepare(
              "SELECT DISTINCT session FROM events WHERE session LIKE ? LIMIT 5"
            ).all(`%${sessionId}%`) as Array<{ session: string }>;
            for (const r of evtKeys) resolved.add(r.session);
          }
        } catch { /* ignore */ }
      }
      variants = [...resolved];
    }

    if (variants.length === 1) {
      conditions.push("session = ?");
      params.push(variants[0]);
    } else if (variants.length > 1) {
      conditions.push(`session IN (${variants.map(() => "?").join(",")})`);
      params.push(...variants);
    }
  }

  // Source filter: use subquery on sessions table to find matching session_keys
  if (q.source && ["agent", "heartbeat", "cron"].includes(q.source)) {
    conditions.push("session IN (SELECT session_key FROM sessions WHERE source = ?)");
    params.push(q.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  // Allow higher limit when filtering by session (full conversation view)
  const maxLimit = q.session ? 10000 : 5000;
  const limit = Math.min(q.limit ?? 500, maxLimit);

  // Select only lightweight columns for the stream listing.
  // Full text (prompt, response, thinking) fetched on-demand via queryEventDetail().
  const cols = `id, ts, agent, session, type, model, input_tokens, output_tokens,
    cache_read, cache_write, cost, detail, run_id, resolved_model, provider_cost, billing,
    CASE WHEN thinking IS NOT NULL THEN 1 ELSE 0 END as has_thinking,
    CASE WHEN prompt IS NOT NULL THEN 1 ELSE 0 END as has_prompt,
    CASE WHEN response IS NOT NULL THEN 1 ELSE 0 END as has_response`;

  return db
    .prepare(`SELECT ${cols} FROM events ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit);
}

/** Fetch full text fields for a single event by ID (on-demand expansion). */
export function queryEventDetail(id: number): unknown | null {
  return getDb()
    .prepare("SELECT id, prompt, response, thinking FROM events WHERE id = ?")
    .get(id) ?? null;
}

/**
 * Server-side sub-filter counts — efficient SQL aggregation over the full dataset.
 * Returns counts for each sub-filter key within the selected time range.
 */
export function querySubFilterCounts(since: number, until?: number): Record<string, number> {
  const db = getDb();
  const timeCond = until ? "ts >= ? AND ts <= ?" : "ts >= ?";
  const timeParams: unknown[] = until ? [since, until] : [since];

  const counts: Record<string, number> = {};

  // llm_output sub-filters
  const llmOut = db.prepare(`
    SELECT
      SUM(CASE WHEN thinking IS NOT NULL THEN 1 ELSE 0 END) as thinking,
      SUM(CASE WHEN cache_read > 0 THEN 1 ELSE 0 END) as cached,
      SUM(CASE WHEN cache_read IS NULL OR cache_read = 0 THEN 1 ELSE 0 END) as no_cache,
      SUM(CASE WHEN billing = 'subscription' THEN 1 ELSE 0 END) as sub_billing,
      SUM(CASE WHEN billing = 'metered' THEN 1 ELSE 0 END) as metered_billing
    FROM events WHERE ${timeCond} AND type = 'llm_output'
  `).get(...timeParams) as Record<string, number> | undefined;
  if (llmOut) {
    counts["thinking"] = llmOut.thinking ?? 0;
    counts["cached"] = llmOut.cached ?? 0;
    counts["no-cache"] = llmOut.no_cache ?? 0;
    counts["sub-billing"] = llmOut.sub_billing ?? 0;
    counts["metered-billing"] = llmOut.metered_billing ?? 0;
  }

  // llm_input sub-filters (from detail JSON flags)
  const llmIn = db.prepare(`
    SELECT
      SUM(CASE WHEN json_extract(detail, '$.hasCompaction') = 1 THEN 1 ELSE 0 END) as has_compaction,
      SUM(CASE WHEN json_extract(detail, '$.hasToolUse') = 1 THEN 1 ELSE 0 END) as has_tool_use,
      SUM(CASE WHEN json_extract(detail, '$.imagesCount') > 0 THEN 1 ELSE 0 END) as has_images,
      SUM(CASE WHEN json_extract(detail, '$.systemPromptLen') >= 10000 THEN 1 ELSE 0 END) as large_context
    FROM events WHERE ${timeCond} AND type = 'llm_input'
  `).get(...timeParams) as Record<string, number> | undefined;
  if (llmIn) {
    counts["has-compaction"] = llmIn.has_compaction ?? 0;
    counts["has-tool-use"] = llmIn.has_tool_use ?? 0;
    counts["has-images"] = llmIn.has_images ?? 0;
    counts["large-context"] = llmIn.large_context ?? 0;
  }

  // tool_call sub-filters (static tool lists, safe to interpolate)
  const READ_TOOLS = "'read','sessions_list','session_status','web_search','image','gateway'";
  const WRITE_TOOLS = "'exec','edit','write','sessions_send','message','process'";

  const toolCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN json_extract(detail, '$.tool') IN (${READ_TOOLS}) THEN 1 ELSE 0 END) as tool_read,
      SUM(CASE WHEN json_extract(detail, '$.tool') IN (${WRITE_TOOLS}) THEN 1 ELSE 0 END) as tool_write,
      SUM(CASE WHEN json_extract(detail, '$.success') = 0 THEN 1 ELSE 0 END) as tool_failed,
      SUM(CASE WHEN json_extract(detail, '$.tool') = 'cron' THEN 1 ELSE 0 END) as tool_cron
    FROM events WHERE ${timeCond} AND type = 'tool_call'
  `).get(...timeParams) as Record<string, number> | undefined;
  if (toolCounts) {
    counts["tool-read"] = toolCounts.tool_read ?? 0;
    counts["tool-write"] = toolCounts.tool_write ?? 0;
    counts["tool-failed"] = toolCounts.tool_failed ?? 0;
    counts["tool-cron"] = toolCounts.tool_cron ?? 0;
  }

  // Top individual tools
  const topTools = db.prepare(`
    SELECT json_extract(detail, '$.tool') as tool, COUNT(*) as cnt
    FROM events WHERE ${timeCond} AND type = 'tool_call' AND json_extract(detail, '$.tool') IS NOT NULL
    GROUP BY tool ORDER BY cnt DESC LIMIT 10
  `).all(...timeParams) as Array<{ tool: string; cnt: number }>;
  for (const t of topTools) {
    counts[`tool:${t.tool}`] = t.cnt;
  }

  // msg_in sub-filters
  const msgIn = db.prepare(`
    SELECT
      SUM(CASE WHEN session LIKE '%discord%' THEN 1 ELSE 0 END) as msg_discord,
      SUM(CASE WHEN session LIKE '%hook%' THEN 1 ELSE 0 END) as msg_hook
    FROM events WHERE ${timeCond} AND type = 'msg_in'
  `).get(...timeParams) as Record<string, number> | undefined;
  if (msgIn) {
    counts["msg-discord"] = msgIn.msg_discord ?? 0;
    counts["msg-hook"] = msgIn.msg_hook ?? 0;
  }

  return counts;
}

export interface SummaryResult {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  totalTokens: number;
  cost: number;
  calls: number;
  models: Record<string, { input: number; output: number; cache: number }>;
}

export function querySummary(since: number, agent?: string): SummaryResult[] {
  const conditions = ["ts >= ?", "type = 'llm_output'"];
  const params: unknown[] = [since];
  if (agent) { conditions.push("agent = ?"); params.push(agent); }

  const rows = getDb()
    .prepare(`
      SELECT agent, model,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read) as cache_read,
        SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read,0) + COALESCE(cache_write,0)) as total_tokens,
        SUM(COALESCE(provider_cost, cost, 0)) as cost,
        COUNT(*) as calls
      FROM events
      WHERE ${conditions.join(" AND ")}
      GROUP BY agent, model
    `)
    .all(...params) as Array<{
      agent: string; model: string;
      input_tokens: number; output_tokens: number; cache_read: number;
      total_tokens: number; cost: number; calls: number;
    }>;

  const byAgent: Record<string, SummaryResult> = {};
  for (const r of rows) {
    if (!byAgent[r.agent]) {
      byAgent[r.agent] = {
        agent: r.agent,
        inputTokens: 0, outputTokens: 0, cacheRead: 0,
        totalTokens: 0, cost: 0, calls: 0, models: {},
      };
    }
    const a = byAgent[r.agent];
    a.inputTokens += r.input_tokens ?? 0;
    a.outputTokens += r.output_tokens ?? 0;
    a.cacheRead += r.cache_read ?? 0;
    a.totalTokens += r.total_tokens ?? 0;
    a.cost += r.cost ?? 0;
    a.calls += r.calls;
    if (r.model) {
      if (!a.models[r.model]) a.models[r.model] = { input: 0, output: 0, cache: 0 };
      a.models[r.model].input += r.input_tokens ?? 0;
      a.models[r.model].output += r.output_tokens ?? 0;
      a.models[r.model].cache += r.cache_read ?? 0;
    }
  }

  return Object.values(byAgent).sort((a, b) => b.totalTokens - a.totalTokens);
}

export function queryAgents(): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT agent FROM events ORDER BY agent")
    .all() as Array<{ agent: string }>;
  return rows.map((r) => r.agent);
}

// ── Provider usage query (for rate limit checks) ────────────────────

export interface ProviderUsageEvent {
  model: string;
  ts: number;
}

/**
 * Query subscription events for a provider within a time window.
 * Returns individual events with model + timestamp for flexible aggregation
 * (weighted pools, per-model counts, etc).
 */
export function queryProviderUsage(provider: string, since: number): ProviderUsageEvent[] {
  return getDb()
    .prepare(`
      SELECT model, ts FROM events
      WHERE type = 'llm_output' AND billing = 'subscription' AND model LIKE ? AND ts >= ?
      ORDER BY ts
    `)
    .all(`${provider}/%`, since) as ProviderUsageEvent[];
}
