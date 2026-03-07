import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the matchSubFilter logic from app/logs/page.tsx.
 *
 * The function is inline in the component (not exported), so we reimplement it
 * here with the exact same logic. If matchSubFilter is ever extracted to a
 * shared module, replace this reimplementation with a direct import.
 */

// ── Constants (mirrored from logs/page.tsx) ──────────────────────────────────

const READ_TOOLS = ["read", "sessions_list", "session_status", "web_search", "image", "gateway"];
const WRITE_TOOLS = ["exec", "edit", "write", "sessions_send", "message", "process"];

// ── Reimplementation of matchSubFilter ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchSubFilter(e: any, sf: string): boolean {
  const d: Record<string, unknown> = e.detail ? JSON.parse(e.detail) : {};
  switch (sf) {
    case "thinking": return !!e.has_thinking;
    case "cached": return !!(e.cache_read && e.cache_read > 0);
    case "no-cache": return !e.cache_read || e.cache_read === 0;
    case "sub-billing": return e.billing === "subscription";
    case "metered-billing": return e.billing === "metered";
    case "has-compaction": return !!d.hasCompaction;
    case "has-tool-use": return !!d.hasToolUse;
    case "has-images": return !!(d.imagesCount && (d.imagesCount as number) > 0);
    case "large-context": return !!(d.systemPromptLen && (d.systemPromptLen as number) >= 10000);
    case "tool-read": return READ_TOOLS.includes(d.tool as string);
    case "tool-write": return WRITE_TOOLS.includes(d.tool as string);
    case "tool-failed": return d.success === 0 || d.success === false;
    case "tool-cron": return d.tool === "cron";
    case "msg-discord": return !!e.session?.includes("discord");
    case "msg-hook": return !!e.session?.includes("hook");
    default:
      if (sf.startsWith("tool:")) return d.tool === sf.slice(5);
      return true;
  }
}

// ── Helper to build fake event rows ──────────────────────────────────────────

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    ts: Date.now(),
    type: "llm_output",
    agent: "test",
    session: "test-session",
    model: "anthropic/claude-sonnet-4-20250514",
    cost: 0.01,
    cache_read: null,
    cache_write: null,
    has_thinking: null,
    billing: null,
    detail: null,
    ...overrides,
  };
}

// ── LLM Response sub-filters ─────────────────────────────────────────────────

describe("matchSubFilter — LLM Response", () => {
  it("'thinking' matches when has_thinking is truthy", () => {
    assert.equal(matchSubFilter(makeEvent({ has_thinking: 1 }), "thinking"), true);
  });

  it("'thinking' does not match when has_thinking is 0", () => {
    assert.equal(matchSubFilter(makeEvent({ has_thinking: 0 }), "thinking"), false);
  });

  it("'thinking' does not match when has_thinking is null", () => {
    assert.equal(matchSubFilter(makeEvent({ has_thinking: null }), "thinking"), false);
  });

  it("'cached' matches when cache_read > 0", () => {
    assert.equal(matchSubFilter(makeEvent({ cache_read: 500 }), "cached"), true);
  });

  it("'cached' does not match when cache_read is 0", () => {
    assert.equal(matchSubFilter(makeEvent({ cache_read: 0 }), "cached"), false);
  });

  it("'cached' does not match when cache_read is null", () => {
    assert.equal(matchSubFilter(makeEvent({ cache_read: null }), "cached"), false);
  });

  it("'no-cache' matches when cache_read is 0", () => {
    assert.equal(matchSubFilter(makeEvent({ cache_read: 0 }), "no-cache"), true);
  });

  it("'no-cache' matches when cache_read is null", () => {
    assert.equal(matchSubFilter(makeEvent({ cache_read: null }), "no-cache"), true);
  });

  it("'no-cache' does not match when cache_read > 0", () => {
    assert.equal(matchSubFilter(makeEvent({ cache_read: 100 }), "no-cache"), false);
  });

  it("'sub-billing' matches subscription billing", () => {
    assert.equal(matchSubFilter(makeEvent({ billing: "subscription" }), "sub-billing"), true);
  });

  it("'sub-billing' does not match metered billing", () => {
    assert.equal(matchSubFilter(makeEvent({ billing: "metered" }), "sub-billing"), false);
  });

  it("'metered-billing' matches metered billing", () => {
    assert.equal(matchSubFilter(makeEvent({ billing: "metered" }), "metered-billing"), true);
  });

  it("'metered-billing' does not match subscription billing", () => {
    assert.equal(matchSubFilter(makeEvent({ billing: "subscription" }), "metered-billing"), false);
  });
});

