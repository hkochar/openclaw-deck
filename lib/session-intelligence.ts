/**
 * Session Intelligence — "What did this agent do?"
 *
 * Pure functions: events in → analysis out. No DB access, no side effects.
 * Segments sessions into outcome regions, extracts artifacts, computes
 * quality scores, and generates rule-based critique.
 */

import type { EventRow, RunSummary } from "./run-intelligence";

// ── Agent Types ─────────────────────────────────────────────────────

export type AgentType =
  | "code"
  | "research"
  | "analysis"
  | "creative"
  | "qa"
  | "coordination"
  | "general";

const ROLE_TO_TYPE: Record<string, AgentType> = {
  "Dev / Infrastructure": "code",
  "Research & Intelligence": "research",
  "QA / Metrics": "qa",
  "Creative / Copywriting": "creative",
  "Monitoring / Alerts": "qa",
  "Security Auditor": "qa",
  "Chief of Staff / Coordinator": "coordination",
};

export function detectAgentType(role: string | null | undefined): AgentType {
  if (!role) return "general";
  return ROLE_TO_TYPE[role] ?? "general";
}

// ── Types ───────────────────────────────────────────────────────────

export type OutcomeType =
  | "file_written"
  | "file_edited"
  | "search_performed"
  | "url_fetched"
  | "code_committed"
  | "test_run"
  | "command_run"
  | "message_sent";

export interface Outcome {
  type: OutcomeType;
  label: string;
  target: string | null;
  detail: string | null;
  timestamp: number;
}

export interface OutcomeRegion {
  regionIndex: number;
  startTs: number;
  endTs: number;
  trigger: string | null;
  outcomes: Outcome[];
  supportingActions: Outcome[];
  toolCalls: number;
  llmCalls: number;
  cost: number;
  tokens: { in: number; out: number };
}

export interface ActivitySummary {
  toolBreakdown: Array<{ tool: string; count: number; successRate: number }>;
  searchCount: number;
  uniqueUrlsFetched: number;
  sourceFetchRatio: number;
  filesRead: number;
  filesWritten: number;
  commandsRun: number;
  modelsUsed: string[];
  thinkingUsed: boolean;
  coordinationCalls: number;
}

export interface QualityScores {
  overall: number;
  toolEfficiency: number;
  researchDepth: number;
  taskCompletion: number;
  errorRecovery: number;
  costEfficiency: number;
}

export interface Critique {
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}

export interface SessionAnalysis {
  agentType: AgentType;
  regions: OutcomeRegion[];
  outcomes: Outcome[];
  activitySummary: ActivitySummary;
  qualityScores: QualityScores;
  critique: Critique;
  task: string | null;
}

// ── Detail Parsing ──────────────────────────────────────────────────

function parseDetail(ev: EventRow): Record<string, unknown> {
  if (!ev.detail) return {};
  try {
    return JSON.parse(ev.detail);
  } catch {
    return {};
  }
}

function getToolName(ev: EventRow): string | null {
  const d = parseDetail(ev);
  return (d.tool as string) ?? (d.toolName as string) ?? null;
}

function getToolQuery(ev: EventRow): string | null {
  const d = parseDetail(ev);
  const params = (d.params ?? {}) as Record<string, unknown>;
  return (
    (params.query as string) ??
    (params.url as string) ??
    (params.command as string) ??
    null
  );
}

function getToolTarget(ev: EventRow): string | null {
  const d = parseDetail(ev);
  const params = (d.params ?? {}) as Record<string, unknown>;
  return (
    (params.file_path as string) ??
    (params.path as string) ??
    (params.target as string) ??
    (params.url as string) ??
    (params.channel as string) ??
    (params.to as string) ??
    null
  );
}

function isErrorEvent(ev: EventRow): boolean {
  const d = parseDetail(ev);
  if (d.isError === true || d.success === 0 || d.error) return true;
  if (ev.type === "tool_call" && d.success !== undefined && d.success !== true && d.success !== 1)
    return true;
  return false;
}

function getMsgText(ev: EventRow): string | null {
  const d = parseDetail(ev);
  const text = (d.text as string) ?? (d.message as string) ?? null;
  if (text) return text.slice(0, 500);
  return null;
}

// ── Coordination tool detection ─────────────────────────────────────

const COORDINATION_TOOLS = new Set([
  "sessions_send",
  "message",
  "session_status",
  "cron",
]);

const OUTCOME_TOOLS = new Set([
  "write",
  "Write",
  "edit",
  "Edit",
  "sessions_send",
  "message",
]);

