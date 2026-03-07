/**
 * Run Intelligence — compute-on-demand session metrics.
 *
 * Pure functions: events in → summary out. No DB access, no side effects.
 * See RUN-INTELLIGENCE-SPEC.md for algorithms and worked examples.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface EventRow {
  id: number;
  ts: number;
  type: string;
  agent: string | null;
  session: string | null;
  model: string | null;
  resolved_model: string | null;
  cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_write: number | null;
  has_thinking: number | null;
  has_prompt: number | null;
  has_response: number | null;
  billing: string | null;
  provider_cost: number | null;
  detail: string | null;
}

export type RunStatus = "completed" | "errored" | "live" | "unknown";
export type EndedReason = "heuristic" | "timeout" | "live";

export interface RunSummary {
  startedTs: number;
  endedTs: number;
  durationMs: number;
  status: RunStatus;
  endedReason: EndedReason;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  modelSet: string[];
  toolCallCount: number;
  uniqueToolCount: number;
  uniqueTools: string[];
  retryCount: number;
  maxLoopDepth: number;
  maxConsecutiveLlmCalls: number;
  errorCount: number;
  touchedConfig: boolean;
  gatewayRestarted: boolean;
  rollbackDuringRun: boolean;
  blockedByBudget: boolean;
  throttledByBudget: boolean;
  overrideActive: boolean;
  eventsMaxId: number;
  billing: "subscription" | "metered" | "mixed" | null;
}

export interface BaselineComparison {
  median: number;
  ratio: number | null; // null if ratio is between 0.5 and 1.5 (not notable)
  count: number;
}

export interface Comparison {
  agent: Partial<Record<string, BaselineComparison>> | null;
  global: Partial<Record<string, BaselineComparison>> | null;
}

// ── Algorithms ───────────────────────────────────────────────────────

const INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes

const CONFIG_TOOL_PATTERNS = [
  "config", "openclaw.json", "settings", "budget",
];

function parseDetail(ev: EventRow): Record<string, unknown> {
  if (!ev.detail) return {};
  try { return JSON.parse(ev.detail); } catch { return {}; }
}

function getToolName(ev: EventRow): string | null {
  const d = parseDetail(ev);
  return (d.tool as string) ?? (d.toolName as string) ?? null;
}

function isErrorEvent(ev: EventRow): boolean {
  const d = parseDetail(ev);
  if (d.isError === true || d.success === 0 || d.error) return true;
  if (ev.type === "tool_call" && d.success !== undefined && d.success !== true && d.success !== 1) return true;
  return false;
}

function getEndedReason(events: EventRow[]): EndedReason {
  if (!events.length) return "timeout";
  const lastTs = events[events.length - 1].ts;
  const now = Date.now();

  if (now - lastTs < INACTIVITY_MS) return "live";

  // Check if last event is llm_output with no subsequent tool_call
  let lastLlmIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "llm_output") { lastLlmIdx = i; break; }
  }
  if (lastLlmIdx >= 0) {
    const hasSubsequentTool = events
      .slice(lastLlmIdx + 1)
      .some(e => e.type === "tool_call");
    if (!hasSubsequentTool) return "heuristic";
  }
  return "timeout";
}

function getStatus(events: EventRow[], endedReason: EndedReason): RunStatus {
  if (endedReason === "live") return "live";

  // Check last 5 events for unrecovered errors
  const last5 = events.slice(-5);
  const hasRecentError = last5.some(e => isErrorEvent(e));

  if (hasRecentError) {
    // Find the first error in last5, check if any successful llm_output comes AFTER it
    const firstErrorIdx = last5.findIndex(e => isErrorEvent(e));
    const hasRecoveryAfterError = last5.slice(firstErrorIdx + 1).some(
      e => e.type === "llm_output" && !isErrorEvent(e)
    );
    if (!hasRecoveryAfterError) return "errored";
  }

  // Check for any terminal llm_output in the whole session
  const hasLlmOutput = events.some(e => e.type === "llm_output");
  if (hasLlmOutput) return "completed";

  return "unknown";
}

export function computeMaxLoopDepth(events: EventRow[]): number {
  let depth = 0;
  let maxDepth = 0;
  let lastWasLlmOutput = false;

  for (const e of events) {
    if (e.type === "llm_output") {
      if (lastWasLlmOutput) {
        depth = 0;
      }
      lastWasLlmOutput = true;
    } else if (e.type === "tool_call") {
      if (lastWasLlmOutput) {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
        lastWasLlmOutput = false;
      }
    }
  }
  return maxDepth;
}

export function computeMaxConsecutiveLlm(events: EventRow[]): number {
  let current = 0;
  let max = 0;
  for (const e of events) {
    if (e.type === "llm_output") {
      current += 1;
      max = Math.max(max, current);
    } else if (e.type === "tool_call") {
      current = 0;
    }
  }
  return max;
}

export function computeRetryCount(events: EventRow[]): number {
  let retries = 0;
  for (let i = 1; i < events.length; i++) {
    if (events[i].type !== "tool_call") continue;
    const currentTool = getToolName(events[i]);
    if (!currentTool) continue;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if (events[j].type === "tool_call" && getToolName(events[j]) === currentTool) {
        // Check if the previous same-tool call OR any event between them indicates error
        const hasError = isErrorEvent(events[j]) ||
          events.slice(j + 1, i).some(e => isErrorEvent(e));
        if (hasError) { retries++; break; }
      }
    }
  }
  return retries;
}

// ── Main Compute ─────────────────────────────────────────────────────

export function computeRunSummary(events: EventRow[]): RunSummary {
  if (!events.length) {
    return emptySummary();
  }

  const startedTs = events[0].ts;
  const endedTs = events[events.length - 1].ts;
  const endedReason = getEndedReason(events);
  const status = getStatus(events, endedReason);

  // Basic aggregations
  const llmOutputs = events.filter(e => e.type === "llm_output");
  const toolCalls = events.filter(e => e.type === "tool_call");

  // For subscription billing, use `cost` field (API-equivalent estimate) since
  // provider_cost may be 0 or a backfill artifact. For metered, prefer provider_cost.
  const totalCostUsd = llmOutputs.reduce((s, e) => {
    const isSub = e.billing === "subscription";
    return s + (isSub ? (e.cost ?? 0) : (e.provider_cost ?? e.cost ?? 0));
  }, 0);
  const totalTokensIn = llmOutputs.reduce((s, e) => s + (e.input_tokens ?? 0), 0);
  const totalTokensOut = llmOutputs.reduce((s, e) => s + (e.output_tokens ?? 0), 0);

  const modelSet = [...new Set(
    llmOutputs.map(e => e.resolved_model || e.model).filter(Boolean) as string[]
  )];

  // Tool metrics
  const toolNames = toolCalls.map(e => getToolName(e)).filter(Boolean) as string[];
  const uniqueTools = [...new Set(toolNames)].slice(0, 50);

  // Error count
  const errorCount = events.filter(e => isErrorEvent(e)).length;

  // Risk flags
  const touchedConfig = toolCalls.some(e => {
    const name = getToolName(e);
    return name ? CONFIG_TOOL_PATTERNS.some(p => name.toLowerCase().includes(p)) : false;
  });
  const gatewayRestarted = events.some(e =>
    e.type === "system_log" && parseDetail(e).category === "restart"
  );
  const rollbackDuringRun = events.some(e =>
    e.type === "system_log" && parseDetail(e).category === "rollback"
  );
  const blockedByBudget = events.some(e => e.type === "budget_blocked");
  const throttledByBudget = events.some(e => e.type === "budget_throttle");
  const overrideActive = events.some(e =>
    e.type === "budget_override" || (e.type === "system_log" && parseDetail(e).category === "budget-override")
  );

  return {
    startedTs,
    endedTs,
    durationMs: endedTs - startedTs,
    status,
    endedReason,
    totalCostUsd,
    totalTokensIn,
    totalTokensOut,
    modelSet,
    toolCallCount: toolCalls.length,
    uniqueToolCount: uniqueTools.length,
    uniqueTools,
    retryCount: computeRetryCount(events),
    maxLoopDepth: computeMaxLoopDepth(events),
    maxConsecutiveLlmCalls: computeMaxConsecutiveLlm(events),
    errorCount,
    touchedConfig,
    gatewayRestarted,
    rollbackDuringRun,
    blockedByBudget,
    throttledByBudget,
    overrideActive,
    eventsMaxId: events[events.length - 1].id,
    billing: (() => {
      const billingTypes = new Set(llmOutputs.map(e => e.billing).filter(Boolean));
      if (billingTypes.size === 0) return null;
      if (billingTypes.size > 1) return "mixed" as const;
      return (billingTypes.values().next().value as "subscription" | "metered") ?? null;
    })(),
  };
}

function emptySummary(): RunSummary {
  return {
    startedTs: 0, endedTs: 0, durationMs: 0,
    status: "unknown", endedReason: "timeout",
    totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0,
    modelSet: [], toolCallCount: 0, uniqueToolCount: 0, uniqueTools: [],
    retryCount: 0, maxLoopDepth: 0, maxConsecutiveLlmCalls: 0, errorCount: 0,
    touchedConfig: false, gatewayRestarted: false, rollbackDuringRun: false,
    blockedByBudget: false, throttledByBudget: false, overrideActive: false,
    eventsMaxId: 0,
    billing: null,
  };
}

// ── Baselines ────────────────────────────────────────────────────────

/** Lightweight per-session aggregates for baseline computation */
export interface SessionAggregate {
  session: string;
  agent: string | null;
  minTs: number;
  totalCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
  toolCallCount: number;
  durationMs: number;
  maxLoopDepth: number;
}


