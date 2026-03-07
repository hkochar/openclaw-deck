/**
 * Integration tests for /api/search endpoint.
 *
 * Requires the Next.js dev server to be running on localhost:3000.
 * Tests real HTTP calls against the search API.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { GET, POST, isServerUp } from "./helpers.js";

let serverUp = false;

before(async () => {
  serverUp = await isServerUp();
  if (!serverUp) console.error("SKIP: Next.js dev server not running on localhost:3000");
});

describe("GET /api/search", () => {
  it("returns 400 when q parameter is missing", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/search");
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes("Missing"));
  });

  it("returns 400 when q is empty", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/search?q=");
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("returns ok response with groups for a valid query", async () => {
    if (!serverUp) return;
    // Search for something that should exist in any running Deck instance
    const { status, body } = await GET("/api/search?q=agent");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.totalHits === "number");
    assert.ok(Array.isArray(body.groups));
    assert.ok(typeof body.query === "string");
  });

  it("returns results with correct shape", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/search?q=agent&limit=3");
    assert.equal(status, 200);
    if (body.totalHits > 0) {
      const group = body.groups[0];
      assert.ok(typeof group.type === "string");
      assert.ok(typeof group.label === "string");
      assert.ok(typeof group.count === "number");
      assert.ok(Array.isArray(group.results));

      const result = group.results[0];
      assert.ok(typeof result.title === "string");
      assert.ok(typeof result.snippet === "string");
      assert.ok(typeof result.sourceType === "string");
      assert.ok(typeof result.sourceId === "string");
      assert.ok(typeof result.timestamp === "number");
      assert.ok(typeof result.clickUrl === "string");
    }
  });

  it("respects type filter", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/search?q=agent&type=session");
    assert.equal(status, 200);
    for (const group of body.groups) {
      assert.equal(group.type, "session", `expected only session results, got ${group.type}`);
    }
  });

  it("respects agent filter", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/search?q=agent&agent=jane");
    assert.equal(status, 200);
    for (const group of body.groups) {
      for (const r of group.results) {
        // Agent should be jane or empty (filesystem sources have no agent)
        assert.ok(r.agent === "jane" || r.agent === "", `expected agent jane, got ${r.agent}`);
      }
    }
  });

  it("respects limit parameter", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/search?q=agent&limit=2");
    assert.equal(status, 200);
    for (const group of body.groups) {
      assert.ok(group.results.length <= 2, `expected <= 2 results, got ${group.results.length}`);
    }
  });

  it("handles dotted terms without error", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/search?q=compaction.memoryFlush.enabled");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it("handles special characters without error", async () => {
    if (!serverUp) return;
    const queries = [
      "file:///path/to/thing",
      "user@example.com",
      "#edit.budgets",
      "src/*.tsx",
      "error: connection",
    ];
    for (const q of queries) {
      const { status, body } = await GET(`/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(status, 200, `query "${q}" should return 200, got ${status}`);
      assert.equal(body.ok, true, `query "${q}" should return ok: true`);
    }
  });

  it("supports date range filtering", async () => {
    if (!serverUp) return;
    const now = Date.now();
    const dayAgo = now - 86_400_000;
    const { status, body } = await GET(`/api/search?q=agent&from=${dayAgo}&to=${now}`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it("supports multi-type filter", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/search?q=agent&type=event,session");
    assert.equal(status, 200);
    for (const group of body.groups) {
      assert.ok(
        group.type === "event" || group.type === "session",
        `expected event or session, got ${group.type}`,
      );
    }
  });

  it("returns snippets with mark tags", async () => {
    if (!serverUp) return;
    const { status, body } = await GET("/api/search?q=agent");
    assert.equal(status, 200);
    if (body.totalHits > 0) {
      const allSnippets = body.groups.flatMap((g: { results: Array<{ snippet: string }> }) => g.results.map((r: { snippet: string }) => r.snippet));
      const hasMarks = allSnippets.some((s: string) => s.includes("<mark>"));
      assert.ok(hasMarks, "at least one snippet should contain <mark> tags");
    }
  });
});

describe("POST /api/search (reindex)", () => {
  it("rebuilds the search index", async () => {
    if (!serverUp) return;
    const { status, body } = await POST("/api/search", {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.message.includes("rebuilt"));
  });

  it("search works after reindex", async () => {
    if (!serverUp) return;
    // Reindex then search
    await POST("/api/search", {});
    const { status, body } = await GET("/api/search?q=agent");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });
});
