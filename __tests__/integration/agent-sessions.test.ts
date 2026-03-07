/**
 * Integration tests — Agent Sessions API + Session-filtered Logs.
 *
 * Tests the /api/agent-sessions endpoint (local-only, reads filesystem)
 * and the /api/logs?session= filter (requires gateway).
 *
 * Run: npx tsx --test __tests__/integration/agent-sessions.test.ts
 */

import { describe, before } from "node:test";
import assert from "node:assert/strict";
import { GET, isServerUp, isGatewayUp, maybeIt } from "./helpers.js";

let serverUp = false;
let gatewayUp = false;

before(async () => {
  serverUp = await isServerUp();
  gatewayUp = await isGatewayUp();
  if (!serverUp) {
    console.error("SKIP: Next.js dev server not running at localhost:3000");
  }
  if (!gatewayUp) {
    console.error("SKIP (gateway tests): Gateway not running at localhost:18789");
  }
});

// ── GET /api/agent-sessions ─────────────────────────────────────────────────

describe("GET /api/agent-sessions", () => {
  maybeIt(
    () => serverUp,
    "server",
    "returns ok: true with agents array",
    async () => {
      const { status, body } = await GET("/api/agent-sessions");
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.agents));
      assert.ok(body.agents.length > 0, "expected at least one agent");
    },
  );

  maybeIt(
    () => serverUp,
    "server",
    "each agent has required fields",
    async () => {
      const { body } = await GET("/api/agent-sessions");
      for (const agent of body.agents) {
        assert.ok(typeof agent.key === "string" && agent.key.length > 0, `missing key`);
        assert.ok(typeof agent.name === "string" && agent.name.length > 0, `missing name`);
        assert.ok(typeof agent.agentId === "string", `missing agentId`);
        assert.ok(typeof agent.sessionCount === "number", `missing sessionCount`);
        assert.ok(typeof agent.totalTokens === "number", `missing totalTokens`);
        assert.ok(Array.isArray(agent.sessions), `missing sessions array`);
        assert.equal(agent.sessions.length, agent.sessionCount, `sessionCount mismatch`);
      }
    },
  );

  maybeIt(
    () => serverUp,
    "server",
    "each session has required fields including fullKey and sessionId",
    async () => {
      const { body } = await GET("/api/agent-sessions");
      // Find an agent with at least one session
      const agentWithSessions = body.agents.find(
        (a: { sessionCount: number }) => a.sessionCount > 0,
      );
      assert.ok(agentWithSessions, "expected at least one agent with sessions");

      for (const s of agentWithSessions.sessions) {
        assert.ok(typeof s.key === "string", `missing key`);
        assert.ok(typeof s.fullKey === "string" && s.fullKey.length > 0, `missing fullKey`);
        assert.ok(typeof s.sessionId === "string", `missing sessionId (can be empty)`);
        assert.ok(typeof s.channel === "string", `missing channel`);
        assert.ok(typeof s.model === "string", `missing model`);
        assert.ok(typeof s.totalTokens === "number", `missing totalTokens`);
        assert.ok(typeof s.hasTranscript === "boolean", `missing hasTranscript`);
        assert.ok(typeof s.transcriptSizeKB === "number", `missing transcriptSizeKB`);
      }
    },
  );

  maybeIt(
    () => serverUp,
    "server",
    "sessions are sorted by updatedAt descending",
    async () => {
      const { body } = await GET("/api/agent-sessions");
      const agentWithSessions = body.agents.find(
        (a: { sessionCount: number }) => a.sessionCount > 1,
      );
      if (!agentWithSessions) return; // skip if no agent has multiple sessions

      const timestamps = agentWithSessions.sessions
        .map((s: { updatedAt: number | null }) => s.updatedAt ?? 0);
      for (let i = 1; i < timestamps.length; i++) {
        assert.ok(
          timestamps[i - 1] >= timestamps[i],
          `sessions not sorted: ${timestamps[i - 1]} < ${timestamps[i]}`,
        );
      }
    },
  );

  maybeIt(
    () => serverUp,
    "server",
    "channel is derived from key when not set explicitly",
    async () => {
      const { body } = await GET("/api/agent-sessions");
      const agentWithSessions = body.agents.find(
        (a: { sessionCount: number }) => a.sessionCount > 0,
      );
      if (!agentWithSessions) return;

      for (const s of agentWithSessions.sessions) {
        // Every session should have a non-empty channel (derived from key if needed)
        // Only truly orphaned sessions with no key structure would be empty
        if (s.fullKey.includes(":")) {
          assert.ok(
            s.channel.length > 0,
            `session ${s.fullKey} has empty channel — should be derived from key`,
          );
        }
      }
    },
  );
});