const SUPPORTING_TOOLS = new Set([
  "read",
  "Read",
  "web_search",
  "WebSearch",
  "web_fetch",
  "WebFetch",
  "browser",
  "memory_search",
  "Grep",
  "Glob",
]);

// ── Outcome Extraction ──────────────────────────────────────────────

export function classifyToolCall(ev: EventRow): Outcome | null {
  const tool = getToolName(ev);
  if (!tool) return null;

  const query = getToolQuery(ev);
  const target = getToolTarget(ev);

  switch (tool) {
    case "write":
    case "Write":
      return {
        type: "file_written",
        label: shortPath(target),
        target,
        detail: null,
        timestamp: ev.ts,
      };
    case "edit":
    case "Edit":
      return {
        type: "file_edited",
        label: shortPath(target),
        target,
        detail: null,
        timestamp: ev.ts,
      };
    case "web_search":
    case "WebSearch":
      return {
        type: "search_performed",
        label: query ?? "search",
        target: null,
        detail: query,
        timestamp: ev.ts,
      };
    case "web_fetch":
    case "WebFetch":
      return {
        type: "url_fetched",
        label: shortUrl(query ?? target),
        target: query ?? target,
        detail: null,
        timestamp: ev.ts,
      };
    case "exec":
    case "Bash": {
      const cmd = query ?? "";
      if (/\bgit\s+commit\b/.test(cmd)) {
        return {
          type: "code_committed",
          label: "git commit",
          target: null,
          detail: cmd.slice(0, 200),
          timestamp: ev.ts,
        };
      }
      if (/\b(vitest|jest|test|pytest|cargo\s+test)\b/.test(cmd)) {
        return {
          type: "test_run",
          label: "test run",
          target: null,
          detail: cmd.slice(0, 200),
          timestamp: ev.ts,
        };
      }
      return {
        type: "command_run",
        label: cmd.split(/\s+/)[0] ?? "command",
        target: null,
        detail: cmd.slice(0, 200),
        timestamp: ev.ts,
      };
    }
    case "sessions_send":
    case "message":
      return {
        type: "message_sent",
        label: `→ ${target ?? "channel"}`,
        target,
        detail: null,
        timestamp: ev.ts,
      };
    default:
      return null;
  }
}

export function shortPath(p: string | null): string {
  if (!p) return "file";
  const parts = p.split("/");
  return parts.length > 2
    ? `…/${parts.slice(-2).join("/")}`
    : parts.join("/");
}

export function shortUrl(u: string | null): string {
  if (!u) return "url";
  try {
    const url = new URL(u);
    return url.hostname + url.pathname.slice(0, 40);
  } catch {
    return u.slice(0, 60);
  }
}

function isOutcomeTool(tool: string): boolean {
  return (
    OUTCOME_TOOLS.has(tool) ||
    tool === "exec" ||
    tool === "Bash"
  );
}

// ── Region Segmentation ─────────────────────────────────────────────

const TIME_GAP_MS = 5 * 60 * 1000; // 5 minutes

export function segmentIntoRegions(events: EventRow[]): OutcomeRegion[] {
  if (!events.length) return [];

  const regions: OutcomeRegion[] = [];
  let currentStart = 0;

  for (let i = 1; i < events.length; i++) {
    const ev = events[i];
    const prev = events[i - 1];
    const isMsgIn = ev.type === "msg_in" || ev.type === "message_received";
    const isTimeGap = ev.ts - prev.ts > TIME_GAP_MS;

    if (isMsgIn || isTimeGap) {
      regions.push(buildRegion(events, currentStart, i, regions.length));
      currentStart = i;
    }
  }

  // Final region
  regions.push(buildRegion(events, currentStart, events.length, regions.length));

  return regions;
}

