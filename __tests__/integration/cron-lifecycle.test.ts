/**
 * Integration tests — Tier 2: Cron CRUD lifecycle.
 *
 * Creates a test cron job, toggles, updates, verifies in list, then disables.
 * The job is created with enabled:false and a far-future schedule to prevent
 * accidental execution.
 *
 * Run: npx tsx --test __tests__/integration/cron-lifecycle.test.ts
 */

import { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { GET, POST, isServerUp, isGatewayUp, maybeIt } from "./helpers.js";

let serverUp = false;
let gatewayUp = false;
let testJobId: string | null = null;
const testJobName = `integration-test-${Date.now()}`;

before(async () => {
  serverUp = await isServerUp();
  if (!serverUp) {
    console.error("SKIP: Next.js dev server not running at localhost:3000");
    return;
  }
  gatewayUp = await isGatewayUp();
  if (!gatewayUp) {
    console.log("Gateway not running — cron lifecycle tests will be skipped");
  }
});

after(async () => {
  // Best-effort cleanup: disable the test job
  if (testJobId && gatewayUp) {
    await POST("/api/cron-manage", {
      action: "toggle",
      jobId: testJobId,
      enabled: false,
    }).catch(() => {});
  }
});

// ── Cron lifecycle ──────────────────────────────────────────────────────────

describe("cron create → list → toggle → update lifecycle", () => {
  maybeIt(() => gatewayUp, "gateway", "create a new cron job", async () => {
    const { status, body } = await POST("/api/cron-manage", {
      action: "create",
      name: testJobName,
      agentId: "main",
      schedule: "0 0 1 1 *", // midnight Jan 1 — effectively never
      message: "integration test — safe to delete",
      enabled: false,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.jobId, "Expected jobId in response");
    testJobId = body.jobId;
  });

  maybeIt(() => gatewayUp, "gateway", "new job appears in GET /api/crons", async () => {
    if (!testJobId) return;
    const { body } = await GET("/api/crons");
    assert.equal(body.ok, true);
    const job = body.crons.find(
      (c: { id: string }) => c.id === testJobId,
    );
    assert.ok(job, `Expected to find job ${testJobId} in crons list`);
    assert.equal(job.enabled, false);
  });

  maybeIt(() => gatewayUp, "gateway", "toggle enable succeeds", async () => {
    if (!testJobId) return;
    const { body } = await POST("/api/cron-manage", {
      action: "toggle",
      jobId: testJobId,
      enabled: true,
    });
    assert.equal(body.ok, true);
  });

  maybeIt(() => gatewayUp, "gateway", "toggle disable succeeds", async () => {
    if (!testJobId) return;
    const { body } = await POST("/api/cron-manage", {
      action: "toggle",
      jobId: testJobId,
      enabled: false,
    });
    assert.equal(body.ok, true);
  });

  maybeIt(() => gatewayUp, "gateway", "update name via patch succeeds", async () => {
    if (!testJobId) return;
    const { body } = await POST("/api/cron-manage", {
      action: "update",
      jobId: testJobId,
      patch: { name: `${testJobName}-renamed` },
    });
    assert.equal(body.ok, true);
  });

  maybeIt(() => gatewayUp, "gateway", "updated name appears in list", async () => {
    if (!testJobId) return;
    const { body } = await GET("/api/crons");
    const job = body.crons.find(
      (c: { id: string }) => c.id === testJobId,
    );
    assert.ok(job);
    assert.equal(job.name, `${testJobName}-renamed`);
  });
});
