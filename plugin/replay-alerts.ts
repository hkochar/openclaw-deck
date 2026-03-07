/**
 * Session guardrails, budget overrides, and session cost cap enforcement.
 * Extracted from budget.ts — tracks in-memory session state and fires alerts.
 */

import fs from "fs";
import path from "path";
import os from "os";
import {
  loadBudgetConfig,
  loadReplayAlertsConfig,
  getDeckSiteUrl,
  logToSystemLog,
  lastAlertTs,
  type SessionAlertAction,
  type CostAlertView,
  type BudgetOverride,
} from "./budget.js";

const DECK_HOME = path.join(os.homedir(), ".openclaw-deck");
const DECK_STATE_DIR = path.join(DECK_HOME, "state");
const OVERRIDE_FILE = path.join(DECK_STATE_DIR, "budget-overrides.json");

// ── Session cost cap (configurable per-agent) ────────────────────

export function getSessionCostCapForAgent(agent: string): number {
  const config = loadBudgetConfig();
  return config.sessionCostCap.agents[agent]
    ?? config.sessionCostCap.default
    ?? 5.0;
}

// ── Budget override (emergency time-limited bypass) ──────────────

export function loadBudgetOverrides(): Record<string, BudgetOverride> {
  try {
    const all = JSON.parse(fs.readFileSync(OVERRIDE_FILE, "utf-8")) as Record<string, BudgetOverride>;
    const now = Date.now();
    const active: Record<string, BudgetOverride> = {};
    for (const [agent, override] of Object.entries(all)) {
      if (override.expiresAt > now) {
        active[agent] = override;
      }
    }
    return active;
  } catch {
    return {};
  }
}

export function setBudgetOverride(agent: string, durationMs: number, reason: string): BudgetOverride {
  const dir = path.dirname(OVERRIDE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const all = loadBudgetOverrides();
  const override: BudgetOverride = {
    agent,
    expiresAt: Date.now() + durationMs,
    reason,
    createdBy: "dashboard",
    createdAt: Date.now(),
  };
  all[agent] = override;
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(all, null, 2) + "\n", "utf-8");
  return override;
}

export function clearBudgetOverride(agent: string): void {
  const all = loadBudgetOverrides();
  delete all[agent];
  const dir = path.dirname(OVERRIDE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(all, null, 2) + "\n", "utf-8");
}

export function hasBudgetOverride(agent: string): boolean {
  const overrides = loadBudgetOverrides();
  return !!overrides[agent] && overrides[agent].expiresAt > Date.now();
}

// ── Budget reset timing (local timezone) ─────────────────────────

/** Get the next budget reset time for a given period (for error responses). */
export function getNextResetTime(period: "daily" | "weekly" | "monthly"): string {
  const now = new Date();

  if (period === "daily") {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0); // LOCAL midnight
    return next.toISOString();
  }

  if (period === "weekly") {
    const next = new Date(now);
    const daysUntilMonday = (8 - next.getDay()) % 7 || 7;
    next.setDate(next.getDate() + daysUntilMonday);
    next.setHours(0, 0, 0, 0);
    return next.toISOString();
  }

  // monthly
  const next = new Date(now);
  next.setMonth(next.getMonth() + 1);
  next.setDate(1);
  next.setHours(0, 0, 0, 0);
  return next.toISOString();
}

// ── Auto-recovery helpers ────────────────────────────────────────

/** Check if an agent should auto-recover based on config. */
export function shouldAutoRecover(agent: string): boolean {
  const config = loadBudgetConfig();
  const agentBudget = config.agents[agent];
  if (agentBudget?.autoRecovery !== undefined) return agentBudget.autoRecovery;
  const defaultMode = config.defaultAutoRecovery;
  if (defaultMode === "all") return true;
  if (defaultMode === "none") return false;
  // "throttle-only": auto-recover if agent action is throttle
  return agentBudget?.action === "throttle";
}

// ── Session guardrail helpers ────────────────────────────────────
// In-memory session tracking for guardrails. Tracks cumulative cost,
// tool call count, and first event timestamp per session for enforcement.

interface ReplaySessionState {
  actualCost: number;    // real provider spend (API billing only; 0 for subscription)
  apiEquivCost: number;  // estimated API-equivalent cost (always computed)
  toolCalls: number;
  firstTs: number;
  lastTs: number;
  // Per-alert cooldown flags (only alert once per session per alert type)
  alertedCost: boolean;
  alertedDuration: boolean;
  alertedToolCalls: boolean;
}

const replaySessionState = new Map<string, ReplaySessionState>();

// Cleanup stale replay sessions (older than 24h) periodically
setInterval(() => {
  const cutoff = Date.now() - 86_400_000;
  for (const [key, state] of replaySessionState) {
    if (state.lastTs < cutoff) replaySessionState.delete(key);
  }
}, 600_000);

function getReplaySession(agent: string, session: string): ReplaySessionState {
  const key = `${agent}:${session}`;
  let state = replaySessionState.get(key);
  if (!state) {
    state = { actualCost: 0, apiEquivCost: 0, toolCalls: 0, firstTs: Date.now(), lastTs: Date.now(),
      alertedCost: false, alertedDuration: false, alertedToolCalls: false };
    replaySessionState.set(key, state);
  }
  return state;
}