function buildRegion(
  events: EventRow[],
  start: number,
  end: number,
  index: number,
): OutcomeRegion {
  const regionEvents = events.slice(start, end);
  const first = regionEvents[0];
  const last = regionEvents[regionEvents.length - 1];

  // Determine trigger
  let trigger: string | null = null;
  if (
    first.type === "msg_in" ||
    first.type === "message_received"
  ) {
    trigger = getMsgText(first);
  }

  // Classify tool calls
  const outcomes: Outcome[] = [];
  const supportingActions: Outcome[] = [];
  const seenOutcomes = new Set<string>();
  const seenSupporting = new Set<string>();

  let toolCalls = 0;
  let llmCalls = 0;
  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const ev of regionEvents) {
    if (ev.type === "llm_output") {
      llmCalls++;
      const isSub = ev.billing === "subscription";
      cost += isSub
        ? (ev.provider_cost ?? 0)
        : (ev.provider_cost ?? ev.cost ?? 0);
      tokensIn += ev.input_tokens ?? 0;
      tokensOut += ev.output_tokens ?? 0;
    }

    if (ev.type !== "tool_call") continue;
    toolCalls++;

    const outcome = classifyToolCall(ev);
    if (!outcome) continue;

    const tool = getToolName(ev) ?? "";
    const dedupeKey = `${outcome.type}:${outcome.target ?? outcome.label}`;

    if (isOutcomeTool(tool)) {
      // Deduplicate: same file written multiple times → keep last
      if (!seenOutcomes.has(dedupeKey)) {
        seenOutcomes.add(dedupeKey);
        outcomes.push(outcome);
      }
    } else if (SUPPORTING_TOOLS.has(tool)) {
      if (!seenSupporting.has(dedupeKey)) {
        seenSupporting.add(dedupeKey);
        supportingActions.push(outcome);
      }
    }
  }

  return {
    regionIndex: index,
    startTs: first.ts,
    endTs: last.ts,
    trigger,
    outcomes,
    supportingActions,
    toolCalls,
    llmCalls,
    cost,
    tokens: { in: tokensIn, out: tokensOut },
  };
}

// ── Activity Summary ────────────────────────────────────────────────

export function buildActivitySummary(events: EventRow[]): ActivitySummary {
  const toolCounts = new Map<string, { total: number; errors: number }>();
  const fetchedUrls = new Set<string>();
  const readFiles = new Set<string>();
  const writtenFiles = new Set<string>();
  let commandsRun = 0;
  let coordinationCalls = 0;
  let thinkingUsed = false;

  for (const ev of events) {
    if (ev.type === "llm_output" && ev.has_thinking) {
      thinkingUsed = true;
    }

    if (ev.type !== "tool_call") continue;
    const tool = getToolName(ev);
    if (!tool) continue;

    const entry = toolCounts.get(tool) ?? { total: 0, errors: 0 };
    entry.total++;
    if (isErrorEvent(ev)) entry.errors++;
    toolCounts.set(tool, entry);

    if (COORDINATION_TOOLS.has(tool)) coordinationCalls++;

    const target = getToolTarget(ev);
    const query = getToolQuery(ev);

    switch (tool) {
      case "web_fetch":
      case "WebFetch":
        if (query) fetchedUrls.add(query);
        else if (target) fetchedUrls.add(target);
        break;
      case "read":
      case "Read":
      case "Grep":
      case "Glob":
        if (target) readFiles.add(target);
        break;
      case "write":
      case "Write":
        if (target) writtenFiles.add(target);
        break;
      case "edit":
      case "Edit":
        if (target) writtenFiles.add(target);
        break;
      case "exec":
      case "Bash":
        commandsRun++;
        break;
    }
  }

  const toolBreakdown = [...toolCounts.entries()]
    .map(([tool, { total, errors }]) => ({
      tool,
      count: total,
      successRate: total > 0 ? Math.round(((total - errors) / total) * 100) : 100,
    }))
    .sort((a, b) => b.count - a.count);

  const searchCount = (toolCounts.get("web_search")?.total ?? 0) +
    (toolCounts.get("WebSearch")?.total ?? 0);

  const uniqueUrlsFetched = fetchedUrls.size;
  const sourceFetchRatio = searchCount > 0 ? uniqueUrlsFetched / searchCount : 0;

  const llmOutputs = events.filter((e) => e.type === "llm_output");
  const modelsUsed = [
    ...new Set(
      llmOutputs
        .map((e) => e.resolved_model || e.model)
        .filter(Boolean) as string[],
    ),
  ];

  return {
    toolBreakdown,
    searchCount,
    uniqueUrlsFetched,
    sourceFetchRatio,
    filesRead: readFiles.size,
    filesWritten: writtenFiles.size,
    commandsRun,
    modelsUsed,
    thinkingUsed,
    coordinationCalls,
  };
}

// ── Quality Scores ──────────────────────────────────────────────────

const WEIGHTS: Record<AgentType, [number, number, number, number, number]> = {
  code: [20, 10, 35, 20, 15],
  research: [10, 35, 25, 10, 20],
  qa: [25, 15, 25, 20, 15],
  creative: [15, 10, 40, 15, 20],
  coordination: [15, 10, 35, 20, 20],
  analysis: [15, 25, 30, 15, 15],
  general: [20, 15, 30, 20, 15],
};

