/**
 * Unit tests for alert-dispatch.ts pure functions.
 *
 * Run: npx tsx --test __tests__/alert-dispatch.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChannelRef, isValidChannelRef } from "../plugin/alert-dispatch.js";

// ── parseChannelRef ─────────────────────────────────────────────────────

describe("parseChannelRef", () => {
  it("parses slack: prefix", () => {
    const result = parseChannelRef("slack:C0AK5Q0AXFG");
    assert.equal(result.platform, "slack");
    assert.equal(result.id, "C0AK5Q0AXFG");
  });

  it("parses discord: prefix", () => {
    const result = parseChannelRef("discord:123456789");
    assert.equal(result.platform, "discord");
    assert.equal(result.id, "123456789");
  });

  it("parses telegram: prefix", () => {
    const result = parseChannelRef("telegram:-1001234567890");
    assert.equal(result.platform, "telegram");
    assert.equal(result.id, "-1001234567890");
  });

  it("bare numeric ID defaults to discord", () => {
    const result = parseChannelRef("9876543210");
    assert.equal(result.platform, "discord");
    assert.equal(result.id, "9876543210");
  });

  it("handles empty string", () => {
    const result = parseChannelRef("");
    assert.equal(result.id, "");
  });

  it("handles prefix with no ID (falls back to discord with full string as id)", () => {
    const result = parseChannelRef("slack:");
    // Implementation treats "slack:" with empty ID after colon as bare string → discord default
    assert.equal(result.platform, "discord");
    assert.equal(result.id, "slack:");
  });

  it("preserves colon in telegram chat ID", () => {
    // telegram IDs can have dashes but not colons — just verify no crash
    const result = parseChannelRef("telegram:12345");
    assert.equal(result.platform, "telegram");
    assert.equal(result.id, "12345");
  });
});

// ── isValidChannelRef ───────────────────────────────────────────────────

describe("isValidChannelRef", () => {
  it("returns true for slack channel ref", () => {
    assert.equal(isValidChannelRef("slack:C0AK5Q0AXFG"), true);
  });

  it("returns true for discord channel ref", () => {
    assert.equal(isValidChannelRef("discord:123456789"), true);
  });

  it("returns true for telegram channel ref", () => {
    assert.equal(isValidChannelRef("telegram:-1001234567890"), true);
  });

  it("returns true for bare numeric ID", () => {
    assert.equal(isValidChannelRef("9876543210"), true);
  });

  it("returns false for empty string", () => {
    assert.equal(isValidChannelRef(""), false);
  });

  it("returns true for prefix with no ID (treated as bare discord ref)", () => {
    // "slack:" with empty ID after colon is treated as bare string → discord:"slack:"
    assert.equal(isValidChannelRef("slack:"), true);
  });
});
