import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentSessionKey, AGENT_DISCORD_CHANNELS } from "@/app/api/_lib/discord-channels";

describe("agentSessionKey", () => {
  it("jane maps to agent:main", () => {
    const key = agentSessionKey("jane");
    assert.ok(key.startsWith("agent:main:discord:channel:"));
    assert.ok(key.includes(AGENT_DISCORD_CHANNELS.jane));
  });

  it("scout maps to agent:scout", () => {
    const key = agentSessionKey("scout");
    assert.ok(key.startsWith("agent:scout:discord:channel:"));
    assert.ok(key.includes(AGENT_DISCORD_CHANNELS.scout));
  });

  it("unknown agent falls back to jane channel", () => {
    const key = agentSessionKey("nonexistent");
    assert.ok(key.includes(AGENT_DISCORD_CHANNELS.jane));
  });
});