// ── GET /api/logs?session= (session filter) ─────────────────────────────────

describe("GET /api/logs?session= (session filter)", () => {
  maybeIt(
    () => gatewayUp,
    "gateway",
    "single session key returns only matching events",
    async () => {
      // First, get a known session key from agent-sessions
      const { body: sessBody } = await GET("/api/agent-sessions");
      const agent = sessBody.agents.find(
        (a: { sessionCount: number }) => a.sessionCount > 0,
      );
      if (!agent) return;
      const session = agent.sessions[0];
      const sessionKey = session.fullKey;

      const { status, body } = await GET(
        `/api/logs?endpoint=stream&limit=10&session=${encodeURIComponent(sessionKey)}`,
      );
      assert.equal(status, 200);
      const events = Array.isArray(body) ? body : body.events ?? [];
      // All returned events should have a session matching the filter key
      for (const e of events) {
        assert.equal(
          e.session,
          sessionKey,
          `event session "${e.session}" does not match filter "${sessionKey}"`,
        );
      }
    },
  );

  maybeIt(
    () => gatewayUp,
    "gateway",
    "comma-separated session keys returns events from all variants",
    async () => {
      // Build multi-variant key like the frontend does
      const { body: sessBody } = await GET("/api/agent-sessions");
      const agent = sessBody.agents.find(
        (a: { key: string; sessionCount: number }) => a.key === "jane" && a.sessionCount > 0,
      );
      if (!agent) return;

      // Find a discord channel session with a sessionId
      const session = agent.sessions.find(
        (s: { fullKey: string; sessionId: string }) =>
          s.fullKey.includes("discord:channel:") && s.sessionId,
      );
      if (!session) return;

      // Build variants
      const variants = [session.fullKey];
      const channelMatch = session.fullKey.match(/:channel:(\d+)$/);
      if (channelMatch) variants.push(`channel:${channelMatch[1]}`);
      if (session.sessionId) variants.push(`${agent.agentId}/${session.sessionId}.jsonl`);

      const sessionParam = variants.join(",");
      const { status, body } = await GET(
        `/api/logs?endpoint=stream&limit=50&session=${encodeURIComponent(sessionParam)}`,
      );
      assert.equal(status, 200);
      const events = Array.isArray(body) ? body : body.events ?? [];

      // Collect unique session formats found
      const sessionFormats = new Set(events.map((e: { session: string }) => e.session));

      // Every event's session should be one of the variants
      for (const e of events) {
        assert.ok(
          variants.includes(e.session),
          `event session "${e.session}" not in variants: ${variants.join(", ")}`,
        );
      }

      // If we got events, we should ideally see more than one format
      if (events.length > 5) {
        console.log(
          `  Session formats found: ${[...sessionFormats].join(", ")} (${events.length} events)`,
        );
      }
    },
  );

  maybeIt(
    () => gatewayUp,
    "gateway",
    "nonexistent session key returns empty results",
    async () => {
      const { status, body } = await GET(
        `/api/logs?endpoint=stream&limit=10&session=${encodeURIComponent("agent:nonexistent:test:key")}`,
      );
      assert.equal(status, 200);
      const events = Array.isArray(body) ? body : body.events ?? [];
      assert.equal(events.length, 0, "expected no events for nonexistent session");
    },
  );
});
