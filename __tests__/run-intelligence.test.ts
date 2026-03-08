import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeMaxLoopDepth,
  computeMaxConsecutiveLlm,
  computeRetryCount,
  computeRunSummary,
  computeComparison,
  type EventRow,
  type SessionAggregate,
} from "@/lib/run-intelligence";

// ── Helpers ──────────────────────────────────────────────────────────

let nextId = 1;
const NOW = Date.now();
const HOUR = 3_600_000;

function makeEvent(
  type: string,
  overrides: Partial<EventRow> = {}
): EventRow {
  const id = nextId++;
  return {
    id,
    ts: NOW - HOUR + id * 1000,
    type,
    agent: "test",
    session: "test-session",
    model: "anthropic/claude-sonnet-4-20250514",
    resolved_model: null,
    cost: type === "llm_output" ? 0.01 : null,
    input_tokens: type === "llm_output" ? 1000 : null,
    output_tokens: type === "llm_output" ? 200 : null,
    cache_read: null,
    cache_write: null,
    has_thinking: null,
    has_prompt: null,
    has_response: null,
    billing: null,
    provider_cost: null,
    detail: null,
    ...overrides,
  };
}

function seq(...types: string[]): EventRow[] {
  return types.map((t) => makeEvent(t));
}

function toolWithName(name: string, error = false): EventRow {
  return makeEvent("tool_call", {
    detail: JSON.stringify({
      tool: name,
      success: error ? 0 : 1,
      ...(error ? { isError: true } : {}),
    }),
  });
}

// ── computeMaxLoopDepth — spec §3.1 worked examples ─────────────────

describe("computeMaxLoopDepth", () => {
  it("example 1: LLM, tool, LLM, tool, LLM → depth 2", () => {
    const events = seq("llm_output", "tool_call", "llm_output", "tool_call", "llm_output");
    assert.equal(computeMaxLoopDepth(events), 2);
  });

  it("example 2: LLM, LLM, tool, LLM → depth 1", () => {
    const events = seq("llm_output", "llm_output", "tool_call", "llm_output");
    assert.equal(computeMaxLoopDepth(events), 1);
  });

  it("example 3: LLM, tool, tool, LLM, tool, LLM → depth 2", () => {
    const events = seq("llm_output", "tool_call", "tool_call", "llm_output", "tool_call", "llm_output");
    assert.equal(computeMaxLoopDepth(events), 2);
  });

  it("example 4: LLM, tool, LLM, tool, LLM, tool, LLM, tool, LLM → depth 4", () => {
    const events = seq(
      "llm_output", "tool_call",
      "llm_output", "tool_call",
      "llm_output", "tool_call",
      "llm_output", "tool_call",
      "llm_output"
    );
    assert.equal(computeMaxLoopDepth(events), 4);
  });

  it("example 5: LLM, tool, LLM, LLM, tool, LLM → depth 1", () => {
    const events = seq("llm_output", "tool_call", "llm_output", "llm_output", "tool_call", "llm_output");
    assert.equal(computeMaxLoopDepth(events), 1);
  });

  it("empty events → depth 0", () => {
    assert.equal(computeMaxLoopDepth([]), 0);
  });

  it("only LLM outputs → depth 0", () => {
    assert.equal(computeMaxLoopDepth(seq("llm_output", "llm_output", "llm_output")), 0);
  });

  it("only tool calls → depth 0", () => {
    assert.equal(computeMaxLoopDepth(seq("tool_call", "tool_call")), 0);
  });

  it("ignores non-LLM/tool events", () => {
    const events = seq("llm_output", "msg_in", "tool_call", "llm_input", "llm_output", "tool_call", "llm_output");
    assert.equal(computeMaxLoopDepth(events), 2);
  });
});

// ── computeMaxConsecutiveLlm — spec §3.2 worked examples ────────────

