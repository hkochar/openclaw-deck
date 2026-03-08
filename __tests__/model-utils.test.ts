import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModel, resolveSessionModel, modelCostPer1M } from "@/app/api/_lib/model-utils";

// ── parseModel ──────────────────────────────────────────────────────────────

describe("parseModel", () => {
  it("standard provider/model", () => {
    const result = parseModel("anthropic/claude-sonnet-4-20250514");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.modelId, "claude-sonnet-4-20250514");
  });

  it("nested slash preserved (openrouter)", () => {
    const result = parseModel("openrouter/meta-llama/llama-3.1-70b");
    assert.equal(result.provider, "openrouter");
    assert.equal(result.modelId, "meta-llama/llama-3.1-70b");
  });

  it("no slash → provider only, empty modelId", () => {
    const result = parseModel("bare-model");
    assert.equal(result.provider, "bare-model");
    assert.equal(result.modelId, "");
  });
});

// ── resolveSessionModel ─────────────────────────────────────────────────────

describe("resolveSessionModel", () => {
  const primary = "anthropic/claude-sonnet-4-20250514";

  it("undefined entry returns configured primary", () => {
    assert.equal(resolveSessionModel(undefined, primary), primary);
  });

  it("full override (provider + model)", () => {
    const entry = { providerOverride: "nvidia", modelOverride: "kimi-k2" };
    assert.equal(resolveSessionModel(entry, primary), "nvidia/kimi-k2");
  });

  it("model override only (no provider)", () => {
    const entry = { modelOverride: "gpt-4o" };
    assert.equal(resolveSessionModel(entry, primary), "gpt-4o");
  });

  it("no overrides returns configured primary", () => {
    const entry = { model: "something", modelProvider: "something" };
    assert.equal(resolveSessionModel(entry, primary), primary);
  });

  it("empty string overrides return configured primary", () => {
    const entry = { providerOverride: "", modelOverride: "" };
    assert.equal(resolveSessionModel(entry, primary), primary);
  });

  it("whitespace-only overrides return configured primary", () => {
    const entry = { providerOverride: "  ", modelOverride: "  " };
    assert.equal(resolveSessionModel(entry, primary), primary);
  });
});

// ── modelCostPer1M ──────────────────────────────────────────────────────────

describe("modelCostPer1M", () => {
  it("null returns 0", () => {
    assert.equal(modelCostPer1M(null), 0);
  });

  it("haiku → 0.25", () => {
    assert.equal(modelCostPer1M("anthropic/claude-3-5-haiku"), 0.25);
  });

  it("sonnet → 3.0", () => {
    assert.equal(modelCostPer1M("anthropic/claude-sonnet-4-20250514"), 3.0);
  });

  it("opus → 15.0", () => {
    assert.equal(modelCostPer1M("anthropic/claude-opus-4-20250514"), 15.0);
  });

  it("kimi (free) → 0", () => {
    assert.equal(modelCostPer1M("nvidia/kimi-k2"), 0);
  });

  it("nvidia (free) → 0", () => {
    assert.equal(modelCostPer1M("nvidia/llama-70b"), 0);
  });

  it("unknown model → 0", () => {
    assert.equal(modelCostPer1M("unknown/some-model"), 0);
  });

  it("case insensitive: HAIKU → 0.25", () => {
    assert.equal(modelCostPer1M("CLAUDE-HAIKU"), 0.25);
  });
});
