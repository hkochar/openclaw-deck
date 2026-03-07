/**
 * Unit tests for gateway plugin index.ts pure functions.
 *
 * Tests parseTaskFromMessage, parseArchiveTs, buildAgentKeyMap, resolveAgentKey.
 * Run: npx tsx --test __tests__/gateway-index.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── parseArchiveTs ──────────────────────────────────────────────────────────

/** Parse archive timestamp: "2026-02-24T23-05-05.844Z" -> epoch ms */
function parseArchiveTs(ts: string): number {
  const iso = ts.replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1T$2:$3:$4");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

describe("parseArchiveTs", () => {
  it("parses valid archive timestamp", () => {
    const result = parseArchiveTs("2026-02-24T23-05-05.844Z");
    const expected = new Date("2026-02-24T23:05:05.844Z").getTime();
    assert.equal(result, expected);
  });

  it("parses timestamp without milliseconds", () => {
    const result = parseArchiveTs("2026-01-15T10-30-00Z");
    const expected = new Date("2026-01-15T10:30:00Z").getTime();
    assert.equal(result, expected);
  });

  it("returns current time for invalid timestamp", () => {
    const before = Date.now();
    const result = parseArchiveTs("not-a-timestamp");
    const after = Date.now();
    assert.ok(result >= before && result <= after);
  });

  it("returns current time for empty string", () => {
    const before = Date.now();
    const result = parseArchiveTs("");
    const after = Date.now();
    assert.ok(result >= before && result <= after);
  });

  it("handles midnight correctly", () => {
    const result = parseArchiveTs("2026-03-01T00-00-00.000Z");
    const expected = new Date("2026-03-01T00:00:00.000Z").getTime();
    assert.equal(result, expected);
  });
});

// ── parseTaskFromMessage ────────────────────────────────────────────────────

const KNOWN_AGENTS = ["jane", "scout", "forge", "maya", "pulse", "vigil", "sentinel"];

function parseTaskFromMessage(content: string): {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  tags: string[];
  assignees: string[];
} {
  const lines = content.trim().split("\n");
  const title = lines[0].trim();
  const description = lines.length > 1 ? lines.slice(1).join("\n").trim() : undefined;

  const lower = content.toLowerCase();
  let priority: "low" | "medium" | "high" | "urgent" | undefined;
  if (lower.includes("urgent") || lower.includes("asap")) priority = "urgent";
  else if (lower.includes("high priority") || lower.includes("important")) priority = "high";
  else if (lower.includes("low priority")) priority = "low";

  const assignees: string[] = [];
  for (const agent of KNOWN_AGENTS) {
    if (new RegExp(`\\b${agent}\\b`, "i").test(lower)) {
      assignees.push(agent);
    }
  }

  const tags = (content.match(/#(\w+)/g) || []).map((t) => t.slice(1));

  return { title, description, priority, tags, assignees };
}

describe("parseTaskFromMessage", () => {
  describe("title extraction", () => {
    it("uses first line as title", () => {
      const result = parseTaskFromMessage("Fix the login bug");
      assert.equal(result.title, "Fix the login bug");
    });

    it("trims whitespace from title", () => {
      const result = parseTaskFromMessage("  Fix the bug  ");
      assert.equal(result.title, "Fix the bug");
    });
  });

  describe("description extraction", () => {
    it("no description for single line", () => {
      const result = parseTaskFromMessage("Fix the bug");
      assert.equal(result.description, undefined);
    });

    it("remaining lines become description", () => {
      const result = parseTaskFromMessage("Fix the bug\nIt crashes on login\nNeeds testing");
      assert.equal(result.description, "It crashes on login\nNeeds testing");
    });

    it("trims description whitespace", () => {
      const result = parseTaskFromMessage("Title\n  Body text  \n");
      assert.equal(result.description, "Body text");
    });
  });

  describe("priority detection", () => {
    it("detects urgent priority", () => {
      const result = parseTaskFromMessage("Fix this urgent bug");
      assert.equal(result.priority, "urgent");
    });

    it("detects ASAP as urgent", () => {
      const result = parseTaskFromMessage("Deploy ASAP");
      assert.equal(result.priority, "urgent");
    });

    it("detects high priority", () => {
      const result = parseTaskFromMessage("This is high priority");
      assert.equal(result.priority, "high");
    });

    it("detects important as high priority", () => {
      const result = parseTaskFromMessage("Important: update the API");
      assert.equal(result.priority, "high");
    });

    it("detects low priority", () => {
      const result = parseTaskFromMessage("Low priority cleanup");
      assert.equal(result.priority, "low");
    });

    it("no priority when not mentioned", () => {
      const result = parseTaskFromMessage("Refactor the auth module");
      assert.equal(result.priority, undefined);
    });

    it("urgent takes precedence over high", () => {
      const result = parseTaskFromMessage("Urgent and important fix");
      assert.equal(result.priority, "urgent");
    });

    it("priority detection is case insensitive", () => {
      const result = parseTaskFromMessage("URGENT: Fix now");
      assert.equal(result.priority, "urgent");
    });
  });

  describe("assignee detection", () => {
    it("detects single agent", () => {
      const result = parseTaskFromMessage("forge: fix the tests");
      assert.deepEqual(result.assignees, ["forge"]);
    });

    it("detects multiple agents", () => {
      const result = parseTaskFromMessage("scout and forge should work on this");
      assert.deepEqual(result.assignees, ["scout", "forge"]);
    });

    it("case insensitive agent matching", () => {
      const result = parseTaskFromMessage("JANE please review");
      assert.deepEqual(result.assignees, ["jane"]);
    });

    it("no assignees when no agent mentioned", () => {
      const result = parseTaskFromMessage("Fix the API endpoint");
      assert.deepEqual(result.assignees, []);
    });

    it("detects all known agents", () => {
      const result = parseTaskFromMessage("jane scout forge maya pulse vigil sentinel");
      assert.equal(result.assignees.length, 7);
    });

    it("word boundary matching prevents partial matches", () => {
      // "forgetful" should not match "forge"
      const result = parseTaskFromMessage("This is a forgetful task");
      // "forge" appears as substring in "forgetful" but \b boundary should prevent match
      // Actually \bforge\b won't match "forgetful" since 't' follows 'e'
      assert.deepEqual(result.assignees, []);
    });
  });

  describe("tag extraction", () => {
    it("extracts hashtags", () => {
      const result = parseTaskFromMessage("Fix bug #frontend #urgent");
      assert.deepEqual(result.tags, ["frontend", "urgent"]);
    });

    it("no tags when none present", () => {
      const result = parseTaskFromMessage("Fix the bug");
      assert.deepEqual(result.tags, []);
    });

    it("handles tags in description", () => {
      const result = parseTaskFromMessage("Title\n#backend #api");
      assert.deepEqual(result.tags, ["backend", "api"]);
    });

    it("extracts word characters only", () => {
      const result = parseTaskFromMessage("#good_tag #also123");
      assert.deepEqual(result.tags, ["good_tag", "also123"]);
    });
  });

  describe("combined parsing", () => {
    it("parses full message with all fields", () => {
      const msg = "Deploy auth fix ASAP\nForge needs to update the middleware\n#security #backend";
      const result = parseTaskFromMessage(msg);
      assert.equal(result.title, "Deploy auth fix ASAP");
      assert.ok(result.description?.includes("middleware"));
      assert.equal(result.priority, "urgent");
      assert.deepEqual(result.assignees, ["forge"]);
      assert.deepEqual(result.tags, ["security", "backend"]);
    });

    it("handles empty content gracefully", () => {
      const result = parseTaskFromMessage("");
      assert.equal(result.title, "");
      assert.equal(result.description, undefined);
      assert.equal(result.priority, undefined);
      assert.deepEqual(result.tags, []);
      assert.deepEqual(result.assignees, []);
    });
  });
});

// ── buildAgentKeyMap ─────────────────────────────────────────────────────────

interface McAgent { id: string; key: string }
interface McConfig { agents: McAgent[] }

function buildAgentKeyMap(
  deckConfig: McConfig | null,
  fallbackAgents?: Array<{ id: string }>,
  fallbackBindings?: Array<{ agentId?: string; match?: { accountId?: string } }>,
): Record<string, string> {
  const map: Record<string, string> = {};

  if (deckConfig) {
    for (const a of deckConfig.agents) {
      map[a.id] = a.key;
      map[a.key] = a.key;
    }
  } else if (fallbackAgents) {
    const agentToAccount: Record<string, string> = {};
    for (const b of fallbackBindings ?? []) {
      if (b.agentId && b.match?.accountId && !agentToAccount[b.agentId]) {
        agentToAccount[b.agentId] = b.match.accountId;
      }
    }
    for (const agent of fallbackAgents) {
      const accountName = agentToAccount[agent.id] ?? agent.id;
      map[agent.id] = accountName;
      map[accountName] = accountName;
    }
  }

  return map;
}

describe("buildAgentKeyMap", () => {
  it("maps agent IDs and keys from Deck config", () => {
    const config: McConfig = {
      agents: [
        { id: "main", key: "jane" },
        { id: "agent-scout-1", key: "scout" },
      ],
    };
    const map = buildAgentKeyMap(config);
    assert.equal(map["main"], "jane");
    assert.equal(map["jane"], "jane");
    assert.equal(map["agent-scout-1"], "scout");
    assert.equal(map["scout"], "scout");
  });

  it("returns empty map for null config without fallback", () => {
    const map = buildAgentKeyMap(null);
    assert.deepEqual(map, {});
  });

  it("uses fallback agents with bindings", () => {
    const map = buildAgentKeyMap(
      null,
      [{ id: "main" }, { id: "agent-2" }],
      [{ agentId: "main", match: { accountId: "jane" } }],
    );
    assert.equal(map["main"], "jane");
    assert.equal(map["jane"], "jane");
    assert.equal(map["agent-2"], "agent-2"); // no binding, maps to self
  });

  it("fallback without bindings maps id to self", () => {
    const map = buildAgentKeyMap(null, [{ id: "main" }], []);
    assert.equal(map["main"], "main");
  });

  it("Deck config takes precedence (non-null)", () => {
    const config: McConfig = { agents: [{ id: "main", key: "jane" }] };
    // Even if fallback agents passed, Deck config is used
    const map = buildAgentKeyMap(config, [{ id: "main" }], [{ agentId: "main", match: { accountId: "other" } }]);
    assert.equal(map["main"], "jane");
  });
});

// ── resolveAgentKey ─────────────────────────────────────────────────────────

function resolveAgentKey(id: string | undefined, keyMap: Record<string, string>): string | undefined {
  if (!id) return undefined;
  return keyMap[id] ?? (id in keyMap ? undefined : id);
}

describe("resolveAgentKey", () => {
  const keyMap = { main: "jane", jane: "jane", "agent-2": "scout", scout: "scout" };

  it("resolves known agent ID to key", () => {
    assert.equal(resolveAgentKey("main", keyMap), "jane");
  });

  it("resolves key to itself", () => {
    assert.equal(resolveAgentKey("jane", keyMap), "jane");
  });

  it("returns undefined for undefined input", () => {
    assert.equal(resolveAgentKey(undefined, keyMap), undefined);
  });

  it("returns id itself for unknown agent", () => {
    assert.equal(resolveAgentKey("unknown-agent", keyMap), "unknown-agent");
  });
});

// ── Session cost tracking (pure logic) ──────────────────────────────────────

interface SessionCostEntry {
  cost: number;
  calls: number;
  alertSent: boolean;
  lastTs: number;
}

function trackSessionCost(
  sessions: Map<string, SessionCostEntry>,
  agent: string,
  session: string,
  cost: number,
  cap: number,
): { exceeded: boolean; total: number } {
  const key = `${agent}:${session}`;
  const entry = sessions.get(key) ?? { cost: 0, calls: 0, alertSent: false, lastTs: 0 };
  entry.cost += cost;
  entry.calls += 1;
  entry.lastTs = Date.now();
  sessions.set(key, entry);

  const exceeded = entry.cost >= cap && !entry.alertSent;
  if (exceeded) entry.alertSent = true;

  return { exceeded, total: entry.cost };
}

describe("trackSessionCost", () => {
  it("accumulates cost across calls", () => {
    const sessions = new Map<string, SessionCostEntry>();
    trackSessionCost(sessions, "jane", "sess1", 0.50, 5.0);
    trackSessionCost(sessions, "jane", "sess1", 0.75, 5.0);
    const result = trackSessionCost(sessions, "jane", "sess1", 0.25, 5.0);
    assert.equal(result.total, 1.50);
    assert.equal(result.exceeded, false);
  });

  it("detects cap exceeded", () => {
    const sessions = new Map<string, SessionCostEntry>();
    trackSessionCost(sessions, "jane", "sess1", 4.0, 5.0);
    const result = trackSessionCost(sessions, "jane", "sess1", 1.5, 5.0);
    assert.equal(result.exceeded, true);
    assert.equal(result.total, 5.5);
  });

  it("alerts only once per session", () => {
    const sessions = new Map<string, SessionCostEntry>();
    trackSessionCost(sessions, "jane", "sess1", 6.0, 5.0); // first time exceeded
    const result = trackSessionCost(sessions, "jane", "sess1", 1.0, 5.0); // second time
    assert.equal(result.exceeded, false); // already alerted
  });

  it("tracks agents independently", () => {
    const sessions = new Map<string, SessionCostEntry>();
    trackSessionCost(sessions, "jane", "sess1", 3.0, 5.0);
    trackSessionCost(sessions, "forge", "sess1", 4.0, 5.0);
    const janeResult = trackSessionCost(sessions, "jane", "sess1", 1.0, 5.0);
    assert.equal(janeResult.total, 4.0);
    assert.equal(janeResult.exceeded, false);
  });

  it("tracks sessions independently", () => {
    const sessions = new Map<string, SessionCostEntry>();
    trackSessionCost(sessions, "jane", "sess1", 4.0, 5.0);
    const result = trackSessionCost(sessions, "jane", "sess2", 1.0, 5.0);
    assert.equal(result.total, 1.0); // different session
  });
});

// ── Agent silence detection (pure logic) ─────────────────────────────────────

interface AgentActivity {
  lastTs: number;
  type: string;
  alerted: boolean;
}

function checkAgentSilence(
  activity: Map<string, AgentActivity>,
  knownAgents: string[],
  thresholdMs: number,
  now: number,
): string[] {
  const silent: string[] = [];
  for (const agent of knownAgents) {
    const a = activity.get(agent);
    if (!a) {
      silent.push(agent); // never seen = silent
      continue;
    }
    if (now - a.lastTs > thresholdMs && !a.alerted) {
      silent.push(agent);
      a.alerted = true;
    }
  }
  return silent;
}

describe("checkAgentSilence", () => {
  it("returns agents with no activity", () => {
    const activity = new Map<string, AgentActivity>();
    const silent = checkAgentSilence(activity, ["jane", "forge"], 30 * 60_000, Date.now());
    assert.deepEqual(silent, ["jane", "forge"]);
  });

  it("returns agents that exceeded threshold", () => {
    const now = Date.now();
    const activity = new Map<string, AgentActivity>([
      ["jane", { lastTs: now - 60 * 60_000, type: "llm_output", alerted: false }], // 60min ago
      ["forge", { lastTs: now - 10 * 60_000, type: "llm_output", alerted: false }], // 10min ago
    ]);
    const silent = checkAgentSilence(activity, ["jane", "forge"], 30 * 60_000, now);
    assert.deepEqual(silent, ["jane"]); // only jane is silent
  });

  it("does not re-alert already-alerted agents", () => {
    const now = Date.now();
    const activity = new Map<string, AgentActivity>([
      ["jane", { lastTs: now - 60 * 60_000, type: "llm_output", alerted: true }],
    ]);
    const silent = checkAgentSilence(activity, ["jane"], 30 * 60_000, now);
    assert.deepEqual(silent, []); // already alerted
  });

  it("returns empty when all agents active", () => {
    const now = Date.now();
    const activity = new Map<string, AgentActivity>([
      ["jane", { lastTs: now - 5 * 60_000, type: "llm_output", alerted: false }],
      ["forge", { lastTs: now - 1 * 60_000, type: "llm_output", alerted: false }],
    ]);
    const silent = checkAgentSilence(activity, ["jane", "forge"], 30 * 60_000, now);
    assert.deepEqual(silent, []);
  });
});
