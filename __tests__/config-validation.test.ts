import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, validateSchedule } from "@/app/api/_lib/config-validation";

// ── validateConfig ──────────────────────────────────────────────────────────

describe("validateConfig", () => {
  it("valid minimal config", () => {
    const config = JSON.stringify({
      agents: { list: [{ id: "main", model: { primary: "anthropic/claude-sonnet-4-20250514" } }] },
    });
    const result = validateConfig(config);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("invalid JSON", () => {
    const result = validateConfig("{not valid json");
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes("Invalid JSON"));
  });

  it("missing agents section", () => {
    const result = validateConfig(JSON.stringify({ models: {} }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("Missing 'agents'")));
  });

  it("agents.list not an array", () => {
    const result = validateConfig(JSON.stringify({ agents: { list: "not-array" } }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("must be an array")));
  });

  it("agents.list empty array", () => {
    const result = validateConfig(JSON.stringify({ agents: { list: [] } }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("is empty")));
  });

  it("agent without id field", () => {
    const result = validateConfig(JSON.stringify({ agents: { list: [{ name: "no-id" }] } }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("'id' field")));
  });

  it("agent with empty primary model", () => {
    const config = JSON.stringify({
      agents: { list: [{ id: "main", model: { primary: "  " } }] },
    });
    const result = validateConfig(config);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("empty primary model")));
  });

  it("models.providers not an object", () => {
    const config = JSON.stringify({
      agents: { list: [{ id: "main" }] },
      models: { providers: "string" },
    });
    const result = validateConfig(config);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("'models.providers'")));
  });

  it("valid config with multiple agents and providers", () => {
    const config = JSON.stringify({
      agents: {
        list: [
          { id: "main", model: { primary: "anthropic/claude-sonnet-4-20250514" } },
          { id: "scout", model: { primary: "nvidia/kimi-k2" } },
        ],
      },
      models: { providers: { anthropic: {}, nvidia: {} } },
    });
    const result = validateConfig(config);
    assert.equal(result.ok, true);
  });
});

// ── validateSchedule ────────────────────────────────────────────────────────

describe("validateSchedule", () => {
  it("valid cron with 5 fields", () => {
    assert.equal(validateSchedule({ kind: "cron", expr: "0 9 * * 1-5" }), null);
  });

  it("cron with 3 fields → error", () => {
    const result = validateSchedule({ kind: "cron", expr: "0 9 *" });
    assert.ok(result !== null);
    assert.ok(result!.includes("5 fields"));
  });

  it("cron with missing expr", () => {
    const result = validateSchedule({ kind: "cron" });
    assert.ok(result !== null);
    assert.ok(result!.includes("'expr' string"));
  });

  it("valid every with positive everyMs", () => {
    assert.equal(validateSchedule({ kind: "every", everyMs: 60000 }), null);
  });

  it("every with zero everyMs", () => {
    const result = validateSchedule({ kind: "every", everyMs: 0 });
    assert.ok(result !== null);
    assert.ok(result!.includes("positive number"));
  });

  it("every with negative everyMs", () => {
    const result = validateSchedule({ kind: "every", everyMs: -1000 });
    assert.ok(result !== null);
  });

  it("every with missing everyMs", () => {
    const result = validateSchedule({ kind: "every" });
    assert.ok(result !== null);
  });

  it("unknown kind", () => {
    const result = validateSchedule({ kind: "once" });
    assert.ok(result !== null);
    assert.ok(result!.includes("unknown schedule kind"));
  });
});