describe("computeMaxConsecutiveLlm", () => {
  it("example 1: LLM, tool, LLM, tool, LLM → max 1", () => {
    const events = seq("llm_output", "tool_call", "llm_output", "tool_call", "llm_output");
    assert.equal(computeMaxConsecutiveLlm(events), 1);
  });

  it("example 2: LLM, LLM, tool, LLM → max 2", () => {
    const events = seq("llm_output", "llm_output", "tool_call", "llm_output");
    assert.equal(computeMaxConsecutiveLlm(events), 2);
  });

  it("example 3: LLM, LLM, LLM → max 3", () => {
    const events = seq("llm_output", "llm_output", "llm_output");
    assert.equal(computeMaxConsecutiveLlm(events), 3);
  });

  it("empty events → 0", () => {
    assert.equal(computeMaxConsecutiveLlm([]), 0);
  });

  it("tool calls reset counter", () => {
    const events = seq("llm_output", "llm_output", "tool_call", "llm_output", "llm_output", "llm_output");
    assert.equal(computeMaxConsecutiveLlm(events), 3);
  });

  it("non-tool events don't reset counter", () => {
    const events = seq("llm_output", "msg_in", "llm_output");
    assert.equal(computeMaxConsecutiveLlm(events), 2);
  });
});

// ── computeRetryCount — spec §3.3 ───────────────────────────────────

describe("computeRetryCount", () => {
  it("no retries — all tool calls succeed", () => {
    const events = [
      makeEvent("llm_output"),
      toolWithName("readFile"),
      makeEvent("llm_output"),
      toolWithName("writeFile"),
    ];
    assert.equal(computeRetryCount(events), 0);
  });

  it("one retry — tool fails then same tool called again", () => {
    const events = [
      makeEvent("llm_output"),
      toolWithName("readFile", true),  // fails
      makeEvent("llm_output"),
      toolWithName("readFile"),         // retried
    ];
    assert.equal(computeRetryCount(events), 1);
  });

  it("error followed by different tool — not a retry", () => {
    const events = [
      makeEvent("llm_output"),
      toolWithName("readFile", true),  // fails
      makeEvent("llm_output"),
      toolWithName("writeFile"),        // different tool
    ];
    assert.equal(computeRetryCount(events), 0);
  });

  it("multiple retries of same tool in sequence", () => {
    const events = [
      makeEvent("llm_output"),
      toolWithName("exec", true),   // fail 1
      makeEvent("llm_output"),
      toolWithName("exec", true),   // retry 1 (fails again)
      makeEvent("llm_output"),
      toolWithName("exec"),          // retry 2 (succeeds)
    ];
    assert.equal(computeRetryCount(events), 2);
  });

  it("error outside lookback window — not counted", () => {
    const events = [
      toolWithName("readFile", true),  // error at position 0
      makeEvent("llm_output"),
      makeEvent("llm_output"),
      makeEvent("llm_output"),
      makeEvent("llm_output"),
      makeEvent("llm_output"),
      makeEvent("llm_output"),         // 6 events between error and retry
      toolWithName("readFile"),         // too far from error
    ];
    assert.equal(computeRetryCount(events), 0);
  });

  it("empty events → 0", () => {
    assert.equal(computeRetryCount([]), 0);
  });
});

// ── computeRunSummary — status detection (spec §2.4) ─────────────────

