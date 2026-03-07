import { getDb } from "./db-core";
import { setOnPricingRecalc } from "./billing";

// ── Cost summary with period bucketing ──────────────────────────────

export interface ModelBreakdown {
  model: string;
  provider: string;
  requests: number;
  cost: number;
  billing: string;
  apiEquivalent?: number;
}

export interface AgentCostSummary {
  agent: string;
  daily: number;
  weekly: number;
  monthly: number;
  dailyRequests: number;
  weeklyRequests: number;
  monthlyRequests: number;
  hourly: Array<{ hour: number; cost: number; requests: number }>;
  billing: "metered" | "subscription" | "mixed";
  models: ModelBreakdown[];
  apiEquivDaily?: number;
  apiEquivWeekly?: number;
  apiEquivMonthly?: number;
  cronDaily?: number;
  cronWeekly?: number;
  cronMonthly?: number;
  cronDailyReqs?: number;
  cronWeeklyReqs?: number;
  cronMonthlyReqs?: number;
  // Flexible time-range fields (when `since` param is provided)
  range?: number;
  rangeReqs?: number;
  apiEquivRange?: number;
  cronRange?: number;
  cronRangeReqs?: number;
}

// ── Tool Cost Attribution ──────────────────────────────────────

export interface ToolCostRow {
  tool_name: string;
  call_count: number;
  success_count: number;
  avg_duration_ms: number;
  total_cost: number;
  total_tokens: number;
  metered_cost: number;
  metered_tokens: number;
  subscription_cost: number;
  subscription_tokens: number;
}

/**
 * Attributes LLM cost to tool calls using timestamp proximity (±60s).
 * Same approach as enrichEvent() — session keys differ between JSONL poller
 * and hooks, so we match by agent + time proximity only.
 */
export function queryToolCosts(since: number, agent?: string): ToolCostRow[] {
  // Two-pass approach: first get tool_call events, then find nearest llm_output for each.
  // Avoids correlated subqueries which older SQLite versions handle poorly.
  const conditions = ["type = 'tool_call'", "ts >= ?"];
  const params: unknown[] = [since];
  if (agent) {
    conditions.push("agent = ?");
    params.push(agent);
  }

  const db = getDb();
  const toolCalls = db.prepare(
    `SELECT id, ts, agent, json_extract(detail, '$.tool') as tool_name,
            json_extract(detail, '$.success') as success,
            CAST(json_extract(detail, '$.durationMs') as REAL) as duration_ms
     FROM events WHERE ${conditions.join(" AND ")}
     ORDER BY ts DESC LIMIT 5000`
  ).all(...params) as Array<{ id: number; ts: number; agent: string; tool_name: string; success: number; duration_ms: number }>;

  if (toolCalls.length === 0) return [];

  // For each tool_call, find nearest llm_output cost + billing mode
  const findNearest = db.prepare(
    `SELECT COALESCE(provider_cost, cost, 0) as cost,
            COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) as tokens,
            COALESCE(billing, 'metered') as billing
     FROM events
     WHERE type = 'llm_output' AND agent = ? AND ts BETWEEN ? AND ?
     ORDER BY ABS(ts - ?) LIMIT 1`
  );

  const byTool: Record<string, {
    calls: number; success: number; duration: number;
    metered_cost: number; metered_tokens: number;
    subscription_cost: number; subscription_tokens: number;
  }> = {};

  for (const tc of toolCalls) {
    if (!byTool[tc.tool_name]) byTool[tc.tool_name] = {
      calls: 0, success: 0, duration: 0,
      metered_cost: 0, metered_tokens: 0,
      subscription_cost: 0, subscription_tokens: 0,
    };
    const t = byTool[tc.tool_name];
    t.calls++;
    if (tc.success) t.success++;
    t.duration += tc.duration_ms ?? 0;

    const nearest = findNearest.get(tc.agent, tc.ts - 60000, tc.ts + 60000, tc.ts) as { cost: number; tokens: number; billing: string } | undefined;
    if (nearest) {
      if (nearest.billing === 'subscription') {
        t.subscription_cost += nearest.cost;
        t.subscription_tokens += nearest.tokens;
      } else {
        t.metered_cost += nearest.cost;
        t.metered_tokens += nearest.tokens;
      }
    }
  }

  return Object.entries(byTool)
    .map(([tool_name, t]) => ({
      tool_name,
      call_count: t.calls,
      success_count: t.success,
      avg_duration_ms: t.calls > 0 ? t.duration / t.calls : 0,
      total_cost: t.metered_cost,
      total_tokens: t.metered_tokens + t.subscription_tokens,
      metered_cost: t.metered_cost,
      metered_tokens: t.metered_tokens,
      subscription_cost: t.subscription_cost,
      subscription_tokens: t.subscription_tokens,
    }))
    .sort((a, b) => b.total_cost - a.total_cost);
}