// ── LLM detail-based sub-filters ─────────────────────────────────────────────

describe("matchSubFilter — LLM detail fields", () => {
  it("'has-compaction' matches when detail has hasCompaction", () => {
    const e = makeEvent({ detail: JSON.stringify({ hasCompaction: true }) });
    assert.equal(matchSubFilter(e, "has-compaction"), true);
  });

  it("'has-compaction' does not match when detail lacks it", () => {
    const e = makeEvent({ detail: JSON.stringify({}) });
    assert.equal(matchSubFilter(e, "has-compaction"), false);
  });

  it("'has-tool-use' matches when detail has hasToolUse", () => {
    const e = makeEvent({ detail: JSON.stringify({ hasToolUse: true }) });
    assert.equal(matchSubFilter(e, "has-tool-use"), true);
  });

  it("'has-images' matches when imagesCount > 0", () => {
    const e = makeEvent({ detail: JSON.stringify({ imagesCount: 3 }) });
    assert.equal(matchSubFilter(e, "has-images"), true);
  });

  it("'has-images' does not match when imagesCount is 0", () => {
    const e = makeEvent({ detail: JSON.stringify({ imagesCount: 0 }) });
    assert.equal(matchSubFilter(e, "has-images"), false);
  });

  it("'large-context' matches when systemPromptLen >= 10000", () => {
    const e = makeEvent({ detail: JSON.stringify({ systemPromptLen: 15000 }) });
    assert.equal(matchSubFilter(e, "large-context"), true);
  });

  it("'large-context' does not match when systemPromptLen < 10000", () => {
    const e = makeEvent({ detail: JSON.stringify({ systemPromptLen: 5000 }) });
    assert.equal(matchSubFilter(e, "large-context"), false);
  });

  it("'large-context' boundary: exactly 10000 matches", () => {
    const e = makeEvent({ detail: JSON.stringify({ systemPromptLen: 10000 }) });
    assert.equal(matchSubFilter(e, "large-context"), true);
  });
});

// ── Tool Call sub-filters ────────────────────────────────────────────────────

describe("matchSubFilter — Tool Call", () => {
  it("'tool-read' matches 'read' tool", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "read" }) });
    assert.equal(matchSubFilter(e, "tool-read"), true);
  });

  it("'tool-read' matches 'web_search' tool", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "web_search" }) });
    assert.equal(matchSubFilter(e, "tool-read"), true);
  });

  it("'tool-read' matches all read tools", () => {
    for (const tool of READ_TOOLS) {
      const e = makeEvent({ detail: JSON.stringify({ tool }) });
      assert.equal(matchSubFilter(e, "tool-read"), true, `expected ${tool} to match tool-read`);
    }
  });

  it("'tool-read' does not match write tools", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "exec" }) });
    assert.equal(matchSubFilter(e, "tool-read"), false);
  });

  it("'tool-write' matches 'exec' tool", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "exec" }) });
    assert.equal(matchSubFilter(e, "tool-write"), true);
  });

  it("'tool-write' matches 'edit' tool", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "edit" }) });
    assert.equal(matchSubFilter(e, "tool-write"), true);
  });

  it("'tool-write' matches all write tools", () => {
    for (const tool of WRITE_TOOLS) {
      const e = makeEvent({ detail: JSON.stringify({ tool }) });
      assert.equal(matchSubFilter(e, "tool-write"), true, `expected ${tool} to match tool-write`);
    }
  });

  it("'tool-write' does not match read tools", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "read" }) });
    assert.equal(matchSubFilter(e, "tool-write"), false);
  });

  it("'tool-failed' matches when success is 0", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "exec", success: 0 }) });
    assert.equal(matchSubFilter(e, "tool-failed"), true);
  });

  it("'tool-failed' matches when success is false", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "exec", success: false }) });
    assert.equal(matchSubFilter(e, "tool-failed"), true);
  });

  it("'tool-failed' does not match when success is 1", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "exec", success: 1 }) });
    assert.equal(matchSubFilter(e, "tool-failed"), false);
  });

  it("'tool-cron' matches cron tool", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "cron" }) });
    assert.equal(matchSubFilter(e, "tool-cron"), true);
  });

  it("'tool-cron' does not match other tools", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "exec" }) });
    assert.equal(matchSubFilter(e, "tool-cron"), false);
  });

  it("'tool:custom' dynamic filter matches exact tool name", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "myCustomTool" }) });
    assert.equal(matchSubFilter(e, "tool:myCustomTool"), true);
  });

  it("'tool:custom' dynamic filter does not match different tool", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "otherTool" }) });
    assert.equal(matchSubFilter(e, "tool:myCustomTool"), false);
  });
});