describe("computeRunSummary — status", () => {
  it("session with only successful events → completed", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR }),
      makeEvent("tool_call", { ts: NOW - 2 * HOUR + 1000 }),
      makeEvent("llm_output", { ts: NOW - 2 * HOUR + 2000 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.status, "completed");
    assert.equal(summary.endedReason, "heuristic");
  });

  it("error in event #3, successful output in event #200 → completed (recovered)", () => {
    const events: EventRow[] = [];
    // First 2 events normal
    events.push(makeEvent("llm_output", { ts: NOW - 2 * HOUR }));
    events.push(makeEvent("tool_call", { ts: NOW - 2 * HOUR + 1000 }));
    // Event #3 — error
    events.push(makeEvent("tool_call", {
      ts: NOW - 2 * HOUR + 2000,
      detail: JSON.stringify({ tool: "exec", isError: true, success: 0 }),
    }));
    // Fill 196 normal events
    for (let i = 0; i < 196; i++) {
      events.push(makeEvent(i % 2 === 0 ? "llm_output" : "tool_call", {
        ts: NOW - 2 * HOUR + 3000 + i * 100,
      }));
    }
    // Event #200 — successful output
    events.push(makeEvent("llm_output", { ts: NOW - 2 * HOUR + 25000 }));
    const summary = computeRunSummary(events);
    assert.equal(summary.status, "completed");
  });

  it("error in last 3 events, no recovery → errored", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR }),
      makeEvent("tool_call", { ts: NOW - 2 * HOUR + 1000 }),
      makeEvent("tool_call", {
        ts: NOW - 2 * HOUR + 2000,
        detail: JSON.stringify({ tool: "exec", isError: true }),
      }),
      makeEvent("tool_call", {
        ts: NOW - 2 * HOUR + 3000,
        detail: JSON.stringify({ tool: "exec", isError: true }),
      }),
      makeEvent("tool_call", {
        ts: NOW - 2 * HOUR + 4000,
        detail: JSON.stringify({ tool: "exec", isError: true }),
      }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.status, "errored");
  });

  it("recent events (< 10 min ago) → live", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 60_000 }),
      makeEvent("tool_call", { ts: NOW - 30_000 }),
      makeEvent("llm_output", { ts: NOW - 10_000 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.status, "live");
    assert.equal(summary.endedReason, "live");
  });

  it("old session with no clean ending → timeout", () => {
    // Ends with tool_call (no terminal llm_output after last tool)
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR }),
      makeEvent("tool_call", { ts: NOW - 2 * HOUR + 1000 }),
      makeEvent("tool_call", { ts: NOW - 2 * HOUR + 2000 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.endedReason, "timeout");
  });

  it("empty events → unknown status", () => {
    const summary = computeRunSummary([]);
    assert.equal(summary.status, "unknown");
  });
});

// ── computeRunSummary — basic aggregations ───────────────────────────

describe("computeRunSummary — aggregations", () => {
  it("aggregates cost and tokens from llm_output events only", () => {
    const events = [
      makeEvent("llm_output", {
        ts: NOW - 2 * HOUR,
        cost: 0.50,
        input_tokens: 5000,
        output_tokens: 1000,
        model: "anthropic/claude-opus-4-20250514",
      }),
      makeEvent("tool_call", {
        ts: NOW - 2 * HOUR + 1000,
        cost: 0.10, // should be ignored (not llm_output)
      }),
      makeEvent("llm_output", {
        ts: NOW - 2 * HOUR + 2000,
        cost: 0.25,
        input_tokens: 3000,
        output_tokens: 500,
        model: "anthropic/claude-sonnet-4-20250514",
      }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.totalCostUsd, 0.75);
    assert.equal(summary.totalTokensIn, 8000);
    assert.equal(summary.totalTokensOut, 1500);
    assert.equal(summary.modelSet.length, 2);
    assert.ok(summary.modelSet.includes("anthropic/claude-opus-4-20250514"));
    assert.ok(summary.modelSet.includes("anthropic/claude-sonnet-4-20250514"));
  });

  it("counts tool calls and unique tools", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR }),
      toolWithName("readFile"),
      toolWithName("readFile"),
      toolWithName("writeFile"),
      toolWithName("exec"),
      makeEvent("llm_output", { ts: NOW - 2 * HOUR + 5000 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.toolCallCount, 4);
    assert.equal(summary.uniqueToolCount, 3);
    assert.deepEqual(summary.uniqueTools.sort(), ["exec", "readFile", "writeFile"]);
  });

  it("computes duration correctly", () => {
    const start = NOW - 2 * HOUR;
    const end = start + 120_000;
    const events = [
      makeEvent("llm_output", { ts: start }),
      makeEvent("llm_output", { ts: end }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.startedTs, start);
    assert.equal(summary.endedTs, end);
    assert.equal(summary.durationMs, 120_000);
  });

  it("counts errors", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR }),
      toolWithName("exec", true),
      toolWithName("readFile", false),
      toolWithName("exec", true),
      makeEvent("llm_output", { ts: NOW - 2 * HOUR + 5000 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.errorCount, 2);
  });

  it("eventsMaxId is the last event id", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR, id: 100 }),
      makeEvent("tool_call", { ts: NOW - 2 * HOUR + 1000, id: 200 }),
      makeEvent("llm_output", { ts: NOW - 2 * HOUR + 2000, id: 300 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.eventsMaxId, 300);
  });
});

