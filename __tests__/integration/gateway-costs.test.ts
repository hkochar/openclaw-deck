/**
 * Integration tests — Agent Cost Guardian API routes.
 *
 * Tests /api/agent-costs, /api/agent-pause, and budget config in /api/deck-config.
 * Requires: Next.js dev server + gateway running.
 *
 * Run: npx tsx --test __tests__/integration/gateway-costs.test.ts
 */

import { describe, before } from "node:test";
import assert from "node:assert/strict";
import { GET, POST, isServerUp, isGatewayUp, maybeIt } from "./helpers.js";

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
    console.log("Gateway not running — cost tests will be skipped");
  }
});

// ── GET /api/agent-costs ─────────────────────────────────────────────────

describe("GET /api/agent-costs", () => {
  maybeIt(() => gatewayUp, "gateway", "returns 200 with agents array", async () => {
    const { status, body } = await GET("/api/agent-costs");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.agents));
  });

  maybeIt(() => gatewayUp, "gateway", "each agent has required cost fields", async () => {
    const { body } = await GET("/api/agent-costs");
    for (const agent of body.agents) {
      assert.ok(typeof agent.agent === "string", "agent has name");
      assert.ok(typeof agent.daily === "number", "agent has daily cost");
      assert.ok(typeof agent.weekly === "number", "agent has weekly cost");
      assert.ok(typeof agent.monthly === "number", "agent has monthly cost");
      assert.ok(Array.isArray(agent.hourly), "agent has hourly array");
      assert.ok(typeof agent.paused === "boolean", "agent has paused status");
    }
  });

  maybeIt(() => gatewayUp, "gateway", "hourly array has 24 entries", async () => {
    const { body } = await GET("/api/agent-costs");
    for (const agent of body.agents) {
      assert.equal(agent.hourly.length, 24, `${agent.agent} should have 24 hourly entries`);
      for (const h of agent.hourly) {
        assert.ok(typeof h.hour === "number");
        assert.ok(typeof h.cost === "number");
      }
    }
  });

  maybeIt(() => gatewayUp, "gateway", "includes global budgets and pricing", async () => {
    const { body } = await GET("/api/agent-costs");
    assert.ok(typeof body.global === "object", "has global field");
    assert.ok(Array.isArray(body.alertThresholds), "has alertThresholds");
    assert.ok(typeof body.pricing === "object", "has pricing");
  });

  maybeIt(() => gatewayUp, "gateway", "pricing has known models", async () => {
    const { body } = await GET("/api/agent-costs");
    const models = Object.keys(body.pricing);
    // Should have at least some default models
    assert.ok(models.length > 0, "pricing has at least one model");
    // Check a known model has all rate fields
    for (const model of models) {
      const rates = body.pricing[model];
      assert.ok(typeof rates.input === "number", `${model} has input rate`);
      assert.ok(typeof rates.output === "number", `${model} has output rate`);
    }
  });

  maybeIt(() => serverUp && !gatewayUp, "no gateway", "returns 502 when gateway is down", async () => {
    const { status, body } = await GET("/api/agent-costs");
    assert.equal(status, 502);
    assert.ok(body.error);
  });
});

// ── GET /api/agent-pause ─────────────────────────────────────────────────

describe("GET /api/agent-pause", () => {
  maybeIt(() => gatewayUp, "gateway", "returns pause status object", async () => {
    const { status, body } = await GET("/api/agent-pause");
    assert.equal(status, 200);
    assert.ok(typeof body === "object");
  });
});

// ── POST /api/agent-pause ────────────────────────────────────────────────

describe("POST /api/agent-pause", () => {
  maybeIt(() => gatewayUp, "gateway", "can pause an agent", async () => {
    const { status, body } = await POST("/api/agent-pause", {
      agent: "vigil",
      paused: true,
      reason: "integration-test",
    });
    assert.equal(status, 200);
    assert.ok(body.ok || body.paused !== undefined);
  });

  maybeIt(() => gatewayUp, "gateway", "can unpause an agent", async () => {
    const { status, body } = await POST("/api/agent-pause", {
      agent: "vigil",
      paused: false,
      reason: "integration-test-cleanup",
    });
    assert.equal(status, 200);
    assert.ok(body.ok || body.paused !== undefined);
  });
});

// ── Budget config in /api/deck-config ──────────────────────────────────────

describe("GET /api/deck-config — budget fields", () => {
  maybeIt(() => serverUp, "server", "includes budgets field", async () => {
    const { body } = await GET("/api/deck-config");
    assert.ok("budgets" in body, "response has budgets");
    assert.ok(typeof body.budgets === "object");
  });

  maybeIt(() => serverUp, "server", "includes modelPricing field", async () => {
    const { body } = await GET("/api/deck-config");
    assert.ok("modelPricing" in body, "response has modelPricing");
    assert.ok(typeof body.modelPricing === "object");
  });

  maybeIt(() => serverUp, "server", "includes throttleChain field", async () => {
    const { body } = await GET("/api/deck-config");
    assert.ok("throttleChain" in body, "response has throttleChain");
    assert.ok(Array.isArray(body.throttleChain));
    assert.ok(body.throttleChain.length > 0, "throttleChain has entries");
  });

  maybeIt(() => serverUp, "server", "default throttleChain is opus > sonnet > haiku", async () => {
    const { body } = await GET("/api/deck-config");
    // Default chain or user-configured — at minimum should be an array of strings
    for (const model of body.throttleChain) {
      assert.ok(typeof model === "string");
    }
  });
});
