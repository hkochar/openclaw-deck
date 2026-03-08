/**
 * Integration tests — Deck Config (deck-agents.json) read/write roundtrip.
 *
 * IMPORTANT: This file mutates config/deck-agents.json but snapshots
 * before and restores after. Tests run sequentially.
 *
 * Run: npx tsx --test __tests__/integration/deck-config-roundtrip.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { GET, POST, isServerUp } from "./helpers.js";

let serverUp = false;
let configSnapshot = "";

const CONFIG_PATH = path.resolve(
  process.env.DECK_ROOT ?? path.resolve(__dirname, "../.."),
  "config/deck-agents.json"
);

before(async () => {
  serverUp = await isServerUp();
  if (!serverUp) {
    console.error("SKIP: Next.js dev server not running at localhost:3000");
    return;
  }
  // Snapshot the config file directly
  try {
    configSnapshot = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    console.error("SKIP: config/deck-agents.json not found at", CONFIG_PATH);
    serverUp = false;
  }
});

after(async () => {
  // Restore original config
  if (serverUp && configSnapshot) {
    fs.writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
  }
});

/** Build a full POST body from GET response */
function postBody(current: Record<string, unknown>, overrides?: Record<string, unknown>) {
  return {
    agents: current.agents,
    systemChannels: current.systemChannels,
    pluginChannels: current.pluginChannels,
    logChannels: current.logChannels,
    ...overrides,
  };
}

// ── GET /api/deck-config ──────────────────────────────────────────────────────

describe("GET /api/deck-config", () => {
  it("returns agents array", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/deck-config");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.agents));
    assert.ok(body.agents.length > 0);
  });

  it("each agent has required fields", async () => {
    if (!serverUp) return;
    const { body } = await GET("/api/deck-config");
    for (const agent of body.agents) {
      assert.ok(typeof agent.id === "string" && agent.id.length > 0, `id missing`);
      assert.ok(typeof agent.key === "string" && agent.key.length > 0, `key missing`);
      assert.ok(typeof agent.name === "string" && agent.name.length > 0, `name missing`);
      assert.ok(typeof agent.emoji === "string" && agent.emoji.length > 0, `emoji missing`);
      assert.ok(typeof agent.discordChannelId === "string", `discordChannelId missing`);
    }
  });

  it("returns all four channel sections", async () => {
    if (!serverUp) return;
    const { body } = await GET("/api/deck-config");
    assert.ok(typeof body.systemChannels === "object");
    assert.ok(typeof body.pluginChannels === "object");
    assert.ok(typeof body.logChannels === "object");
    assert.ok(typeof body.sessionKeys === "object");
  });
});

// ── POST /api/deck-config — validation ────────────────────────────────────────

describe("POST /api/deck-config validation", () => {
  it("empty agents returns 400", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/deck-config", { agents: [] });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(Array.isArray(body.errors));
  });

  it("missing name returns 400 with error", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const { status, body } = await POST("/api/deck-config", postBody(current, {
      agents: [{ id: "main", key: "jane", name: "", emoji: "🌐", discordChannelId: "1000000000000000001" }],
    }));
    assert.equal(status, 400);
    assert.ok(body.errors.some((e: string) => e.includes("name")));
  });

  it("non-numeric channel ID returns 400", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const { status, body } = await POST("/api/deck-config", postBody(current, {
      agents: [{ id: "main", key: "jane", name: "Jane", emoji: "🌐", discordChannelId: "abc" }],
    }));
    assert.equal(status, 400);
    assert.ok(body.errors.some((e: string) => e.includes("snowflake")));
  });

  it("duplicate keys return 400", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const agent = { id: "main", key: "jane", name: "Jane", emoji: "🌐", discordChannelId: "1000000000000000001" };
    const { status, body } = await POST("/api/deck-config", postBody(current, {
      agents: [agent, { ...agent, id: "main2" }],
    }));
    assert.equal(status, 400);
    assert.ok(body.errors.some((e: string) => e.includes("duplicate")));
  });

  it("invalid system channel ID returns 400", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const { status, body } = await POST("/api/deck-config", postBody(current, {
      systemChannels: { ...current.systemChannels, systemStatus: "not-a-number" },
    }));
    assert.equal(status, 400);
    assert.ok(body.errors.some((e: string) => e.includes("System channel")));
  });

  it("empty system channel ID is allowed", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const { status, body } = await POST("/api/deck-config", postBody(current, {
      systemChannels: { ...current.systemChannels, systemStatus: "" },
    }));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it("empty log channels object is allowed", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const { status, body } = await POST("/api/deck-config", postBody(current, {
      logChannels: {},
    }));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });
});

// ── POST /api/deck-config — save roundtrip ────────────────────────────────────

describe("POST /api/deck-config save roundtrip", () => {
  it("saving current config returns ok", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const { status, body } = await POST("/api/deck-config", postBody(current));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it("modifying an agent name persists", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const agents = [...current.agents];
    const originalName = agents[0].name;
    agents[0] = { ...agents[0], name: "TestName_" + Date.now() };

    const { status, body } = await POST("/api/deck-config", postBody(current, { agents }));
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // Re-read and verify
    const { body: reread } = await GET("/api/deck-config");
    assert.equal(reread.agents[0].name, agents[0].name);

    // Restore original
    agents[0] = { ...agents[0], name: originalName };
    await POST("/api/deck-config", postBody(current, { agents }));
  });

  it("adding a new agent persists", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const newAgent = {
      id: "testadd",
      key: "testadd",
      name: "TestAdd",
      role: "Test",
      emoji: "🧪",
      discordChannelId: "9999999999999999999",
      agentDir: "",
    };
    const agents = [...current.agents, newAgent];

    const { status, body } = await POST("/api/deck-config", postBody(current, { agents }));
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const { body: reread } = await GET("/api/deck-config");
    assert.equal(reread.agents.length, current.agents.length + 1);
    assert.ok(reread.agents.some((a: { key: string }) => a.key === "testadd"));
  });

  it("removing an agent persists", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    assert.ok(current.agents.length >= 2, "Need at least 2 agents to test removal");
    const agents = current.agents.slice(0, -1); // remove last

    const { status } = await POST("/api/deck-config", postBody(current, { agents }));
    assert.equal(status, 200);

    const { body: reread } = await GET("/api/deck-config");
    assert.equal(reread.agents.length, current.agents.length - 1);
  });

  it("adding a log channel persists", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const logChannels = { ...current.logChannels, "test-channel": "8888888888888888888" };

    const { status, body } = await POST("/api/deck-config", postBody(current, { logChannels }));
    assert.equal(status, 200);

    const { body: reread } = await GET("/api/deck-config");
    assert.equal(reread.logChannels["test-channel"], "8888888888888888888");
  });

  it("removing a log channel persists", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const keys = Object.keys(current.logChannels);
    assert.ok(keys.length >= 1, "Need at least 1 log channel to test removal");
    const { [keys[keys.length - 1]]: _, ...rest } = current.logChannels;

    const { status } = await POST("/api/deck-config", postBody(current, { logChannels: rest }));
    assert.equal(status, 200);

    const { body: reread } = await GET("/api/deck-config");
    assert.equal(Object.keys(reread.logChannels).length, keys.length - 1);
  });

  it("config file on disk matches API response", async () => {
    if (!serverUp) return;
    const { body: current } = await GET("/api/deck-config");
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    assert.equal(onDisk.agents.length, current.agents.length);
    assert.equal(onDisk.agents[0].key, current.agents[0].key);
  });
});
