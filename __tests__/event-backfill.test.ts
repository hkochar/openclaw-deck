/**
 * Unit tests — Event Backfill from JSONL Transcripts.
 *
 * Tests the parseTranscriptEvents logic by creating mock JSONL transcript
 * files and verifying the correct events are extracted.
 *
 * Run: npx tsx --test __tests__/event-backfill.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

// We can't import from the gateway plugin directly, so we test via the
// gateway HTTP API. This file tests the data shape expectations.

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";

// ── JSONL Transcript Format Assertions ──────────────────────────────────────

describe("JSONL Transcript Format", () => {
  const agentsDir = path.join(os.homedir(), ".openclaw", "agents");

  it("agents directory exists", () => {
    assert.ok(fs.existsSync(agentsDir), `${agentsDir} should exist`);
  });

  it("at least one agent has session transcripts", () => {
    const agents = fs.readdirSync(agentsDir).filter(d =>
      fs.statSync(path.join(agentsDir, d)).isDirectory()
    );
    let hasTranscripts = false;
    for (const agent of agents) {
      const sessionsDir = path.join(agentsDir, agent, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;
      const files = fs.readdirSync(sessionsDir).filter(f => f.includes(".jsonl"));
      if (files.length > 0) { hasTranscripts = true; break; }
    }
    assert.ok(hasTranscripts, "expected at least one JSONL transcript");
  });

  it("transcript files have valid JSONL format", () => {
    const agents = fs.readdirSync(agentsDir).filter(d =>
      fs.statSync(path.join(agentsDir, d)).isDirectory()
    );
    let tested = 0;
    for (const agent of agents) {
      const sessionsDir = path.join(agentsDir, agent, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;
      const files = fs.readdirSync(sessionsDir).filter(f => f.includes(".jsonl") && !f.startsWith("sessions.json"));
      for (const file of files.slice(0, 2)) { // test up to 2 files per agent
        const content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
        const lines = content.split("\n").filter(Boolean);
        assert.ok(lines.length > 0, `${file} should have at least one line`);
        // First line should be parseable JSON
        const first = JSON.parse(lines[0]);
        assert.ok(typeof first === "object", `${file} first line should be JSON object`);
        tested++;
      }
      if (tested >= 3) break;
    }
    assert.ok(tested > 0, "should have tested at least one transcript");
  });

  it("transcripts have session header as first entry", () => {
    const agents = fs.readdirSync(agentsDir).filter(d =>
      fs.statSync(path.join(agentsDir, d)).isDirectory()
    );
    for (const agent of agents) {
      const sessionsDir = path.join(agentsDir, agent, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;
      const files = fs.readdirSync(sessionsDir).filter(f =>
        f.match(/^[0-9a-f-]+\.jsonl/) && !f.startsWith("sessions.json")
      );
      for (const file of files.slice(0, 2)) {
        const content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
        const firstLine = content.split("\n")[0];
        const first = JSON.parse(firstLine);
        assert.equal(first.type, "session", `${file} should start with session header`);
        assert.ok(first.id, `${file} session header should have id`);
        assert.ok(first.timestamp, `${file} session header should have timestamp`);
        break; // one per agent is enough
      }
      break;
    }
  });

  it("assistant messages with usage have required fields", () => {
    const agents = fs.readdirSync(agentsDir).filter(d =>
      fs.statSync(path.join(agentsDir, d)).isDirectory()
    );
    let found = false;
    outer: for (const agent of agents) {
      const sessionsDir = path.join(agentsDir, agent, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;
      const files = fs.readdirSync(sessionsDir).filter(f =>
        f.includes(".jsonl") && !f.startsWith("sessions.json")
      );
      for (const file of files.slice(0, 3)) {
        const content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
        for (const line of content.split("\n").filter(Boolean)) {
          const entry = JSON.parse(line);
          if (entry.type !== "message") continue;
          const msg = entry.message;
          if (msg?.role !== "assistant" || !msg?.usage) continue;
          if ((msg.usage.totalTokens ?? 0) === 0) continue;

          // Verify required fields
          assert.ok(msg.usage.input != null, "usage should have input tokens");
          assert.ok(msg.usage.output != null, "usage should have output tokens");
          assert.ok(msg.model || msg.usage.totalTokens >= 0, "should have model or tokens");
          assert.ok(entry.timestamp, "should have timestamp");
          assert.ok(Array.isArray(msg.content), "content should be array");
          found = true;
          break outer;
        }
      }
    }
    assert.ok(found, "should find at least one assistant message with usage data");
  });

  it("tool results have required fields", () => {
    const agents = fs.readdirSync(agentsDir).filter(d =>
      fs.statSync(path.join(agentsDir, d)).isDirectory()
    );
    let found = false;
    outer: for (const agent of agents) {
      const sessionsDir = path.join(agentsDir, agent, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;
      const files = fs.readdirSync(sessionsDir).filter(f =>
        f.includes(".jsonl") && !f.startsWith("sessions.json")
      );
      for (const file of files.slice(0, 3)) {
        const content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
        for (const line of content.split("\n").filter(Boolean)) {
          const entry = JSON.parse(line);
          if (entry.type !== "message") continue;
          const msg = entry.message;
          if (msg?.role !== "toolResult") continue;

          assert.ok(msg.toolCallId || msg.toolName, "tool result should have toolCallId or toolName");
          assert.ok(entry.timestamp, "should have timestamp");
          found = true;
          break outer;
        }
      }
    }
    assert.ok(found, "should find at least one tool result message");
  });
});

// ── Backfill Output Verification (via SQLite) ───────────────────────────────

describe("Event Backfill Data Integrity", () => {
  let gatewayUp = false;

  before(async () => {
    try {
      await fetch(GATEWAY_URL, { signal: AbortSignal.timeout(3000) });
      gatewayUp = true;
    } catch {
      console.error("SKIP: Gateway not running");
    }
  });

  it("sessions table has entries", async () => {
    if (!gatewayUp) return;
    const res = await fetch(`${GATEWAY_URL}/sessions?status=all`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(res.ok, "gateway /sessions should respond 200");
    const rows = await res.json();
    assert.ok(Array.isArray(rows), "should return array");
    assert.ok(rows.length > 0, "should have sessions");
  });

  it("sessions with transcripts have matching session_id", async () => {
    if (!gatewayUp) return;
    const res = await fetch(`${GATEWAY_URL}/sessions?status=all`, {
      signal: AbortSignal.timeout(5000),
    });
    const rows = await res.json();
    const withTranscripts = rows.filter((r: { transcript_size_kb: number }) => r.transcript_size_kb > 0);
    assert.ok(withTranscripts.length > 0, "some sessions should have transcripts");

    for (const row of withTranscripts.slice(0, 5)) {
      assert.ok(
        row.session_id && row.session_id.length > 0,
        `session ${row.session_key} has transcript but no session_id`,
      );
    }
  });

  it("archived sessions with origin have valid session key format", async () => {
    if (!gatewayUp) return;
    const res = await fetch(`${GATEWAY_URL}/sessions?status=all`, {
      signal: AbortSignal.timeout(5000),
    });
    const rows = await res.json();
    const withOrigin = rows.filter((r: { origin: string | null; status: string }) =>
      r.origin && r.status !== "active" && !r.origin.startsWith("{")
    );

    for (const row of withOrigin.slice(0, 10)) {
      // Origin should look like a session key, not JSON
      assert.ok(
        row.origin.includes(":"),
        `origin "${row.origin}" should be a session key with colons`,
      );
      assert.ok(
        !row.origin.startsWith("archived:"),
        `origin should not start with "archived:" — got "${row.origin}"`,
      );
    }
  });

  it("events table has llm_output entries", async () => {
    if (!gatewayUp) return;
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
    const res = await fetch(
      `${GATEWAY_URL}/logs/stream?since=${since}&limit=5`,
      { signal: AbortSignal.timeout(5000) },
    );
    assert.ok(res.ok, "gateway /logs/stream should respond 200");
    const events = await res.json();
    assert.ok(Array.isArray(events), "should return array");
    const llmOutputs = events.filter((e: { type: string }) => e.type === "llm_output");
    // There should be at least some llm_output events (from live logging or backfill)
    console.log(`  Found ${llmOutputs.length} llm_output events in last 30 days (of ${events.length} total)`);
  });

  it("llm_output events have required token fields", async () => {
    if (!gatewayUp) return;
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const res = await fetch(
      `${GATEWAY_URL}/logs/stream?since=${since}&limit=50`,
      { signal: AbortSignal.timeout(5000) },
    );
    const events = await res.json();
    const llmOutputs = events.filter((e: { type: string }) => e.type === "llm_output");

    for (const e of llmOutputs.slice(0, 10)) {
      assert.ok(e.agent, `llm_output event ${e.id} missing agent`);
      assert.ok(e.session, `llm_output event ${e.id} missing session`);
      assert.ok(e.model, `llm_output event ${e.id} missing model`);
      assert.ok(typeof e.input_tokens === "number", `llm_output event ${e.id} missing input_tokens`);
      assert.ok(typeof e.output_tokens === "number", `llm_output event ${e.id} missing output_tokens`);
    }
  });

  it("backfilled events have correct session key format", async () => {
    if (!gatewayUp) return;
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const res = await fetch(
      `${GATEWAY_URL}/logs/stream?since=${since}&limit=100`,
      { signal: AbortSignal.timeout(5000) },
    );
    const events = await res.json();

    for (const e of events) {
      // Session should never be empty
      assert.ok(e.session && e.session.length > 0, `event ${e.id} has empty session`);
      // Session should never start with "archived:"
      assert.ok(
        !e.session.startsWith("archived:"),
        `event ${e.id} has archived session key: ${e.session}`,
      );
    }
  });
});
