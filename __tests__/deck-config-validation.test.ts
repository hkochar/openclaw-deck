/**
 * Unit tests for Deck Config (agents.json) validation.
 *
 * Tests the server-side validation logic extracted inline from the route.
 * Run: npx tsx --test __tests__/deck-config-validation.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Since validation is inline in the route, we replicate the core logic here.
// This mirrors the validateMcConfig function from app/api/deck-config/route.ts.

function isNumericString(s: string): boolean {
  return /^\d{10,25}$/.test(s);
}

interface AgentInput {
  id?: string;
  key?: string;
  name?: string;
  role?: string;
  emoji?: string;
  discordChannelId?: string;
  agentDir?: string;
}

function validateMcConfig(body: {
  agents?: AgentInput[];
  systemChannels?: Record<string, string>;
  pluginChannels?: Record<string, string>;
  logChannels?: Record<string, string>;
}): string[] {
  const errors: string[] = [];

  if (!Array.isArray(body.agents) || body.agents.length === 0) {
    errors.push("agents must be a non-empty array");
    return errors;
  }

  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();

  for (let i = 0; i < body.agents.length; i++) {
    const a = body.agents[i];
    const label = `Agent #${i + 1}`;
    if (!a.key || !a.key.trim()) errors.push(`${label}: key is required`);
    if (!a.id || !a.id.trim()) errors.push(`${label}: id is required`);
    if (!a.name || !a.name.trim()) errors.push(`${label}: name is required`);
    if (!a.emoji || !a.emoji.trim()) errors.push(`${label}: emoji is required`);
    if (!a.discordChannelId || !a.discordChannelId.trim()) {
      errors.push(`${label}: discordChannelId is required`);
    } else if (!isNumericString(a.discordChannelId.trim())) {
      errors.push(`${label}: discordChannelId must be a numeric Discord snowflake`);
    }
    if (a.key && seenKeys.has(a.key)) errors.push(`${label}: duplicate key "${a.key}"`);
    if (a.id && seenIds.has(a.id)) errors.push(`${label}: duplicate id "${a.id}"`);
    if (a.key) seenKeys.add(a.key);
    if (a.id) seenIds.add(a.id);
  }

  function validateChannelSection(
    section: Record<string, string> | undefined,
    sectionName: string,
    requiredKeys: string[],
  ) {
    if (!section || typeof section !== "object") {
      errors.push(`${sectionName} is required`);
      return;
    }
    for (const key of requiredKeys) {
      if (!(key in section)) {
        errors.push(`${sectionName} "${key}" is required`);
      }
    }
    for (const [name, id] of Object.entries(section)) {
      if (id && id.trim() && !isNumericString(id.trim())) {
        errors.push(`${sectionName} "${name}": must be a numeric Discord snowflake`);
      }
    }
  }

  validateChannelSection(body.systemChannels, "System channel", ["systemStatus", "agentMonitoring"]);
  validateChannelSection(body.pluginChannels, "Plugin channel", ["model-drift"]);

  // Log channels — optional, but validate IDs if present
  if (body.logChannels && typeof body.logChannels === "object") {
    for (const [name, id] of Object.entries(body.logChannels)) {
      if (!id || !isNumericString(id.trim())) {
        errors.push(`Log channel "${name}": must be a numeric Discord snowflake`);
      }
    }
  }

  return errors;
}

// ── Valid configs ──────────────────────────────────────────────────────────

describe("validateMcConfig", () => {
  const validAgent: AgentInput = {
    id: "main",
    key: "jane",
    name: "Jane",
    emoji: "🌐",
    role: "Coordinator",
    discordChannelId: "1000000000000000001",
    agentDir: "",
  };

  const validSystemChannels = {
    systemStatus: "1000000000000000002",
    agentMonitoring: "1000000000000000003",
  };

  const validPluginChannels = {
    "model-drift": "1000000000000000007",
  };

  const validLogChannels = {
    "deck-qa": "1000000000000000009",
  };

  const allValid = {
    agents: [validAgent],
    systemChannels: validSystemChannels,
    pluginChannels: validPluginChannels,
    logChannels: validLogChannels,
  };

  it("valid minimal config passes", () => {
    const errors = validateMcConfig(allValid);
    assert.equal(errors.length, 0);
  });

  it("valid config with multiple agents", () => {
    const errors = validateMcConfig({
      ...allValid,
      agents: [
        validAgent,
        { ...validAgent, id: "scout", key: "scout", name: "Scout", emoji: "🔍", discordChannelId: "1000000000000000010" },
      ],
    });
    assert.equal(errors.length, 0);
  });

  it("valid config with no log channels", () => {
    const errors = validateMcConfig({ ...allValid, logChannels: undefined });
    assert.equal(errors.length, 0);
  });

  it("valid config with empty log channels object", () => {
    const errors = validateMcConfig({ ...allValid, logChannels: {} });
    assert.equal(errors.length, 0);
  });

  // ── Missing/empty fields ────────────────────────────────────────────────

  it("empty agents array fails", () => {
    const errors = validateMcConfig({ agents: [] });
    assert.ok(errors.some((e) => e.includes("non-empty array")));
  });

  it("missing agents fails", () => {
    const errors = validateMcConfig({});
    assert.ok(errors.some((e) => e.includes("non-empty array")));
  });

  it("empty name fails", () => {
    const errors = validateMcConfig({ ...allValid, agents: [{ ...validAgent, name: "" }] });
    assert.ok(errors.some((e) => e.includes("name is required")));
  });

  it("empty key fails", () => {
    const errors = validateMcConfig({ ...allValid, agents: [{ ...validAgent, key: "" }] });
    assert.ok(errors.some((e) => e.includes("key is required")));
  });

  it("empty id fails", () => {
    const errors = validateMcConfig({ ...allValid, agents: [{ ...validAgent, id: "" }] });
    assert.ok(errors.some((e) => e.includes("id is required")));
  });

  it("empty emoji fails", () => {
    const errors = validateMcConfig({ ...allValid, agents: [{ ...validAgent, emoji: "" }] });
    assert.ok(errors.some((e) => e.includes("emoji is required")));
  });

  it("empty discordChannelId fails", () => {
    const errors = validateMcConfig({ ...allValid, agents: [{ ...validAgent, discordChannelId: "" }] });
    assert.ok(errors.some((e) => e.includes("discordChannelId is required")));
  });

  // ── Invalid channel IDs ─────────────────────────────────────────────────

  it("non-numeric channel ID fails", () => {
    const errors = validateMcConfig({ ...allValid, agents: [{ ...validAgent, discordChannelId: "abc123" }] });
    assert.ok(errors.some((e) => e.includes("numeric Discord snowflake")));
  });

  it("too-short channel ID fails", () => {
    const errors = validateMcConfig({ ...allValid, agents: [{ ...validAgent, discordChannelId: "12345" }] });
    assert.ok(errors.some((e) => e.includes("numeric Discord snowflake")));
  });

  it("system channel with invalid non-empty ID fails", () => {
    const errors = validateMcConfig({
      ...allValid,
      systemChannels: { ...validSystemChannels, systemStatus: "not-a-number" },
    });
    assert.ok(errors.some((e) => e.includes("System channel")));
  });

  it("system channel with empty ID is allowed (warning not error)", () => {
    const errors = validateMcConfig({
      ...allValid,
      systemChannels: { ...validSystemChannels, systemStatus: "" },
    });
    assert.equal(errors.length, 0);
  });

  it("plugin channel with invalid ID fails", () => {
    const errors = validateMcConfig({
      ...allValid,
      pluginChannels: { ...validPluginChannels, "model-drift": "abc" },
    });
    assert.ok(errors.some((e) => e.includes("Plugin channel")));
  });

  it("log channel with invalid ID fails", () => {
    const errors = validateMcConfig({
      ...allValid,
      logChannels: { "deck-qa": "abc" },
    });
    assert.ok(errors.some((e) => e.includes("Log channel")));
  });

  // ── Duplicates ──────────────────────────────────────────────────────────

  it("duplicate keys fail", () => {
    const errors = validateMcConfig({
      ...allValid,
      agents: [validAgent, { ...validAgent, id: "other" }],
    });
    assert.ok(errors.some((e) => e.includes("duplicate key")));
  });

  it("duplicate ids fail", () => {
    const errors = validateMcConfig({
      ...allValid,
      agents: [validAgent, { ...validAgent, key: "other" }],
    });
    assert.ok(errors.some((e) => e.includes("duplicate id")));
  });

  // ── Optional fields ─────────────────────────────────────────────────────

  it("empty role is allowed", () => {
    const errors = validateMcConfig({ ...allValid, agents: [{ ...validAgent, role: "" }] });
    assert.equal(errors.length, 0);
  });

  it("empty agentDir is allowed", () => {
    const errors = validateMcConfig({ ...allValid, agents: [{ ...validAgent, agentDir: "" }] });
    assert.equal(errors.length, 0);
  });

  it("missing role is allowed", () => {
    const { role: _, ...noRole } = validAgent;
    const errors = validateMcConfig({ ...allValid, agents: [noRole] });
    assert.equal(errors.length, 0);
  });

  // ── Required channel section keys ───────────────────────────────────────

  it("missing systemChannels object fails", () => {
    const errors = validateMcConfig({ ...allValid, systemChannels: undefined });
    assert.ok(errors.some((e) => e.includes("System channel is required")));
  });

  it("missing required system channel key fails", () => {
    const errors = validateMcConfig({ ...allValid, systemChannels: { systemStatus: "1000000000000000002" } });
    assert.ok(errors.some((e) => e.includes('"agentMonitoring" is required')));
  });

  it("missing pluginChannels object fails", () => {
    const errors = validateMcConfig({ ...allValid, pluginChannels: undefined });
    assert.ok(errors.some((e) => e.includes("Plugin channel is required")));
  });

  it("valid plugin channels with only model-drift passes", () => {
    const errors = validateMcConfig({ ...allValid, pluginChannels: { "model-drift": "1000000000000000007" } });
    assert.ok(!errors.some((e) => e.includes("Plugin channel")));
  });
});