// ── Guidelines Parsing ───────────────────────────────────────────────

export interface GuidelineOverrides {
  weightMultipliers: Record<string, number>; // score dimension → multiplier
  fetchRatioThreshold: number;               // default 0.3
  loopDepthThreshold: number;                // default 8
  strictness: number;                        // 1.0 = normal, 0.8 = strict, 1.2 = lenient
}

const DEFAULT_OVERRIDES: GuidelineOverrides = {
  weightMultipliers: {},
  fetchRatioThreshold: 0.3,
  loopDepthThreshold: 8,
  strictness: 1.0,
};

export function parseGuidelines(guidelines: string | null | undefined): GuidelineOverrides {
  if (!guidelines) return { ...DEFAULT_OVERRIDES, weightMultipliers: {} };

  const g = guidelines.toLowerCase();
  const overrides: GuidelineOverrides = {
    weightMultipliers: {},
    fetchRatioThreshold: 0.3,
    loopDepthThreshold: 8,
    strictness: 1.0,
  };

  // Weight multipliers
  if (/ignore\s+cost|cost\s+doesn.?t\s+matter/.test(g)) {
    overrides.weightMultipliers.costEfficiency = 0;
  }
  if (/focus\s+on\s+depth|depth\s+is\s+important/.test(g)) {
    overrides.weightMultipliers.researchDepth = 2;
  }
  if (/focus\s+on\s+efficiency/.test(g)) {
    overrides.weightMultipliers.toolEfficiency = 2;
  }
  if (/focus\s+on\s+completion/.test(g)) {
    overrides.weightMultipliers.taskCompletion = 2;
  }

  // Threshold overrides
  if (/penalize\s+(shallow\s+)?research|shallow\s+research/.test(g)) {
    overrides.fetchRatioThreshold = 0.5;
  }
  if (/penalize\s+loops|no\s+loops/.test(g)) {
    overrides.loopDepthThreshold = 4;
  }

  // Global strictness
  if (/\bstrict\b/.test(g)) {
    overrides.strictness = 0.8;
  }
  if (/\blenient\b/.test(g)) {
    overrides.strictness = 1.2;
  }

  return overrides;
}

function applyWeightOverrides(
  baseWeights: [number, number, number, number, number],
  overrides: GuidelineOverrides,
): [number, number, number, number, number] {
  const dims = ["toolEfficiency", "researchDepth", "taskCompletion", "errorRecovery", "costEfficiency"];
  const w = [...baseWeights] as [number, number, number, number, number];

  for (let i = 0; i < dims.length; i++) {
    const mult = overrides.weightMultipliers[dims[i]];
    if (mult !== undefined) w[i] = w[i] * mult;
  }

  // Re-normalize to sum to 100
  const sum = w.reduce((s, v) => s + v, 0);
  if (sum > 0 && sum !== 100) {
    const scale = 100 / sum;
    for (let i = 0; i < w.length; i++) w[i] = Math.round(w[i] * scale);
  }

  return w;
}

