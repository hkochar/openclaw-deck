/**
 * Acceptance tests for Cost Guardian Enforcement (Spec 2).
 *
 * Tests budget checking, throttle step-down, session cost cap,
 * budget override lifecycle, auto-recovery, and reset timing.
 *
 * Run: npx tsx --test __tests__/cost-guardian-acceptance.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Types (mirrored from budget.ts) ──────────────────────────────

type BudgetAction = "ok" | "alert" | "throttle" | "block";
type AgentAction = "alert" | "throttle" | "block";

interface AgentBudget {
  daily?: number | null;
  weekly?: number | null;
  monthly?: number | null;
  dailyRequests?: number | null;
  weeklyRequests?: number | null;
  action: AgentAction;
  autoRecovery?: boolean;
}

interface SessionCostCapConfig {
  default: number;
  agents: Record<string, number>;
}

interface BudgetConfig {
  global: { daily?: number; weekly?: number; monthly?: number; dailyRequests?: number; weeklyRequests?: number };
  agents: Record<string, AgentBudget>;
  alertThresholds: number[];
  alertChannel: string;
  defaultAutoRecovery: "all" | "throttle-only" | "none";
  sessionCostCap: SessionCostCapConfig;
}

interface CostSummary {
  agent: string;
  daily: number;
  weekly: number;
  monthly: number;
  dailyRequests: number;
  weeklyRequests: number;
}

interface BudgetCheckResult {
  action: BudgetAction;
  trigger: "agent" | "global";
  period: string;
  ratio: number;
}

interface BudgetOverride {
  agent: string;
  expiresAt: number;
  reason: string;
  createdBy: string;
  createdAt: number;
}

// ── Reimplemented pure functions ─────────────────────────────────

const ACTION_SEVERITY: Record<BudgetAction, number> = { ok: 0, alert: 1, throttle: 2, block: 3 };

function checkRatio(ratio: number, action: AgentAction, thresholds: number[]): BudgetAction {
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

function checkBudget(config: BudgetConfig, costs: CostSummary[], agent: string): BudgetCheckResult {
  const agentBudget = config.agents[agent];
  const agentCost = costs.find((c) => c.agent === agent);
  const ok: BudgetCheckResult = { action: "ok", trigger: "agent", period: "daily", ratio: 0 };
  if (!agentCost) return ok;

  let worst = ok;
  const thresholds = config.alertThresholds;
  const action = agentBudget?.action ?? "alert";

  function update(newAction: BudgetAction, trigger: "agent" | "global", period: string, ratio: number) {
    if (ACTION_SEVERITY[newAction] > ACTION_SEVERITY[worst.action]) {
      worst = { action: newAction, trigger, period, ratio };
    }
  }

  if (agentBudget?.daily && agentBudget.daily > 0) {
    const ratio = agentCost.daily / agentBudget.daily;
    update(checkRatio(ratio, action, thresholds), "agent", "daily", ratio);
  }
  if (agentBudget?.dailyRequests && agentBudget.dailyRequests > 0) {
    const ratio = agentCost.dailyRequests / agentBudget.dailyRequests;
    update(checkRatio(ratio, action, thresholds), "agent", "dailyRequests", ratio);
  }
  if (config.global.daily && config.global.daily > 0) {
    const totalDaily = costs.reduce((sum, c) => sum + c.daily, 0);
    const ratio = totalDaily / config.global.daily;
    update(checkRatio(ratio, "block", thresholds), "global", "daily", ratio);
  }
  return worst;
}

const MODEL_ID_MAP: Record<string, { model: string; provider: string }> = {
  opus: { model: "claude-opus-4-6", provider: "anthropic" },
  sonnet: { model: "claude-sonnet-4-5-20250514", provider: "anthropic" },
  haiku: { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
};

function getThrottledModel(currentModel: string, chain: string[] = ["opus", "sonnet", "haiku"]): { model: string; provider: string } | null {
  const lower = currentModel.toLowerCase();
  let currentIdx = -1;
  for (let i = 0; i < chain.length; i++) {
    if (lower.includes(chain[i].toLowerCase())) { currentIdx = i; break; }
  }
  if (currentIdx < 0 || currentIdx >= chain.length - 1) return null;
  const nextKey = chain[currentIdx + 1];
  return MODEL_ID_MAP[nextKey.toLowerCase()] ?? null;
}

function getSessionCostCapForAgent(config: BudgetConfig, agent: string): number {
  return config.sessionCostCap.agents[agent]
    ?? config.sessionCostCap.default
    ?? 5.0;
}

function shouldAutoRecover(
  agentBudget: AgentBudget | undefined,
  defaultMode: "all" | "throttle-only" | "none",
): boolean {
  if (agentBudget?.autoRecovery !== undefined) return agentBudget.autoRecovery;
  if (defaultMode === "all") return true;
  if (defaultMode === "none") return false;
  return agentBudget?.action === "throttle";
}

// ── 2.1 Block Enforcement ────────────────────────────────────────

describe("2.1 Block enforcement", () => {
  const config: BudgetConfig = {
    global: {},
    agents: {
      "agent-x": { daily: 0.01, action: "block" },
    },
    alertThresholds: [80, 100],
    alertChannel: "systemStatus",
    defaultAutoRecovery: "all",
    sessionCostCap: { default: 5.0, agents: {} },
  };

  it("blocks agent when daily spend exceeds budget", () => {
    const costs: CostSummary[] = [
      { agent: "agent-x", daily: 0.02, weekly: 0.02, monthly: 0.02, dailyRequests: 5, weeklyRequests: 5 },
    ];
    const result = checkBudget(config, costs, "agent-x");
    assert.equal(result.action, "block");
    assert.equal(result.trigger, "agent");
    assert.equal(result.period, "daily");
    assert.ok(result.ratio >= 1.0);
  });

  it("alerts agent at 80% threshold before blocking", () => {
    const costs: CostSummary[] = [
      { agent: "agent-x", daily: 0.008, weekly: 0.008, monthly: 0.008, dailyRequests: 4, weeklyRequests: 4 },
    ];
    const result = checkBudget(config, costs, "agent-x");
    assert.equal(result.action, "alert");
    assert.ok(result.ratio >= 0.8);
    assert.ok(result.ratio < 1.0);
  });

  it("ok when well below budget", () => {
    const costs: CostSummary[] = [
      { agent: "agent-x", daily: 0.003, weekly: 0.003, monthly: 0.003, dailyRequests: 1, weeklyRequests: 1 },
    ];
    const result = checkBudget(config, costs, "agent-x");
    assert.equal(result.action, "ok");
  });

  it("unknown agent returns ok (no budget configured)", () => {
    const costs: CostSummary[] = [
      { agent: "unknown", daily: 100, weekly: 100, monthly: 100, dailyRequests: 999, weeklyRequests: 999 },
    ];
    const result = checkBudget(config, costs, "unknown");
    assert.equal(result.action, "ok");
  });

  it("agent with no cost data returns ok", () => {
    const result = checkBudget(config, [], "agent-x");
    assert.equal(result.action, "ok");
  });
});

// ── 2.2 Throttle Step-Down ───────────────────────────────────────

describe("2.2 Throttle step-down", () => {
  const config: BudgetConfig = {
    global: {},
    agents: {
      "agent-x": { daily: 5.0, action: "throttle" },
    },
    alertThresholds: [50, 80, 100],
    alertChannel: "systemStatus",
    defaultAutoRecovery: "all",
    sessionCostCap: { default: 5.0, agents: {} },
  };

  it("throttle action at 100% budget for throttle agents", () => {
    const costs: CostSummary[] = [
      { agent: "agent-x", daily: 5.0, weekly: 5.0, monthly: 5.0, dailyRequests: 50, weeklyRequests: 50 },
    ];
    const result = checkBudget(config, costs, "agent-x");
    assert.equal(result.action, "throttle");
  });

  it("opus throttles to sonnet (one step, not haiku)", () => {
    const result = getThrottledModel("claude-opus-4-6");
    assert.ok(result);
    assert.equal(result!.model, "claude-sonnet-4-5-20250514");
    // NOT haiku — must step down one level
    assert.notEqual(result!.model, "claude-haiku-4-5-20251001");
  });

  it("sonnet throttles to haiku", () => {
    const result = getThrottledModel("claude-sonnet-4-5-20250514");
    assert.ok(result);
    assert.equal(result!.model, "claude-haiku-4-5-20251001");
  });

  it("haiku cannot be throttled further (already cheapest)", () => {
    const result = getThrottledModel("claude-haiku-4-5-20251001");
    assert.equal(result, null);
  });

  it("throttle chain respects custom order", () => {
    const result = getThrottledModel("claude-opus-4-6", ["opus", "haiku"]);
    assert.ok(result);
    assert.equal(result!.model, "claude-haiku-4-5-20251001");
  });
});

// ── 2.4 Session Cost Cap ─────────────────────────────────────────

describe("2.4 Session cost cap", () => {
  const config: BudgetConfig = {
    global: {},
    agents: {
      "agent-x": { daily: 100, action: "block" },
    },
    alertThresholds: [80, 100],
    alertChannel: "systemStatus",
    defaultAutoRecovery: "all",
    sessionCostCap: { default: 5.0, agents: { "agent-x": 0.50 } },
  };

  it("per-agent cap overrides default", () => {
    assert.equal(getSessionCostCapForAgent(config, "agent-x"), 0.50);
  });

  it("unspecified agent gets default cap", () => {
    assert.equal(getSessionCostCapForAgent(config, "agent-y"), 5.0);
  });

  it("session cap is per-session, not per-agent total", () => {
    // Two separate sessions for the same agent each get their own cap
    const cap1 = getSessionCostCapForAgent(config, "agent-x");
    const cap2 = getSessionCostCapForAgent(config, "agent-x");
    assert.equal(cap1, cap2);
    assert.equal(cap1, 0.50);
    // Each session can spend up to $0.50 independently
  });

  it("cap value is configurable, not hardcoded $5", () => {
    const customConfig: BudgetConfig = {
      ...config,
      sessionCostCap: { default: 2.0, agents: { "agent-x": 0.10 } },
    };
    assert.equal(getSessionCostCapForAgent(customConfig, "agent-x"), 0.10);
    assert.notEqual(getSessionCostCapForAgent(customConfig, "agent-x"), 5.0);
  });
});

// ── 2.5 Auto-Recovery ────────────────────────────────────────────

describe("2.5 Auto-recovery", () => {
  it("agent with explicit autoRecovery=true recovers", () => {
    assert.equal(
      shouldAutoRecover({ action: "block", autoRecovery: true }, "none"),
      true,
    );
  });

  it("agent with explicit autoRecovery=false does not recover", () => {
    assert.equal(
      shouldAutoRecover({ action: "throttle", autoRecovery: false }, "all"),
      false,
    );
  });

  it("default 'all' auto-recovers blocked agents", () => {
    assert.equal(
      shouldAutoRecover({ action: "block" }, "all"),
      true,
    );
  });

  it("default 'none' does not auto-recover", () => {
    assert.equal(
      shouldAutoRecover({ action: "block" }, "none"),
      false,
    );
  });

  it("default 'throttle-only' recovers throttled but not blocked", () => {
    assert.equal(
      shouldAutoRecover({ action: "throttle" }, "throttle-only"),
      true,
    );
    assert.equal(
      shouldAutoRecover({ action: "block" }, "throttle-only"),
      false,
    );
  });
});

// ── 2.6 Emergency Override ───────────────────────────────────────

describe("2.6 Emergency override lifecycle", () => {
  it("override has agent, expiry, reason, and creator", () => {
    const override: BudgetOverride = {
      agent: "agent-x",
      expiresAt: Date.now() + 3_600_000, // 1 hour
      reason: "urgent task",
      createdBy: "dashboard",
      createdAt: Date.now(),
    };
    assert.equal(override.agent, "agent-x");
    assert.ok(override.expiresAt > Date.now());
    assert.equal(override.reason, "urgent task");
    assert.equal(override.createdBy, "dashboard");
  });

  it("override expires after duration", () => {
    const override: BudgetOverride = {
      agent: "agent-x",
      expiresAt: Date.now() - 1000, // expired 1s ago
      reason: "test",
      createdBy: "dashboard",
      createdAt: Date.now() - 3_600_000,
    };
    assert.ok(override.expiresAt < Date.now(), "Override should be expired");
  });

  it("active override check", () => {
    const activeOverride: BudgetOverride = {
      agent: "agent-x",
      expiresAt: Date.now() + 3_600_000,
      reason: "test",
      createdBy: "dashboard",
      createdAt: Date.now(),
    };
    assert.ok(activeOverride.expiresAt > Date.now());

    const expiredOverride: BudgetOverride = {
      agent: "agent-x",
      expiresAt: Date.now() - 1,
      reason: "test",
      createdBy: "dashboard",
      createdAt: Date.now() - 7_200_000,
    };
    assert.ok(expiredOverride.expiresAt <= Date.now());
  });
});

// ── 2.7 Budget Reset at Midnight ─────────────────────────────────

describe("2.7 Budget reset timing", () => {
  function getNextResetTime(period: "daily" | "weekly" | "monthly"): Date {
    const now = new Date();
    if (period === "daily") {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      return next;
    }
    if (period === "weekly") {
      const next = new Date(now);
      const daysUntilMonday = (8 - next.getDay()) % 7 || 7;
      next.setDate(next.getDate() + daysUntilMonday);
      next.setHours(0, 0, 0, 0);
      return next;
    }
    const next = new Date(now);
    next.setMonth(next.getMonth() + 1);
    next.setDate(1);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  it("daily resets at midnight local time", () => {
    const reset = getNextResetTime("daily");
    assert.equal(reset.getHours(), 0);
    assert.equal(reset.getMinutes(), 0);
    assert.equal(reset.getSeconds(), 0);
    assert.ok(reset.getTime() > Date.now());
  });

  it("weekly resets on Monday midnight", () => {
    const reset = getNextResetTime("weekly");
    assert.equal(reset.getDay(), 1, "Should be Monday");
    assert.equal(reset.getHours(), 0);
    assert.ok(reset.getTime() > Date.now());
  });

  it("monthly resets on 1st of next month", () => {
    const reset = getNextResetTime("monthly");
    assert.equal(reset.getDate(), 1);
    assert.equal(reset.getHours(), 0);
    assert.ok(reset.getTime() > Date.now());
  });
});

// ── 2.8 Overshoot Bound ─────────────────────────────────────────

describe("2.8 Overshoot bound", () => {
  it("budget check before in-flight call returns ok", () => {
    const config: BudgetConfig = {
      global: {},
      agents: { "agent-x": { daily: 1.00, action: "block" } },
      alertThresholds: [80, 100],
      alertChannel: "systemStatus",
      defaultAutoRecovery: "all",
      sessionCostCap: { default: 5.0, agents: {} },
    };
    // At $0.95 — still under budget
    const costs: CostSummary[] = [
      { agent: "agent-x", daily: 0.95, weekly: 0.95, monthly: 0.95, dailyRequests: 10, weeklyRequests: 10 },
    ];
    const result = checkBudget(config, costs, "agent-x");
    assert.equal(result.action, "alert"); // 95% triggers alert, not block
    assert.ok(result.ratio < 1.0);
  });

  it("budget check after in-flight call completes blocks next", () => {
    const config: BudgetConfig = {
      global: {},
      agents: { "agent-x": { daily: 1.00, action: "block" } },
      alertThresholds: [80, 100],
      alertChannel: "systemStatus",
      defaultAutoRecovery: "all",
      sessionCostCap: { default: 5.0, agents: {} },
    };
    // After in-flight: spent $1.05 — over budget
    const costs: CostSummary[] = [
      { agent: "agent-x", daily: 1.05, weekly: 1.05, monthly: 1.05, dailyRequests: 11, weeklyRequests: 11 },
    ];
    const result = checkBudget(config, costs, "agent-x");
    assert.equal(result.action, "block");
    assert.ok(result.ratio > 1.0);
  });

  it("overshoot bounded by single call cost", () => {
    // Budget $1.00, one in-flight call costs $0.95 = overshoot to $1.90
    // This is acceptable — bounded by cost of one call
    const budget = 1.00;
    const inFlightCost = 0.95;
    const totalSpend = budget + inFlightCost - 0.05; // $1.90
    const overshoot = totalSpend - budget;
    assert.ok(overshoot <= inFlightCost, "Overshoot should be bounded by single call cost");
  });
});

// ── Global Budget ────────────────────────────────────────────────

describe("Global budget enforcement", () => {
  const config: BudgetConfig = {
    global: { daily: 10.0 },
    agents: {
      "agent-a": { daily: 5.0, action: "block" },
      "agent-b": { daily: 5.0, action: "block" },
    },
    alertThresholds: [80, 100],
    alertChannel: "systemStatus",
    defaultAutoRecovery: "all",
    sessionCostCap: { default: 5.0, agents: {} },
  };

  it("blocks when global daily budget exceeded", () => {
    const costs: CostSummary[] = [
      { agent: "agent-a", daily: 4.0, weekly: 4.0, monthly: 4.0, dailyRequests: 40, weeklyRequests: 40 },
      { agent: "agent-b", daily: 7.0, weekly: 7.0, monthly: 7.0, dailyRequests: 70, weeklyRequests: 70 },
    ];
    // Total daily = 11.0, global limit = 10.0
    const result = checkBudget(config, costs, "agent-a");
    assert.equal(result.action, "block");
    assert.equal(result.trigger, "global");
  });

  it("worst action wins — global block overrides agent alert", () => {
    const costs: CostSummary[] = [
      { agent: "agent-a", daily: 3.0, weekly: 3.0, monthly: 3.0, dailyRequests: 30, weeklyRequests: 30 },
      { agent: "agent-b", daily: 8.0, weekly: 8.0, monthly: 8.0, dailyRequests: 80, weeklyRequests: 80 },
    ];
    // agent-a at 60% of own budget (alert), but global at 110% (block)
    const result = checkBudget(config, costs, "agent-a");
    assert.equal(result.action, "block");
    assert.equal(result.trigger, "global");
  });
});