/** Check if a replay alert should fire (respects per-agent cooldown). */
function checkReplayCooldown(alertType: string, agent: string, cooldownMs: number): boolean {
  const key = `replay:${alertType}:${agent}`;
  const now = Date.now();
  const last = lastAlertTs.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  lastAlertTs.set(key, now);
  return true;
}

export interface ReplayAlertEvent {
  type: "session-cost" | "step-cost" | "long-session" | "excessive-tools" | "context-critical";
  agent: string;
  session: string;
  value: number;     // the measured value that triggered the alert
  threshold: number;  // the configured threshold
  action?: SessionAlertAction;  // enforcement action taken (alert/throttle/block)
  detail?: Record<string, unknown>;
}

// Callback for firing alerts (registered by index.ts with Discord integration)
let replayAlertCallbacks: Array<(event: ReplayAlertEvent) => void> = [];
export function onReplayAlert(cb: (event: ReplayAlertEvent) => void): void {
  replayAlertCallbacks.push(cb);
}

export function fireReplayAlert(event: ReplayAlertEvent): void {
  logToSystemLog("replay-alert", event.type,
    `${event.agent}: ${event.type} — value=${event.value} threshold=${event.threshold}`,
    { ...event.detail, value: event.value, threshold: event.threshold },
    "warning");
  for (const cb of replayAlertCallbacks) {
    try { cb(event); } catch { /* don't crash */ }
  }
}

/**
 * Resolve which cost value to use for alert evaluation based on costView config.
 * Returns null if this call should be skipped (e.g. costView="actual" but billing is subscription).
 */
export function resolveCostForAlert(
  costView: CostAlertView, actualCost: number, apiEquivCost: number, billing: string,
): number | null {
  switch (costView) {
    case "actual":
      // Only alert on real provider spend; skip subscription (no actual cost)
      return billing === "subscription" ? null : actualCost;
    case "api-equiv":
      return apiEquivCost;
    case "total":
    default:
      // Use actual if available, otherwise api-equiv
      return billing === "subscription" ? apiEquivCost : actualCost;
  }
}

/**
 * Track an LLM output event for session guardrails.
 * Called from the llm_output hook — checks duration and context utilization.
 * Cost enforcement is handled separately via checkSessionCost() in before_model_resolve.
 */
export function trackReplayLlmOutput(
  agent: string, session: string, cost: number, model: string,
  inputTokens: number, cacheRead: number,
  billing: string, providerCost: number | undefined,
): void {
  const config = loadReplayAlertsConfig();
  if (!config.enabled) return;

  const state = getReplaySession(agent, session);
  // Track actual and api-equiv costs separately (used by checkSessionCost)
  const actualStep = providerCost ?? 0;
  const apiEquivStep = cost; // cost param is always the estimated/api-equiv value
  state.actualCost += actualStep;
  state.apiEquivCost += apiEquivStep;
  state.lastTs = Date.now();

  // Guardrail 0: Expensive LLM Step — single call exceeds stepCostThreshold
  const budgetCfg = loadBudgetConfig();
  const stepCost = resolveCostForAlert(budgetCfg.costView, actualStep, apiEquivStep, billing);
  if (stepCost != null && stepCost >= config.stepCostThreshold) {
    if (checkReplayCooldown("step-cost", agent, 300_000)) {
      fireReplayAlert({
        type: "step-cost", agent, session,
        value: stepCost, threshold: config.stepCostThreshold,
        action: config.action,
        detail: { stepCost, model, costView: budgetCfg.costView, billing, actualCost: actualStep, apiEquivCost: apiEquivStep },
      });
    }
  }

  // Guardrail 1: Long-Running Session — duration exceeds threshold
  const durationMin = (Date.now() - state.firstTs) / 60_000;
  if (!state.alertedDuration && durationMin >= config.maxSessionDuration) {
    state.alertedDuration = true;
    if (checkReplayCooldown("long-session", agent, 1_800_000)) {
      fireReplayAlert({
        type: "long-session", agent, session,
        value: Math.round(durationMin), threshold: config.maxSessionDuration,
        action: config.action,
        detail: { durationMinutes: Math.round(durationMin), startTs: state.firstTs },
      });
    }
  }

  // Guardrail 2: Context Window Critical — input tokens exceed threshold % of max context
  const MODEL_MAX_CONTEXT: Record<string, number> = {
    opus: 200_000, sonnet: 200_000, haiku: 200_000,
    "gpt-4o": 128_000, "gpt-4": 128_000, "gpt-5": 1_000_000,
    deepseek: 128_000, gemini: 1_000_000, llama: 128_000, qwen: 128_000,
  };
  const lower = model.toLowerCase();
  let maxCtx = 200_000;
  for (const [key, max] of Object.entries(MODEL_MAX_CONTEXT)) {
    if (lower.includes(key)) { maxCtx = max; break; }
  }
  // inputTokens already includes cacheRead (cache_read is a breakdown, not additive)
  const utilPct = (inputTokens / maxCtx) * 100;
  if (utilPct >= config.contextThreshold) {
    if (checkReplayCooldown("context-critical", agent, 900_000)) {
      fireReplayAlert({
        type: "context-critical", agent, session,
        value: Math.round(utilPct), threshold: config.contextThreshold,
        action: config.action,
        detail: { utilization: Math.round(utilPct), inputTokens, cacheRead, maxContext: maxCtx, model },
      });
    }
  }
}

