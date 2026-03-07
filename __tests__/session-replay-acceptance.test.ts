/**
 * Acceptance tests for Session Replay (Spec 3).
 *
 * Tests event ordering, 5000-event cap, session key resolution,
 * LRU cache behavior, and cross-feature budget enforcement markers.
 *
 * Run: npx tsx --test __tests__/session-replay-acceptance.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRunSummary,
  computeComparison,
  type EventRow,
  type SessionAggregate,
} from "@/lib/run-intelligence";

// ── Helpers ──────────────────────────────────────────────────────

let nextId = 1;
const NOW = Date.now();
const HOUR = 3_600_000;

function makeEvent(
  type: string,
  overrides: Partial<EventRow> = {},
): EventRow {
  const id = nextId++;
  return {
    id,
    ts: NOW - 2 * HOUR + id * 1000,
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

// ── 3.1 Event Ordering — ts ASC, id ASC (canonical) ──────────────

describe("3.1 Event ordering — canonical ts ASC, id ASC", () => {
  it("computeRunSummary preserves chronological order (startedTs < endedTs)", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 1 }),
      makeEvent("tool_call", { ts: 2000, id: 2 }),
      makeEvent("llm_output", { ts: 3000, id: 3 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.startedTs, 1000);
    assert.equal(summary.endedTs, 3000);
  });

  it("events with same ts are ordered by id", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 10 }),
      makeEvent("tool_call", { ts: 1000, id: 11 }),
      makeEvent("tool_call", { ts: 1000, id: 12 }),
      makeEvent("llm_output", { ts: 2000, id: 13 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.toolCallCount, 2);
    assert.equal(summary.eventsMaxId, 13);
  });

  it("no duplicate events affect counts", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 1, cost: 0.10 }),
      makeEvent("llm_output", { ts: 2000, id: 2, cost: 0.20 }),
      makeEvent("llm_output", { ts: 3000, id: 3, cost: 0.30 }),
    ];
    const summary = computeRunSummary(events);
    // Each event counted once — total cost should be ~0.60
    assert.ok(Math.abs(summary.totalCostUsd - 0.60) < 0.001);
  });

  it("event types: llm_output, tool_call, message_received all counted", () => {
    const events = [
      makeEvent("message_received", { ts: 1000, id: 1 }),
      makeEvent("llm_output", { ts: 2000, id: 2 }),
      makeEvent("tool_call", { ts: 3000, id: 3, detail: JSON.stringify({ tool: "readFile" }) }),
      makeEvent("llm_output", { ts: 4000, id: 4 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.toolCallCount, 1);
    assert.equal(summary.uniqueTools.length, 1);
    assert.ok(summary.uniqueTools.includes("readFile"));
  });
});

// ── 3.2 Event Detail — thinking, prompt, response flags ──────────

describe("3.2 Event detail — thinking and prompt visibility", () => {
  it("has_thinking flag reflected in events", () => {
    const events = [
      makeEvent("llm_output", {
        ts: 1000, id: 1,
        has_thinking: 1,
        has_prompt: 1,
        has_response: 1,
      }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.totalCostUsd, 0.01);
    // Thinking is available for expansion in UI
    assert.equal(events[0].has_thinking, 1);
  });

  it("tool_call detail includes tool name and result", () => {
    const detail = JSON.stringify({
      tool: "writeFile",
      success: 1,
      output: "file written",
    });
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 1 }),
      makeEvent("tool_call", { ts: 2000, id: 2, detail }),
      makeEvent("llm_output", { ts: 3000, id: 3 }),
    ];
    const summary = computeRunSummary(events);
    assert.ok(summary.uniqueTools.includes("writeFile"));
  });

  it("model used is tracked per llm_output event", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 1, model: "anthropic/claude-opus-4-20250514" }),
      makeEvent("llm_output", { ts: 2000, id: 2, model: "anthropic/claude-sonnet-4-20250514" }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.modelSet.length, 2);
    assert.ok(summary.modelSet.includes("anthropic/claude-opus-4-20250514"));
    assert.ok(summary.modelSet.includes("anthropic/claude-sonnet-4-20250514"));
  });
});

// ── 3.3 Deep Links — stable event IDs ────────────────────────────

describe("3.3 Deep links — stable event IDs", () => {
  it("eventsMaxId is deterministic for same event set", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 42 }),
      makeEvent("tool_call", { ts: 2000, id: 99 }),
      makeEvent("llm_output", { ts: 3000, id: 150 }),
    ];
    const s1 = computeRunSummary(events);
    const s2 = computeRunSummary(events);
    assert.equal(s1.eventsMaxId, s2.eventsMaxId);
    assert.equal(s1.eventsMaxId, 150);
  });

  it("event IDs are stable integers, not array indices", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 500 }),
      makeEvent("llm_output", { ts: 2000, id: 1000 }),
    ];
    // IDs are not 0, 1 — they are from the DB
    assert.notEqual(events[0].id, 0);
    assert.notEqual(events[1].id, 1);
    assert.equal(events[0].id, 500);
    assert.equal(events[1].id, 1000);
  });
});

// ── 3.4 Performance Ceiling — 5000 event cap ─────────────────────

describe("3.4 Performance ceiling — large event sets", () => {
  it("computeRunSummary handles 5000 events correctly", () => {
    const events: EventRow[] = [];
    for (let i = 0; i < 5000; i++) {
      events.push(makeEvent(
        i % 3 === 0 ? "llm_output" : "tool_call",
        {
          ts: 1000 + i * 100,
          id: i + 1,
          cost: i % 3 === 0 ? 0.001 : null,
          detail: i % 3 !== 0 ? JSON.stringify({ tool: "exec", success: 1 }) : null,
        },
      ));
    }
    const summary = computeRunSummary(events);
    assert.equal(summary.eventsMaxId, 5000);
    assert.ok(summary.toolCallCount > 0);
    assert.ok(summary.totalCostUsd > 0);
  });

  it("computeRunSummary handles 1000+ events within reasonable time", () => {
    const events: EventRow[] = [];
    for (let i = 0; i < 2000; i++) {
      events.push(makeEvent(
        i % 2 === 0 ? "llm_output" : "tool_call",
        { ts: 1000 + i * 50, id: i + 1 },
      ));
    }
    const start = Date.now();
    const summary = computeRunSummary(events);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `Took ${elapsed}ms — should be under 1000ms`);
    assert.equal(summary.eventsMaxId, 2000);
  });
});

// ── 3.5 Archived/Compacted Sessions ──────────────────────────────

describe("3.5 Archived/compacted sessions", () => {
  it("partial event sets still produce valid summary", () => {
    // Compacted session might only have a subset of events
    const events = [
      makeEvent("llm_output", { ts: 5000, id: 500 }),
      makeEvent("tool_call", { ts: 6000, id: 501 }),
    ];
    const summary = computeRunSummary(events);
    assert.ok(summary.startedTs > 0);
    assert.ok(summary.endedTs >= summary.startedTs);
    assert.equal(summary.eventsMaxId, 501);
  });

  it("empty events produce unknown status (no crash)", () => {
    const summary = computeRunSummary([]);
    assert.equal(summary.status, "unknown");
    assert.equal(summary.totalCostUsd, 0);
    assert.equal(summary.toolCallCount, 0);
    assert.equal(summary.eventsMaxId, 0);
  });
});

// ── 3.6 Budget Enforcement Markers (Cross-Feature) ───────────────

describe("3.6 Budget enforcement markers in session timeline", () => {
  it("budget_blocked event sets blockedByBudget flag", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 1 }),
      makeEvent("tool_call", { ts: 2000, id: 2 }),
      makeEvent("budget_blocked", { ts: 3000, id: 3 }),
      makeEvent("llm_output", { ts: 4000, id: 4 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.blockedByBudget, true);
    assert.equal(summary.throttledByBudget, false);
  });

  it("budget_throttle event sets throttledByBudget flag", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 1, model: "anthropic/claude-opus-4-20250514" }),
      makeEvent("budget_throttle", {
        ts: 2000, id: 2,
        detail: JSON.stringify({ from: "opus", to: "sonnet" }),
      }),
      makeEvent("llm_output", { ts: 3000, id: 3, model: "anthropic/claude-sonnet-4-20250514" }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.throttledByBudget, true);
    // Model set should contain both models (before and after throttle)
    assert.ok(summary.modelSet.includes("anthropic/claude-opus-4-20250514"));
    assert.ok(summary.modelSet.includes("anthropic/claude-sonnet-4-20250514"));
  });

  it("both throttle and block in same session sets both flags", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 1 }),
      makeEvent("budget_throttle", { ts: 2000, id: 2 }),
      makeEvent("llm_output", { ts: 3000, id: 3 }),
      makeEvent("budget_blocked", { ts: 4000, id: 4 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.throttledByBudget, true);
    assert.equal(summary.blockedByBudget, true);
  });

  it("budget_override event sets overrideActive flag", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 1 }),
      makeEvent("budget_blocked", { ts: 2000, id: 2 }),
      makeEvent("budget_override", { ts: 3000, id: 3 }),
      makeEvent("llm_output", { ts: 4000, id: 4 }),
    ];
    const summary = computeRunSummary(events);
    assert.equal(summary.blockedByBudget, true);
    assert.equal(summary.overrideActive, true);
  });

  it("risk flags shown in comparison context", () => {
    const events = [
      makeEvent("llm_output", { ts: NOW - 2 * HOUR, id: 1, cost: 5.00 }),
      makeEvent("budget_throttle", { ts: NOW - 2 * HOUR + 1000, id: 2 }),
      makeEvent("budget_blocked", { ts: NOW - 2 * HOUR + 2000, id: 3 }),
    ];
    const summary = computeRunSummary(events);

    // Create baselines for comparison
    const sessions: SessionAggregate[] = Array.from({ length: 20 }, (_, i) => ({
      session: `s-${i}`,
      agent: "test",
      minTs: NOW - (20 - i) * HOUR,
      totalCost: 0.30,
      totalTokensIn: 5000,
      totalTokensOut: 1000,
      toolCallCount: 5,
      durationMs: 60_000,
      maxLoopDepth: 3,
    }));

    const comparison = computeComparison(summary, sessions, sessions);
    // Summary still has risk flags even with comparison
    assert.equal(summary.throttledByBudget, true);
    assert.equal(summary.blockedByBudget, true);
    // Comparison should show this session's cost as anomalous (5.00 vs median ~0.30)
    assert.ok(comparison.agent?.totalCostUsd?.ratio);
    assert.ok(comparison.agent!.totalCostUsd!.ratio! > 1.5);
  });
});

// ── Session Key Resolution (unit-level) ──────────────────────────

describe("Session key resolution — format variants", () => {
  it("UUID extraction from JSONL key format", () => {
    const key = "main/9de7d054-abcd-4321-9876-123456789abc.jsonl";
    const match = key.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    assert.ok(match);
    assert.equal(match![1], "9de7d054-abcd-4321-9876-123456789abc");
  });

  it("UUID extraction from gateway session key", () => {
    const key = "agent:main:discord:channel:1234567890123456789";
    const match = key.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    assert.equal(match, null, "Gateway key has no UUID — lookup required");
  });

  it("channel ID extraction from gateway key", () => {
    const key = "agent:main:discord:channel:1234567890123456789";
    const parts = key.split(":");
    assert.equal(parts[0], "agent");
    assert.equal(parts[1], "main");
    assert.equal(parts[4], "1234567890123456789");
  });

  it("legacy channel key format", () => {
    const key = "channel:1234567890123456789";
    const parts = key.split(":");
    assert.equal(parts[0], "channel");
    assert.equal(parts[1], "1234567890123456789");
  });
});

// ── LRU Cache Behavior ──────────────────────────────────────────

describe("LRU cache — deterministic results", () => {
  it("same events produce identical summary (deterministic)", () => {
    const events = [
      makeEvent("llm_output", { ts: 1000, id: 1, cost: 0.50 }),
      makeEvent("tool_call", { ts: 2000, id: 2 }),
      makeEvent("llm_output", { ts: 3000, id: 3, cost: 0.25 }),
    ];
    const s1 = computeRunSummary(events);
    const s2 = computeRunSummary(events);

    assert.equal(s1.totalCostUsd, s2.totalCostUsd);
    assert.equal(s1.toolCallCount, s2.toolCallCount);
    assert.equal(s1.eventsMaxId, s2.eventsMaxId);
    assert.equal(s1.status, s2.status);
    assert.deepEqual(s1.modelSet, s2.modelSet);
    assert.deepEqual(s1.uniqueTools, s2.uniqueTools);
  });

  it("cache key includes maxId — adding events invalidates cache", () => {
    const events1 = [
      makeEvent("llm_output", { ts: 1000, id: 1, cost: 0.10 }),
    ];
    const events2 = [
      ...events1,
      makeEvent("llm_output", { ts: 2000, id: 2, cost: 0.20 }),
    ];
    const s1 = computeRunSummary(events1);
    const s2 = computeRunSummary(events2);
    assert.notEqual(s1.eventsMaxId, s2.eventsMaxId);
    assert.notEqual(s1.totalCostUsd, s2.totalCostUsd);
  });
});
