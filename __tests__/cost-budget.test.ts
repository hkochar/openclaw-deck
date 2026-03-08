/**
 * Unit tests for Cost Guardian utilities.
 *
 * Tests cost formatting, budget config validation, and pricing table logic.
 * Run: npx tsx --test __tests__/cost-budget.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Cost formatting (mirrors fmtCost from app/costs/page.tsx) ─────────────

function fmtCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

describe("fmtCost", () => {
  it("formats >= $100 with no decimals", () => {
    assert.equal(fmtCost(100), "$100");
    assert.equal(fmtCost(1234.56), "$1235");
  });

  it("formats >= $1 with 2 decimals", () => {
    assert.equal(fmtCost(1), "$1.00");
    assert.equal(fmtCost(9.131), "$9.13");
    assert.equal(fmtCost(26.9643), "$26.96");
    assert.equal(fmtCost(99.999), "$100.00");
  });

  it("formats >= $0.01 with 3 decimals", () => {
    assert.equal(fmtCost(0.01), "$0.010");
    assert.equal(fmtCost(0.123), "$0.123");
    assert.equal(fmtCost(0.9079), "$0.908");
  });

  it("formats < $0.01 with 4 decimals", () => {
    assert.equal(fmtCost(0), "$0.0000");
    assert.equal(fmtCost(0.001), "$0.0010");
    assert.equal(fmtCost(0.0029), "$0.0029");
  });
});

// ── Budget config validation ──────────────────────────────────────────────

interface BudgetConfig {
  global?: { daily?: number; weekly?: number; monthly?: number };
  agents?: Record<string, { daily?: number; weekly?: number; monthly?: number; action?: string }>;
  alertThresholds?: number[];
  alertChannel?: string;
}

function validateBudgetConfig(budgets: BudgetConfig): string[] {
  const errors: string[] = [];

  if (budgets.global) {
    for (const [k, v] of Object.entries(budgets.global)) {
      if (v !== undefined && (typeof v !== "number" || v < 0)) {
        errors.push(`Global ${k}: must be a non-negative number`);
      }
    }
  }

  if (budgets.agents) {
    for (const [agent, cfg] of Object.entries(budgets.agents)) {
      if (cfg.daily !== undefined && (typeof cfg.daily !== "number" || cfg.daily < 0)) {
        errors.push(`Agent "${agent}" daily: must be a non-negative number`);
      }
      if (cfg.action && !["alert", "throttle", "block"].includes(cfg.action)) {
        errors.push(`Agent "${agent}" action: must be alert, throttle, or block`);
      }
    }
  }

  if (budgets.alertThresholds) {
    if (!Array.isArray(budgets.alertThresholds)) {
      errors.push("alertThresholds must be an array");
    } else {
      for (const t of budgets.alertThresholds) {
        if (typeof t !== "number" || t < 0 || t > 200) {
          errors.push(`Alert threshold ${t}: must be 0-200`);
        }
      }
    }
  }

  return errors;
}

describe("validateBudgetConfig", () => {
  it("empty config is valid", () => {
    assert.deepEqual(validateBudgetConfig({}), []);
  });

  it("valid global budgets pass", () => {
    assert.deepEqual(validateBudgetConfig({ global: { daily: 100, weekly: 500, monthly: 2000 } }), []);
  });

  it("negative global budget fails", () => {
    const errors = validateBudgetConfig({ global: { daily: -10 } });
    assert.ok(errors.some((e) => e.includes("non-negative")));
  });

  it("valid agent budget with action passes", () => {
    assert.deepEqual(
      validateBudgetConfig({ agents: { jane: { daily: 50, action: "throttle" } } }),
      [],
    );
  });

  it("invalid agent action fails", () => {
    const errors = validateBudgetConfig({ agents: { jane: { action: "destroy" } } });
    assert.ok(errors.some((e) => e.includes("must be alert, throttle, or block")));
  });

  it("valid actions: alert, throttle, block", () => {
    for (const action of ["alert", "throttle", "block"]) {
      assert.deepEqual(
        validateBudgetConfig({ agents: { test: { daily: 10, action } } }),
        [],
      );
    }
  });

  it("valid alert thresholds pass", () => {
    assert.deepEqual(validateBudgetConfig({ alertThresholds: [80, 100] }), []);
  });

  it("out-of-range threshold fails", () => {
    const errors = validateBudgetConfig({ alertThresholds: [80, 300] });
    assert.ok(errors.some((e) => e.includes("must be 0-200")));
  });
});

// ── Pricing table validation ──────────────────────────────────────────────

interface PricingEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function validatePricingTable(pricing: Record<string, PricingEntry>): string[] {
  const errors: string[] = [];
  for (const [model, rates] of Object.entries(pricing)) {
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (typeof rates[field] !== "number" || rates[field] < 0) {
        errors.push(`Model "${model}" ${field}: must be a non-negative number`);
      }
    }
  }
  return errors;
}

describe("validatePricingTable", () => {
  it("valid pricing passes", () => {
    const pricing = {
      opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    };
    assert.deepEqual(validatePricingTable(pricing), []);
  });

  it("empty pricing is valid", () => {
    assert.deepEqual(validatePricingTable({}), []);
  });

  it("negative rate fails", () => {
    const errors = validatePricingTable({
      opus: { input: -5, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    });
    assert.ok(errors.some((e) => e.includes("non-negative")));
  });

  it("zero rates are valid", () => {
    assert.deepEqual(
      validatePricingTable({
        free: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      [],
    );
  });
});

// ── Throttle chain validation ─────────────────────────────────────────────

function validateThrottleChain(chain: string[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(chain) || chain.length === 0) {
    errors.push("Throttle chain must be a non-empty array");
    return errors;
  }
  const seen = new Set<string>();
  for (const model of chain) {
    if (typeof model !== "string" || !model.trim()) {
      errors.push("Throttle chain entries must be non-empty strings");
    }
    if (seen.has(model)) {
      errors.push(`Duplicate model in throttle chain: "${model}"`);
    }
    seen.add(model);
  }
  return errors;
}

describe("validateThrottleChain", () => {
  it("valid chain passes", () => {
    assert.deepEqual(validateThrottleChain(["opus", "sonnet", "haiku"]), []);
  });

  it("single-model chain is valid", () => {
    assert.deepEqual(validateThrottleChain(["haiku"]), []);
  });

  it("empty chain fails", () => {
    const errors = validateThrottleChain([]);
    assert.ok(errors.some((e) => e.includes("non-empty array")));
  });

  it("duplicate model fails", () => {
    const errors = validateThrottleChain(["opus", "sonnet", "opus"]);
    assert.ok(errors.some((e) => e.includes("Duplicate")));
  });

  it("empty string entry fails", () => {
    const errors = validateThrottleChain(["opus", "", "haiku"]);
    assert.ok(errors.some((e) => e.includes("non-empty strings")));
  });
});

// ── Budget percentage calculation ─────────────────────────────────────────

function budgetPercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min((used / limit) * 100, 100);
}

describe("budgetPercent", () => {
  it("0 used / 100 limit = 0%", () => {
    assert.equal(budgetPercent(0, 100), 0);
  });

  it("50 used / 100 limit = 50%", () => {
    assert.equal(budgetPercent(50, 100), 50);
  });

  it("100 used / 100 limit = 100%", () => {
    assert.equal(budgetPercent(100, 100), 100);
  });

  it("caps at 100% when over budget", () => {
    assert.equal(budgetPercent(150, 100), 100);
  });

  it("0 limit returns 0%", () => {
    assert.equal(budgetPercent(50, 0), 0);
  });

  it("negative limit returns 0%", () => {
    assert.equal(budgetPercent(50, -10), 0);
  });
});

// ── Billing mode resolution ─────────────────────────────────────────────

type BillingMode = "metered" | "subscription";

interface AuthProfile {
  provider: string;
  mode: string;
}

/** Mirrors getBillingMode logic from event-log.ts */
function buildBillingMap(profiles: Record<string, AuthProfile>): Record<string, BillingMode> {
  const map: Record<string, BillingMode> = {};
  for (const profile of Object.values(profiles)) {
    if (!profile.provider) continue;
    const mode: BillingMode = profile.mode === "api_key" ? "metered" : "subscription";
    // If any profile for this provider is metered, mark as metered (conservative)
    if (!map[profile.provider] || mode === "metered") {
      map[profile.provider] = mode;
    }
  }
  return map;
}

