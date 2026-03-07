/**
 * Unit tests for gateway budget enforcement logic.
 *
 * Re-implements pure functions from extensions/openclaw-deck-sync/budget.ts
 * locally (the gateway plugin cannot be imported directly), then tests them
 * thoroughly against the documented behaviour.
 *
 * Run: npx tsx --test __tests__/gateway-budget.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Types (mirrored from budget.ts) ─────────────────────────────────────

type BudgetAction = "ok" | "alert" | "throttle" | "block";
type AgentAction = "alert" | "throttle" | "block";
type AutoRecoveryDefault = "all" | "throttle-only" | "none";

interface AgentBudgetSlice {
  autoRecovery?: boolean;
  action?: AgentAction;
}

interface ProviderLimitWindow {
  id: string;
  duration: number;
  rolling: boolean;
  shared: boolean;
  weights?: Record<string, number>;
  model?: string;
  limit: number;
}

// ── 1. checkRatio ────────────────────────────────────────────────────────

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

describe("checkRatio", () => {
  it("below all thresholds returns ok", () => {
    assert.equal(checkRatio(0.5, "block", [80, 100]), "ok");
  });

  it("at 80% threshold with [80,100] returns alert", () => {
    assert.equal(checkRatio(0.8, "block", [80, 100]), "alert");
  });

  it("at 100% with action block returns block", () => {
    assert.equal(checkRatio(1.0, "block", [80, 100]), "block");
  });

  it("at 100% with action throttle returns throttle", () => {
    assert.equal(checkRatio(1.0, "throttle", [80, 100]), "throttle");
  });

  it("at 100% with action alert returns alert", () => {
    assert.equal(checkRatio(1.0, "alert", [80, 100]), "alert");
  });

  it("between thresholds returns alert", () => {
    // ratio 0.9 is between 80% and 100%
    assert.equal(checkRatio(0.9, "block", [80, 100]), "alert");
  });

  it("empty thresholds with ratio < 1.0 returns ok", () => {
    assert.equal(checkRatio(0.95, "block", []), "ok");
  });

  it("empty thresholds with ratio >= 1.0 returns action (block)", () => {
    assert.equal(checkRatio(1.0, "block", []), "block");
  });

  it("empty thresholds with ratio >= 1.0 returns action (throttle)", () => {
    assert.equal(checkRatio(1.5, "throttle", []), "throttle");
  });

  it("empty thresholds with ratio >= 1.0 returns action (alert)", () => {
    assert.equal(checkRatio(1.0, "alert", []), "alert");
  });

  it("ratio 0 returns ok", () => {
    assert.equal(checkRatio(0, "block", [80, 100]), "ok");
  });

  it("ratio exactly at threshold boundary (80% = 0.8)", () => {
    assert.equal(checkRatio(0.8, "alert", [80, 100]), "alert");
  });

  it("ratio just below threshold boundary (79.9%)", () => {
    assert.equal(checkRatio(0.799, "block", [80, 100]), "ok");
  });

  it("ratio over 1.0 still triggers action", () => {
    assert.equal(checkRatio(2.5, "block", [80, 100]), "block");
  });

  it("threshold at 100% is not treated as sub-1.0 alert", () => {
    // 100/100 = 1.0, the threshold 1.0 has t < 1.0 guard, so it skips
    // ratio 0.99 should be ok since sorted=[1.0, 0.8] and 1.0 is skipped (not < 1.0)
    // and 0.99 >= 0.8, so it alerts
    assert.equal(checkRatio(0.99, "block", [80, 100]), "alert");
  });

  it("single threshold at 50%", () => {
    assert.equal(checkRatio(0.5, "alert", [50]), "alert");
    assert.equal(checkRatio(0.49, "alert", [50]), "ok");
  });
});

// ── 2. worstAction ───────────────────────────────────────────────────────

const ACTION_SEVERITY: Record<BudgetAction, number> = { ok: 0, alert: 1, throttle: 2, block: 3 };

function worstAction(a: BudgetAction, b: BudgetAction): BudgetAction {
  return ACTION_SEVERITY[a] >= ACTION_SEVERITY[b] ? a : b;
}

describe("worstAction", () => {
  const actions: BudgetAction[] = ["ok", "alert", "throttle", "block"];

  it("ok vs ok = ok", () => assert.equal(worstAction("ok", "ok"), "ok"));
  it("ok vs alert = alert", () => assert.equal(worstAction("ok", "alert"), "alert"));
  it("ok vs throttle = throttle", () => assert.equal(worstAction("ok", "throttle"), "throttle"));
  it("ok vs block = block", () => assert.equal(worstAction("ok", "block"), "block"));
  it("alert vs ok = alert", () => assert.equal(worstAction("alert", "ok"), "alert"));
  it("alert vs alert = alert", () => assert.equal(worstAction("alert", "alert"), "alert"));
  it("alert vs throttle = throttle", () => assert.equal(worstAction("alert", "throttle"), "throttle"));
  it("alert vs block = block", () => assert.equal(worstAction("alert", "block"), "block"));
  it("throttle vs ok = throttle", () => assert.equal(worstAction("throttle", "ok"), "throttle"));
  it("throttle vs alert = throttle", () => assert.equal(worstAction("throttle", "alert"), "throttle"));
  it("throttle vs throttle = throttle", () => assert.equal(worstAction("throttle", "throttle"), "throttle"));
  it("throttle vs block = block", () => assert.equal(worstAction("throttle", "block"), "block"));
  it("block vs ok = block", () => assert.equal(worstAction("block", "ok"), "block"));
  it("block vs alert = block", () => assert.equal(worstAction("block", "alert"), "block"));
  it("block vs throttle = block", () => assert.equal(worstAction("block", "throttle"), "block"));
  it("block vs block = block", () => assert.equal(worstAction("block", "block"), "block"));

  it("is commutative for severity (higher always wins)", () => {
    for (const a of actions) {
      for (const b of actions) {
        const ab = worstAction(a, b);
        const ba = worstAction(b, a);
        // Both should return the same severity level
        assert.equal(ACTION_SEVERITY[ab], ACTION_SEVERITY[ba],
          `worstAction(${a},${b}) severity should equal worstAction(${b},${a}) severity`);
      }
    }
  });
});

// ── 3. getThrottledModel ─────────────────────────────────────────────────

const MODEL_ID_MAP: Record<string, { model: string; provider: string }> = {
  opus: { model: "claude-opus-4-6", provider: "anthropic" },
  sonnet: { model: "claude-sonnet-4-5-20250514", provider: "anthropic" },
  haiku: { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
};

const DEFAULT_THROTTLE_CHAIN = ["opus", "sonnet", "haiku"];

function getThrottledModel(
  currentModel: string,
  chain: string[] = DEFAULT_THROTTLE_CHAIN,
): { model: string; provider: string } | null {
  const lower = currentModel.toLowerCase();

  let currentIdx = -1;
  for (let i = 0; i < chain.length; i++) {
    if (lower.includes(chain[i].toLowerCase())) {
      currentIdx = i;
      break;
    }
  }

  if (currentIdx < 0 || currentIdx >= chain.length - 1) return null;

  const nextKey = chain[currentIdx + 1];
  return MODEL_ID_MAP[nextKey.toLowerCase()] ?? null;
}

describe("getThrottledModel", () => {
  it("opus throttles to sonnet", () => {
    const result = getThrottledModel("claude-opus-4-6");
    assert.deepEqual(result, { model: "claude-sonnet-4-5-20250514", provider: "anthropic" });
  });

  it("sonnet throttles to haiku", () => {
    const result = getThrottledModel("claude-sonnet-4-5-20250514");
    assert.deepEqual(result, { model: "claude-haiku-4-5-20251001", provider: "anthropic" });
  });

  it("haiku returns null (already cheapest)", () => {
    assert.equal(getThrottledModel("claude-haiku-4-5-20251001"), null);
  });

  it("unknown model returns null", () => {
    assert.equal(getThrottledModel("gpt-4o"), null);
  });

  it("partial match with provider prefix: anthropic/claude-opus-4-6 throttles to sonnet", () => {
    const result = getThrottledModel("anthropic/claude-opus-4-6");
    assert.deepEqual(result, { model: "claude-sonnet-4-5-20250514", provider: "anthropic" });
  });

  it("case insensitive: Claude-OPUS-4-6 throttles to sonnet", () => {
    const result = getThrottledModel("Claude-OPUS-4-6");
    assert.deepEqual(result, { model: "claude-sonnet-4-5-20250514", provider: "anthropic" });
  });

  it("empty string returns null", () => {
    assert.equal(getThrottledModel(""), null);
  });

  it("empty chain returns null", () => {
    assert.equal(getThrottledModel("claude-opus-4-6", []), null);
  });

  it("single-entry chain returns null (already cheapest)", () => {
    assert.equal(getThrottledModel("claude-opus-4-6", ["opus"]), null);
  });
});

// ── 4. getCheapestModel ──────────────────────────────────────────────────

function getCheapestModel(
  chain: string[] = DEFAULT_THROTTLE_CHAIN,
): { model: string; provider: string } | null {
  if (chain.length === 0) return null;
  const cheapestKey = chain[chain.length - 1];
  return MODEL_ID_MAP[cheapestKey.toLowerCase()] ?? null;
}

describe("getCheapestModel", () => {
  it("returns haiku for default chain", () => {
    assert.deepEqual(getCheapestModel(), { model: "claude-haiku-4-5-20251001", provider: "anthropic" });
  });

  it("empty chain returns null", () => {
    assert.equal(getCheapestModel([]), null);
  });

  it("single-entry chain returns that entry", () => {
    assert.deepEqual(getCheapestModel(["sonnet"]), { model: "claude-sonnet-4-5-20250514", provider: "anthropic" });
  });

  it("unknown key at end of chain returns null", () => {
    assert.equal(getCheapestModel(["opus", "sonnet", "unknown"]), null);
  });
});

// ── 5. getNextResetTime ──────────────────────────────────────────────────

function getNextResetTime(period: "daily" | "weekly" | "monthly"): string {
  const now = new Date();

  if (period === "daily") {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
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

describe("getNextResetTime", () => {
  it("daily returns a time in the future", () => {
    const result = new Date(getNextResetTime("daily"));
    assert.ok(result.getTime() > Date.now(), "daily reset should be in the future");
  });

  it("daily returns local midnight (hours/minutes/seconds all zero)", () => {
    const result = new Date(getNextResetTime("daily"));
    // The ISO string encodes local midnight as UTC offset, but we can verify
    // by constructing the expected value the same way the function does
    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    expected.setHours(0, 0, 0, 0);
    assert.equal(result.getTime(), expected.getTime());
  });

  it("weekly returns a Monday (day of week = 1)", () => {
    const result = new Date(getNextResetTime("weekly"));
    assert.equal(result.getDay(), 1, "weekly reset should be Monday");
  });

  it("weekly returns a future date", () => {
    const result = new Date(getNextResetTime("weekly"));
    assert.ok(result.getTime() > Date.now(), "weekly reset should be in the future");
  });

  it("weekly returns midnight", () => {
    const result = new Date(getNextResetTime("weekly"));
    assert.equal(result.getHours(), 0);
    assert.equal(result.getMinutes(), 0);
    assert.equal(result.getSeconds(), 0);
    assert.equal(result.getMilliseconds(), 0);
  });

  it("monthly returns the 1st of next month", () => {
    const result = new Date(getNextResetTime("monthly"));
    assert.equal(result.getDate(), 1, "monthly reset should be 1st");
  });

  it("monthly returns a future date", () => {
    const result = new Date(getNextResetTime("monthly"));
    assert.ok(result.getTime() > Date.now(), "monthly reset should be in the future");
  });

  it("monthly returns midnight", () => {
    const result = new Date(getNextResetTime("monthly"));
    assert.equal(result.getHours(), 0);
    assert.equal(result.getMinutes(), 0);
    assert.equal(result.getSeconds(), 0);
    assert.equal(result.getMilliseconds(), 0);
  });

  it("all periods return valid ISO strings", () => {
    for (const period of ["daily", "weekly", "monthly"] as const) {
      const result = getNextResetTime(period);
      assert.ok(!isNaN(new Date(result).getTime()), `${period} should produce valid ISO string`);
    }
  });
});

// ── 6. shouldAutoRecover ─────────────────────────────────────────────────

function shouldAutoRecover(
  agentBudget: AgentBudgetSlice | undefined,
  defaultMode: AutoRecoveryDefault,
): boolean {
  if (agentBudget?.autoRecovery !== undefined) return agentBudget.autoRecovery;
  if (defaultMode === "all") return true;
  if (defaultMode === "none") return false;
  // "throttle-only": auto-recover if agent action is throttle
  return agentBudget?.action === "throttle";
}

describe("shouldAutoRecover", () => {
  it("explicit true overrides everything", () => {
    assert.equal(shouldAutoRecover({ autoRecovery: true, action: "block" }, "none"), true);
  });

  it("explicit false overrides everything", () => {
    assert.equal(shouldAutoRecover({ autoRecovery: false, action: "throttle" }, "all"), false);
  });

  it("default all returns true (no explicit setting)", () => {
    assert.equal(shouldAutoRecover({ action: "block" }, "all"), true);
  });

  it("default none returns false (no explicit setting)", () => {
    assert.equal(shouldAutoRecover({ action: "throttle" }, "none"), false);
  });

  it("default throttle-only with action throttle returns true", () => {
    assert.equal(shouldAutoRecover({ action: "throttle" }, "throttle-only"), true);
  });

  it("default throttle-only with action block returns false", () => {
    assert.equal(shouldAutoRecover({ action: "block" }, "throttle-only"), false);
  });

  it("default throttle-only with action alert returns false", () => {
    assert.equal(shouldAutoRecover({ action: "alert" }, "throttle-only"), false);
  });

  it("no agent budget with throttle-only returns false", () => {
    assert.equal(shouldAutoRecover(undefined, "throttle-only"), false);
  });

  it("no agent budget with all returns true", () => {
    assert.equal(shouldAutoRecover(undefined, "all"), true);
  });

  it("no agent budget with none returns false", () => {
    assert.equal(shouldAutoRecover(undefined, "none"), false);
  });
});

// ── 7. fixedWindowStart (edge cases) ─────────────────────────────────────

function fixedWindowStart(durationSec: number, now: Date): number {
  if (durationSec <= 86400) {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return start.getTime();
  }
  // Weekly: Sunday midnight UTC
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

describe("fixedWindowStart (edge cases)", () => {
  it("1-hour window still returns midnight UTC", () => {
    const now = new Date("2026-02-26T14:30:00Z");
    const start = fixedWindowStart(3600, now);
    assert.equal(new Date(start).toISOString(), "2026-02-26T00:00:00.000Z");
  });

  it("exactly 86400s (1 day) returns midnight UTC", () => {
    const now = new Date("2026-02-26T23:59:59Z");
    const start = fixedWindowStart(86400, now);
    assert.equal(new Date(start).toISOString(), "2026-02-26T00:00:00.000Z");
  });

  it("86401s triggers weekly logic (Sunday)", () => {
    // Thursday Feb 26 2026 -- Sunday before is Feb 22
    const now = new Date("2026-02-26T12:00:00Z");
    const start = fixedWindowStart(86401, now);
    assert.equal(new Date(start).toISOString(), "2026-02-22T00:00:00.000Z");
  });

  it("Saturday returns previous Sunday for weekly", () => {
    // Saturday Feb 28 2026 -- Sunday before is Feb 22
    const now = new Date("2026-02-28T12:00:00Z");
    const start = fixedWindowStart(604800, now);
    assert.equal(new Date(start).toISOString(), "2026-02-22T00:00:00.000Z");
  });

  it("Sunday returns that Sunday for weekly", () => {
    const now = new Date("2026-02-22T10:00:00Z"); // Sunday
    const start = fixedWindowStart(604800, now);
    assert.equal(new Date(start).toISOString(), "2026-02-22T00:00:00.000Z");
  });

  it("midnight UTC exactly returns same day", () => {
    const now = new Date("2026-02-26T00:00:00.000Z");
    const start = fixedWindowStart(86400, now);
    assert.equal(new Date(start).toISOString(), "2026-02-26T00:00:00.000Z");
  });
});

// ── 8. formatWindowLabel (additional edge cases) ─────────────────────────

function formatWindowLabel(w: { duration: number; rolling: boolean; shared: boolean; model?: string }): string {
  const dur = w.duration;
  const durStr = dur < 3600 ? `${Math.round(dur / 60)}m`
    : dur < 86400 ? `${Math.round(dur / 3600)}h`
    : dur < 604800 ? `${Math.round(dur / 86400)}d`
    : "weekly";
  const type = w.rolling ? "rolling" : "fixed";
  const suffix = !w.shared && w.model ? ` (${w.model})` : "";
  return `${durStr} ${type}${suffix}`;
}

describe("formatWindowLabel (edge cases)", () => {
  it("60 seconds = 1m", () => {
    assert.equal(formatWindowLabel({ duration: 60, rolling: true, shared: true }), "1m rolling");
  });

  it("3599 seconds rounds to 60m", () => {
    assert.equal(formatWindowLabel({ duration: 3599, rolling: false, shared: true }), "60m fixed");
  });

  it("3600 seconds = 1h", () => {
    assert.equal(formatWindowLabel({ duration: 3600, rolling: true, shared: true }), "1h rolling");
  });

  it("86399 seconds rounds to 24h", () => {
    assert.equal(formatWindowLabel({ duration: 86399, rolling: true, shared: true }), "24h rolling");
  });

  it("86400 seconds = 1d", () => {
    assert.equal(formatWindowLabel({ duration: 86400, rolling: false, shared: true }), "1d fixed");
  });

  it("shared window with model does NOT show model suffix", () => {
    assert.equal(
      formatWindowLabel({ duration: 18000, rolling: true, shared: true, model: "opus" }),
      "5h rolling",
    );
  });

  it("non-shared window without model shows no suffix", () => {
    assert.equal(
      formatWindowLabel({ duration: 18000, rolling: true, shared: false }),
      "5h rolling",
    );
  });

  it("non-shared window with model shows suffix", () => {
    assert.equal(
      formatWindowLabel({ duration: 18000, rolling: true, shared: false, model: "gpt-5" }),
      "5h rolling (gpt-5)",
    );
  });

  it("exactly 604800 seconds = weekly", () => {
    assert.equal(formatWindowLabel({ duration: 604800, rolling: false, shared: true }), "weekly fixed");
  });

  it("over 604800 seconds still shows weekly", () => {
    assert.equal(formatWindowLabel({ duration: 1_000_000, rolling: false, shared: true }), "weekly fixed");
  });
});