function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function compareMetric(
  current: number,
  sessions: SessionAggregate[],
  getter: (s: SessionAggregate) => number,
): BaselineComparison | null {
  if (sessions.length < 10) return null;
  const values = sessions.map(getter).filter(v => v != null);
  if (values.length < 10) return null;
  const med = median(values);
  if (med === 0) return { median: med, ratio: null, count: values.length };
  const ratio = current / med;
  return {
    median: med,
    ratio: ratio >= 1.5 || ratio <= 0.5 ? Math.round(ratio * 10) / 10 : null,
    count: values.length,
  };
}

export function computeComparison(
  summary: RunSummary,
  agentSessions: SessionAggregate[],
  globalSessions: SessionAggregate[],
): Comparison {
  const metrics: Array<{
    key: string;
    current: number;
    getter: (s: SessionAggregate) => number;
  }> = [
    { key: "totalCostUsd", current: summary.totalCostUsd, getter: s => s.totalCost },
    { key: "toolCallCount", current: summary.toolCallCount, getter: s => s.toolCallCount },
    { key: "durationMs", current: summary.durationMs, getter: s => s.durationMs },
    { key: "totalTokensIn", current: summary.totalTokensIn, getter: s => s.totalTokensIn },
    { key: "totalTokensOut", current: summary.totalTokensOut, getter: s => s.totalTokensOut },
  ];

  const agent: Partial<Record<string, BaselineComparison>> = {};
  const global: Partial<Record<string, BaselineComparison>> = {};

  for (const m of metrics) {
    const ac = compareMetric(m.current, agentSessions, m.getter);
    if (ac) agent[m.key] = ac;
    const gc = compareMetric(m.current, globalSessions, m.getter);
    if (gc) global[m.key] = gc;
  }

  return {
    agent: Object.keys(agent).length ? agent : null,
    global: Object.keys(global).length ? global : null,
  };
}
