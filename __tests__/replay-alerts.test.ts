/**
 * Unit tests for replay alert logic (budget.ts replay tracking).
 *
 * Re-implements pure functions from plugin/budget.ts for testability.
 * Tests the 5 replay-triggered alert types from SESSION-REPLAY-SPEC §7.
 *
 * Run: npx tsx --test __tests__/replay-alerts.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Types (mirrored from budget.ts) ─────────────────────────────────────

interface ReplayAlertsConfig {
  enabled: boolean;
  sessionCostThreshold: number;
  stepCostThreshold: number;
  maxSessionDuration: number;
  maxToolCalls: number;
  contextThreshold: number;
  alertChannel: string;
}

interface ReplayAlertEvent {
  type: "session-cost" | "step-cost" | "long-session" | "excessive-tools" | "context-critical";
  agent: string;
  session: string;
  value: number;
  threshold: number;
  detail?: Record<string, unknown>;
}

interface ReplaySessionState {
  cost: number;
  toolCalls: number;
  firstTs: number;
  lastTs: number;
  alertedCost: boolean;
  alertedDuration: boolean;
  alertedToolCalls: boolean;
}

// ── Model context sizes (mirrored) ──────────────────────────────────────

const MODEL_MAX_CONTEXT: Record<string, number> = {
  opus: 200_000, sonnet: 200_000, haiku: 200_000,
  "gpt-4o": 128_000, "gpt-4": 128_000, "gpt-5": 1_000_000,
  deepseek: 128_000, gemini: 1_000_000, llama: 128_000, qwen: 128_000,
};

function getMaxContext(model: string): number {
  const lower = model.toLowerCase();
  for (const [key, max] of Object.entries(MODEL_MAX_CONTEXT)) {
    if (lower.includes(key)) return max;
  }
  return 200_000;
}

// ── Re-implementation of replay alert logic ─────────────────────────────

const DEFAULT_CONFIG: ReplayAlertsConfig = {
  enabled: true,
  sessionCostThreshold: 5.0,
  stepCostThreshold: 0.50,
  maxSessionDuration: 60,
  maxToolCalls: 200,
  contextThreshold: 85,
  alertChannel: "systemStatus",
};

let sessionStates: Map<string, ReplaySessionState>;
let firedAlerts: ReplayAlertEvent[];
let cooldowns: Map<string, number>;

function reset() {
  sessionStates = new Map();
  firedAlerts = [];
  cooldowns = new Map();
}

function getReplaySession(agent: string, session: string): ReplaySessionState {
  const key = `${agent}:${session}`;
  let state = sessionStates.get(key);
  if (!state) {
    state = {
      cost: 0, toolCalls: 0, firstTs: Date.now(), lastTs: Date.now(),
      alertedCost: false, alertedDuration: false, alertedToolCalls: false,
    };
    sessionStates.set(key, state);
  }
  return state;
}

function checkCooldown(alertType: string, agent: string, cooldownMs: number): boolean {
  const key = `replay:${alertType}:${agent}`;
  const now = Date.now();
  const last = cooldowns.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  cooldowns.set(key, now);
  return true;
}

function trackLlmOutput(
  agent: string, session: string, cost: number, model: string,
  inputTokens: number, cacheRead: number,
  config: ReplayAlertsConfig = DEFAULT_CONFIG,
  nowOverride?: number,
): void {
  if (!config.enabled) return;

  const state = getReplaySession(agent, session);
  state.cost += cost;
  state.lastTs = nowOverride ?? Date.now();

  // Alert 1: Session Cost Spike
  if (!state.alertedCost && state.cost >= config.sessionCostThreshold) {
    state.alertedCost = true;
    if (checkCooldown("session-cost", agent, 300_000)) {
      firedAlerts.push({
        type: "session-cost", agent, session,
        value: state.cost, threshold: config.sessionCostThreshold,
      });
    }
  }

  // Alert 2: Expensive Step
  if (cost >= config.stepCostThreshold) {
    if (checkCooldown("step-cost", agent, 300_000)) {
      firedAlerts.push({
        type: "step-cost", agent, session,
        value: cost, threshold: config.stepCostThreshold,
      });
    }
  }

  // Alert 3: Long-Running Session
  const durationMin = ((nowOverride ?? Date.now()) - state.firstTs) / 60_000;
  if (!state.alertedDuration && durationMin >= config.maxSessionDuration) {
    state.alertedDuration = true;
    if (checkCooldown("long-session", agent, 1_800_000)) {
      firedAlerts.push({
        type: "long-session", agent, session,
        value: Math.round(durationMin), threshold: config.maxSessionDuration,
      });
    }
  }

  // Alert 5: Context Window Critical
  const maxCtx = getMaxContext(model);
  const totalInput = inputTokens + cacheRead;
  const utilPct = (totalInput / maxCtx) * 100;
  if (utilPct >= config.contextThreshold) {
    if (checkCooldown("context-critical", agent, 900_000)) {
      firedAlerts.push({
        type: "context-critical", agent, session,
        value: Math.round(utilPct), threshold: config.contextThreshold,
      });
    }
  }
}

function trackToolCall(
  agent: string, session: string,
  config: ReplayAlertsConfig = DEFAULT_CONFIG,
): void {
  if (!config.enabled) return;
  const state = getReplaySession(agent, session);
  state.toolCalls++;
  state.lastTs = Date.now();

  // Alert 4: Excessive Tool Calls
  if (!state.alertedToolCalls && state.toolCalls >= config.maxToolCalls) {
    state.alertedToolCalls = true;
    if (checkCooldown("excessive-tools", agent, 900_000)) {
      firedAlerts.push({
        type: "excessive-tools", agent, session,
        value: state.toolCalls, threshold: config.maxToolCalls,
      });
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => reset());

// ── Alert 1: Session Cost Spike ─────────────────────────────────────────

describe("Replay Alert: Session Cost Spike", () => {
  it("fires when cumulative session cost exceeds threshold", () => {
    const config = { ...DEFAULT_CONFIG, sessionCostThreshold: 1.00 };
    // 5 calls at $0.25 each = $1.25 total → should fire after the 4th
    trackLlmOutput("jane", "sess1", 0.25, "anthropic/claude-opus-4-6", 10000, 0, config);
    trackLlmOutput("jane", "sess1", 0.25, "anthropic/claude-opus-4-6", 10000, 0, config);
    trackLlmOutput("jane", "sess1", 0.25, "anthropic/claude-opus-4-6", 10000, 0, config);
    assert.equal(firedAlerts.length, 0, "Below threshold — no alert");

    trackLlmOutput("jane", "sess1", 0.25, "anthropic/claude-opus-4-6", 10000, 0, config);
    assert.equal(firedAlerts.length, 1, "At threshold — alert fires");
    assert.equal(firedAlerts[0].type, "session-cost");
    assert.equal(firedAlerts[0].value, 1.00);
  });

  it("fires only once per session (alertedCost flag)", () => {
    const config = { ...DEFAULT_CONFIG, sessionCostThreshold: 0.50 };
    trackLlmOutput("jane", "sess1", 0.60, "anthropic/claude-opus-4-6", 10000, 0, config);
    trackLlmOutput("jane", "sess1", 0.60, "anthropic/claude-opus-4-6", 10000, 0, config);
    assert.equal(firedAlerts.filter(a => a.type === "session-cost").length, 1);
  });

  it("tracks sessions independently", () => {
    const config = { ...DEFAULT_CONFIG, sessionCostThreshold: 1.00 };
    trackLlmOutput("jane", "sess1", 1.50, "anthropic/claude-opus-4-6", 10000, 0, config);
    trackLlmOutput("jane", "sess2", 0.50, "anthropic/claude-opus-4-6", 10000, 0, config);
    const costAlerts = firedAlerts.filter(a => a.type === "session-cost");
    assert.equal(costAlerts.length, 1);
    assert.equal(costAlerts[0].session, "sess1");
  });
});

// ── Alert 2: Expensive Step ─────────────────────────────────────────────

describe("Replay Alert: Expensive Step", () => {
  it("fires when a single LLM call exceeds step cost threshold", () => {
    const config = { ...DEFAULT_CONFIG, stepCostThreshold: 0.50 };
    trackLlmOutput("jane", "sess1", 0.30, "anthropic/claude-opus-4-6", 10000, 0, config);
    assert.equal(firedAlerts.length, 0, "Below threshold");

    trackLlmOutput("jane", "sess1", 0.60, "anthropic/claude-opus-4-6", 10000, 0, config);
    assert.equal(firedAlerts.length, 1);
    assert.equal(firedAlerts[0].type, "step-cost");
    assert.equal(firedAlerts[0].value, 0.60);
  });

  it("fires per expensive call (not once per session)", () => {
    // Step cost fires on cooldown, not on alertedCost flag
    // But cooldown of 5min means rapid calls get collapsed
    const config = { ...DEFAULT_CONFIG, stepCostThreshold: 0.50 };
    trackLlmOutput("jane", "sess1", 0.60, "anthropic/claude-opus-4-6", 10000, 0, config);
    // Second call within cooldown — should NOT fire
    trackLlmOutput("jane", "sess1", 0.70, "anthropic/claude-opus-4-6", 10000, 0, config);
    assert.equal(firedAlerts.filter(a => a.type === "step-cost").length, 1);
  });
});

// ── Alert 3: Long-Running Session ───────────────────────────────────────

describe("Replay Alert: Long-Running Session", () => {
  it("fires when session duration exceeds threshold", () => {
    const config = { ...DEFAULT_CONFIG, maxSessionDuration: 60 };
    const startTs = Date.now() - 65 * 60_000; // 65 minutes ago

    // Manually set session start time
    const state = getReplaySession("jane", "sess1");
    state.firstTs = startTs;

    trackLlmOutput("jane", "sess1", 0.10, "anthropic/claude-opus-4-6", 10000, 0, config);
    assert.equal(firedAlerts.length, 1);
    assert.equal(firedAlerts[0].type, "long-session");
    assert.ok(firedAlerts[0].value >= 60);
  });

  it("does not fire for short sessions", () => {
    const config = { ...DEFAULT_CONFIG, maxSessionDuration: 60 };
    // Session just started (default firstTs = now)
    trackLlmOutput("jane", "sess1", 0.10, "anthropic/claude-opus-4-6", 10000, 0, config);
    assert.equal(firedAlerts.filter(a => a.type === "long-session").length, 0);
  });

  it("fires only once per session", () => {
    const config = { ...DEFAULT_CONFIG, maxSessionDuration: 60 };
    const state = getReplaySession("jane", "sess1");
    state.firstTs = Date.now() - 70 * 60_000;

    trackLlmOutput("jane", "sess1", 0.10, "anthropic/claude-opus-4-6", 10000, 0, config);
    trackLlmOutput("jane", "sess1", 0.10, "anthropic/claude-opus-4-6", 10000, 0, config);
    assert.equal(firedAlerts.filter(a => a.type === "long-session").length, 1);
  });
});

// ── Alert 4: Excessive Tool Calls ───────────────────────────────────────

describe("Replay Alert: Excessive Tool Calls", () => {
  it("fires when tool call count exceeds threshold", () => {
    const config = { ...DEFAULT_CONFIG, maxToolCalls: 10 };
    for (let i = 0; i < 9; i++) {
      trackToolCall("jane", "sess1", config);
    }
    assert.equal(firedAlerts.length, 0, "Below threshold");

    trackToolCall("jane", "sess1", config);
    assert.equal(firedAlerts.length, 1);
    assert.equal(firedAlerts[0].type, "excessive-tools");
    assert.equal(firedAlerts[0].value, 10);
  });

  it("fires only once per session", () => {
    const config = { ...DEFAULT_CONFIG, maxToolCalls: 5 };
    for (let i = 0; i < 10; i++) {
      trackToolCall("jane", "sess1", config);
    }
    assert.equal(firedAlerts.filter(a => a.type === "excessive-tools").length, 1);
  });
});

// ── Alert 5: Context Window Critical ────────────────────────────────────

describe("Replay Alert: Context Window Critical", () => {
  it("fires when context utilization exceeds threshold", () => {
    const config = { ...DEFAULT_CONFIG, contextThreshold: 85 };
    // claude-opus-4-6 → 200K context. 170K tokens = 85%
    trackLlmOutput("jane", "sess1", 0.10, "anthropic/claude-opus-4-6", 170_000, 0, config);
    assert.equal(firedAlerts.length, 1);
    assert.equal(firedAlerts[0].type, "context-critical");
    assert.equal(firedAlerts[0].value, 85);
  });

  it("does not fire when below threshold", () => {
    const config = { ...DEFAULT_CONFIG, contextThreshold: 85 };
    // 100K tokens on 200K context = 50%
    trackLlmOutput("jane", "sess1", 0.10, "anthropic/claude-opus-4-6", 100_000, 0, config);
    assert.equal(firedAlerts.filter(a => a.type === "context-critical").length, 0);
  });

  it("includes cache_read in utilization calculation", () => {
    const config = { ...DEFAULT_CONFIG, contextThreshold: 85 };
    // 100K input + 70K cache = 170K total on 200K = 85%
    trackLlmOutput("jane", "sess1", 0.10, "anthropic/claude-opus-4-6", 100_000, 70_000, config);
    assert.equal(firedAlerts.length, 1);
    assert.equal(firedAlerts[0].type, "context-critical");
  });

  it("uses correct max context for different models", () => {
    const config = { ...DEFAULT_CONFIG, contextThreshold: 85 };
    // Gemini has 1M context. 170K = 17% — should NOT fire
    trackLlmOutput("jane", "sess1", 0.10, "google/gemini-2.0-flash", 170_000, 0, config);
    assert.equal(firedAlerts.filter(a => a.type === "context-critical").length, 0);

    // But 850K on Gemini = 85% — should fire
    reset();
    trackLlmOutput("jane", "sess2", 0.10, "google/gemini-2.0-flash", 850_000, 0, config);
    assert.equal(firedAlerts.filter(a => a.type === "context-critical").length, 1);
  });
});

// ── getMaxContext ────────────────────────────────────────────────────────

describe("getMaxContext", () => {
  it("returns 200K for opus", () => {
    assert.equal(getMaxContext("anthropic/claude-opus-4-6"), 200_000);
  });

  it("returns 200K for sonnet", () => {
    assert.equal(getMaxContext("anthropic/claude-sonnet-4-5-20250514"), 200_000);
  });

  it("returns 128K for gpt-4o", () => {
    assert.equal(getMaxContext("openai/gpt-4o"), 128_000);
  });

  it("returns 1M for gemini", () => {
    assert.equal(getMaxContext("google/gemini-2.0-flash"), 1_000_000);
  });

  it("returns 200K default for unknown model", () => {
    assert.equal(getMaxContext("some/unknown-model"), 200_000);
  });
});

// ── Config: enabled toggle ──────────────────────────────────────────────

describe("Replay Alerts: enabled toggle", () => {
  it("no alerts fire when disabled", () => {
    const config = { ...DEFAULT_CONFIG, enabled: false, sessionCostThreshold: 0.01 };
    trackLlmOutput("jane", "sess1", 1.00, "anthropic/claude-opus-4-6", 190_000, 0, config);
    trackToolCall("jane", "sess1", config);
    assert.equal(firedAlerts.length, 0);
  });
});

// ── Cooldown behaviour ──────────────────────────────────────────────────

describe("Replay Alerts: cooldown", () => {
  it("step-cost cooldown prevents rapid re-firing", () => {
    const config = { ...DEFAULT_CONFIG, stepCostThreshold: 0.10 };
    trackLlmOutput("jane", "sess1", 0.50, "anthropic/claude-opus-4-6", 10000, 0, config);
    trackLlmOutput("jane", "sess1", 0.50, "anthropic/claude-opus-4-6", 10000, 0, config);
    trackLlmOutput("jane", "sess1", 0.50, "anthropic/claude-opus-4-6", 10000, 0, config);
    // Only 1 step-cost alert (cooldown prevents second and third)
    assert.equal(firedAlerts.filter(a => a.type === "step-cost").length, 1);
  });

  it("different agents have independent cooldowns", () => {
    const config = { ...DEFAULT_CONFIG, stepCostThreshold: 0.10 };
    trackLlmOutput("jane", "sess1", 0.50, "anthropic/claude-opus-4-6", 10000, 0, config);
    trackLlmOutput("scout", "sess2", 0.50, "anthropic/claude-opus-4-6", 10000, 0, config);
    // Both should fire (independent cooldowns)
    assert.equal(firedAlerts.filter(a => a.type === "step-cost").length, 2);
  });
});

// ── resolveCostForAlert (pure, imported from replay-alerts) ─────────────

describe("resolveCostForAlert (inline)", () => {
  // Mirrors plugin/replay-alerts.ts resolveCostForAlert logic
  function resolveCost(
    costView: "provider" | "api",
    actualCost: number,
    apiEquivCost: number,
    billing: string,
  ): number | null {
    if (costView === "provider") {
      return billing === "subscription" ? null : actualCost;
    }
    return apiEquivCost;
  }

  it("returns provider cost for 'provider' view + metered", () => {
    assert.equal(resolveCost("provider", 0.05, 0.10, "metered"), 0.05);
  });

  it("returns api equiv cost for 'api' view", () => {
    assert.equal(resolveCost("api", 0.05, 0.10, "metered"), 0.10);
  });

  it("returns null for subscription billing with 'provider' view", () => {
    assert.equal(resolveCost("provider", 0.05, 0.10, "subscription"), null);
  });

  it("returns api equiv for subscription billing with 'api' view", () => {
    assert.equal(resolveCost("api", 0.05, 0.10, "subscription"), 0.10);
  });
});
