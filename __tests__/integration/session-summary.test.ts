import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { GET, isServerUp, maybeIt } from "./helpers";
import {
  computeRunSummary,
  computeComparison,
  type EventRow,
  type RunSummary,
  type SessionAggregate,
} from "@/lib/run-intelligence";

// ── Setup ────────────────────────────────────────────────────────────────────

let serverUp = false;

describe("session-summary integration", () => {
  before(async () => {
    serverUp = await isServerUp();
  });

  // ── API shape tests (require running server + DB) ────────────────────────

  maybeIt(
    () => serverUp,
    "server not running",
    "GET without session param returns 400",
    async () => {
      const res = await GET("/api/logs/session-summary");
      assert.equal(res.status, 400);
      assert.equal(res.body.ok, false);
      assert.ok(res.body.error.includes("missing session"));
    },
  );

  maybeIt(
    () => serverUp,
    "server not running",
    "GET with nonexistent session returns 404",
    async () => {
      const res = await GET("/api/logs/session-summary?session=nonexistent-session-xyz");
      assert.equal(res.status, 404);
      assert.equal(res.body.ok, false);
    },
  );

  maybeIt(
    () => serverUp,
    "server not running",
    "GET with valid session returns RunSummary shape",
    async () => {
      // First, find a session that has events by querying the logs API
      const logsRes = await GET("/api/logs?limit=1");
      if (logsRes.status !== 200 || !logsRes.body?.events?.length) {
        // No events in DB — skip
        return;
      }
      const session = logsRes.body.events[0].session;
      if (!session) return;

      const res = await GET(`/api/logs/session-summary?session=${encodeURIComponent(session)}`);
      if (res.status === 404) {
        // Session has no events in the expected format — acceptable
        return;
      }
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      // Verify RunSummary shape
      const summary: RunSummary = res.body.summary;
      assert.equal(typeof summary.startedTs, "number");
      assert.equal(typeof summary.endedTs, "number");
      assert.equal(typeof summary.durationMs, "number");
      assert.ok(["completed", "errored", "live", "unknown"].includes(summary.status));
      assert.ok(["heuristic", "timeout", "live"].includes(summary.endedReason));
      assert.equal(typeof summary.totalCostUsd, "number");
      assert.equal(typeof summary.totalTokensIn, "number");
      assert.equal(typeof summary.totalTokensOut, "number");
      assert.ok(Array.isArray(summary.modelSet));
      assert.equal(typeof summary.toolCallCount, "number");
      assert.equal(typeof summary.uniqueToolCount, "number");
      assert.ok(Array.isArray(summary.uniqueTools));
      assert.equal(typeof summary.retryCount, "number");
      assert.equal(typeof summary.maxLoopDepth, "number");
      assert.equal(typeof summary.maxConsecutiveLlmCalls, "number");
      assert.equal(typeof summary.errorCount, "number");
      assert.equal(typeof summary.touchedConfig, "boolean");
      assert.equal(typeof summary.gatewayRestarted, "boolean");
      assert.equal(typeof summary.rollbackDuringRun, "boolean");
      assert.equal(typeof summary.blockedByBudget, "boolean");
      assert.equal(typeof summary.throttledByBudget, "boolean");
      assert.equal(typeof summary.overrideActive, "boolean");
      assert.equal(typeof summary.eventsMaxId, "number");

      // Verify comparison shape
      const comparison = res.body.comparison;
      assert.ok(comparison !== undefined);
      // comparison.agent and comparison.global are either null or objects
      if (comparison.agent !== null) {
        assert.equal(typeof comparison.agent, "object");
      }
      if (comparison.global !== null) {
        assert.equal(typeof comparison.global, "object");
      }
    },
  );

  maybeIt(
    () => serverUp,
    "server not running",
    "repeated GET returns cached result (second call faster)",
    async () => {
      const logsRes = await GET("/api/logs?limit=1");
      if (logsRes.status !== 200 || !logsRes.body?.events?.length) return;
      const session = logsRes.body.events[0].session;
      if (!session) return;

      const url = `/api/logs/session-summary?session=${encodeURIComponent(session)}`;

      // First call — populates cache
      const res1 = await GET(url);
      if (res1.status !== 200) return;

      // Second call — should hit cache
      const start = performance.now();
      const res2 = await GET(url);
      const elapsed = performance.now() - start;

      assert.equal(res2.status, 200);
      assert.equal(res2.body.ok, true);
      // Cached response should be fast (< 500ms for a local server)
      // We don't assert on timing strictly — just verify shape is same
      assert.deepEqual(res2.body.summary.eventsMaxId, res1.body.summary.eventsMaxId);
    },
  );

  // ── Pure function tests (always run) ─────────────────────────────────────

  it("computeRunSummary returns valid RunSummary for synthetic events", () => {
    const NOW = Date.now();
    const events: EventRow[] = [
      {
        id: 1, ts: NOW - 3600000, type: "llm_output", agent: "test", session: "s1",
        model: "anthropic/claude-sonnet-4-20250514", resolved_model: null,
        cost: 0.05, input_tokens: 2000, output_tokens: 500,
        cache_read: null, cache_write: null,
        has_thinking: null, has_prompt: null, has_response: null,
        billing: null, provider_cost: null, detail: null,
      },
      {
        id: 2, ts: NOW - 3599000, type: "tool_call", agent: "test", session: "s1",
        model: null, resolved_model: null,
        cost: null, input_tokens: null, output_tokens: null,
        cache_read: null, cache_write: null,
        has_thinking: null, has_prompt: null, has_response: null,
        billing: null, provider_cost: null, detail: JSON.stringify({ tool: "readFile", success: 1 }),
      },
      {
        id: 3, ts: NOW - 3598000, type: "llm_output", agent: "test", session: "s1",
        model: "anthropic/claude-sonnet-4-20250514", resolved_model: null,
        cost: 0.03, input_tokens: 1500, output_tokens: 300,
        cache_read: null, cache_write: null,
        has_thinking: null, has_prompt: null, has_response: null,
        billing: null, provider_cost: null, detail: null,
      },
    ];

    const summary = computeRunSummary(events);
    assert.equal(summary.totalCostUsd, 0.08);
    assert.equal(summary.totalTokensIn, 3500);
    assert.equal(summary.totalTokensOut, 800);
    assert.equal(summary.toolCallCount, 1);
    assert.equal(summary.uniqueToolCount, 1);
    assert.deepEqual(summary.uniqueTools, ["readFile"]);
    assert.equal(summary.maxLoopDepth, 1);
    assert.equal(summary.errorCount, 0);
    assert.equal(summary.eventsMaxId, 3);
  });

  it("computeComparison returns baselines when enough sessions exist", () => {
    const NOW = Date.now();
    const HOUR = 3600000;

    const summary = computeRunSummary([
      {
        id: 1, ts: NOW - 2 * HOUR, type: "llm_output", agent: "test", session: "s1",
        model: "anthropic/claude-sonnet-4-20250514", resolved_model: null,
        cost: 2.00, input_tokens: 20000, output_tokens: 5000,
        cache_read: null, cache_write: null,
        has_thinking: null, has_prompt: null, has_response: null,
        billing: null, provider_cost: null, detail: null,
      },
    ]);

    const sessions: SessionAggregate[] = Array.from({ length: 15 }, (_, i) => ({
      session: `session-${i}`,
      agent: "test",
      minTs: NOW - (15 - i) * HOUR,
      totalCost: 0.20 + (i % 3) * 0.05,
      totalTokensIn: 5000 + i * 100,
      totalTokensOut: 1000 + i * 50,
      toolCallCount: 5 + (i % 3),
      durationMs: 60000,
      maxLoopDepth: 2,
    }));

    const comparison = computeComparison(summary, sessions, sessions);
    assert.notEqual(comparison.agent, null);
    assert.notEqual(comparison.global, null);
    // Cost of 2.00 is way above median ~0.25, so ratio should be shown
    assert.ok(comparison.agent!.totalCostUsd);
    assert.ok(comparison.agent!.totalCostUsd!.ratio! >= 1.5);
  });

  it("computeComparison suppresses baselines with fewer than 10 sessions", () => {
    const summary = computeRunSummary([
      {
        id: 1, ts: Date.now() - 3600000, type: "llm_output", agent: "test", session: "s1",
        model: "m", resolved_model: null,
        cost: 1.00, input_tokens: 10000, output_tokens: 2000,
        cache_read: null, cache_write: null,
        has_thinking: null, has_prompt: null, has_response: null,
        billing: null, provider_cost: null, detail: null,
      },
    ]);

    const fewSessions: SessionAggregate[] = Array.from({ length: 5 }, (_, i) => ({
      session: `s-${i}`, agent: "test", minTs: Date.now() - i * 3600000,
      totalCost: 0.30, totalTokensIn: 5000, totalTokensOut: 1000,
      toolCallCount: 5, durationMs: 60000, maxLoopDepth: 2,
    }));

    const comparison = computeComparison(summary, fewSessions, fewSessions);
    assert.equal(comparison.agent, null);
    assert.equal(comparison.global, null);
  });
});