// ── Cost cache ──────────────────────────────────────────────────────

const COST_CACHE_TTL = 30_000;
let costCache: { data: AgentCostSummary[]; ts: number; since: number | undefined; until: number | undefined } | null = null;

/** Invalidate cost cache (called after reconciliation or pricing recalc). */
export function invalidateCostCache(): void {
  costCache = null;
}

// Register pricing recalc hook to invalidate cost cache
setOnPricingRecalc(invalidateCostCache);

/** Returns per-agent cost summary bucketed by day/week/month, with hourly sparkline. Cached 30s. */
export function queryCostSummary(opts?: { since?: number; until?: number }): AgentCostSummary[] {
  const since = opts?.since;
  const until = opts?.until;
  if (costCache && Date.now() - costCache.ts < COST_CACHE_TTL && costCache.since === since && costCache.until === until) return costCache.data;

  const now = new Date();
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(now); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const sinceMs = since ?? monthStart.getTime();
  const untilMs = until ?? Date.now();
  const queryFrom = Math.min(sinceMs, monthStart.getTime());

  const sql = `
    SELECT e.agent, e.ts, COALESCE(e.provider_cost, e.cost) as cost, e.billing, e.model,
      COALESCE(e.input_tokens, 0) as input_tokens,
      COALESCE(e.output_tokens, 0) as output_tokens,
      COALESCE(e.cache_read, 0) as cache_read,
      COALESCE(e.cache_write, 0) as cache_write,
      s.channel
    FROM events e
    LEFT JOIN sessions s ON e.session = s.session_key
    WHERE e.type = 'llm_output' AND e.ts >= ?${until ? " AND e.ts <= ?" : ""}
    ORDER BY e.agent, e.ts
  `;
  const params: number[] = [queryFrom];
  if (until) params.push(until);

  const rows = getDb()
    .prepare(sql)
    .all(...params) as Array<{
      agent: string; ts: number; cost: number; billing: string | null; model: string | null;
      input_tokens: number; output_tokens: number; cache_read: number; cache_write: number;
      channel: string | null;
    }>;

  const byAgent: Record<string, {
    daily: number; weekly: number; monthly: number;
    dailyReqs: number; weeklyReqs: number; monthlyReqs: number;
    hourlyCostMap: Map<number, number>; hourlyReqMap: Map<number, number>;
    billingModes: Set<string>;
    modelMap: Map<string, { requests: number; cost: number; billing: string; apiEquivCost: number }>;
    apiEquivDaily: number; apiEquivWeekly: number; apiEquivMonthly: number;
    cronDaily: number; cronWeekly: number; cronMonthly: number;
    cronDailyReqs: number; cronWeeklyReqs: number; cronMonthlyReqs: number;
    range: number; rangeReqs: number; apiEquivRange: number;
    cronRange: number; cronRangeReqs: number;
  }> = {};
  const todayMs = todayStart.getTime();
  const weekMs = weekStart.getTime();
  const hourlyStart = now.getTime() - 24 * 60 * 60 * 1000;

  for (const r of rows) {
    if (!byAgent[r.agent]) {
      byAgent[r.agent] = {
        daily: 0, weekly: 0, monthly: 0,
        dailyReqs: 0, weeklyReqs: 0, monthlyReqs: 0,
        hourlyCostMap: new Map(), hourlyReqMap: new Map(),
        billingModes: new Set(), modelMap: new Map(),
        apiEquivDaily: 0, apiEquivWeekly: 0, apiEquivMonthly: 0,
        cronDaily: 0, cronWeekly: 0, cronMonthly: 0,
        cronDailyReqs: 0, cronWeeklyReqs: 0, cronMonthlyReqs: 0,
        range: 0, rangeReqs: 0, apiEquivRange: 0,
        cronRange: 0, cronRangeReqs: 0,
      };
    }
    const a = byAgent[r.agent];
    if (r.billing) a.billingModes.add(r.billing);
    // For subscription events, actual cost is $0 (flat rate). The cost column
    // holds the API-equivalent estimate, which goes into apiEquiv fields only.
    const cost = r.billing === "subscription" ? 0 : (r.cost ?? 0);

    // Compute API equivalent for subscription events (from cost column which has the estimate)
    const apiEquiv = (r.billing === "subscription")
      ? (r.cost ?? 0)
      : 0;

    // Track per-model breakdown
    if (r.model) {
      const existing = a.modelMap.get(r.model);
      if (existing) {
        existing.requests++;
        existing.cost += cost;
        existing.apiEquivCost += apiEquiv;
      } else {
        a.modelMap.set(r.model, { requests: 1, cost, billing: r.billing ?? "metered", apiEquivCost: apiEquiv });
      }
    }

    // Always count requests (regardless of cost)
    a.monthlyReqs++;
    if (r.ts >= weekMs) a.weeklyReqs++;
    if (r.ts >= todayMs) a.dailyReqs++;
    if (r.ts >= sinceMs && r.ts <= untilMs) a.rangeReqs++;

    if (cost > 0) {
      a.monthly += cost;
      if (r.ts >= weekMs) a.weekly += cost;
      if (r.ts >= todayMs) a.daily += cost;
      if (r.ts >= sinceMs && r.ts <= untilMs) a.range += cost;
    }

    // API equivalent accumulation for subscription events
    if (apiEquiv > 0) {
      a.apiEquivMonthly += apiEquiv;
      if (r.ts >= weekMs) a.apiEquivWeekly += apiEquiv;
      if (r.ts >= todayMs) a.apiEquivDaily += apiEquiv;
      if (r.ts >= sinceMs && r.ts <= untilMs) a.apiEquivRange += apiEquiv;
    }

    // Cron cost attribution
    const isCron = r.channel === "cron";
    if (isCron) {
      if (cost > 0) {
        a.cronMonthly += cost;
        if (r.ts >= weekMs) a.cronWeekly += cost;
        if (r.ts >= todayMs) a.cronDaily += cost;
      }
      a.cronMonthlyReqs++;
      if (r.ts >= weekMs) a.cronWeeklyReqs++;
      if (r.ts >= todayMs) a.cronDailyReqs++;
      if (r.ts >= sinceMs && r.ts <= untilMs) { a.cronRangeReqs++; if (cost > 0) a.cronRange += cost; }
    }

    if (r.ts >= hourlyStart) {
      const hourBucket = Math.floor((r.ts - hourlyStart) / (60 * 60 * 1000));
      if (cost > 0) a.hourlyCostMap.set(hourBucket, (a.hourlyCostMap.get(hourBucket) ?? 0) + cost);
      a.hourlyReqMap.set(hourBucket, (a.hourlyReqMap.get(hourBucket) ?? 0) + 1);
    }
  }

  const result: AgentCostSummary[] = Object.entries(byAgent).map(([agent, data]) => {
    const hourly: Array<{ hour: number; cost: number; requests: number }> = [];
    for (let h = 0; h < 24; h++) {
      hourly.push({
        hour: h,
        cost: Math.round((data.hourlyCostMap.get(h) ?? 0) * 10000) / 10000,
        requests: data.hourlyReqMap.get(h) ?? 0,
      });
    }
    const modes = data.billingModes;
    const billing: "metered" | "subscription" | "mixed" =
      modes.size === 0 ? "metered"
      : modes.size === 1 ? (modes.has("subscription") ? "subscription" : "metered")
      : "mixed";
    const models: ModelBreakdown[] = Array.from(data.modelMap.entries()).map(([model, m]) => {
      const slashIdx = model.indexOf("/");
      const entry: ModelBreakdown = {
        model,
        provider: slashIdx > 0 ? model.slice(0, slashIdx) : "unknown",
        requests: m.requests,
        cost: Math.round(m.cost * 10000) / 10000,
        billing: m.billing,
      };
      if (m.apiEquivCost > 0) entry.apiEquivalent = Math.round(m.apiEquivCost * 10000) / 10000;
      return entry;
    }).sort((a, b) => b.requests - a.requests);

    const summary: AgentCostSummary = {
      agent,
      daily: Math.round(data.daily * 10000) / 10000,
      weekly: Math.round(data.weekly * 10000) / 10000,
      monthly: Math.round(data.monthly * 10000) / 10000,
      dailyRequests: data.dailyReqs,
      weeklyRequests: data.weeklyReqs,
      monthlyRequests: data.monthlyReqs,
      hourly,
      billing,
      models,
    };
    if (data.apiEquivDaily > 0) summary.apiEquivDaily = Math.round(data.apiEquivDaily * 10000) / 10000;
    if (data.apiEquivWeekly > 0) summary.apiEquivWeekly = Math.round(data.apiEquivWeekly * 10000) / 10000;
    if (data.apiEquivMonthly > 0) summary.apiEquivMonthly = Math.round(data.apiEquivMonthly * 10000) / 10000;
    if (data.cronMonthlyReqs > 0) {
      summary.cronDaily = Math.round(data.cronDaily * 10000) / 10000;
      summary.cronWeekly = Math.round(data.cronWeekly * 10000) / 10000;
      summary.cronMonthly = Math.round(data.cronMonthly * 10000) / 10000;
      summary.cronDailyReqs = data.cronDailyReqs;
      summary.cronWeeklyReqs = data.cronWeeklyReqs;
      summary.cronMonthlyReqs = data.cronMonthlyReqs;
    }
    // Range fields (always included when since is provided)
    if (since !== undefined) {
      summary.range = Math.round(data.range * 10000) / 10000;
      summary.rangeReqs = data.rangeReqs;
      if (data.apiEquivRange > 0) summary.apiEquivRange = Math.round(data.apiEquivRange * 10000) / 10000;
      if (data.cronRangeReqs > 0) {
        summary.cronRange = Math.round(data.cronRange * 10000) / 10000;
        summary.cronRangeReqs = data.cronRangeReqs;
      }
    }
    return summary;
  });

  costCache = { data: result, ts: Date.now(), since, until };
  return result;
}

