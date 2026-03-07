/**
 * Unit tests for global costView logic.
 *
 * Tests resolvePeriodCost (used by checkBudget for period-based limits)
 * and resolveCostForAlert (used by session alerts and session cost cap).
 *
 * Run: npx tsx --test __tests__/cost-view.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Types (mirrored from budget.ts) ─────────────────────────────────────

type CostAlertView = "actual" | "api-equiv" | "total";

// ── resolvePeriodCost (used by checkBudget for daily/weekly/monthly) ────

function resolvePeriodCost(
  costView: CostAlertView, actual: number, apiEquiv: number | undefined, billing: string,
): number {
  switch (costView) {
    case "actual": return billing === "subscription" ? 0 : actual;
    case "api-equiv": return apiEquiv ?? actual;
    case "total":
    default: return billing === "subscription" ? (apiEquiv ?? 0) : actual;
  }
}

describe("resolvePeriodCost", () => {
  describe("costView = actual", () => {
    it("metered billing returns actual cost", () => {
      assert.equal(resolvePeriodCost("actual", 5.00, 5.00, "metered"), 5.00);
    });

    it("subscription billing returns 0 (no real spend)", () => {
      assert.equal(resolvePeriodCost("actual", 0, 12.50, "subscription"), 0);
    });

    it("subscription with non-zero actual still returns 0", () => {
      // Edge case: shouldn't happen in practice, but guard against it
      assert.equal(resolvePeriodCost("actual", 3.00, 12.50, "subscription"), 0);
    });
  });

  describe("costView = api-equiv", () => {
    it("metered billing returns apiEquiv", () => {
      assert.equal(resolvePeriodCost("api-equiv", 5.00, 8.00, "metered"), 8.00);
    });

    it("subscription billing returns apiEquiv", () => {
      assert.equal(resolvePeriodCost("api-equiv", 0, 12.50, "subscription"), 12.50);
    });

    it("undefined apiEquiv falls back to actual", () => {
      assert.equal(resolvePeriodCost("api-equiv", 5.00, undefined, "metered"), 5.00);
    });
  });

  describe("costView = total (default)", () => {
    it("metered billing returns actual cost", () => {
      assert.equal(resolvePeriodCost("total", 5.00, 8.00, "metered"), 5.00);
    });

    it("subscription billing returns apiEquiv", () => {
      assert.equal(resolvePeriodCost("total", 0, 12.50, "subscription"), 12.50);
    });

    it("subscription with undefined apiEquiv returns 0", () => {
      assert.equal(resolvePeriodCost("total", 0, undefined, "subscription"), 0);
    });
  });

  describe("edge cases", () => {
    it("zero costs return 0 for all modes", () => {
      assert.equal(resolvePeriodCost("actual", 0, 0, "metered"), 0);
      assert.equal(resolvePeriodCost("api-equiv", 0, 0, "metered"), 0);
      assert.equal(resolvePeriodCost("total", 0, 0, "metered"), 0);
    });

    it("unknown billing treated as metered (actual mode)", () => {
      assert.equal(resolvePeriodCost("actual", 5.00, 8.00, "unknown"), 5.00);
    });

    it("unknown billing treated as metered (total mode)", () => {
      assert.equal(resolvePeriodCost("total", 5.00, 8.00, "unknown"), 5.00);
    });
  });
});

// ── resolveCostForAlert (used by session alerts + session cost cap) ─────

function resolveCostForAlert(
  costView: CostAlertView, actualCost: number, apiEquivCost: number, billing: string,
): number | null {
  switch (costView) {
    case "actual":
      return billing === "subscription" ? null : actualCost;
    case "api-equiv":
      return apiEquivCost;
    case "total":
    default:
      return billing === "subscription" ? apiEquivCost : actualCost;
  }
}

describe("resolveCostForAlert", () => {
  describe("costView = actual", () => {
    it("metered billing returns actual cost", () => {
      assert.equal(resolveCostForAlert("actual", 0.50, 0.50, "metered"), 0.50);
    });

    it("subscription billing returns null (skip alert)", () => {
      assert.equal(resolveCostForAlert("actual", 0, 0.50, "subscription"), null);
    });
  });

  describe("costView = api-equiv", () => {
    it("metered billing returns apiEquiv cost", () => {
      assert.equal(resolveCostForAlert("api-equiv", 0.50, 0.80, "metered"), 0.80);
    });

    it("subscription billing returns apiEquiv cost (tracks subscription usage)", () => {
      assert.equal(resolveCostForAlert("api-equiv", 0, 0.80, "subscription"), 0.80);
    });
  });

  describe("costView = total (default)", () => {
    it("metered billing returns actual cost", () => {
      assert.equal(resolveCostForAlert("total", 0.50, 0.80, "metered"), 0.50);
    });

    it("subscription billing returns apiEquiv cost", () => {
      assert.equal(resolveCostForAlert("total", 0, 0.80, "subscription"), 0.80);
    });
  });

  describe("edge cases", () => {
    it("zero apiEquiv still returned for subscription+api-equiv", () => {
      assert.equal(resolveCostForAlert("api-equiv", 0, 0, "subscription"), 0);
    });

    it("high actual cost for metered+actual", () => {
      assert.equal(resolveCostForAlert("actual", 100.00, 150.00, "metered"), 100.00);
    });
  });
});

// ── Integration: costView drives budget check behavior ─────────────────

describe("costView budget integration", () => {
  // Simulates how checkBudget uses resolvePeriodCost to compute ratio
  function checkBudgetRatio(
    costView: CostAlertView, actual: number, apiEquiv: number | undefined,
    billing: string, limit: number,
  ): number {
    const cost = resolvePeriodCost(costView, actual, apiEquiv, billing);
    return limit > 0 ? cost / limit : 0;
  }

  it("subscription user with actual-only costView never hits budget", () => {
    const ratio = checkBudgetRatio("actual", 0, 25.00, "subscription", 50);
    assert.equal(ratio, 0); // 0/50 = 0%
  });

  it("subscription user with api-equiv costView hits budget at 50%", () => {
    const ratio = checkBudgetRatio("api-equiv", 0, 25.00, "subscription", 50);
    assert.equal(ratio, 0.5); // 25/50 = 50%
  });

  it("subscription user with total costView uses apiEquiv", () => {
    const ratio = checkBudgetRatio("total", 0, 25.00, "subscription", 50);
    assert.equal(ratio, 0.5); // 25/50 = 50%
  });

  it("metered user with total costView uses actual", () => {
    const ratio = checkBudgetRatio("total", 30.00, 30.00, "metered", 50);
    assert.equal(ratio, 0.6); // 30/50 = 60%
  });

  it("metered user exceeds budget when actual > limit", () => {
    const ratio = checkBudgetRatio("actual", 60.00, 60.00, "metered", 50);
    assert.ok(ratio >= 1.0); // 60/50 = 120%
  });

  // Simulates how session cost cap uses resolveCostForAlert
  function sessionCostCapTriggered(
    costView: CostAlertView, providerCost: number, apiEquivCost: number,
    billing: string, cap: number,
  ): boolean {
    const resolved = resolveCostForAlert(costView, providerCost, apiEquivCost, billing);
    if (resolved === null) return false;
    return resolved >= cap;
  }

  it("session cost cap: subscription skipped with actual costView", () => {
    assert.equal(sessionCostCapTriggered("actual", 0, 10.00, "subscription", 5), false);
  });

  it("session cost cap: subscription triggers with api-equiv costView", () => {
    assert.equal(sessionCostCapTriggered("api-equiv", 0, 10.00, "subscription", 5), true);
  });

  it("session cost cap: metered triggers when actual exceeds cap", () => {
    assert.equal(sessionCostCapTriggered("actual", 6.00, 6.00, "metered", 5), true);
  });

  it("session cost cap: metered below cap does not trigger", () => {
    assert.equal(sessionCostCapTriggered("actual", 3.00, 3.00, "metered", 5), false);
  });
});

// ── Global aggregation with costView ────────────────────────────────────

describe("global budget aggregation with costView", () => {
  interface AgentCost {
    actual: number;
    apiEquiv: number | undefined;
    billing: string;
  }

  function aggregateGlobalCost(costView: CostAlertView, agents: AgentCost[]): number {
    return agents.reduce((sum, c) => sum + resolvePeriodCost(costView, c.actual, c.apiEquiv, c.billing), 0);
  }

  const mixedAgents: AgentCost[] = [
    { actual: 10.00, apiEquiv: 10.00, billing: "metered" },   // API key user
    { actual: 0, apiEquiv: 15.00, billing: "subscription" },  // subscription user
    { actual: 5.00, apiEquiv: 5.00, billing: "metered" },     // API key user
  ];

  it("actual mode: only counts metered agents ($15)", () => {
    assert.equal(aggregateGlobalCost("actual", mixedAgents), 15.00);
  });

  it("api-equiv mode: counts all agents ($30)", () => {
    assert.equal(aggregateGlobalCost("api-equiv", mixedAgents), 30.00);
  });

  it("total mode: metered actual + subscription apiEquiv ($30)", () => {
    assert.equal(aggregateGlobalCost("total", mixedAgents), 30.00);
  });

  it("empty agent list returns 0 for all modes", () => {
    assert.equal(aggregateGlobalCost("actual", []), 0);
    assert.equal(aggregateGlobalCost("api-equiv", []), 0);
    assert.equal(aggregateGlobalCost("total", []), 0);
  });

  it("all subscription agents with actual mode = $0", () => {
    const allSub: AgentCost[] = [
      { actual: 0, apiEquiv: 20.00, billing: "subscription" },
      { actual: 0, apiEquiv: 30.00, billing: "subscription" },
    ];
    assert.equal(aggregateGlobalCost("actual", allSub), 0);
  });

  it("all subscription agents with api-equiv mode = full cost", () => {
    const allSub: AgentCost[] = [
      { actual: 0, apiEquiv: 20.00, billing: "subscription" },
      { actual: 0, apiEquiv: 30.00, billing: "subscription" },
    ];
    assert.equal(aggregateGlobalCost("api-equiv", allSub), 50.00);
  });
});