describe("buildBillingMap", () => {
  it("api_key mode → metered", () => {
    const map = buildBillingMap({
      "openrouter:default": { provider: "openrouter", mode: "api_key" },
    });
    assert.equal(map["openrouter"], "metered");
  });

  it("oauth mode → subscription", () => {
    const map = buildBillingMap({
      "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
    });
    assert.equal(map["openai-codex"], "subscription");
  });

  it("token mode → subscription", () => {
    const map = buildBillingMap({
      "anthropic:manual": { provider: "anthropic", mode: "token" },
    });
    assert.equal(map["anthropic"], "subscription");
  });

  it("mixed profiles: metered wins (conservative)", () => {
    const map = buildBillingMap({
      "anthropic:oauth": { provider: "anthropic", mode: "oauth" },
      "anthropic:api": { provider: "anthropic", mode: "api_key" },
    });
    assert.equal(map["anthropic"], "metered");
  });

  it("multiple providers resolved independently", () => {
    const map = buildBillingMap({
      "anthropic:manual": { provider: "anthropic", mode: "token" },
      "openrouter:default": { provider: "openrouter", mode: "api_key" },
      "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
    });
    assert.equal(map["anthropic"], "subscription");
    assert.equal(map["openrouter"], "metered");
    assert.equal(map["openai-codex"], "subscription");
  });

  it("empty profiles → empty map", () => {
    assert.deepEqual(buildBillingMap({}), {});
  });

  it("profile without provider is skipped", () => {
    const map = buildBillingMap({
      "broken": { provider: "", mode: "api_key" },
    });
    assert.deepEqual(map, {});
  });
});