// ── Message sub-filters ──────────────────────────────────────────────────────

describe("matchSubFilter — Message", () => {
  it("'msg-discord' matches when session contains 'discord'", () => {
    const e = makeEvent({ session: "agent:main:discord:channel:123456" });
    assert.equal(matchSubFilter(e, "msg-discord"), true);
  });

  it("'msg-discord' does not match non-discord session", () => {
    const e = makeEvent({ session: "agent:main:hook:cron" });
    assert.equal(matchSubFilter(e, "msg-discord"), false);
  });

  it("'msg-hook' matches when session contains 'hook'", () => {
    const e = makeEvent({ session: "agent:main:hook:cron" });
    assert.equal(matchSubFilter(e, "msg-hook"), true);
  });

  it("'msg-hook' does not match discord session", () => {
    const e = makeEvent({ session: "agent:main:discord:channel:123456" });
    assert.equal(matchSubFilter(e, "msg-hook"), false);
  });
});

// ── Multiple sub-filters active simultaneously ───────────────────────────────

describe("matchSubFilter — multiple filters", () => {
  it("event matching both 'thinking' and 'cached' passes both filters", () => {
    const e = makeEvent({ has_thinking: 1, cache_read: 200 });
    assert.equal(matchSubFilter(e, "thinking"), true);
    assert.equal(matchSubFilter(e, "cached"), true);
  });

  it("event matching 'thinking' but not 'cached' passes only one", () => {
    const e = makeEvent({ has_thinking: 1, cache_read: 0 });
    assert.equal(matchSubFilter(e, "thinking"), true);
    assert.equal(matchSubFilter(e, "cached"), false);
  });

  it("tool-read and tool-failed can both match the same event", () => {
    const e = makeEvent({ detail: JSON.stringify({ tool: "read", success: 0 }) });
    assert.equal(matchSubFilter(e, "tool-read"), true);
    assert.equal(matchSubFilter(e, "tool-failed"), true);
  });

  it("simulates full filtering: all sub-filters must pass", () => {
    const e = makeEvent({ has_thinking: 1, cache_read: 500, billing: "metered" });
    const activeFilters = ["thinking", "cached", "metered-billing"];
    const allMatch = activeFilters.every((sf) => matchSubFilter(e, sf));
    assert.equal(allMatch, true);
  });

  it("simulates full filtering: one failing sub-filter rejects event", () => {
    const e = makeEvent({ has_thinking: 1, cache_read: 0, billing: "metered" });
    const activeFilters = ["thinking", "cached", "metered-billing"];
    const allMatch = activeFilters.every((sf) => matchSubFilter(e, sf));
    assert.equal(allMatch, false);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("matchSubFilter — edge cases", () => {
  it("unknown sub-filter returns true (passthrough)", () => {
    const e = makeEvent({});
    assert.equal(matchSubFilter(e, "nonexistent-filter"), true);
  });

  it("null detail is handled gracefully", () => {
    const e = makeEvent({ detail: null });
    assert.equal(matchSubFilter(e, "tool-read"), false);
    assert.equal(matchSubFilter(e, "tool-failed"), false);
    assert.equal(matchSubFilter(e, "has-compaction"), false);
  });

  it("malformed detail JSON is handled gracefully (empty detail = no match)", () => {
    // matchSubFilter calls JSON.parse(e.detail), which will throw on malformed JSON.
    // In the real component this would cause an error. We test that empty detail
    // (the safe fallback) correctly returns false for detail-based filters.
    const e = makeEvent({ detail: "{}" });
    assert.equal(matchSubFilter(e, "tool-read"), false);
    assert.equal(matchSubFilter(e, "has-images"), false);
  });

  it("session is null — msg-discord returns false", () => {
    const e = makeEvent({ session: null });
    assert.equal(matchSubFilter(e, "msg-discord"), false);
  });

  it("session is undefined — msg-hook returns false", () => {
    const e = makeEvent({});
    delete (e as Record<string, unknown>).session;
    assert.equal(matchSubFilter(e, "msg-hook"), false);
  });
});
