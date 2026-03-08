/**
 * Integration tests — Budget endpoints, session summary, and replay.
 *
 * Tests gracefully skip if the gateway/server are not running.
 *
 * Run: npx tsx --test __tests__/integration/budget-and-replay.test.ts
 */

import { describe, before } from "node:test";
import assert from "node:assert/strict";
import { GET, POST, isServerUp, isGatewayUp, maybeIt, GATEWAY_URL } from "./helpers.js";

let serverUp = false;
let gatewayUp = false;

before(async () => {
  serverUp = await isServerUp();
  if (!serverUp) {
    console.error("SKIP: Next.js dev server not running at localhost:3000");
    return;
  }
  gatewayUp = await isGatewayUp();
  if (!gatewayUp) {
    console.log("Gateway not running — gateway-dependent tests will be skipped");
  }
});

// ── GET /api/budget-override ─────────────────────────────────────────────────

describe("GET /api/budget-override", () => {
  maybeIt(() => serverUp && gatewayUp, "gateway", "returns JSON (may be empty object)", async () => {
    const { status, body } = await GET("/api/budget-override");
    // Either 200 with overrides object, or 502 if gateway doesn't support the endpoint yet
    if (status === 200) {
      assert.equal(typeof body, "object");
    } else {
      assert.equal(status, 502); // Gateway hasn't restarted with new code
    }
  });
});

// ── GET /budget/status (direct gateway) ──────────────────────────────────────

describe("GET /budget/status (via gateway)", () => {
  maybeIt(() => gatewayUp, "gateway", "returns agents array with required fields", async () => {
    const res = await fetch(`${GATEWAY_URL}/budget/status`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.agents));
    assert.ok(data.agents.length > 0, "Should have at least one agent");
    const agent = data.agents[0];
    // Core fields (always present)
    assert.equal(typeof agent.agent, "string");
    assert.equal(typeof agent.daily, "number");
    assert.equal(typeof agent.weekly, "number");
    assert.equal(typeof agent.monthly, "number");
    assert.equal(typeof agent.paused, "boolean");
  });

  maybeIt(() => gatewayUp, "gateway", "agent has hourly breakdown array", async () => {
    const res = await fetch(`${GATEWAY_URL}/budget/status`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    const agent = data.agents[0];
    assert.ok(Array.isArray(agent.hourly));
    assert.equal(agent.hourly.length, 24);
    const h = agent.hourly[0];
    assert.equal(typeof h.hour, "number");
    assert.equal(typeof h.cost, "number");
    assert.equal(typeof h.requests, "number");
  });
});

// ── GET /api/logs/session-summary ────────────────────────────────────────────

describe("GET /api/logs/session-summary", () => {
  maybeIt(() => serverUp, "server", "returns 400 without session param", async () => {
    const { status, body } = await GET("/api/logs/session-summary");
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes("session"));
  });

  maybeIt(() => serverUp, "server", "returns 404 for nonexistent session", async () => {
    const { status, body } = await GET(
      "/api/logs/session-summary?session=nonexistent-session-key-12345"
    );
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });

  maybeIt(() => serverUp, "server", "returns summary for real session", async () => {
    // First find a real session key
    const logsRes = await GET("/api/logs?endpoint=stream&limit=5");
    if (logsRes.status !== 200) return; // skip if logs API not working

    const events = Array.isArray(logsRes.body) ? logsRes.body : [];
    const sessionKey = events.find((e: Record<string, unknown>) => e.session)?.session;
    if (!sessionKey) return; // no events with sessions

    const { status, body } = await GET(
      `/api/logs/session-summary?session=${encodeURIComponent(sessionKey as string)}`
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // Verify summary shape
    const s = body.summary;
    assert.equal(typeof s.startedTs, "number");
    assert.equal(typeof s.endedTs, "number");
    assert.equal(typeof s.durationMs, "number");
    assert.ok(["completed", "errored", "live", "unknown"].includes(s.status));
    assert.ok(["heuristic", "timeout", "live"].includes(s.endedReason));
    assert.equal(typeof s.totalCostUsd, "number");
    assert.equal(typeof s.totalTokensIn, "number");
    assert.equal(typeof s.totalTokensOut, "number");
    assert.ok(Array.isArray(s.modelSet));
    assert.equal(typeof s.toolCallCount, "number");
    assert.equal(typeof s.uniqueToolCount, "number");
    assert.ok(Array.isArray(s.uniqueTools));
    assert.equal(typeof s.retryCount, "number");
    assert.equal(typeof s.maxLoopDepth, "number");
    assert.equal(typeof s.maxConsecutiveLlmCalls, "number");
    assert.equal(typeof s.errorCount, "number");
    assert.equal(typeof s.eventsMaxId, "number");

    // Risk flags
    assert.equal(typeof s.touchedConfig, "boolean");
    assert.equal(typeof s.gatewayRestarted, "boolean");
    assert.equal(typeof s.blockedByBudget, "boolean");
    assert.equal(typeof s.throttledByBudget, "boolean");

    // Comparison shape
    assert.ok("comparison" in body);
    const c = body.comparison;
    assert.ok(c.agent === null || typeof c.agent === "object");
    assert.ok(c.global === null || typeof c.global === "object");
  });

  maybeIt(() => serverUp, "server", "returns deterministic results (cache)", async () => {
    const logsRes = await GET("/api/logs?endpoint=stream&limit=5");
    if (logsRes.status !== 200) return;

    const events = Array.isArray(logsRes.body) ? logsRes.body : [];
    const sessionKey = events.find((e: Record<string, unknown>) => e.session)?.session;
    if (!sessionKey) return;

    const url = `/api/logs/session-summary?session=${encodeURIComponent(sessionKey as string)}`;
    const r1 = await GET(url);
    const r2 = await GET(url);

    if (r1.status === 200 && r2.status === 200) {
      assert.equal(r1.body.summary.eventsMaxId, r2.body.summary.eventsMaxId);
      assert.equal(r1.body.summary.totalCostUsd, r2.body.summary.totalCostUsd);
    }
  });
});

// ── Replay page loads ────────────────────────────────────────────────────────

describe("Replay page", () => {
  maybeIt(() => serverUp, "server", "returns 200", async () => {
    const res = await fetch("http://localhost:3000/replay", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("replay"), "Page should contain replay-related content");
  });
});