// ── Cost timeline for multi-day sparklines ──────────────────────────

export interface CostTimelineBucket {
  ts: number;     // bucket start timestamp (ms)
  cost: number;
  calls: number;
  tokens: number; // total tokens (input + output + cache)
}

export interface CostTimeline {
  agent: string;
  buckets: CostTimelineBucket[];
  total: number;
  billing: "metered" | "subscription" | "mixed";
}

/**
 * Hourly cost buckets over a configurable time range, optionally filtered by agent.
 * Unlike queryCostSummary (30s cache, 24h only), this is on-demand and supports 1–30 days.
 */
export function queryCostTimeline(opts?: { agent?: string; days?: number }): CostTimeline[] {
  const days = Math.min(Math.max(opts?.days ?? 7, 1), 30);
  const now = Date.now();
  const since = now - days * 24 * 60 * 60 * 1000;
  const totalBuckets = days * 24;

  const conditions = ["type = 'llm_output'", "ts >= ?"];
  const params: unknown[] = [since];
  if (opts?.agent) { conditions.push("agent = ?"); params.push(opts.agent); }

  const rows = getDb()
    .prepare(`
      SELECT agent, ts, COALESCE(provider_cost, cost) as cost, billing,
        COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read, 0) as tokens
      FROM events
      WHERE ${conditions.join(" AND ")}
      ORDER BY agent, ts
    `)
    .all(...params) as Array<{ agent: string; ts: number; cost: number; billing: string | null; tokens: number }>;

  const byAgent: Record<string, { bucketMap: Map<number, { cost: number; calls: number; tokens: number }>; total: number; billingModes: Set<string> }> = {};

  for (const r of rows) {
    if (!byAgent[r.agent]) {
      byAgent[r.agent] = { bucketMap: new Map(), total: 0, billingModes: new Set() };
    }
    const a = byAgent[r.agent];
    if (r.billing) a.billingModes.add(r.billing);
    const cost = r.cost ?? 0;
    a.total += cost;
    const bucket = Math.floor((r.ts - since) / (60 * 60 * 1000));
    const existing = a.bucketMap.get(bucket) ?? { cost: 0, calls: 0, tokens: 0 };
    existing.cost += cost;
    existing.calls += 1;
    existing.tokens += r.tokens ?? 0;
    a.bucketMap.set(bucket, existing);
  }

  return Object.entries(byAgent).map(([agent, data]) => {
    const buckets: CostTimelineBucket[] = [];
    for (let b = 0; b < totalBuckets; b++) {
      const entry = data.bucketMap.get(b);
      buckets.push({
        ts: since + b * 60 * 60 * 1000,
        cost: Math.round((entry?.cost ?? 0) * 10000) / 10000,
        calls: entry?.calls ?? 0,
        tokens: entry?.tokens ?? 0,
      });
    }
    const modes = data.billingModes;
    const billing: "metered" | "subscription" | "mixed" =
      modes.size === 0 ? "metered"
      : modes.size === 1 ? (modes.has("subscription") ? "subscription" : "metered")
      : "mixed";
    return {
      agent,
      buckets,
      total: Math.round(data.total * 10000) / 10000,
      billing,
    };
  });
}
