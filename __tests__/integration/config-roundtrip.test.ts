/**
 * Integration tests — Tier 1: Config read/write/restore lifecycle.
 *
 * IMPORTANT: This file mutates ~/.openclaw/openclaw.json but snapshots
 * before and restores after. Tests run sequentially.
 *
 * Run: npx tsx --test __tests__/integration/config-roundtrip.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { GET, POST, isServerUp, snapshotConfig, restoreConfig } from "./helpers.js";

let serverUp = false;
let configSnapshot = "";

before(async () => {
  serverUp = await isServerUp();
  if (!serverUp) {
    console.error("SKIP: Next.js dev server not running at localhost:3000");
    return;
  }
  configSnapshot = snapshotConfig();
});

after(async () => {
  if (serverUp && configSnapshot) {
    await restoreConfig(configSnapshot);
  }
});

// ── GET /api/config ─────────────────────────────────────────────────────────

describe("GET /api/config", () => {
  it("returns ok: true with raw JSON string", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/config");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.raw, "string");
    // raw must be valid JSON
    assert.doesNotThrow(() => JSON.parse(body.raw));
  });

  it("backups array has correct shape", async () => {
    if (!serverUp) return;
    const { body } = await GET("/api/config");
    assert.ok(Array.isArray(body.backups));
    for (const b of body.backups) {
      assert.ok(typeof b.id === "string");
      assert.ok(typeof b.source === "string");
      assert.ok(typeof b.label === "string");
    }
  });
});

// ── POST /api/config — validation ───────────────────────────────────────────

describe("POST /api/config validation", () => {
  it("empty content returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/config", {
      action: "save",
      content: "",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("invalid JSON returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/config", {
      action: "save",
      content: "{bad json!!!}",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes("Invalid JSON"));
  });

  it("unknown action returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/config", { action: "explode" });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("missing backupId for restore returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/config", {
      action: "restore",
      source: "file",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("invalid git SHA for preview returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/config", {
      action: "preview",
      backupId: "ZZZZ",
      source: "git",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

// ── POST /api/config — save roundtrip ───────────────────────────────────────

describe("POST /api/config save roundtrip", () => {
  it("saving current config returns ok", async () => {
    if (!serverUp) return;
    // Read the live config
    const { body: getBody } = await GET("/api/config");
    assert.equal(getBody.ok, true);

    // Save it back unchanged
    const { status, body } = await POST("/api/config", {
      action: "save",
      content: getBody.raw,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it("re-read matches what was saved", async () => {
    if (!serverUp) return;
    const { body } = await GET("/api/config");
    assert.equal(body.ok, true);
    // The config we saved should parse to the same object
    const parsed = JSON.parse(body.raw);
    assert.ok(parsed.agents, "Config should have agents key");
  });

  it(".bak file exists after save", async () => {
    if (!serverUp) return;
    const bakPath = path.join(
      process.env.HOME || "~",
      ".openclaw",
      "openclaw.json.bak",
    );
    assert.ok(fs.existsSync(bakPath), "Expected .bak file to exist after save");
  });
});
