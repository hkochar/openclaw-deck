/**
 * Unit tests for provider rate limit logic.
 *
 * Tests provider limit config validation, weighted usage calculation,
 * window start computation, and threshold checking.
 * Run: npx tsx --test __tests__/provider-limits.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Provider limit config validation ────────────────────────────────────

interface ProviderLimitWindow {
  id: string;
  duration: number;
  rolling: boolean;
  shared: boolean;
  weights?: Record<string, number>;
  model?: string;
  limit: number;
}

interface ProviderLimits {
  windows: ProviderLimitWindow[];
}

function validateProviderLimits(config: Record<string, ProviderLimits>): string[] {
  const errors: string[] = [];
  for (const [provider, limits] of Object.entries(config)) {
    if (!limits.windows || !Array.isArray(limits.windows)) {
      errors.push(`Provider "${provider}": windows must be an array`);
      continue;
    }
    const ids = new Set<string>();
    for (const w of limits.windows) {
      if (!w.id || typeof w.id !== "string") {
        errors.push(`Provider "${provider}": window ID is required`);
      }
      if (ids.has(w.id)) {
        errors.push(`Provider "${provider}": duplicate window ID "${w.id}"`);
      }
      ids.add(w.id);
      if (typeof w.duration !== "number" || w.duration <= 0) {
        errors.push(`Provider "${provider}" window "${w.id}": duration must be positive`);
      }
      if (typeof w.limit !== "number" || w.limit <= 0) {
        errors.push(`Provider "${provider}" window "${w.id}": limit must be positive`);
      }
      if (w.shared && (!w.weights || Object.keys(w.weights).length === 0)) {
        errors.push(`Provider "${provider}" window "${w.id}": shared pool requires weights`);
      }
      if (!w.shared && !w.model) {
        errors.push(`Provider "${provider}" window "${w.id}": per-model window requires model substring`);
      }
      if (w.weights) {
        for (const [model, weight] of Object.entries(w.weights)) {
          if (typeof weight !== "number" || weight < 0) {
            errors.push(`Provider "${provider}" window "${w.id}" weight "${model}": must be non-negative`);
          }
        }
      }
    }
  }
  return errors;
}

describe("validateProviderLimits", () => {
  it("empty config is valid", () => {
    assert.deepEqual(validateProviderLimits({}), []);
  });

  it("valid anthropic config passes", () => {
    const config = {
      anthropic: {
        windows: [
          { id: "5h-rolling", duration: 18000, rolling: true, shared: true, weights: { opus: 1.0, sonnet: 0.5, haiku: 0.25 }, limit: 45 },
          { id: "weekly", duration: 604800, rolling: false, shared: true, weights: { opus: 1.0, sonnet: 0.5, haiku: 0.25 }, limit: 225 },
        ],
      },
    };
    assert.deepEqual(validateProviderLimits(config), []);
  });

  it("valid openai per-model config passes", () => {
    const config = {
      openai: {
        windows: [
          { id: "gpt5-weekly", duration: 604800, rolling: false, shared: false, model: "gpt-5", limit: 3000 },
          { id: "o3-weekly", duration: 604800, rolling: false, shared: false, model: "o3", limit: 100 },
        ],
      },
    };
    assert.deepEqual(validateProviderLimits(config), []);
  });

  it("zero duration fails", () => {
    const errors = validateProviderLimits({
      test: { windows: [{ id: "bad", duration: 0, rolling: true, shared: true, weights: { x: 1 }, limit: 10 }] },
    });
    assert.ok(errors.some((e) => e.includes("duration must be positive")));
  });

  it("negative limit fails", () => {
    const errors = validateProviderLimits({
      test: { windows: [{ id: "bad", duration: 3600, rolling: true, shared: true, weights: { x: 1 }, limit: -5 }] },
    });
    assert.ok(errors.some((e) => e.includes("limit must be positive")));
  });

  it("shared pool without weights fails", () => {
    const errors = validateProviderLimits({
      test: { windows: [{ id: "bad", duration: 3600, rolling: true, shared: true, limit: 10 }] },
    });
    assert.ok(errors.some((e) => e.includes("shared pool requires weights")));
  });

  it("per-model window without model fails", () => {
    const errors = validateProviderLimits({
      test: { windows: [{ id: "bad", duration: 3600, rolling: false, shared: false, limit: 100 }] },
    });
    assert.ok(errors.some((e) => e.includes("per-model window requires model")));
  });

  it("duplicate window IDs fail", () => {
    const errors = validateProviderLimits({
      test: {
        windows: [
          { id: "same", duration: 3600, rolling: true, shared: true, weights: { x: 1 }, limit: 10 },
          { id: "same", duration: 7200, rolling: true, shared: true, weights: { x: 1 }, limit: 20 },
        ],
      },
    });
    assert.ok(errors.some((e) => e.includes("duplicate window ID")));
  });

  it("negative weight fails", () => {
    const errors = validateProviderLimits({
      test: { windows: [{ id: "bad", duration: 3600, rolling: true, shared: true, weights: { opus: -1 }, limit: 10 }] },
    });
    assert.ok(errors.some((e) => e.includes("must be non-negative")));
  });

  it("multiple providers validated independently", () => {
    const config = {
      anthropic: { windows: [{ id: "5h", duration: 18000, rolling: true, shared: true, weights: { opus: 1 }, limit: 45 }] },
      openai: { windows: [{ id: "weekly", duration: 604800, rolling: false, shared: false, model: "gpt-5", limit: 3000 }] },
    };
    assert.deepEqual(validateProviderLimits(config), []);
  });
});

// ── Weighted usage calculation ──────────────────────────────────────────

interface UsageEvent {
  model: string;
  ts: number;
}

function calculateWeightedUsage(events: UsageEvent[], weights: Record<string, number>): number {
  const weightKeys = Object.entries(weights).sort((a, b) => b[0].length - a[0].length);
  let total = 0;
  for (const ev of events) {
    const lower = ev.model.toLowerCase();
    let weight = 1.0; // default if no match
    for (const [substr, w] of weightKeys) {
      if (lower.includes(substr.toLowerCase())) {
        weight = w;
        break;
      }
    }
    total += weight;
  }
  return total;
}

describe("calculateWeightedUsage", () => {
  const weights = { opus: 1.0, sonnet: 0.5, haiku: 0.25 };

  it("single opus message = 1.0", () => {
    const events = [{ model: "anthropic/claude-opus-4-6", ts: 1 }];
    assert.equal(calculateWeightedUsage(events, weights), 1.0);
  });

  it("single sonnet message = 0.5", () => {
    const events = [{ model: "anthropic/claude-sonnet-4-5", ts: 1 }];
    assert.equal(calculateWeightedUsage(events, weights), 0.5);
  });

  it("single haiku message = 0.25", () => {
    const events = [{ model: "anthropic/claude-haiku-4-5", ts: 1 }];
    assert.equal(calculateWeightedUsage(events, weights), 0.25);
  });

  it("mixed messages sum correctly", () => {
    const events = [
      { model: "anthropic/claude-opus-4-6", ts: 1 },     // 1.0
      { model: "anthropic/claude-sonnet-4-5", ts: 2 },   // 0.5
      { model: "anthropic/claude-sonnet-4-5", ts: 3 },   // 0.5
      { model: "anthropic/claude-haiku-4-5", ts: 4 },    // 0.25
    ];
    assert.equal(calculateWeightedUsage(events, weights), 2.25);
  });

  it("unknown model defaults to weight 1.0", () => {
    const events = [{ model: "anthropic/claude-unknown-9", ts: 1 }];
    assert.equal(calculateWeightedUsage(events, weights), 1.0);
  });

  it("empty events = 0", () => {
    assert.equal(calculateWeightedUsage([], weights), 0);
  });

  it("empty weights → all events weight 1.0", () => {
    const events = [
      { model: "anthropic/claude-opus-4-6", ts: 1 },
      { model: "anthropic/claude-sonnet-4-5", ts: 2 },
    ];
    assert.equal(calculateWeightedUsage(events, {}), 2.0);
  });

  it("case insensitive matching", () => {
    const events = [{ model: "anthropic/claude-OPUS-4-6", ts: 1 }];
    assert.equal(calculateWeightedUsage(events, weights), 1.0);
  });

  it("longest substring wins when ambiguous", () => {
    // "sonnet" should match "sonnet" not "son"
    const customWeights = { son: 0.1, sonnet: 0.5 };
    const events = [{ model: "anthropic/claude-sonnet-4-5", ts: 1 }];
    assert.equal(calculateWeightedUsage(events, customWeights), 0.5);
  });
});

// ── Per-model usage counting ─────────────────────────────────────────────

function countModelUsage(events: UsageEvent[], modelSubstring: string): number {
  const lower = modelSubstring.toLowerCase();
  return events.filter((ev) => ev.model.toLowerCase().includes(lower)).length;
}

describe("countModelUsage", () => {
  const events = [
    { model: "openai/gpt-5", ts: 1 },
    { model: "openai/gpt-5", ts: 2 },
    { model: "openai/o3", ts: 3 },
    { model: "openai/o4-mini", ts: 4 },
    { model: "openai/o4-mini", ts: 5 },
    { model: "openai/o4-mini", ts: 6 },
  ];

  it("counts gpt-5 messages correctly", () => {
    assert.equal(countModelUsage(events, "gpt-5"), 2);
  });

  it("counts o3 messages correctly", () => {
    assert.equal(countModelUsage(events, "o3"), 1);
  });

  it("counts o4-mini messages correctly", () => {
    assert.equal(countModelUsage(events, "o4-mini"), 3);
  });

  it("no match returns 0", () => {
    assert.equal(countModelUsage(events, "gemini"), 0);
  });

  it("empty events returns 0", () => {
    assert.equal(countModelUsage([], "gpt-5"), 0);
  });

  it("case insensitive", () => {
    assert.equal(countModelUsage(events, "GPT-5"), 2);
  });
});

// ── Fixed window start computation ───────────────────────────────────────

function fixedWindowStart(durationSec: number, now: Date): number {
  if (durationSec <= 86400) {
    // Daily or shorter: midnight UTC
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

describe("fixedWindowStart", () => {
  it("daily window starts at midnight UTC", () => {
    // Wednesday Feb 19 2025 15:30 UTC
    const now = new Date("2025-02-19T15:30:00Z");
    const start = fixedWindowStart(86400, now);
    assert.equal(new Date(start).toISOString(), "2025-02-19T00:00:00.000Z");
  });

  it("weekly window starts at Sunday midnight UTC", () => {
    // Wednesday Feb 19 2025
    const now = new Date("2025-02-19T15:30:00Z");
    const start = fixedWindowStart(604800, now);
    assert.equal(new Date(start).toISOString(), "2025-02-16T00:00:00.000Z"); // Sunday
  });

  it("weekly window on Sunday itself returns that Sunday", () => {
    const now = new Date("2025-02-16T10:00:00Z"); // Sunday
    const start = fixedWindowStart(604800, now);
    assert.equal(new Date(start).toISOString(), "2025-02-16T00:00:00.000Z");
  });

  it("daily window at exactly midnight returns same day", () => {
    const now = new Date("2025-02-19T00:00:00Z");
    const start = fixedWindowStart(86400, now);
    assert.equal(new Date(start).toISOString(), "2025-02-19T00:00:00.000Z");
  });

  it("sub-daily durations still use midnight UTC", () => {
    const now = new Date("2025-02-19T15:30:00Z");
    const start = fixedWindowStart(3600, now); // 1 hour
    assert.equal(new Date(start).toISOString(), "2025-02-19T00:00:00.000Z");
  });
});

// ── Threshold checking ───────────────────────────────────────────────────

type LimitAction = "ok" | "alert";

function checkThreshold(used: number, limit: number, thresholds: number[]): LimitAction {
  if (limit <= 0) return "ok";
  const pct = (used / limit) * 100;
  const sorted = [...thresholds].sort((a, b) => b - a);
  for (const t of sorted) {
    if (pct >= t) return "alert";
  }
  return "ok";
}

describe("checkThreshold", () => {
  it("below all thresholds → ok", () => {
    assert.equal(checkThreshold(10, 100, [50, 80, 100]), "ok");
  });

  it("at 50% with [50, 80, 100] → alert", () => {
    assert.equal(checkThreshold(50, 100, [50, 80, 100]), "alert");
  });

  it("at 80% with [80, 100] → alert", () => {
    assert.equal(checkThreshold(80, 100, [80, 100]), "alert");
  });

  it("at 100% → alert", () => {
    assert.equal(checkThreshold(100, 100, [80, 100]), "alert");
  });

  it("over 100% → alert", () => {
    assert.equal(checkThreshold(150, 100, [80, 100]), "alert");
  });

  it("zero limit → ok (no division by zero)", () => {
    assert.equal(checkThreshold(50, 0, [80, 100]), "ok");
  });

  it("empty thresholds → ok", () => {
    assert.equal(checkThreshold(100, 100, []), "ok");
  });

  it("at 79% with [80, 100] → ok", () => {
    assert.equal(checkThreshold(79, 100, [80, 100]), "ok");
  });
});

// ── Window label formatting ──────────────────────────────────────────────

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

describe("formatWindowLabel", () => {
  it("5h rolling shared", () => {
    assert.equal(formatWindowLabel({ duration: 18000, rolling: true, shared: true }), "5h rolling");
  });

  it("weekly fixed shared", () => {
    assert.equal(formatWindowLabel({ duration: 604800, rolling: false, shared: true }), "weekly fixed");
  });

  it("daily fixed per-model", () => {
    assert.equal(formatWindowLabel({ duration: 86400, rolling: false, shared: false, model: "o4-mini" }), "1d fixed (o4-mini)");
  });

  it("weekly fixed per-model", () => {
    assert.equal(formatWindowLabel({ duration: 604800, rolling: false, shared: false, model: "gpt-5" }), "weekly fixed (gpt-5)");
  });

  it("30m rolling", () => {
    assert.equal(formatWindowLabel({ duration: 1800, rolling: true, shared: true }), "30m rolling");
  });
});
