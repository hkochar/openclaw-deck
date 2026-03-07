/**
 * Integration tests — Tier 1b: Additional local-only routes.
 *
 * These routes only need the Next.js dev server + filesystem.
 * No gateway required.
 *
 * Run: npx tsx --test __tests__/integration/local-only-2.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { GET, POST, isServerUp } from "./helpers.js";

let serverUp = false;

before(async () => {
  serverUp = await isServerUp();
  if (!serverUp) {
    console.error("SKIP: Next.js dev server not running at localhost:3000");
  }
});

// ── GET /api/sentinel-config ────────────────────────────────────────────────

describe("GET /api/sentinel-config", () => {
  it("returns config with checks object", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/sentinel-config");
    // Returns 200 with raw config or 404 if file missing
    if (status === 200) {
      assert.equal(typeof body.checks, "object");
      assert.equal(typeof body.loop_interval_seconds, "number");
    } else {
      assert.equal(status, 404);
    }
  });
});

describe("POST /api/sentinel-config validation", () => {
  it("rejects config with invalid loop_interval_seconds", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/sentinel-config", {
      loop_interval_seconds: 5,
      checks: {},
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

// ── GET /api/service-control (log tailing) ──────────────────────────────────

describe("GET /api/service-control", () => {
  it("returns 400 without service param", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/service-control");
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("returns log lines or 404 for known service", async () => {
    if (!serverUp) return;
    const { status, body } = await GET(
      "/api/service-control?service=gateway&lines=10",
    );
    // Either 200 with log lines or 404 if no log file
    assert.ok(status === 200 || status === 404);
    if (status === 200) {
      assert.equal(body.ok, true);
      assert.equal(typeof body.lines, "string");
    }
  });
});

// ── POST /api/service-control validation ────────────────────────────────────

describe("POST /api/service-control validation", () => {
  it("unknown service returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/service-control", {
      service: "ai.openclaw.fake",
      action: "restart",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("unknown action returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/service-control", {
      service: "ai.openclaw.gateway",
      action: "explode",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

// ── GET /api/test-run ───────────────────────────────────────────────────────

describe("GET /api/test-run", () => {
  it("returns ok: true with suites object", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/test-run");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.suites, "object");
  });
});