// ── Cost calculation with billing mode ──────────────────────────────────

/** Mirrors estimateCost behavior: subscription → 0, metered → calculated */
function costForBilling(billing: BillingMode | undefined, calculatedCost: number): number {
  return billing === "subscription" ? 0 : calculatedCost;
}

describe("costForBilling", () => {
  it("subscription → $0 regardless of calculated cost", () => {
    assert.equal(costForBilling("subscription", 1.5), 0);
    assert.equal(costForBilling("subscription", 0), 0);
  });

  it("metered → uses calculated cost", () => {
    assert.equal(costForBilling("metered", 1.5), 1.5);
    assert.equal(costForBilling("metered", 0), 0);
  });

  it("undefined billing → uses calculated cost (backwards compat)", () => {
    assert.equal(costForBilling(undefined, 1.5), 1.5);
  });
});

// ── Agent cost summary billing aggregation ──────────────────────────────

function aggregateBilling(modes: Set<string>): "metered" | "subscription" | "mixed" {
  if (modes.size === 0) return "metered";
  if (modes.size === 1) return modes.has("subscription") ? "subscription" : "metered";
  return "mixed";
}

describe("aggregateBilling", () => {
  it("empty set → metered (default)", () => {
    assert.equal(aggregateBilling(new Set()), "metered");
  });

  it("only metered → metered", () => {
    assert.equal(aggregateBilling(new Set(["metered"])), "metered");
  });

  it("only subscription → subscription", () => {
    assert.equal(aggregateBilling(new Set(["subscription"])), "subscription");
  });

  it("both → mixed", () => {
    assert.equal(aggregateBilling(new Set(["metered", "subscription"])), "mixed");
  });
});
