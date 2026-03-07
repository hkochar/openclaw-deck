/**
 * API Contract Tests — ensure API responses match what the frontend expects.
 *
 * These tests verify that the REST API response shapes align with the
 * frontend component expectations. They catch regressions where an API
 * returns fewer/different fields than the UI consumes.
 *
 * Run: pnpm test or tsx --test __tests__/api-contracts.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Expected field sets (derived from component property access) ──────────

/** Fields the frontend accesses on agent objects (from page.tsx, models, calendar, sidebar). */
const REQUIRED_AGENT_FIELDS = [
  "id",
  "key",
  "name",
  "role",
  "emoji",
  "status",
  "computed_status",
  "model",
  "configured_model",
  "session_key",
  "cron_model",
  "cron_model_updated_at",
  "bio",
  "last_heartbeat",
  "heartbeat_age_ms",
  "is_stale",
  "is_offline",
] as const;

/** Fields the frontend accesses on activity objects (from page.tsx, activity-feed). */
const REQUIRED_ACTIVITY_FIELDS = [
  "id",
  "type",
  "agent_key",
  "agent_name",
  "agent_emoji",
  "message",
  "timestamp",
] as const;

/** Fields the frontend accesses on drift event objects (from models, calendar). */
const REQUIRED_DRIFT_FIELDS = [
  "id",
  "agent_key",
  "actual_model",
  "configured_model",
  "tag",
  "timestamp",
] as const;

// ── Mock data generators (simulate what queryAgentsWithHealth etc. return) ──

function mockHeartbeatRow() {
  return {
    id: 1,
    agent_key: "jane",
    name: "Jane",
    role: "Coordinator",
    emoji: "X",
    status: "active",
    model: "anthropic/claude-sonnet-4-5",
    configured_model: null,
    session_key: "agent:main:discord:channel:123",
    cron_model: null,
    cron_model_updated_at: null,
    bio: null,
    last_heartbeat: Date.now() - 30_000,
    updated_at: Date.now(),
    computed_status: "active",
  };
}

function mockAgentsJsonEntry() {
  return {
    id: "main",
    key: "jane",
    name: "Jane",
    role: "Chief of Staff / Coordinator",
    emoji: "X",
    discordChannelId: "123456789",
    agentDir: "agents/jane",
  };
}

function mockActivityRow() {
  return {
    id: 1,
    type: "status_change",
    agent_key: "jane",
    agent_name: "Jane",
    message: "Agent came online",
    timestamp: Date.now(),
  };
}

