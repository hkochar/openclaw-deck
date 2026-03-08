/**
 * Integration tests — Tier 2: Gateway-required routes.
 *
 * Tests gracefully skip if the gateway is not running.
 *
 * Run: npx tsx --test __tests__/integration/gateway-required.test.ts
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
    console.log("Gateway not running — gateway-dependent tests will be skipped");
  }
});

// ── GET /api/gateway-health (gateway up) ────────────────────────────────────

describe("GET /api/gateway-health (gateway up)", () => {
  maybeIt(() => gatewayUp, "gateway", "returns ok: true with status > 0", async () => {
    const { status, body } = await GET("/api/gateway-health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.status > 0);
  });
});

// ── GET /api/crons ──────────────────────────────────────────────────────────

describe("GET /api/crons", () => {
  maybeIt(() => gatewayUp, "gateway", "returns ok: true with crons array", async () => {
    const { status, body } = await GET("/api/crons");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.crons));
  });

  maybeIt(() => gatewayUp, "gateway", "each cron has required fields", async () => {
    const { body } = await GET("/api/crons");
    for (const c of body.crons) {
      assert.ok(typeof c.id === "string");
      assert.ok(typeof c.name === "string");
      assert.ok(typeof c.enabled === "boolean");
      assert.ok(typeof c.schedule === "string");
    }
  });
});

// ── GET /api/cron-schedule ──────────────────────────────────────────────────

describe("GET /api/cron-schedule", () => {
  maybeIt(() => gatewayUp, "gateway", "returns array with schedule items", async () => {
    const { status, body } = await GET("/api/cron-schedule");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ── GET /api/usage ──────────────────────────────────────────────────────────

describe("GET /api/usage", () => {
  maybeIt(() => gatewayUp, "gateway", "returns ok: true with usage array", async () => {
    const { status, body } = await GET("/api/usage");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.usage));
  });
});

// ── POST /api/cron-manage — validation (with gateway) ───────────────────────

describe("POST /api/cron-manage validation (gateway)", () => {
  maybeIt(() => serverUp, "server", "create missing required fields returns 400", async () => {
    const { status, body } = await POST("/api/cron-manage", {
      action: "create",
      name: "test",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  maybeIt(() => serverUp, "server", "create invalid interval format returns 400", async () => {
    const { status, body } = await POST("/api/cron-manage", {
      action: "create",
      name: "test",
      agentId: "main",
      schedule: "every purple",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  maybeIt(() => serverUp, "server", "create invalid cron (not 5 fields) returns 400", async () => {
    const { status, body } = await POST("/api/cron-manage", {
      action: "create",
      name: "test",
      agentId: "main",
      schedule: "* * *",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  maybeIt(() => serverUp, "server", "update missing jobId returns 400", async () => {
    const { status, body } = await POST("/api/cron-manage", {
      action: "update",
      patch: {},
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  maybeIt(() => serverUp, "server", "update invalid schedule returns 400", async () => {
    const { status, body } = await POST("/api/cron-manage", {
      action: "update",
      jobId: "fake-id",
      patch: { schedule: { kind: "cron", expr: "bad" } },
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

// ── POST /api/model-swap — validation ───────────────────────────────────────

describe("POST /api/model-swap validation", () => {
  maybeIt(() => serverUp, "server", "missing model for test returns 400", async () => {
    const { status, body } = await POST("/api/model-swap", { action: "test" });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  maybeIt(() => serverUp, "server", "unknown action returns 400", async () => {
    const { status, body } = await POST("/api/model-swap", { action: "zap" });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  maybeIt(() => serverUp, "server", "session missing agentId returns 400", async () => {
    const { status, body } = await POST("/api/model-swap", {
      action: "session",
      model: "anthropic/claude-haiku-4-5",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  maybeIt(() => serverUp, "server", "session missing model returns 400", async () => {
    const { status, body } = await POST("/api/model-swap", {
      action: "session",
      agentId: "jane",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  maybeIt(() => serverUp, "server", "swap missing agentId returns 400", async () => {
    const { status, body } = await POST("/api/model-swap", {
      action: "swap",
      model: "anthropic/claude-haiku-4-5",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});