/**
 * Track a tool call for session guardrails.
 * Called from the tool_call event — checks tool call count.
 */
export function trackReplayToolCall(agent: string, session: string): void {
  const config = loadReplayAlertsConfig();
  if (!config.enabled) return;

  const state = getReplaySession(agent, session);
  state.toolCalls++;
  state.lastTs = Date.now();

  // Guardrail 3: Excessive Tool Calls — tool call count exceeds threshold
  if (!state.alertedToolCalls && state.toolCalls >= config.maxToolCalls) {
    state.alertedToolCalls = true;
    if (checkReplayCooldown("excessive-tools", agent, 900_000)) {
      fireReplayAlert({
        type: "excessive-tools", agent, session,
        value: state.toolCalls, threshold: config.maxToolCalls,
        action: config.action,
        detail: { toolCallCount: state.toolCalls },
      });
    }
  }
}

// ── Session limit enforcement (called from before_model_resolve) ─

export interface SessionLimitResult {
  action: SessionAlertAction;
  trigger: "session-cost" | "tool-calls" | "duration";
  value: number;
  threshold: number;
}

/**
 * Resolve action based on ratio and alert thresholds.
 * At 100%+ → full action (block/throttle/alert). Below 100% but above a threshold → alert.
 */
function resolveSessionAction(ratio: number, action: SessionAlertAction, thresholds: number[]): SessionAlertAction | null {
  if (ratio >= 1.0) return action; // at or over limit — full enforcement
  const sorted = thresholds.map(t => t / 100).sort((a, b) => b - a);
  for (const t of sorted) {
    if (t < 1.0 && ratio >= t) return "alert"; // approaching limit — warn
  }
  return null; // below all thresholds
}

/**
 * Check session cost cap before an LLM call.
 * Uses alertThresholds for early warnings (alert at 55%/80%), enforces at 100%.
 */
export function checkSessionCost(agent: string, session: string, billing: string): SessionLimitResult | null {
  const budgetConfig = loadBudgetConfig();
  const cap = getSessionCostCapForAgent(agent);
  const capAction = budgetConfig.sessionCostCap.action;

  const state = replaySessionState.get(`${agent}:${session}`);
  if (!state) return null;

  const costForCheck = resolveCostForAlert(budgetConfig.costView, state.actualCost, state.apiEquivCost, billing);
  if (costForCheck === null || costForCheck <= 0) return null;

  const ratio = costForCheck / cap;
  const resolved = resolveSessionAction(ratio, capAction, budgetConfig.alertThresholds);
  if (!resolved) return null;

  return { action: resolved, trigger: "session-cost", value: costForCheck, threshold: cap };
}

/**
 * Check session guardrails (duration, tool calls) before an LLM call.
 * Uses alertThresholds for early warnings, enforces at 100%.
 */
export function checkSessionLimits(agent: string, session: string): SessionLimitResult | null {
  const config = loadReplayAlertsConfig();
  if (!config.enabled) return null;

  const budgetConfig = loadBudgetConfig();
  const state = replaySessionState.get(`${agent}:${session}`);
  if (!state) return null;

  // Check tool calls
  const toolRatio = state.toolCalls / config.maxToolCalls;
  const toolAction = resolveSessionAction(toolRatio, config.action, budgetConfig.alertThresholds);
  if (toolAction) {
    return { action: toolAction, trigger: "tool-calls", value: state.toolCalls, threshold: config.maxToolCalls };
  }

  // Check session duration
  const durationMin = (Date.now() - state.firstTs) / 60_000;
  const durRatio = durationMin / config.maxSessionDuration;
  const durAction = resolveSessionAction(durRatio, config.action, budgetConfig.alertThresholds);
  if (durAction) {
    return { action: durAction, trigger: "duration", value: Math.round(durationMin), threshold: config.maxSessionDuration };
  }

  return null;
}

/**
 * Get summaries of tracked replay sessions (replaces getExpensiveSessions from event-log).
 */
export function getReplaySessionSummaries(limit = 10): Array<{
  agent: string; session: string;
  actualCost: number; apiEquivCost: number;
  toolCalls: number; firstTs: number; lastTs: number;
}> {
  const entries = [...replaySessionState.entries()]
    .map(([key, s]) => {
      const [agent, ...rest] = key.split(":");
      return { agent, session: rest.join(":"), ...s };
    })
    .sort((a, b) => b.apiEquivCost - a.apiEquivCost)
    .slice(0, limit);
  return entries.map(({ alertedCost, alertedDuration, alertedToolCalls, ...rest }) => rest);
}
