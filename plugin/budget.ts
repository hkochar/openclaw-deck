import fs from "fs";
import path from "path";
import os from "os";
import { queryCostSummary, setPricingTable, queryProviderUsage, type ModelPricing } from "./event-log.js";
import { sendAlert, type AlertTokens, type AlertMessage } from "./alert-dispatch.js";

export function logToSystemLog(category: string, action: string, summary: string, detail?: Record<string, unknown>, status: string = "ok"): void {
  const mcUrl = process.env.DECK_DASHBOARD_URL || "http://127.0.0.1:3000";
  fetch(`${mcUrl}/api/system-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, action, summary, detail, status }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ── Types ────────────────────────────────────────────────────────

export interface AgentBudget {
  daily?: number | null;
  weekly?: number | null;
  monthly?: number | null;
  dailyRequests?: number | null;
  weeklyRequests?: number | null;
  action: "alert" | "throttle" | "block";
  autoRecovery?: boolean;
}

export type AutoRecoveryDefault = "all" | "throttle-only" | "none";

export type SessionAlertAction = "alert" | "throttle" | "block";

export interface SessionCostCapConfig {
  default: number;
  agents: Record<string, number>;
  action: SessionAlertAction;     // what to do when session cost cap is hit
}

export interface BudgetConfig {
  global: { daily?: number; weekly?: number; monthly?: number; dailyRequests?: number; weeklyRequests?: number; action?: "alert" | "throttle" | "block" };
  agents: Record<string, AgentBudget>;
  alertThresholds: number[];  // percentages, e.g. [50, 80, 100]
  alertChannel: string;       // systemChannels key
  defaultAutoRecovery: AutoRecoveryDefault;
  sessionCostCap: SessionCostCapConfig;
  costView: CostAlertView;    // which cost to evaluate across all budget checks
}

// ── Session guardrails (runaway detection) ──────────────────────

export type CostAlertView = "actual" | "api-equiv" | "total";

export interface SessionGuardrailsConfig {
  enabled: boolean;
  action: SessionAlertAction;     // what to do when a guardrail threshold is breached
  maxSessionDuration: number;     // minutes — alert when a session runs longer than this
  cronMaxDuration: number;        // minutes — alert when a single cron invocation runs longer than this
  maxToolCalls: number;           // count — alert when a session makes more tool calls than this
  contextThreshold: number;       // percentage — alert when context window usage exceeds this
  stepCostThreshold: number;      // dollars — alert when a single LLM call costs more than this
}

// Legacy alias for backward compatibility
export type ReplayAlertsConfig = SessionGuardrailsConfig;

// ── Alert routing (multi-platform) ─────────────────────────────
export type AlertCategory = "budget" | "session" | "drift" | "cron" | "monitoring";

export interface AlertRoutingConfig {
  platform: string;  // "discord" | "slack" | "telegram"
  channels: Array<{ id: string; name: string }>;
  routing: Record<AlertCategory, string>;  // category → channel id
}

/** Load alertRouting config from deck-config.json. */
export function loadAlertRouting(): AlertRoutingConfig | null {
  const raw = readDeckConfig();
  const ar = raw.alertRouting as AlertRoutingConfig | undefined;
  if (!ar || !ar.platform || !ar.channels?.length) return null;
  return ar;
}

/**
 * Resolve a channel ref for the given alert category.
 * If alertRouting is configured, returns a platform-prefixed ref (e.g. "slack:C0ABC").
 * Otherwise falls back to legacy systemChannels / pluginChannels.
 */
export function resolveAlertChannel(
  category: AlertCategory,
  deckConfig: { systemChannels?: Record<string, string>; pluginChannels?: Record<string, string> } | null,
): string {
  const routing = loadAlertRouting();
  if (routing) {
    const channelId = routing.routing?.[category];
    // Use routed channel if set, otherwise fall back to first channel
    const id = channelId || routing.channels[0]?.id;
    if (id) {
      // If the id already has a platform prefix, return as-is
      if (/^(discord|slack|telegram):/.test(id)) return id;
      return `${routing.platform}:${id}`;
    }
  }

  // Legacy fallback: drift/cron go to model-drift channel, everything else to systemStatus
  if (category === "drift" || category === "cron") {
    return deckConfig?.pluginChannels?.["model-drift"] ?? deckConfig?.systemChannels?.systemStatus ?? "";
  }
  const budgetCfg = loadBudgetConfig();
  const channelKey = budgetCfg.alertChannel || "systemStatus";
  return deckConfig?.systemChannels?.[channelKey] ?? deckConfig?.systemChannels?.systemStatus ?? "";
}

const DEFAULT_SESSION_GUARDRAILS: SessionGuardrailsConfig = {
  enabled: true,
  action: "alert",
  maxSessionDuration: 60,
  cronMaxDuration: 30,
  maxToolCalls: 200,
  contextThreshold: 85,
  stepCostThreshold: 1,
};

export interface PauseState {
  paused: boolean;
  since?: number;
  reason?: string;
}

// ── Provider rate limit types ───────────────────────────────────

export interface ProviderLimitWindow {
  id: string;              // e.g. "5h-rolling", "gpt5-weekly"
  duration: number;        // window size in seconds
  rolling: boolean;        // true = sliding window from now, false = fixed period
  shared: boolean;         // true = all models share weighted pool, false = per-model
  weights?: Record<string, number>;  // model-substring → weight (shared pools only)
  model?: string;          // model substring match (per-model windows only)
  limit: number;           // max units per window
  anchorEpoch?: number;    // epoch ms of a known window reset (fixed windows align to this)
}

export interface ProviderLimits {
  windows: ProviderLimitWindow[];
}

export interface ProviderWindowStatus {
  windowId: string;
  provider: string;
  label: string;     // human-readable: "5h rolling" or "weekly (gpt-5)"
  used: number;      // weighted units or flat count
  limit: number;
  pct: number;       // 0-100+
  breakdown?: { model: string; raw: number; weighted: number }[];
  windowStart: number;  // epoch ms — start of the current window
  resetsAt: number;     // epoch ms — when the window resets/rolls over
  rolling: boolean;
}

// ── Budget check result ──────────────────────────────────────────

export interface BudgetCheckResult {
  action: BudgetAction;
  trigger: "agent" | "global";
  period: "daily" | "weekly" | "monthly" | "dailyRequests" | "weeklyRequests";
  ratio: number;
}

// ── Budget override types ────────────────────────────────────────

export interface BudgetOverride {
  agent: string;
  expiresAt: number;   // epoch ms
  reason: string;
  createdBy: string;   // "dashboard" or "api"
  createdAt: number;
}

// ── Paths ────────────────────────────────────────────────────────

const DECK_HOME = path.join(os.homedir(), ".openclaw-deck");
const DECK_STATE_DIR = path.join(DECK_HOME, "state");
const DECK_ROOT = process.env.DECK_ROOT || path.resolve(__dirname, "..");
const DECK_CONFIG_PATH = path.join(DECK_ROOT, "config/deck-config.json");
const PAUSE_FILE = path.join(DECK_STATE_DIR, "agent-paused.json");
const OVERRIDE_FILE = path.join(DECK_STATE_DIR, "budget-overrides.json");

// ── Config loading with file-watch cache ─────────────────────────

let cachedBudgetConfig: BudgetConfig | null = null;
let cachedModelPricing: Record<string, ModelPricing> | null = null;
let cachedThrottleChain: string[] | null = null;
let cachedProviderLimits: Record<string, ProviderLimits> | null = null;
let cachedReplayAlerts: SessionGuardrailsConfig | null = null;
let configWatcherStarted = false;

const DEFAULT_SESSION_COST_CAP: SessionCostCapConfig = { default: 5.0, agents: {}, action: "alert" };

const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  global: {},
  agents: {},
  alertThresholds: [80, 100],
  alertChannel: "systemStatus",
  defaultAutoRecovery: "throttle-only",
  sessionCostCap: DEFAULT_SESSION_COST_CAP,
  costView: "total",
};

const DEFAULT_THROTTLE_CHAIN = ["opus", "sonnet", "haiku"];

function readDeckConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(DECK_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function getDeckSiteUrl(): string {
  const raw = readDeckConfig();
  const serviceUrls = raw.serviceUrls as Record<string, string> | undefined;
  return serviceUrls?.deckDashboard || process.env.OPENCLAW_DECK_SITE_URL || "http://localhost:3000";
}

/** Build a /costs URL filtered by agent + today */
export function costsUrl(base: string, agent?: string): string {
  const params = new URLSearchParams({ range: "today" });
  if (agent) params.set("agent", agent);
  return `${base}/costs?${params}`;
}

/** Build a /logs URL filtered by agent + last 10 minutes */
export function logsUrl(base: string, agent?: string): string {
  const since = Date.now() - 10 * 60 * 1000;
  const params = new URLSearchParams({ since: String(since) });
  if (agent) params.set("agent", agent);
  return `${base}/logs?${params}`;
}

/** Build a /budget-action URL for pause/override actions */
function budgetActionUrl(base: string, action: string, agent: string): string {
  return `${base}/budget-action?action=${encodeURIComponent(action)}&agent=${encodeURIComponent(agent)}`;
}

function reloadConfig(): void {
  const raw = readDeckConfig();

  // Budget config
  const budgets = raw.budgets as Record<string, unknown> | undefined;
  // Session cost caps
  const caps = budgets?.sessionCostCap as { default?: number; agents?: Record<string, number>; action?: string } | undefined;
  const sessionCostCap: SessionCostCapConfig = {
    default: caps?.default ?? 5.0,
    agents: caps?.agents ?? {},
    action: (caps?.action as SessionAlertAction) ?? "alert",
  };

  cachedBudgetConfig = {
    global: (budgets?.global as BudgetConfig["global"]) ?? {},
    agents: (budgets?.agents as Record<string, AgentBudget>) ?? {},
    alertThresholds: (budgets?.alertThresholds as number[]) ?? [80, 100],
    alertChannel: (budgets?.alertChannel as string) ?? "systemStatus",
    defaultAutoRecovery: (budgets?.defaultAutoRecovery as AutoRecoveryDefault) ?? "throttle-only",
    sessionCostCap,
    costView: (budgets?.costView as CostAlertView) ?? "total",
  };

  // Model pricing
  const pricing = raw.modelPricing as Record<string, ModelPricing> | undefined;
  if (pricing && Object.keys(pricing).length > 0) {
    cachedModelPricing = pricing;
    setPricingTable(pricing);
  }

  // Throttle chain
  cachedThrottleChain = (raw.throttleChain as string[]) ?? DEFAULT_THROTTLE_CHAIN;

  // Provider limits
  cachedProviderLimits = (raw.providerLimits as Record<string, ProviderLimits>) ?? {};

  // Session guardrails (formerly replay alerts)
  const ra = raw.sessionGuardrails as Partial<SessionGuardrailsConfig> | undefined;
  // Also check legacy key for backward compat
  const legacyRa = raw.replayAlerts as Partial<SessionGuardrailsConfig> | undefined;
  const sg = ra ?? legacyRa;
  cachedReplayAlerts = {
    enabled: sg?.enabled ?? DEFAULT_SESSION_GUARDRAILS.enabled,
    action: (sg?.action as SessionAlertAction) ?? DEFAULT_SESSION_GUARDRAILS.action,
    maxSessionDuration: sg?.maxSessionDuration ?? DEFAULT_SESSION_GUARDRAILS.maxSessionDuration,
    cronMaxDuration: sg?.cronMaxDuration ?? DEFAULT_SESSION_GUARDRAILS.cronMaxDuration,
    maxToolCalls: sg?.maxToolCalls ?? DEFAULT_SESSION_GUARDRAILS.maxToolCalls,
    contextThreshold: sg?.contextThreshold ?? DEFAULT_SESSION_GUARDRAILS.contextThreshold,
    stepCostThreshold: sg?.stepCostThreshold ?? DEFAULT_SESSION_GUARDRAILS.stepCostThreshold,
  };
}

function ensureConfigWatcher(): void {
  if (configWatcherStarted) return;
  configWatcherStarted = true;
  reloadConfig();

  // Watch for config changes (poll every 5s — fs.watchFile is cross-platform reliable)
  try {
    fs.watchFile(DECK_CONFIG_PATH, { interval: 5000 }, () => {
      reloadConfig();
    });
  } catch {
    // If file doesn't exist yet, that's fine — we'll use defaults
  }
}

export function loadBudgetConfig(): BudgetConfig {
  ensureConfigWatcher();
  return cachedBudgetConfig ?? DEFAULT_BUDGET_CONFIG;
}

export function loadReplayAlertsConfig(): ReplayAlertsConfig {
  ensureConfigWatcher();
  return cachedReplayAlerts ?? DEFAULT_SESSION_GUARDRAILS;
}

export function getThrottleChain(): string[] {
  ensureConfigWatcher();
  return cachedThrottleChain ?? DEFAULT_THROTTLE_CHAIN;
}

// ── Pause state (file-based, no restart needed) ──────────────────

export function loadAllPausedState(): Record<string, PauseState> {
  try {
    return JSON.parse(fs.readFileSync(PAUSE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function loadPausedState(agent: string): PauseState | null {
  const all = loadAllPausedState();
  return all[agent] ?? null;
}

export function writePausedState(agent: string, paused: boolean, reason: string): void {
  const dir = path.dirname(PAUSE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const all = loadAllPausedState();
  all[agent] = { paused, since: Date.now(), reason };
  fs.writeFileSync(PAUSE_FILE, JSON.stringify(all, null, 2) + "\n", "utf-8");
}

// ── Budget enforcement ───────────────────────────────────────────

export type BudgetAction = "ok" | "alert" | "throttle" | "block";

// Alert cooldown: don't spam Discord more than once per 5 min per agent
export const lastAlertTs = new Map<string, number>();
export const ALERT_COOLDOWN = 300_000;

/**
 * Check a ratio against thresholds + action. Returns the most severe action triggered.
 */
function checkRatio(ratio: number, action: AgentBudget["action"], thresholds: number[]): BudgetAction {
  const sorted = thresholds.map((t) => t / 100).sort((a, b) => b - a);
  if (ratio >= 1.0) {
    if (action === "block") return "block";
    if (action === "throttle") return "throttle";
    return "alert";
  }
  for (const t of sorted) {
    if (t < 1.0 && ratio >= t) return "alert";
  }
  return "ok";
}

/** Severity rank for BudgetAction — higher = more severe. */
const ACTION_SEVERITY: Record<BudgetAction, number> = { ok: 0, alert: 1, throttle: 2, block: 3 };

function worstAction(a: BudgetAction, b: BudgetAction): BudgetAction {
  return ACTION_SEVERITY[a] >= ACTION_SEVERITY[b] ? a : b;
}

/**
 * Check an agent's current spend + request count against their budget.
 * Returns structured result with trigger source, period, and ratio.
 * Uses cached cost summary (30s TTL) so this is fast.
 */
/** Resolve cost for a budget period based on costView setting. */
function resolvePeriodCost(costView: CostAlertView, actual: number, apiEquiv: number | undefined, billing: string): number {
  switch (costView) {
    case "actual": return billing === "subscription" ? 0 : actual;
    case "api-equiv": return apiEquiv ?? actual;
    case "total":
    default: return billing === "subscription" ? (apiEquiv ?? 0) : actual;
  }
}

export function checkBudget(agent: string): BudgetCheckResult {
  const config = loadBudgetConfig();
  const agentBudget = config.agents[agent];
  const costs = queryCostSummary();
  const agentCost = costs.find((c) => c.agent === agent);

  const ok: BudgetCheckResult = { action: "ok", trigger: "agent", period: "daily", ratio: 0 };
  if (!agentCost) return ok;

  let worst: BudgetCheckResult = ok;
  const thresholds = config.alertThresholds;
  const action = agentBudget?.action ?? "alert";
  const cv = config.costView;

  function update(newAction: BudgetAction, trigger: "agent" | "global", period: BudgetCheckResult["period"], ratio: number) {
    if (ACTION_SEVERITY[newAction] > ACTION_SEVERITY[worst.action]) {
      worst = { action: newAction, trigger, period, ratio };
    }
  }

  // Agent cost budget (daily $)
  if (agentBudget?.daily && agentBudget.daily > 0) {
    const cost = resolvePeriodCost(cv, agentCost.daily, agentCost.apiEquivDaily, agentCost.billing);
    const ratio = cost / agentBudget.daily;
    update(checkRatio(ratio, action, thresholds), "agent", "daily", ratio);
  }

  // Agent request budget (daily requests)
  if (agentBudget?.dailyRequests && agentBudget.dailyRequests > 0) {
    const ratio = agentCost.dailyRequests / agentBudget.dailyRequests;
    update(checkRatio(ratio, action, thresholds), "agent", "dailyRequests", ratio);
  }

  // Agent request budget (weekly requests)
  if (agentBudget?.weeklyRequests && agentBudget.weeklyRequests > 0) {
    const ratio = agentCost.weeklyRequests / agentBudget.weeklyRequests;
    update(checkRatio(ratio, action, thresholds), "agent", "weeklyRequests", ratio);
  }

  // Global cost budget (daily $)
  const globalAction = config.global.action ?? "alert";
  if (config.global.daily && config.global.daily > 0) {
    const totalDaily = costs.reduce((sum, c) => sum + resolvePeriodCost(cv, c.daily, c.apiEquivDaily, c.billing), 0);
    const ratio = totalDaily / config.global.daily;
    update(checkRatio(ratio, globalAction, thresholds), "global", "daily", ratio);
  }

  // Global request budget (daily requests)
  if (config.global.dailyRequests && config.global.dailyRequests > 0) {
    const totalDailyReqs = costs.reduce((sum, c) => sum + c.dailyRequests, 0);
    const ratio = totalDailyReqs / config.global.dailyRequests;
    update(checkRatio(ratio, globalAction, thresholds), "global", "dailyRequests", ratio);
  }

  // Global request budget (weekly requests)
  if (config.global.weeklyRequests && config.global.weeklyRequests > 0) {
    const totalWeeklyReqs = costs.reduce((sum, c) => sum + c.weeklyRequests, 0);
    const ratio = totalWeeklyReqs / config.global.weeklyRequests;
    update(checkRatio(ratio, globalAction, thresholds), "global", "weeklyRequests", ratio);
  }

  return worst;
}

/** Map of throttle chain keys to actual model identifiers. */
const MODEL_ID_MAP: Record<string, { model: string; provider: string }> = {
  opus: { model: "claude-opus-4-6", provider: "anthropic" },
  sonnet: { model: "claude-sonnet-4-5-20250514", provider: "anthropic" },
  haiku: { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
};

/**
 * Given the current model string, return the next cheaper model in the throttle chain.
 * Returns null if already at cheapest or model not in chain.
 */
export function getThrottledModel(currentModel: string): { model: string; provider: string } | null {
  const chain = getThrottleChain();
  const lower = currentModel.toLowerCase();

  // Find which position in the chain the current model matches
  let currentIdx = -1;
  for (let i = 0; i < chain.length; i++) {
    if (lower.includes(chain[i].toLowerCase())) {
      currentIdx = i;
      break;
    }
  }

  // If not in chain or already at cheapest, can't throttle
  if (currentIdx < 0 || currentIdx >= chain.length - 1) return null;

  // Return next model in chain
  const nextKey = chain[currentIdx + 1];
  return MODEL_ID_MAP[nextKey.toLowerCase()] ?? null;
}

/**
 * Return the cheapest model in the throttle chain. Used when we don't know the current model.
 */
export function getCheapestModel(): { model: string; provider: string } | null {
  const chain = getThrottleChain();
  if (chain.length === 0) return null;
  const cheapestKey = chain[chain.length - 1];
  return MODEL_ID_MAP[cheapestKey.toLowerCase()] ?? null;
}

/**
 * Send a budget alert to the configured platform. Rate-limited per agent.
 * channelRef supports platform prefixes: "discord:123", "slack:C0ABC", "telegram:-100123".
 * Bare numeric IDs default to Discord for backward compatibility.
 */
export async function sendBudgetAlert(
  agent: string,
  level: "threshold" | "exceeded" | "blocked" | "paused" | "resumed",
  channelRef: string,
  botTokenOrTokens: string | AlertTokens,
  context?: { trigger?: string; period?: string; ratio?: number; skipCooldown?: boolean },
): Promise<void> {
  // Cooldown check
  const now = Date.now();
  const key = `${agent}:${level}`;
  if (!context?.skipCooldown) {
    const last = lastAlertTs.get(key) ?? 0;
    if (now - last < ALERT_COOLDOWN) return;
  }
  lastAlertTs.set(key, now);

  const costs = queryCostSummary();
  const agentCost = costs.find((c) => c.agent === agent);
  const config = loadBudgetConfig();
  const budget = config.agents[agent];

  const actionLabel = level === "blocked" ? "BLOCKED"
    : level === "exceeded" ? "EXCEEDED"
    : level === "paused" ? "PAUSED"
    : level === "resumed" ? "RESUMED"
    : "WARNING";

  // Action buttons
  const deckSiteUrl = getDeckSiteUrl();
  const buttons: Array<{ label: string; url: string }> = [];

  if (level === "paused") {
    buttons.push(
      { label: "Unpause Agent", url: budgetActionUrl(deckSiteUrl, "unpause", agent) },
      { label: "View Costs", url: costsUrl(deckSiteUrl, agent) },
      { label: "View Logs", url: logsUrl(deckSiteUrl, agent) },
    );
  } else if (level === "resumed") {
    buttons.push(
      { label: "View Costs", url: costsUrl(deckSiteUrl, agent) },
      { label: "View Logs", url: logsUrl(deckSiteUrl, agent) },
    );
  } else if (level === "blocked") {
    buttons.push(
      { label: "Unpause Agent", url: budgetActionUrl(deckSiteUrl, "unpause", agent) },
      { label: "Override Budget", url: budgetActionUrl(deckSiteUrl, "override", agent) },
      { label: "View Costs", url: costsUrl(deckSiteUrl, agent) },
      { label: "Configure", url: `${deckSiteUrl}/deck-config#edit.budgets.agentBudgets` },
    );
  } else if (level === "exceeded") {
    buttons.push(
      { label: "Override Budget", url: budgetActionUrl(deckSiteUrl, "override", agent) },
      { label: "Pause Agent", url: budgetActionUrl(deckSiteUrl, "pause", agent) },
      { label: "View Costs", url: costsUrl(deckSiteUrl, agent) },
      { label: "View Logs", url: logsUrl(deckSiteUrl, agent) },
      { label: "Configure", url: `${deckSiteUrl}/deck-config#edit.budgets.agentBudgets` },
    );
  } else {
    buttons.push(
      { label: "Pause Agent", url: budgetActionUrl(deckSiteUrl, "pause", agent) },
      { label: "Override Budget", url: budgetActionUrl(deckSiteUrl, "override", agent) },
      { label: "View Costs", url: costsUrl(deckSiteUrl, agent) },
      { label: "Configure", url: `${deckSiteUrl}/deck-config#edit.budgets.agentBudgets` },
    );
  }

  const sysStatus = level === "blocked" || level === "paused" ? "error"
    : level === "resumed" ? "ok"
    : "warning";
  logToSystemLog("budget", level === "paused" || level === "resumed" ? `agent-${level}` : `budget-${level}`,
    level === "paused" ? `${agent}: manually paused — all LLM calls blocked`
    : level === "resumed" ? `${agent}: resumed — LLM calls unblocked`
    : `${agent}: ${actionLabel} — $${agentCost?.daily?.toFixed(2) ?? "0"}/$${budget?.daily?.toFixed(2) ?? "∞"}`,
    { agent, level, daily: agentCost?.daily, limit: budget?.daily, action: budget?.action },
    sysStatus);

  // Resolve tokens: accept either a bare Discord token string (backward compat) or AlertTokens object
  const tokens: AlertTokens = typeof botTokenOrTokens === "string"
    ? { discord: botTokenOrTokens || undefined }
    : botTokenOrTokens;

  if (!channelRef) return;

  // Build cost lines showing both actual and API equivalent
  const isGlobalTrigger = context?.trigger === "global";
  const costLines: string[] = [];

  if (isGlobalTrigger && config.global.daily) {
    const totalActual = costs.reduce((s, c) => s + (c.daily ?? 0), 0);
    const totalEquiv = costs.reduce((s, c) => s + resolvePeriodCost(config.costView, c.daily ?? 0, c.apiEquivDaily, c.billing ?? "metered"), 0);
    costLines.push(`Fleet daily: $${totalEquiv.toFixed(2)} / $${config.global.daily.toFixed(2)}`);
    if (totalActual !== totalEquiv) {
      costLines.push(`  Actual:   $${totalActual.toFixed(2)}`);
      costLines.push(`  API equiv: $${totalEquiv.toFixed(2)}`);
    }
  } else if (budget?.daily) {
    const actualDaily = agentCost?.daily ?? 0;
    const apiEquivDaily = agentCost?.apiEquivDaily ?? 0;
    const billing = agentCost?.billing ?? "metered";
    const resolvedDaily = resolvePeriodCost(config.costView, actualDaily, apiEquivDaily, billing);
    costLines.push(`Daily:     $${resolvedDaily.toFixed(2)} / $${budget.daily.toFixed(2)}`);
    if (billing === "subscription" || (actualDaily > 0 && apiEquivDaily > 0)) {
      costLines.push(`  Actual:   $${actualDaily.toFixed(2)}`);
      costLines.push(`  API equiv: $${apiEquivDaily.toFixed(2)}`);
    }
  }

  const alertTitle = level === "paused" || level === "resumed"
    ? `Agent ${actionLabel}` : `Budget ${actionLabel}`;

  const bodyLines: string[] = [`Agent:     ${agent}`];
  if (level === "paused") {
    bodyLines.push(`Reason:    ${context?.trigger ?? "manual"}`);
    bodyLines.push("Status:    All LLM calls are blocked until unpaused.");
  } else if (level === "resumed") {
    bodyLines.push("Status:    Agent is active again.");
  } else {
    bodyLines.push(...costLines);
    if (budget?.dailyRequests) bodyLines.push(`Requests:  ${agentCost?.dailyRequests ?? 0} / ${budget.dailyRequests}`);
    if (context?.ratio != null) bodyLines.push(`Usage:     ${Math.round(context.ratio * 100)}%${context.trigger ? ` (${context.period ?? "daily"} ${context.trigger === "global" ? "global" : "agent"} limit)` : ""}`);
    if (level === "blocked") bodyLines.push("Status:    Agent LLM calls are being blocked.");
    else if (level === "exceeded" && budget?.action === "throttle") bodyLines.push("Status:    Agent being throttled to cheaper model.");
  }

  await sendAlert(channelRef, { title: alertTitle, lines: bodyLines, buttons }, tokens);
}

// ── Provider rate limit checking ────────────────────────────────

export function loadProviderLimits(): Record<string, ProviderLimits> {
  ensureConfigWatcher();
  return cachedProviderLimits ?? {};
}

// ── Re-exports from split modules ─────────────────────────────────
// These were extracted for file-size reduction. Re-exported here for
// backward compatibility so existing imports from "./budget.js" still work.

export { checkProviderLimits, checkAllProviderLimits, sendProviderLimitAlert } from "./rate-limits.js";
export { getSessionCostCapForAgent, loadBudgetOverrides, setBudgetOverride, clearBudgetOverride, hasBudgetOverride, getNextResetTime, shouldAutoRecover, onReplayAlert, fireReplayAlert, resolveCostForAlert, trackReplayLlmOutput, trackReplayToolCall, resetCronInvocation, checkSessionCost, checkSessionLimits, getReplaySessionSummaries, type ReplayAlertEvent, type SessionLimitResult } from "./replay-alerts.js";
export { sendAlert, parseChannelRef, type AlertTokens, type AlertMessage, type AlertPlatform } from "./alert-dispatch.js";
// loadAlertRouting, resolveAlertChannel are defined and exported above

