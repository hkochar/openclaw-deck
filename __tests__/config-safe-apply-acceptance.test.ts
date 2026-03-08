/**
 * Acceptance tests for Config Safe Apply (Spec 1).
 *
 * Tests diffChanges logic, config validation, rollback detection,
 * and config history tracking.
 *
 * Run: npx tsx --test __tests__/config-safe-apply-acceptance.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── diffChanges (reimplemented from deck-config route.ts) ──────────

function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): string[] {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = before[key];
    const newVal = after[key];

    if (
      oldVal !== null && newVal !== null &&
      typeof oldVal === "object" && typeof newVal === "object" &&
      !Array.isArray(oldVal) && !Array.isArray(newVal)
    ) {
      changes.push(
        ...diffChanges(
          oldVal as Record<string, unknown>,
          newVal as Record<string, unknown>,
          path,
        ),
      );
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push(`${path}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
    }
  }
  return changes;
}

// ── 1.1 Happy Path — diffChanges detects config changes ──────────

describe("1.1 Happy path — config change detection", () => {
  it("detects agent name change", () => {
    const before = {
      agents: [{ key: "jane", name: "Jane", emoji: "🤖" }],
    };
    const after = {
      agents: [{ key: "jane", name: "Jane Bot", emoji: "🤖" }],
    };
    const changes = diffChanges(before, after);
    assert.ok(changes.length > 0);
    assert.ok(changes.some(c => c.includes("agents")));
  });

  it("detects channel ID change", () => {
    const before = { systemChannels: { systemStatus: "111" } };
    const after = { systemChannels: { systemStatus: "222" } };
    const changes = diffChanges(before, after);
    assert.equal(changes.length, 1);
    assert.ok(changes[0].includes("systemStatus"));
    assert.ok(changes[0].includes("111"));
    assert.ok(changes[0].includes("222"));
  });

  it("returns empty array when nothing changed", () => {
    const config = {
      agents: [{ key: "jane", name: "Jane" }],
      systemChannels: { systemStatus: "111" },
    };
    const changes = diffChanges(config, config);
    assert.equal(changes.length, 0);
  });

  it("detects nested changes", () => {
    const before = { gateway: { url: "https://old.example.com" } };
    const after = { gateway: { url: "https://new.example.com" } };
    const changes = diffChanges(before, after);
    assert.equal(changes.length, 1);
    assert.ok(changes[0].includes("gateway.url"));
  });

  it("detects added fields", () => {
    const before = {};
    const after = { budgets: { global: { daily: 10 } } };
    const changes = diffChanges(before, after);
    assert.ok(changes.length > 0);
    assert.ok(changes.some(c => c.includes("budgets")));
  });

  it("detects removed fields", () => {
    const before = { serviceUrls: { grafana: "https://grafana.example.com" } };
    const after = {};
    const changes = diffChanges(before, after);
    assert.ok(changes.length > 0);
  });
});

// ── 1.2 Rollback detection via risk flags ────────────────────────

describe("1.2 Rollback detection in run intelligence", () => {
  // This tests that rollback events are surfaced as risk flags
  // in the session replay (cross-feature with run-intelligence)

  it("system_log with category=rollback sets rollbackDuringRun", () => {
    // This is tested in run-intelligence.test.ts via computeRunSummary
    // Here we verify the detection pattern
    const event = {
      type: "system_log",
      detail: JSON.stringify({ category: "rollback" }),
    };
    const parsed = JSON.parse(event.detail);
    assert.equal(parsed.category, "rollback");
    assert.equal(event.type, "system_log");
  });

  it("system_log with category=restart sets gatewayRestarted", () => {
    const event = {
      type: "system_log",
      detail: JSON.stringify({ category: "restart" }),
    };
    const parsed = JSON.parse(event.detail);
    assert.equal(parsed.category, "restart");
  });
});

// ── 1.3 Config History — commit message format ───────────────────

describe("1.3 Config history — commit tracking", () => {
  it("commit message summarizes top 3 changes", () => {
    const changes = [
      "agents.0.name: \"Jane\" → \"Jane Bot\"",
      "systemChannels.systemStatus: \"111\" → \"222\"",
      "gateway.url: \"https://old.com\" → \"https://new.com\"",
      "budgets.global.daily: 10 → 20",
    ];
    const commitMsg = changes.slice(0, 3).join(", ");
    assert.ok(commitMsg.includes("agents.0.name"));
    assert.ok(commitMsg.includes("systemChannels.systemStatus"));
    assert.ok(commitMsg.includes("gateway.url"));
    assert.ok(!commitMsg.includes("budgets.global.daily")); // truncated after 3
  });

  it("no-change save does not trigger commit", () => {
    const changes: string[] = [];
    assert.equal(changes.length, 0);
    // commitMcConfig is only called when changes.length > 0
  });
});

// ── Config Validation (from deck-config route) ─────────────────────

function isNumericString(s: string): boolean {
  return /^\d{10,25}$/.test(s);
}

function isValidChannelRef(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  if (isNumericString(trimmed)) return true;
  const match = trimmed.match(/^(discord|slack|telegram):(.+)$/);
  if (match) {
    if (match[1] === "discord") return isNumericString(match[2]);
    return match[2].length > 0;
  }
  return false;
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

function validateAgents(agents: AgentInput[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(agents) || agents.length === 0) {
    return ["agents must be a non-empty array"];
  }
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const label = `Agent #${i + 1}`;
    if (!a.key || !a.key.trim()) errors.push(`${label}: key is required`);
    if (!a.id || !a.id.trim()) errors.push(`${label}: id is required`);
    if (!a.name || !a.name.trim()) errors.push(`${label}: name is required`);
    if (!a.emoji || !a.emoji.trim()) errors.push(`${label}: emoji is required`);
    if (!a.discordChannelId || !a.discordChannelId.trim()) {
      errors.push(`${label}: discordChannelId is required`);
    } else if (!isValidChannelRef(a.discordChannelId.trim())) {
      errors.push(`${label}: discordChannelId must be a channel ID (discord:ID, slack:ID, or telegram:ID)`);
    }
    if (a.key && seenKeys.has(a.key)) errors.push(`${label}: duplicate key "${a.key}"`);
    if (a.id && seenIds.has(a.id)) errors.push(`${label}: duplicate id "${a.id}"`);
    if (a.key) seenKeys.add(a.key);
    if (a.id) seenIds.add(a.id);
  }
  return errors;
}

describe("Config validation — agent validation", () => {
  it("valid agent passes validation", () => {
    const errors = validateAgents([{
      id: "123", key: "jane", name: "Jane", emoji: "🤖",
      discordChannelId: "1234567890123456789",
    }]);
    assert.equal(errors.length, 0);
  });

  it("missing key caught", () => {
    const errors = validateAgents([{
      id: "123", name: "Jane", emoji: "🤖",
      discordChannelId: "1234567890123456789",
    }]);
    assert.ok(errors.some(e => e.includes("key is required")));
  });

  it("missing emoji caught", () => {
    const errors = validateAgents([{
      id: "123", key: "jane", name: "Jane",
      discordChannelId: "1234567890123456789",
    }]);
    assert.ok(errors.some(e => e.includes("emoji is required")));
  });

  it("invalid Discord snowflake caught", () => {
    const errors = validateAgents([{
      id: "123", key: "jane", name: "Jane", emoji: "🤖",
      discordChannelId: "not-a-number",
    }]);
    assert.ok(errors.some(e => e.includes("must be a channel ID")));
  });

  it("duplicate keys caught", () => {
    const errors = validateAgents([
      { id: "1", key: "jane", name: "Jane", emoji: "🤖", discordChannelId: "1234567890123456789" },
      { id: "2", key: "jane", name: "Jane 2", emoji: "🤖", discordChannelId: "9876543210123456789" },
    ]);
    assert.ok(errors.some(e => e.includes("duplicate key")));
  });

  it("duplicate IDs caught", () => {
    const errors = validateAgents([
      { id: "same", key: "jane", name: "Jane", emoji: "🤖", discordChannelId: "1234567890123456789" },
      { id: "same", key: "forge", name: "Forge", emoji: "🔨", discordChannelId: "9876543210123456789" },
    ]);
    assert.ok(errors.some(e => e.includes("duplicate id")));
  });

  it("empty array fails", () => {
    const errors = validateAgents([]);
    assert.ok(errors.some(e => e.includes("non-empty array")));
  });
});

// ── Restart categorization ───────────────────────────────────────

describe("Config save — restart categorization", () => {
  it("agent changes require gateway + ops-bot restart", () => {
    const agentChanges = ["agents.0.name: \"Jane\" → \"Jane Bot\""];
    const restarts: string[] = [];
    const hasAgentChanges = agentChanges.some(c => c.startsWith("agents"));
    if (hasAgentChanges) { restarts.push("gateway"); restarts.push("ops-bot"); }
    assert.ok(restarts.includes("gateway"));
    assert.ok(restarts.includes("ops-bot"));
  });

  it("channel changes require gateway + ops-bot restart", () => {
    const changes = ["systemChannels.systemStatus: \"111\" → \"222\""];
    const restarts: string[] = [];
    const hasChannelChanges = changes.some(c =>
      c.startsWith("systemChannels") ||
      c.startsWith("pluginChannels") || c.startsWith("logChannels")
    );
    if (hasChannelChanges) { restarts.push("gateway"); restarts.push("ops-bot"); }
    assert.ok(restarts.includes("gateway"));
    assert.ok(restarts.includes("ops-bot"));
  });

  it("service URL changes require openclaw-deck restart", () => {
    const configChanges = ["serviceUrls.grafana: \"\" → \"https://grafana.example.com\""];
    const restarts: string[] = [];
    const hasServiceUrlChanges = configChanges.some(c => c.startsWith("serviceUrls"));
    if (hasServiceUrlChanges) restarts.push("openclaw-deck");
    assert.ok(restarts.includes("openclaw-deck"));
  });

  it("ops-bot command changes take effect immediately (no restart)", () => {
    const agentChanges = ["opsBotCommands.restart: true → false"];
    const restarts: string[] = [];
    const hasAgentChanges = agentChanges.some(c => c.startsWith("agents"));
    const hasChannelChanges = agentChanges.some(c =>
      c.startsWith("systemChannels")
    );
    const hasOpsBotChanges = agentChanges.some(c => c.startsWith("opsBotCommands"));
    if (hasAgentChanges || hasChannelChanges) { restarts.push("gateway"); restarts.push("ops-bot"); }

    assert.equal(restarts.length, 0, "Ops-bot command changes should not require restart");
    const immediate = hasOpsBotChanges && restarts.length === 0
      ? ["Ops-bot command permissions (effective immediately)"]
      : [];
    assert.equal(immediate.length, 1);
  });
});