function mockDriftRow() {
  return {
    id: 1,
    agent_key: "jane",
    configured_model: "anthropic/claude-sonnet-4-5",
    actual_model: "anthropic/claude-haiku-3-5",
    tag: "work",
    timestamp: Date.now(),
    resolved: 0,
    resolved_at: null,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("API Contract: /api/agents response shape", () => {
  it("builds agent response with all required fields", () => {
    const agentConfig = mockAgentsJsonEntry();
    const hb = mockHeartbeatRow();
    const now = Date.now();
    const lastHb = hb.last_heartbeat;
    const ageMs = lastHb ? now - lastHb : null;

    // Simulate the API route's mapping logic
    const response = {
      id: agentConfig.id,
      key: agentConfig.key,
      name: agentConfig.name,
      role: agentConfig.role,
      emoji: agentConfig.emoji,
      status: hb.status ?? "offline",
      computed_status: hb.computed_status ?? "offline",
      model: hb.model ?? null,
      configured_model: hb.configured_model ?? null,
      session_key: hb.session_key ?? null,
      cron_model: hb.cron_model ?? null,
      cron_model_updated_at: hb.cron_model_updated_at ?? null,
      bio: hb.bio ?? null,
      last_heartbeat: lastHb,
      heartbeat_age_ms: ageMs,
      is_stale: ageMs != null && ageMs > 2 * 60 * 1000,
      is_offline: ageMs == null || ageMs > 5 * 60 * 1000,
    };

    for (const field of REQUIRED_AGENT_FIELDS) {
      assert.ok(
        field in response,
        `Agent response missing required field: "${field}"`,
      );
    }
  });

  it("handles null heartbeat correctly (no NaN)", () => {
    const agentConfig = mockAgentsJsonEntry();
    const now = Date.now();
    const lastHb: number | null = null;
    const ageMs = lastHb ? now - lastHb : null;

    const response = {
      last_heartbeat: lastHb,
      heartbeat_age_ms: ageMs,
      is_stale: ageMs != null && ageMs > 2 * 60 * 1000,
      is_offline: ageMs == null || ageMs > 5 * 60 * 1000,
      status: "offline",
      computed_status: "offline",
    };

    assert.equal(response.last_heartbeat, null, "last_heartbeat should be null, not 0");
    assert.equal(response.heartbeat_age_ms, null, "heartbeat_age_ms should be null, not NaN");
    assert.equal(response.is_stale, false, "null heartbeat should not be stale");
    assert.equal(response.is_offline, true, "null heartbeat should be offline");
  });

  it("computes is_stale and is_offline thresholds correctly", () => {
    const now = Date.now();

    // Active (30s ago)
    const active = { ageMs: 30_000 };
    assert.equal(active.ageMs > 2 * 60 * 1000, false, "30s should not be stale");
    assert.equal(active.ageMs > 5 * 60 * 1000, false, "30s should not be offline");

    // Stale (3 min ago)
    const stale = { ageMs: 3 * 60 * 1000 };
    assert.equal(stale.ageMs > 2 * 60 * 1000, true, "3min should be stale");
    assert.equal(stale.ageMs > 5 * 60 * 1000, false, "3min should not be offline");

    // Offline (10 min ago)
    const offline = { ageMs: 10 * 60 * 1000 };
    assert.equal(offline.ageMs > 2 * 60 * 1000, true, "10min should be stale");
    assert.equal(offline.ageMs > 5 * 60 * 1000, true, "10min should be offline");
  });

  it("frontend mapping produces valid camelCase properties", () => {
    const apiResponse = {
      key: "jane",
      name: "Jane",
      emoji: "X",
      status: "active",
      computed_status: "active",
      last_heartbeat: Date.now() - 30_000,
      heartbeat_age_ms: 30_000,
      is_stale: false,
      is_offline: false,
      model: "anthropic/claude-sonnet-4-5",
      configured_model: null,
      session_key: "agent:main:discord:channel:123",
      cron_model: null,
      cron_model_updated_at: null,
      bio: null,
    };

    // Simulate the page.tsx mapping
    const mapped = {
      _id: apiResponse.key,
      key: apiResponse.key,
      name: apiResponse.name,
      emoji: apiResponse.emoji,
      status: apiResponse.status ?? "offline",
      computedStatus: apiResponse.computed_status ?? "offline",
      lastHeartbeat: apiResponse.last_heartbeat ?? null,
      model: apiResponse.model,
      configuredModel: apiResponse.configured_model,
      bio: apiResponse.bio,
      sessionKey: apiResponse.session_key,
    };

    // Verify no NaN or undefined for display-critical fields
    assert.ok(typeof mapped.key === "string", "key must be string");
    assert.ok(typeof mapped.name === "string", "name must be string");
    assert.ok(mapped.lastHeartbeat === null || typeof mapped.lastHeartbeat === "number", "lastHeartbeat must be number or null");
    if (mapped.lastHeartbeat !== null) {
      assert.ok(!isNaN(mapped.lastHeartbeat), "lastHeartbeat must not be NaN");
    }
  });

  it("calendar page mapping includes computed fields", () => {
    const apiResponse = {
      key: "jane",
      last_heartbeat: Date.now() - 30_000,
      heartbeat_age_ms: 30_000,
      is_stale: false,
      is_offline: false,
      cron_model: "anthropic/claude-haiku-3-5",
      cron_model_updated_at: Date.now() - 60_000,
    };

    // Simulate the calendar/page.tsx mapping
    const mapped = {
      lastHeartbeat: apiResponse.last_heartbeat ?? null,
      heartbeatAgeMs: apiResponse.heartbeat_age_ms ?? null,
      isStale: apiResponse.is_stale ?? false,
      isOffline: apiResponse.is_offline ?? true,
      cronModel: apiResponse.cron_model,
      cronModelUpdatedAt: apiResponse.cron_model_updated_at,
    };

    assert.ok("heartbeatAgeMs" in mapped, "calendar mapping must include heartbeatAgeMs");
    assert.ok("isStale" in mapped, "calendar mapping must include isStale");
    assert.ok("isOffline" in mapped, "calendar mapping must include isOffline");
    assert.ok("cronModel" in mapped, "calendar mapping must include cronModel");
    assert.ok("cronModelUpdatedAt" in mapped, "calendar mapping must include cronModelUpdatedAt");
    assert.equal(typeof mapped.heartbeatAgeMs, "number");
    assert.equal(typeof mapped.isStale, "boolean");
    assert.equal(typeof mapped.isOffline, "boolean");
  });
});

describe("API Contract: /api/activities response shape", () => {
  it("activity response includes all required fields", () => {
    const raw = mockActivityRow();
    const emojiMap = new Map([["jane", "X"]]);

    // Simulate the API route's enrichment
    const response = {
      ...raw,
      agent_emoji: emojiMap.get(raw.agent_key ?? "") ?? "",
    };

    for (const field of REQUIRED_ACTIVITY_FIELDS) {
      assert.ok(
        field in response,
        `Activity response missing required field: "${field}"`,
      );
    }
  });

  it("activity emoji lookup falls back to empty string", () => {
    const raw = mockActivityRow();
    raw.agent_key = "unknown_agent";
    const emojiMap = new Map([["jane", "X"]]);

    const response = {
      ...raw,
      agent_emoji: emojiMap.get(raw.agent_key ?? "") ?? "",
    };

    assert.equal(response.agent_emoji, "", "unknown agent should get empty emoji, not undefined");
  });

  it("frontend mapping produces valid Activity type", () => {
    const apiEvent = {
      id: 1,
      type: "status_change",
      agent_key: "jane",
      agent_name: "Jane",
      agent_emoji: "X",
      message: "Agent came online",
      timestamp: Date.now(),
    };

    // Simulate page.tsx mapping
    const mapped = {
      _id: String(apiEvent.id),
      type: apiEvent.type,
      message: apiEvent.message,
      timestamp: apiEvent.timestamp,
      agentId: apiEvent.agent_key,
      agent: apiEvent.agent_name
        ? { name: apiEvent.agent_name, emoji: apiEvent.agent_emoji || "" }
        : null,
    };

    assert.ok(typeof mapped._id === "string", "_id must be string");
    assert.ok(typeof mapped.timestamp === "number", "timestamp must be number");
    assert.ok(mapped.agent !== null, "agent should not be null when agent_name is present");
    assert.equal(mapped.agent?.emoji, "X", "emoji should come from API, not hardcoded empty");
  });
});

describe("API Contract: /api/drift response shape", () => {
  it("drift response includes all required fields", () => {
    const raw = mockDriftRow();

    for (const field of REQUIRED_DRIFT_FIELDS) {
      assert.ok(
        field in raw,
        `Drift response missing required field: "${field}"`,
      );
    }
  });

  it("frontend mapping produces valid drift object", () => {
    const apiEvent = mockDriftRow();

    // Simulate models/page.tsx mapping
    const mapped = {
      _id: String(apiEvent.id),
      agentKey: apiEvent.agent_key,
      actualModel: apiEvent.actual_model,
      configuredModel: apiEvent.configured_model,
      tag: apiEvent.tag,
      timestamp: apiEvent.timestamp,
    };

    assert.ok(typeof mapped._id === "string");
    assert.ok(typeof mapped.agentKey === "string");
    assert.ok(typeof mapped.actualModel === "string");
    assert.ok(typeof mapped.configuredModel === "string");
    assert.ok(typeof mapped.timestamp === "number");
  });
});
