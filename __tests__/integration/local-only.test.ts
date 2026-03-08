/**
 * Integration tests — Tier 1: Local-only routes.
 *
 * These routes only need the Next.js dev server + filesystem.
 * No gateway required.
 *
 * Run: npx tsx --test __tests__/integration/local-only.test.ts
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

// ── GET /api/system-log ─────────────────────────────────────────────────────

describe("GET /api/system-log", () => {
  it("returns ok: true with events array", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/system-log?limit=5");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events));
  });

  it("limit param is respected", async () => {
    if (!serverUp) return;
    const { body } = await GET("/api/system-log?limit=1");
    assert.ok(body.events.length <= 1);
  });

  it("categories filter returns matching subset", async () => {
    if (!serverUp) return;
    const { body } = await GET("/api/system-log?categories=testing&limit=50");
    assert.ok(Array.isArray(body.events));
    for (const e of body.events) {
      assert.equal(e.category, "testing");
    }
  });

  it("since far-future returns empty events", async () => {
    if (!serverUp) return;
    const { body } = await GET("/api/system-log?since=9999999999999");
    assert.equal(body.events.length, 0);
  });
});

// ── GET /api/models-list ────────────────────────────────────────────────────

describe("GET /api/models-list", () => {
  it("returns ok: true with non-empty models array", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/models-list");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.models));
    assert.ok(body.models.length > 0);
  });

  it("each model has id, name, provider", async () => {
    if (!serverUp) return;
    const { body } = await GET("/api/models-list");
    for (const m of body.models) {
      assert.ok(typeof m.id === "string" && m.id.length > 0);
      assert.ok(typeof m.name === "string" && m.name.length > 0);
      assert.ok(typeof m.provider === "string" && m.provider.length > 0);
    }
  });

  it("model id contains provider/model format", async () => {
    if (!serverUp) return;
    const { body } = await GET("/api/models-list");
    for (const m of body.models) {
      assert.ok(m.id.includes("/"), `Expected provider/model format: ${m.id}`);
    }
  });
});

// ── GET /api/services ───────────────────────────────────────────────────────

describe("GET /api/services", () => {
  it("returns ok: true with services array", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/services");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.services));
  });
});

// ── GET /api/gateway-health ─────────────────────────────────────────────────

describe("GET /api/gateway-health", () => {
  it("always returns 200 with boolean ok", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/gateway-health");
    assert.equal(status, 200);
    assert.equal(typeof body.ok, "boolean");
  });
});

// ── GET /api/agent-models ───────────────────────────────────────────────────

describe("GET /api/agent-models", () => {
  it("returns ok: true with models object", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/agent-models");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.models, "object");
  });
});

// ── GET /api/agent-docs ─────────────────────────────────────────────────────

describe("GET /api/agent-docs", () => {
  it("returns an array", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/agent-docs");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ── GET /api/git-file — validation ──────────────────────────────────────────

describe("GET /api/git-file validation", () => {
  it("missing file param returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/git-file?action=log");
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("path traversal blocked", async () => {
    if (!serverUp) return;
    const { status, body } = await GET(
      "/api/git-file?action=log&file=../../etc/passwd",
    );
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("invalid SHA in show action returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await GET(
      "/api/git-file?action=show&file=openclaw.json&sha=INVALID",
    );
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("absolute path blocked", async () => {
    if (!serverUp) return;
    const { status, body } = await GET(
      "/api/git-file?action=log&file=/etc/passwd",
    );
    assert.equal(status, 400);
    assert.ok(body.error);
  });
});

// ── POST /api/gateway-control — validation ──────────────────────────────────

describe("POST /api/gateway-control validation", () => {
  it("unknown action returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/gateway-control", {
      action: "explode",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("GET always returns ok + output shape", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/gateway-control");
    assert.equal(status, 200);
    assert.equal(typeof body.ok, "boolean");
    assert.equal(typeof body.output, "string");
  });
});

// ── POST /api/cron-manage — validation ──────────────────────────────────────

describe("POST /api/cron-manage validation", () => {
  it("unknown action returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/cron-manage", {
      action: "nope",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("toggle missing jobId returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/cron-manage", {
      action: "toggle",
      enabled: true,
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});