// ── computeRunSummary — risk flags ───────────────────────────────────

describe("computeRunSummary — risk flags", () => {
  it("touchedConfig true when tool name contains 'config'", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR }),
      makeEvent("tool_call", {
        ts: NOW - 2 * HOUR + 1000,
        detail: JSON.stringify({ tool: "writeConfig" }),
      }),
      makeEvent("llm_output", { ts: NOW - 2 * HOUR + 2000 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.touchedConfig, true);
  });

  it("blockedByBudget true when budget_blocked event exists", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR }),
      makeEvent("budget_blocked", { ts: NOW - 2 * HOUR + 1000 }),
      makeEvent("llm_output", { ts: NOW - 2 * HOUR + 2000 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.blockedByBudget, true);
  });

  it("throttledByBudget true when budget_throttle event exists", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR }),
      makeEvent("budget_throttle", { ts: NOW - 2 * HOUR + 1000 }),
      makeEvent("llm_output", { ts: NOW - 2 * HOUR + 2000 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.throttledByBudget, true);
  });

  it("all risk flags false for clean session", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR }),
      toolWithName("readFile"),
      makeEvent("llm_output", { ts: NOW - 2 * HOUR + 2000 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.touchedConfig, false);
    assert.equal(summary.gatewayRestarted, false);
    assert.equal(summary.rollbackDuringRun, false);
    assert.equal(summary.blockedByBudget, false);
    assert.equal(summary.throttledByBudget, false);
    assert.equal(summary.overrideActive, false);
  });
});

// ── computeComparison — baselines ────────────────────────────────────

describe("computeComparison", () => {
  function makeSessions(count: number, costBase = 0.30): SessionAggregate[] {
    return Array.from({ length: count }, (_, i) => ({
      session: `session-${i}`,
      agent: "test",
      minTs: NOW - (count - i) * HOUR,
      totalCost: costBase + (i % 5) * 0.05,
      totalTokensIn: 5000 + i * 100,
      totalTokensOut: 1000 + i * 50,
      toolCallCount: 5 + (i % 3),
      durationMs: 60_000 + i * 1000,
      maxLoopDepth: 3,
    }));
  }

  it("suppresses baseline when fewer than 10 sessions", () => {
    const summary = computeRunSummary([
      makeEvent("llm_output", { ts: NOW - 2 * HOUR, cost: 1.00 }),
    ]);
    const comparison = computeComparison(summary, makeSessions(5), makeSessions(5));
    assert.equal(comparison.agent, null);
    assert.equal(comparison.global, null);
  });

  it("shows baseline when 10+ sessions", () => {
    const summary = computeRunSummary([
      makeEvent("llm_output", { ts: NOW - 2 * HOUR, cost: 5.00, input_tokens: 50000, output_tokens: 10000 }),
    ]);
    const comparison = computeComparison(summary, makeSessions(20), makeSessions(50));
    assert.notEqual(comparison.agent, null);
    assert.ok(comparison.agent!.totalCostUsd);
    assert.equal(comparison.agent!.totalCostUsd!.count, 20);
  });

  it("ratio is null when within 0.5-1.5x range", () => {
    const summary = computeRunSummary([
      makeEvent("llm_output", { ts: NOW - 2 * HOUR, cost: 0.35 }), // close to median ~0.30-0.40
    ]);
    const sessions = makeSessions(20, 0.30);
    const comparison = computeComparison(summary, sessions, sessions);
    // Cost is close to median — ratio should be null (not notable)
    if (comparison.agent?.totalCostUsd) {
      assert.equal(comparison.agent.totalCostUsd.ratio, null);
    }
  });

  it("ratio shown when ≥1.5x", () => {
    const summary = computeRunSummary([
      makeEvent("llm_output", { ts: NOW - 2 * HOUR, cost: 5.00 }), // way above median
    ]);
    const sessions = makeSessions(20, 0.30);
    const comparison = computeComparison(summary, sessions, sessions);
    assert.ok(comparison.agent?.totalCostUsd?.ratio);
    assert.ok(comparison.agent!.totalCostUsd!.ratio! >= 1.5);
  });
});
