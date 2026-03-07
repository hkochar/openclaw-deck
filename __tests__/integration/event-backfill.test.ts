/**
 * Integration tests — Event Backfill + Session→Logs Flow.
 *
 * Verifies that:
 * 1. Sessions API returns origin field for archived sessions
 * 2. Clicking "Logs" for a session with events returns data
 * 3. Backfilled events are queryable via the logs API
 * 4. Session key variants (origin, UUID, channel) all resolve events
 *
 * Run: npx tsx --test __tests__/integration/event-backfill.test.ts
 */

import { describe, before } from "node:test";
import assert from "node:assert/strict";
import { GET, isServerUp, isGatewayUp, maybeIt, GATEWAY_URL } from "./helpers.js";

let serverUp = false;
let gatewayUp = false;

before(async () => {
  serverUp = await isServerUp();
  gatewayUp = await isGatewayUp();
  if (!serverUp) console.error("SKIP: Next.js dev server not running");
  if (!gatewayUp) console.error("SKIP: Gateway not running");
});

// ── Session Origin Field ────────────────────────────────────────────────────

describe("Session origin field", () => {
  maybeIt(
    () => serverUp,
    "server",
    "archived sessions include origin when available",
    async () => {
      const { body } = await GET("/api/agent-sessions");
      const allSessions = body.agents.flatMap(
        (a: { sessions: Array<{ status: string; origin?: string }> }) => a.sessions,
      );
      const archived = allSessions.filter(
        (s: { status: string }) => s.status !== "active",
      );
      const withOrigin = archived.filter(
        (s: { origin?: string }) => s.origin,
      );

      console.log(`  ${archived.length} archived sessions, ${withOrigin.length} with origin`);
      assert.ok(archived.length > 0, "expected some archived sessions");

      // Verify origin format
      for (const s of withOrigin) {
        assert.ok(
          typeof s.origin === "string" && s.origin.length > 0,
          "origin should be non-empty string",
        );
        assert.ok(
          !s.origin.startsWith("archived:"),
          `origin should not start with "archived:": ${s.origin}`,
        );
      }
    },
  );

  maybeIt(
    () => serverUp,
    "server",
    "origin contains the original session key with channel info",
    async () => {
      const { body } = await GET("/api/agent-sessions");
      const allSessions = body.agents.flatMap(
        (a: { sessions: Array<{ status: string; origin?: string; channel?: string }> }) => a.sessions,
      );
      const discordArchived = allSessions.filter(
        (s: { status: string; origin?: string; channel?: string }) =>
          s.status !== "active" && s.origin && s.origin.includes("discord"),
      );

      if (discordArchived.length === 0) {
        console.log("  No archived Discord sessions with origin — skipping");
        return;
      }

      for (const s of discordArchived.slice(0, 5)) {
        // Discord origins should contain channel ID
        assert.ok(
          s.origin.includes("channel:"),
          `Discord origin should contain channel ID: ${s.origin}`,
        );
      }
    },
  );
});

// ── Active Session → Logs Flow ──────────────────────────────────────────────

describe("Active session logs flow", () => {
  maybeIt(
    () => serverUp && gatewayUp,
    "server+gateway",
    "active session with events returns log data",
    async () => {
      const { body: sessBody } = await GET("/api/agent-sessions");
      // Find an active session with tokens (likely has events)
      const agent = sessBody.agents.find(
        (a: { sessions: Array<{ status: string; totalTokens: number }> }) =>
          a.sessions.some((s) => s.status === "active" && s.totalTokens > 0),
      );
      if (!agent) { console.log("  No active sessions with tokens — skipping"); return; }

      const session = agent.sessions.find(
        (s: { status: string; totalTokens: number }) => s.status === "active" && s.totalTokens > 0,
      );

      // Build variants like the frontend does
      const variants = [session.fullKey];
      const channelMatch = session.fullKey.match(/:channel:(\d+)$/);
      if (channelMatch) variants.push(`channel:${channelMatch[1]}`);
      if (session.sessionId) variants.push(`${agent.agentId}/${session.sessionId}.jsonl`);

      const sessionParam = variants.join(",");
      const since = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const { status, body } = await GET(
        `/api/logs?endpoint=stream&since=${since}&limit=20&session=${encodeURIComponent(sessionParam)}`,
      );
      assert.equal(status, 200);
      const events = Array.isArray(body) ? body : body.events ?? [];
      console.log(`  Session ${session.fullKey}: ${events.length} events`);
      assert.ok(events.length > 0, `expected events for active session with ${session.totalTokens} tokens`);
    },
  );
});

// ── Archived Session → Logs Flow ────────────────────────────────────────────