/** Simple hash for guideline dedup */
export function guidelinesHash(guidelines: string | null | undefined): string | null {
  if (!guidelines) return null;
  // Simple djb2 hash
  let hash = 5381;
  for (let i = 0; i < guidelines.length; i++) {
    hash = ((hash << 5) + hash + guidelines.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}

export function computeQualityScores(
  agentType: AgentType,
  activity: ActivitySummary,
  events: EventRow[],
  runSummary?: RunSummary | null,
  costBaseline?: number | null,
  guidelines?: string | null,
): QualityScores {
  const overrides = parseGuidelines(guidelines);
  const errorCount = events.filter((e) => isErrorEvent(e)).length;

  // Tool efficiency: success rate - retry penalty
  const totalTools = activity.toolBreakdown.reduce((s, t) => s + t.count, 0);
  const totalErrors = activity.toolBreakdown.reduce(
    (s, t) => s + Math.round(t.count * (1 - t.successRate / 100)),
    0,
  );
  const successRate = totalTools > 0 ? (totalTools - totalErrors) / totalTools : 1;
  const retryCount = runSummary?.retryCount ?? 0;
  const toolEfficiency = Math.max(0, Math.min(100, Math.round(successRate * 100 - retryCount * 5)));

  // Research depth: varies by agent type
  let researchDepth: number;
  if (agentType === "code") {
    researchDepth = Math.min(
      100,
      activity.filesRead * 8 + activity.commandsRun * 5,
    );
  } else {
    researchDepth = Math.min(
      100,
      activity.searchCount * 10 + activity.uniqueUrlsFetched * 15,
    );
    if (activity.searchCount >= 5 && activity.sourceFetchRatio < overrides.fetchRatioThreshold) {
      researchDepth = Math.round(researchDepth * 0.7);
    }
  }

  // Task completion: status-based + outcome bonus
  const status = runSummary?.status ?? "unknown";
  const statusBase: Record<string, number> = {
    completed: 80,
    live: 60,
    unknown: 40,
    errored: 20,
  };
  let taskCompletion = statusBase[status] ?? 40;
  const hasOutcomes = activity.filesWritten > 0 || activity.commandsRun > 0;
  if (hasOutcomes) taskCompletion = Math.min(100, taskCompletion + 20);

  // Error recovery
  let errorRecovery: number;
  if (errorCount === 0) {
    errorRecovery = 100;
  } else if (status === "completed") {
    errorRecovery = 80;
  } else if (status === "errored") {
    errorRecovery = 20;
  } else {
    errorRecovery = 50;
  }

  // Cost efficiency: relative to baseline
  let costEfficiency = 70; // default when no baseline
  if (costBaseline != null && costBaseline > 0 && runSummary) {
    const ratio = runSummary.totalCostUsd / costBaseline;
    if (ratio <= 1) costEfficiency = 100;
    else if (ratio <= 1.5) costEfficiency = 85;
    else if (ratio <= 2) costEfficiency = 50;
    else costEfficiency = 30;
  }

  // Overall: weighted by agent type, with guideline overrides
  const w = applyWeightOverrides(WEIGHTS[agentType], overrides);
  const overall = Math.round(
    (toolEfficiency * w[0] +
      researchDepth * w[1] +
      taskCompletion * w[2] +
      errorRecovery * w[3] +
      costEfficiency * w[4]) /
      100,
  );

  return {
    overall,
    toolEfficiency,
    researchDepth,
    taskCompletion,
    errorRecovery,
    costEfficiency,
  };
}

// ── Critique Generation ─────────────────────────────────────────────

export function generateCritique(
  agentType: AgentType,
  activity: ActivitySummary,
  scores: QualityScores,
  regions: OutcomeRegion[],
  runSummary?: RunSummary | null,
  guidelines?: string | null,
): Critique {
  const overrides = parseGuidelines(guidelines);
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const suggestions: string[] = [];

  // Strengths
  if (scores.toolEfficiency > 85) {
    strengths.push("High tool efficiency — few errors or retries");
  }
  if (activity.searchCount >= 5) {
    strengths.push(
      `Thorough research — ${activity.searchCount} searches performed`,
    );
  }
  if (activity.sourceFetchRatio >= 0.5 && activity.searchCount >= 3) {
    strengths.push("Good source depth — fetched primary sources, not just search snippets");
  }
  if (activity.thinkingUsed) {
    strengths.push("Used extended thinking for deeper reasoning");
  }
  if (scores.costEfficiency > 80) {
    strengths.push("Cost efficient — within baseline expectations");
  }
  if (activity.filesWritten > 0) {
    strengths.push(`Produced ${activity.filesWritten} output artifact${activity.filesWritten > 1 ? "s" : ""}`);
  }
  if (runSummary && runSummary.errorCount > 0 && runSummary.status === "completed") {
    strengths.push("Recovered from errors and completed the task");
  }
  if (regions.length > 1) {
    strengths.push(`Multi-phase work — ${regions.length} distinct task regions`);
  }

  // Weaknesses
  if (
    activity.searchCount >= 5 &&
    activity.sourceFetchRatio < overrides.fetchRatioThreshold
  ) {
    weaknesses.push(
      `Shallow research — ${activity.searchCount} searches but only ${activity.uniqueUrlsFetched} URLs fetched (${Math.round(activity.sourceFetchRatio * 100)}% fetch ratio)`,
    );
  }
  if (scores.toolEfficiency < 60) {
    weaknesses.push("Low tool efficiency — many errors or failed tool calls");
  }
  if (runSummary && runSummary.errorCount > 2 && runSummary.status === "errored") {
    weaknesses.push(
      `${runSummary.errorCount} unrecovered errors — session ended in error state`,
    );
  }
  if (runSummary && runSummary.maxLoopDepth > overrides.loopDepthThreshold) {
    weaknesses.push(`Deep tool loop detected (depth ${runSummary.maxLoopDepth}) — possible stuck behavior`);
  }
  if (scores.costEfficiency < 50) {
    weaknesses.push("Cost significantly above baseline");
  }
  if (runSummary?.status === "errored") {
    weaknesses.push("Session ended in error state");
  }
  if (
    agentType === "code" &&
    activity.filesWritten === 0 &&
    activity.commandsRun === 0
  ) {
    weaknesses.push("No code output produced (code agent)");
  }
  if (
    activity.coordinationCalls > 0 &&
    activity.toolBreakdown.length > 0
  ) {
    const totalCalls = activity.toolBreakdown.reduce((s, t) => s + t.count, 0);
    const coordPct = Math.round((activity.coordinationCalls / totalCalls) * 100);
    if (coordPct > 35) {
      weaknesses.push(
        `High coordination overhead — ${coordPct}% of tool calls were coordination/status updates.`,
      );
    }
  }

  // Suggestions (derived from weaknesses)
  if (activity.searchCount >= 5 && activity.sourceFetchRatio < overrides.fetchRatioThreshold) {
    suggestions.push(
      "Fetch primary sources instead of relying on search snippets — web_fetch costs almost nothing but provides 10x the signal",
    );
  }
  if (scores.toolEfficiency < 60) {
    suggestions.push("Validate inputs before tool calls to reduce error rate");
  }
  if (runSummary && runSummary.maxLoopDepth > overrides.loopDepthThreshold) {
    suggestions.push("Add exit conditions for loops to prevent stuck behavior");
  }
  if (scores.costEfficiency < 50 && activity.modelsUsed.length === 1) {
    suggestions.push("Consider using a smaller model for routine tasks to reduce cost");
  }
  if (
    agentType === "research" &&
    activity.searchCount < 3 &&
    activity.filesWritten > 0
  ) {
    suggestions.push("Broaden source research before producing output artifacts");
  }
  if (activity.coordinationCalls > 15) {
    suggestions.push(
      "Reduce coordination overhead — batch status updates, suppress heartbeats during deep work",
    );
  }

  return { strengths, weaknesses, suggestions };
}

// ── Letter Grade ────────────────────────────────────────────────────

export function scoreToGrade(score: number): string {
  if (score >= 93) return "A";
  if (score >= 87) return "A-";
  if (score >= 83) return "B+";
  if (score >= 77) return "B";
  if (score >= 73) return "B-";
  if (score >= 67) return "C+";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

// ── Main Compute ────────────────────────────────────────────────────

export function computeSessionAnalysis(
  events: EventRow[],
  agentType: AgentType,
  runSummary?: RunSummary | null,
  costBaseline?: number | null,
  guidelines?: string | null,
): SessionAnalysis {
  if (!events.length) {
    return emptyAnalysis(agentType);
  }

  const regions = segmentIntoRegions(events);
  const activitySummary = buildActivitySummary(events);
  const qualityScores = computeQualityScores(
    agentType,
    activitySummary,
    events,
    runSummary,
    costBaseline,
    guidelines,
  );
  const critique = generateCritique(
    agentType,
    activitySummary,
    qualityScores,
    regions,
    runSummary,
    guidelines,
  );

  // Flat outcomes list from all regions
  const outcomes = regions.flatMap((r) => r.outcomes);

  // Extract task from first msg_in
  let task: string | null = null;
  for (const ev of events) {
    if (ev.type === "msg_in" || ev.type === "message_received") {
      task = getMsgText(ev);
      break;
    }
  }

  return {
    agentType,
    regions,
    outcomes,
    activitySummary,
    qualityScores,
    critique,
    task,
  };
}

function emptyAnalysis(agentType: AgentType): SessionAnalysis {
  return {
    agentType,
    regions: [],
    outcomes: [],
    activitySummary: {
      toolBreakdown: [],
      searchCount: 0,
      uniqueUrlsFetched: 0,
      sourceFetchRatio: 0,
      filesRead: 0,
      filesWritten: 0,
      commandsRun: 0,
      modelsUsed: [],
      thinkingUsed: false,
      coordinationCalls: 0,
    },
    qualityScores: {
      overall: 0,
      toolEfficiency: 0,
      researchDepth: 0,
      taskCompletion: 0,
      errorRecovery: 0,
      costEfficiency: 0,
    },
    critique: { strengths: [], weaknesses: [], suggestions: [] },
    task: null,
  };
}