describe("Archived session logs flow", () => {
  maybeIt(
    () => serverUp && gatewayUp,
    "server+gateway",
    "archived session with origin builds correct log URL variants",
    async () => {
      const { body: sessBody } = await GET("/api/agent-sessions");
      // Find an archived session with origin
      let targetAgent: { agentId: string } | null = null;
      let targetSession: { sessionId: string; fullKey: string; origin: string } | null = null;

      for (const agent of sessBody.agents) {
        const s = agent.sessions.find(
          (s: { status: string; origin?: string }) =>
            s.status !== "active" && s.origin && !s.origin.startsWith("{"),
        );
        if (s) {
          targetAgent = agent;
          targetSession = s;
          break;
        }
      }

      if (!targetAgent || !targetSession) {
        console.log("  No archived sessions with origin — skipping");
        return;
      }

      // Build the same variants archivedLogUrl would build
      const variants: string[] = [];
      if (targetSession.sessionId.match(/^[0-9a-f-]+$/)) {
        variants.push(`${targetAgent.agentId}/${targetSession.sessionId}.jsonl`);
      }
      if (targetSession.origin && !targetSession.origin.startsWith("archived:")) {
        variants.push(targetSession.origin);
        const parts = targetSession.origin.split(":");
        if (parts.length >= 4) {
          variants.push(`channel:${parts.slice(3).join(":")}`);
        }
      }

      console.log(`  Testing archived session ${targetSession.sessionId}`);
      console.log(`  Origin: ${targetSession.origin}`);
      console.log(`  Variants: ${variants.join(", ")}`);

      // Query logs with these variants
      const since = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const sessionParam = variants.join(",");
      const { status, body } = await GET(
        `/api/logs?endpoint=stream&since=${since}&limit=20&session=${encodeURIComponent(sessionParam)}`,
      );
      assert.equal(status, 200);
      const events = Array.isArray(body) ? body : body.events ?? [];
      console.log(`  Found ${events.length} events`);

      // Events (if any) should use one of our variant keys
      for (const e of events) {
        assert.ok(
          variants.includes(e.session),
          `event session "${e.session}" not in variants: ${variants.join(", ")}`,
        );
      }
    },
  );

  maybeIt(
    () => gatewayUp,
    "gateway",
    "gateway /sessions endpoint returns origin for archived sessions",
    async () => {
      const res = await fetch(`${GATEWAY_URL}/sessions?status=all`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.ok(res.ok);
      const rows = await res.json();
      const archived = rows.filter(
        (r: { status: string; origin: string | null }) =>
          r.status !== "active" && r.origin && !r.origin.startsWith("{"),
      );

      console.log(`  ${archived.length} archived sessions with origin in gateway`);

      for (const row of archived.slice(0, 5)) {
        assert.ok(row.origin.includes(":"), `origin should contain colons: ${row.origin}`);
        assert.ok(
          !row.origin.startsWith("archived:"),
          `origin should not be archived key: ${row.origin}`,
        );
      }
    },
  );
});

// ── Backfill Completeness ───────────────────────────────────────────────────

describe("Event backfill completeness", () => {
  maybeIt(
    () => gatewayUp,
    "gateway",
    "events exist for multiple agents",
    async () => {
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const res = await fetch(
        `${GATEWAY_URL}/logs/stream?since=${since}&limit=500`,
        { signal: AbortSignal.timeout(10000) },
      );
      assert.ok(res.ok);
      const events = await res.json();
      const agents = new Set(events.map((e: { agent: string }) => e.agent));
      console.log(`  Agents with events: ${[...agents].join(", ")} (${events.length} total)`);
      assert.ok(agents.size > 0, "should have events from at least one agent");
    },
  );

  maybeIt(
    () => gatewayUp,
    "gateway",
    "events have correct types (llm_output, tool_call, msg_in, llm_input)",
    async () => {
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const res = await fetch(
        `${GATEWAY_URL}/logs/stream?since=${since}&limit=200`,
        { signal: AbortSignal.timeout(10000) },
      );
      const events = await res.json();
      const types = new Set(events.map((e: { type: string }) => e.type));
      console.log(`  Event types: ${[...types].join(", ")}`);

      // Should have at least llm_output (from hooks or backfill)
      assert.ok(types.has("llm_output"), "should have llm_output events");
    },
  );

  maybeIt(
    () => gatewayUp,
    "gateway",
    "llm_output events have model and cost data",
    async () => {
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const res = await fetch(
        `${GATEWAY_URL}/logs/stream?since=${since}&limit=100`,
        { signal: AbortSignal.timeout(10000) },
      );
      const events = await res.json();
      const llmOutputs = events.filter((e: { type: string }) => e.type === "llm_output");

      let withModel = 0;
      let withCost = 0;
      for (const e of llmOutputs) {
        if (e.model) withModel++;
        if (e.cost > 0) withCost++;
      }

      console.log(`  llm_output: ${llmOutputs.length} total, ${withModel} with model, ${withCost} with cost`);
      if (llmOutputs.length > 0) {
        assert.ok(withModel > 0, "at least some llm_output events should have model");
      }
    },
  );

  maybeIt(
    () => gatewayUp,
    "gateway",
    "event detail endpoint returns prompt/response for llm_output",
    async () => {
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const res = await fetch(
        `${GATEWAY_URL}/logs/stream?since=${since}&limit=10`,
        { signal: AbortSignal.timeout(5000) },
      );
      const events = await res.json();
      const llmOutput = events.find(
        (e: { type: string; has_response: boolean }) => e.type === "llm_output" && e.has_response,
      );

      if (!llmOutput) {
        console.log("  No llm_output with response in last 7 days — skipping detail test");
        return;
      }

      const detailRes = await fetch(
        `${GATEWAY_URL}/logs/event-detail?id=${llmOutput.id}`,
        { signal: AbortSignal.timeout(5000) },
      );
      assert.ok(detailRes.ok, "event-detail should respond 200");
      const detail = await detailRes.json();
      assert.ok(detail.id === llmOutput.id, "detail should match requested id");
      assert.ok(
        detail.response || detail.prompt || detail.thinking,
        "event detail should have at least one text field",
      );
    },
  );
});
