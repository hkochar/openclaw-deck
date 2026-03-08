import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  segmentIntoRegions,
  buildActivitySummary,
  computeQualityScores,
  generateCritique,
  computeSessionAnalysis,
  detectAgentType,
  scoreToGrade,
  parseGuidelines,
  guidelinesHash,
  type OutcomeRegion,
} from "@/lib/session-intelligence";
import type { EventRow, RunSummary } from "@/lib/run-intelligence";

// ── Helpers ──────────────────────────────────────────────────────────

let nextId = 1;
const NOW = Date.now();
const HOUR = 3_600_000;
const MIN = 60_000;

function resetIds() {
  nextId = 1;
}

function makeEvent(
  type: string,
  overrides: Partial<EventRow> = {},
): EventRow {
  const id = nextId++;
  return {
    id,
    ts: NOW - HOUR + id * 1000,
    type,
    agent: "scout",
    session: "test-session",
    model: "anthropic/claude-sonnet-4-20250514",
    resolved_model: null,
    cost: type === "llm_output" ? 0.01 : null,
    input_tokens: type === "llm_output" ? 1000 : null,
    output_tokens: type === "llm_output" ? 200 : null,
    cache_read: null,
    cache_write: null,
    has_thinking: null,
    has_prompt: null,
    has_response: null,
    billing: null,
    provider_cost: null,
    detail: null,
    ...overrides,
  };
}

function toolCall(
  tool: string,
  params: Record<string, unknown> = {},
  tsOffset = 0,
): EventRow {
  return makeEvent("tool_call", {
    ts: NOW - HOUR + nextId * 1000 + tsOffset,
    detail: JSON.stringify({ tool, params, success: 1 }),
  });
}

function msgIn(text: string, tsOffset = 0): EventRow {
  return makeEvent("msg_in", {
    ts: NOW - HOUR + nextId * 1000 + tsOffset,
    detail: JSON.stringify({ text }),
  });
}

function llmOutput(tsOffset = 0): EventRow {
  return makeEvent("llm_output", {
    ts: NOW - HOUR + nextId * 1000 + tsOffset,
  });
}

// ── detectAgentType ──────────────────────────────────────────────────

describe("detectAgentType", () => {
  it("maps known roles correctly", () => {
    assert.equal(detectAgentType("Dev / Infrastructure"), "code");
    assert.equal(detectAgentType("Research & Intelligence"), "research");
    assert.equal(detectAgentType("QA / Metrics"), "qa");
    assert.equal(detectAgentType("Creative / Copywriting"), "creative");
    assert.equal(detectAgentType("Chief of Staff / Coordinator"), "coordination");
    assert.equal(detectAgentType("Monitoring / Alerts"), "qa");
    assert.equal(detectAgentType("Security Auditor"), "qa");
  });

  it("returns general for unknown/null", () => {
    assert.equal(detectAgentType(null), "general");
    assert.equal(detectAgentType("Unknown Role"), "general");
  });
});

// ── scoreToGrade ─────────────────────────────────────────────────────

describe("scoreToGrade", () => {
  it("maps scores to letter grades", () => {
    assert.equal(scoreToGrade(95), "A");
    assert.equal(scoreToGrade(88), "A-");
    assert.equal(scoreToGrade(85), "B+");
    assert.equal(scoreToGrade(77), "B");
    assert.equal(scoreToGrade(73), "B-");
    assert.equal(scoreToGrade(67), "C+");
    assert.equal(scoreToGrade(60), "C");
    assert.equal(scoreToGrade(50), "D");
    assert.equal(scoreToGrade(30), "F");
  });
});

// ── segmentIntoRegions ───────────────────────────────────────────────

describe("segmentIntoRegions", () => {
  beforeEach(() => resetIds());

  it("single region for events without msg_in boundaries", () => {
    const events = [
      llmOutput(),
      toolCall("web_search", { query: "test" }),
      llmOutput(),
      toolCall("write", { file_path: "/tmp/out.md" }),
    ];
    const regions = segmentIntoRegions(events);
    assert.equal(regions.length, 1);
    assert.equal(regions[0].regionIndex, 0);
    assert.equal(regions[0].trigger, null);
  });

  it("splits on msg_in events", () => {
    const events = [
      msgIn("Research launch strategies"),
      llmOutput(),
      toolCall("web_search", { query: "OSS launch" }),
      toolCall("write", { file_path: "/tmp/research.md" }),
      msgIn("Now draft the HN post"),
      llmOutput(),
      toolCall("write", { file_path: "/tmp/hn-post.md" }),
    ];
    const regions = segmentIntoRegions(events);
    assert.equal(regions.length, 2);
    assert.equal(regions[0].trigger, "Research launch strategies");
    assert.equal(regions[1].trigger, "Now draft the HN post");
  });

  it("splits on time gaps > 5 minutes", () => {
    const base = NOW;
    nextId = 1;
    const events: EventRow[] = [
      { ...makeEvent("llm_output"), ts: base },
      { ...makeEvent("tool_call", { detail: JSON.stringify({ tool: "read", params: { file_path: "/a" }, success: 1 }) }), ts: base + 1000 },
      // 6-minute gap
      { ...makeEvent("llm_output"), ts: base + 7 * MIN },
      { ...makeEvent("tool_call", { detail: JSON.stringify({ tool: "write", params: { file_path: "/b" }, success: 1 }) }), ts: base + 7 * MIN + 1000 },
    ];
    const regions = segmentIntoRegions(events);
    assert.equal(regions.length, 2);
    assert.equal(regions[1].trigger, null); // time gap, no msg_in
  });

  it("classifies outcomes vs supporting actions", () => {
    const events = [
      msgIn("Do research"),
      llmOutput(),
      toolCall("web_search", { query: "test query" }),
      toolCall("web_fetch", { url: "https://example.com" }),
      toolCall("read", { file_path: "/tmp/notes.md" }),
      toolCall("write", { file_path: "/tmp/output.md" }),
    ];
    const regions = segmentIntoRegions(events);
    assert.equal(regions.length, 1);
    // write = outcome, web_search/web_fetch = supporting (read tracked in activity summary only)
    assert.equal(regions[0].outcomes.length, 1);
    assert.equal(regions[0].outcomes[0].type, "file_written");
    assert.equal(regions[0].supportingActions.length, 2);
  });

  it("computes per-region cost and tokens", () => {
    const events = [
      msgIn("Task 1"),
      llmOutput(),
      llmOutput(),
      msgIn("Task 2"),
      llmOutput(),
    ];
    const regions = segmentIntoRegions(events);
    assert.equal(regions.length, 2);
    assert.equal(regions[0].llmCalls, 2);
    assert.equal(regions[1].llmCalls, 1);
  });

  it("returns empty array for empty events", () => {
    assert.deepEqual(segmentIntoRegions([]), []);
  });
});

// ── buildActivitySummary ─────────────────────────────────────────────

describe("buildActivitySummary", () => {
  beforeEach(() => resetIds());

  it("counts tool breakdown correctly", () => {
    const events = [
      toolCall("web_search", { query: "q1" }),
      toolCall("web_search", { query: "q2" }),
      toolCall("web_fetch", { url: "https://a.com" }),
      toolCall("read", { file_path: "/a.ts" }),
      toolCall("write", { file_path: "/out.md" }),
    ];
    const summary = buildActivitySummary(events);
    assert.equal(summary.searchCount, 2);
    assert.equal(summary.uniqueUrlsFetched, 1);
    assert.equal(summary.sourceFetchRatio, 0.5);
    assert.equal(summary.filesRead, 1);
    assert.equal(summary.filesWritten, 1);
  });

  it("detects thinking usage", () => {
    const events = [
      makeEvent("llm_output", { has_thinking: 1 }),
    ];
    const summary = buildActivitySummary(events);
    assert.equal(summary.thinkingUsed, true);
  });

  it("counts coordination calls", () => {
    const events = [
      toolCall("sessions_send"),
      toolCall("session_status"),
      toolCall("cron"),
      toolCall("web_search", { query: "real work" }),
    ];
    const summary = buildActivitySummary(events);
    assert.equal(summary.coordinationCalls, 3);
  });

  it("deduplicates fetched URLs", () => {
    const events = [
      toolCall("web_fetch", { url: "https://a.com" }),
      toolCall("web_fetch", { url: "https://a.com" }),
      toolCall("web_fetch", { url: "https://b.com" }),
    ];
    const summary = buildActivitySummary(events);
    assert.equal(summary.uniqueUrlsFetched, 2);
  });
});

// ── computeQualityScores ─────────────────────────────────────────────

describe("computeQualityScores", () => {
  beforeEach(() => resetIds());

  it("scores research agent with good fetch ratio highly on depth", () => {
    const events = [
      toolCall("web_search", { query: "q1" }),
      toolCall("web_search", { query: "q2" }),
      toolCall("web_search", { query: "q3" }),
      toolCall("web_fetch", { url: "https://a.com" }),
      toolCall("web_fetch", { url: "https://b.com" }),
      toolCall("write", { file_path: "/out.md" }),
    ];
    const activity = buildActivitySummary(events);
    const scores = computeQualityScores("research", activity, events);
    // 3 searches * 10 + 2 fetches * 15 = 60, no penalty (ratio = 0.67)
    assert.equal(scores.researchDepth, 60);
  });

  it("penalizes shallow research (low fetch ratio)", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) =>
        toolCall("web_search", { query: `q${i}` }),
      ),
      toolCall("web_fetch", { url: "https://a.com" }),
    ];
    const activity = buildActivitySummary(events);
    const scores = computeQualityScores("research", activity, events);
    // 10 * 10 + 1 * 15 = 100, but ratio = 0.1 < 0.3 → * 0.7 = 70 (capped at 100 first)
    assert.equal(scores.researchDepth, 70);
  });

  it("code agent scores research depth from files and commands", () => {
    const events = [
      toolCall("read", { file_path: "/a.ts" }),
      toolCall("read", { file_path: "/b.ts" }),
      toolCall("exec", { command: "npm test" }),
      toolCall("write", { file_path: "/c.ts" }),
    ];
    const activity = buildActivitySummary(events);
    const scores = computeQualityScores("code", activity, events);
    // 2 * 8 + 1 * 5 = 21
    assert.equal(scores.researchDepth, 21);
  });

  it("gives error recovery 100 when no errors", () => {
    const events = [toolCall("read", { file_path: "/a.ts" })];
    const activity = buildActivitySummary(events);
    const scores = computeQualityScores("general", activity, events);
    assert.equal(scores.errorRecovery, 100);
  });

  it("overall is a weighted average", () => {
    const events = [
      toolCall("web_search", { query: "q1" }),
      toolCall("write", { file_path: "/out.md" }),
    ];
    const activity = buildActivitySummary(events);
    const scores = computeQualityScores("general", activity, events);
    assert.ok(scores.overall >= 0 && scores.overall <= 100);
  });
});

// ── generateCritique ─────────────────────────────────────────────────

describe("generateCritique", () => {
  beforeEach(() => resetIds());

  it("flags shallow research when fetch ratio is low", () => {
    const events = Array.from({ length: 8 }, (_, i) =>
      toolCall("web_search", { query: `q${i}` }),
    );
    const activity = buildActivitySummary(events);
    const scores = computeQualityScores("research", activity, events);
    const regions = segmentIntoRegions(events);
    const critique = generateCritique("research", activity, scores, regions);
    assert.ok(
      critique.weaknesses.some((w) => w.includes("Shallow research")),
    );
    assert.ok(
      critique.suggestions.some((s) => s.includes("Fetch primary sources")),
    );
  });

  it("praises good source depth", () => {
    const events = [
      toolCall("web_search", { query: "q1" }),
      toolCall("web_search", { query: "q2" }),
      toolCall("web_search", { query: "q3" }),
      toolCall("web_fetch", { url: "https://a.com" }),
      toolCall("web_fetch", { url: "https://b.com" }),
    ];
    const activity = buildActivitySummary(events);
    const scores = computeQualityScores("research", activity, events);
    const regions = segmentIntoRegions(events);
    const critique = generateCritique("research", activity, scores, regions);
    assert.ok(
      critique.strengths.some((s) => s.includes("source depth")),
    );
  });

  it("flags high coordination overhead", () => {
    const events = [
      ...Array.from({ length: 8 }, () => toolCall("session_status")),
      toolCall("web_search", { query: "work" }),
      toolCall("write", { file_path: "/out.md" }),
    ];
    const activity = buildActivitySummary(events);
    const scores = computeQualityScores("research", activity, events);
    const regions = segmentIntoRegions(events);
    const critique = generateCritique("research", activity, scores, regions);
    assert.ok(
      critique.weaknesses.some((w) => w.includes("coordination overhead")),
    );
  });
});

// ── computeSessionAnalysis (integration) ─────────────────────────────

describe("computeSessionAnalysis", () => {
  beforeEach(() => resetIds());

  it("produces complete analysis for a research session", () => {
    const events = [
      msgIn("Research OSS launch strategies"),
      llmOutput(),
      toolCall("web_search", { query: "OSS launch HN" }),
      toolCall("web_search", { query: "Langfuse launch" }),
      toolCall("web_fetch", { url: "https://github.com/langfuse" }),
      llmOutput(),
      toolCall("write", { file_path: "/research/findings.md" }),
      msgIn("Now draft the post"),
      llmOutput(),
      toolCall("read", { file_path: "/research/findings.md" }),
      toolCall("write", { file_path: "/launch/hn-post.md" }),
    ];

    const analysis = computeSessionAnalysis(events, "research");

    // Basic structure
    assert.equal(analysis.agentType, "research");
    assert.equal(analysis.task, "Research OSS launch strategies");
    assert.equal(analysis.regions.length, 2);
    assert.ok(analysis.outcomes.length >= 2);
    assert.ok(analysis.qualityScores.overall > 0);
    assert.ok(analysis.activitySummary.searchCount === 2);
    assert.ok(analysis.activitySummary.uniqueUrlsFetched === 1);
  });

  it("returns empty analysis for empty events", () => {
    const analysis = computeSessionAnalysis([], "general");
    assert.equal(analysis.regions.length, 0);
    assert.equal(analysis.outcomes.length, 0);
    assert.equal(analysis.qualityScores.overall, 0);
  });

  it("classifies git commit as code_committed", () => {
    const events = [
      llmOutput(),
      toolCall("exec", { command: 'git commit -m "fix bug"' }),
    ];
    const analysis = computeSessionAnalysis(events, "code");
    const commitOutcomes = analysis.outcomes.filter(
      (o) => o.type === "code_committed",
    );
    assert.equal(commitOutcomes.length, 1);
  });

  it("classifies test run as test_run", () => {
    const events = [
      llmOutput(),
      toolCall("exec", { command: "vitest run" }),
    ];
    const analysis = computeSessionAnalysis(events, "code");
    const testOutcomes = analysis.outcomes.filter(
      (o) => o.type === "test_run",
    );
    assert.equal(testOutcomes.length, 1);
  });

  it("uses RunSummary status for task completion scoring", () => {
    const events = [llmOutput(), toolCall("write", { file_path: "/a" })];
    const runSummary: RunSummary = {
      startedTs: NOW,
      endedTs: NOW + 1000,
      durationMs: 1000,
      status: "completed",
      endedReason: "heuristic",
      totalCostUsd: 0.01,
      totalTokensIn: 1000,
      totalTokensOut: 200,
      modelSet: ["claude-sonnet"],
      toolCallCount: 1,
      uniqueToolCount: 1,
      uniqueTools: ["write"],
      retryCount: 0,
      maxLoopDepth: 0,
      maxConsecutiveLlmCalls: 0,
      errorCount: 0,
      touchedConfig: false,
      gatewayRestarted: false,
      rollbackDuringRun: false,
      blockedByBudget: false,
      throttledByBudget: false,
      overrideActive: false,
      eventsMaxId: 100,
      billing: null,
    };
    const analysis = computeSessionAnalysis(events, "code", runSummary);
    // completed (80) + has outcomes (+20) = 100
    assert.equal(analysis.qualityScores.taskCompletion, 100);
  });
});

// ── parseGuidelines ──────────────────────────────────────────────────

describe("parseGuidelines", () => {
  it("returns defaults for null/undefined", () => {
    const o = parseGuidelines(null);
    assert.deepEqual(o.weightMultipliers, {});
    assert.equal(o.fetchRatioThreshold, 0.3);
    assert.equal(o.loopDepthThreshold, 8);
    assert.equal(o.strictness, 1.0);
  });

  it("parses 'ignore cost'", () => {
    const o = parseGuidelines("ignore cost");
    assert.equal(o.weightMultipliers.costEfficiency, 0);
  });

  it("parses 'focus on depth'", () => {
    const o = parseGuidelines("focus on depth");
    assert.equal(o.weightMultipliers.researchDepth, 2);
  });

  it("parses 'focus on efficiency'", () => {
    const o = parseGuidelines("focus on efficiency");
    assert.equal(o.weightMultipliers.toolEfficiency, 2);
  });

  it("parses 'penalize loops'", () => {
    const o = parseGuidelines("penalize loops");
    assert.equal(o.loopDepthThreshold, 4);
  });

  it("parses 'penalize shallow research'", () => {
    const o = parseGuidelines("penalize shallow research");
    assert.equal(o.fetchRatioThreshold, 0.5);
  });

  it("parses 'strict'", () => {
    const o = parseGuidelines("strict");
    assert.equal(o.strictness, 0.8);
  });

  it("parses 'lenient'", () => {
    const o = parseGuidelines("lenient");
    assert.equal(o.strictness, 1.2);
  });

  it("handles multiple keywords", () => {
    const o = parseGuidelines("focus on depth, ignore cost, strict");
    assert.equal(o.weightMultipliers.researchDepth, 2);
    assert.equal(o.weightMultipliers.costEfficiency, 0);
    assert.equal(o.strictness, 0.8);
  });
});

// ── guidelinesHash ───────────────────────────────────────────────────

describe("guidelinesHash", () => {
  it("returns null for null/undefined", () => {
    assert.equal(guidelinesHash(null), null);
    assert.equal(guidelinesHash(undefined), null);
  });

  it("returns consistent hash for same input", () => {
    const h1 = guidelinesHash("focus on depth");
    const h2 = guidelinesHash("focus on depth");
    assert.equal(h1, h2);
    assert.ok(typeof h1 === "string" && h1.length > 0);
  });

  it("returns different hashes for different input", () => {
    const h1 = guidelinesHash("focus on depth");
    const h2 = guidelinesHash("ignore cost");
    assert.notEqual(h1, h2);
  });
});

// ── Guidelines-modified scoring ──────────────────────────────────────

describe("computeQualityScores with guidelines", () => {
  beforeEach(() => resetIds());

  it("'ignore cost' zeroes costEfficiency weight in overall", () => {
    const events = [
      toolCall("web_search", { query: "q1" }),
      toolCall("write", { file_path: "/out.md" }),
    ];
    const activity = buildActivitySummary(events);
    const defaultScores = computeQualityScores("research", activity, events);
    const guidedScores = computeQualityScores("research", activity, events, null, null, "ignore cost");
    // Overall should differ when cost weight is zeroed
    assert.notEqual(defaultScores.overall, guidedScores.overall);
    // Individual dimension scores stay the same
    assert.equal(defaultScores.costEfficiency, guidedScores.costEfficiency);
    assert.equal(defaultScores.researchDepth, guidedScores.researchDepth);
  });

  it("'focus on depth' changes overall due to weight redistribution", () => {
    const events = [
      toolCall("web_search", { query: "q1" }),
      toolCall("web_search", { query: "q2" }),
      toolCall("web_fetch", { url: "https://a.com" }),
      toolCall("web_fetch", { url: "https://b.com" }),
      toolCall("write", { file_path: "/out.md" }),
    ];
    const activity = buildActivitySummary(events);
    const defaultScores = computeQualityScores("research", activity, events);
    const guidedScores = computeQualityScores("research", activity, events, null, null, "focus on depth");
    // Overall should differ due to weight redistribution
    assert.notEqual(defaultScores.overall, guidedScores.overall);
  });

  it("guidelines do not change individual dimension scores, only overall", () => {
    const events = [
      toolCall("web_search", { query: "q1" }),
      toolCall("web_fetch", { url: "https://a.com" }),
      toolCall("write", { file_path: "/out.md" }),
    ];
    const activity = buildActivitySummary(events);
    const defaultScores = computeQualityScores("research", activity, events);
    const guidedScores = computeQualityScores("research", activity, events, null, null, "focus on efficiency, strict");
    assert.equal(defaultScores.toolEfficiency, guidedScores.toolEfficiency);
    assert.equal(defaultScores.researchDepth, guidedScores.researchDepth);
    assert.equal(defaultScores.taskCompletion, guidedScores.taskCompletion);
    assert.equal(defaultScores.errorRecovery, guidedScores.errorRecovery);
    assert.equal(defaultScores.costEfficiency, guidedScores.costEfficiency);
  });
});

// ── computeSessionAnalysis with guidelines ───────────────────────────

describe("computeSessionAnalysis with guidelines", () => {
  beforeEach(() => resetIds());

  it("passes guidelines through to scoring", () => {
    const events = [
      msgIn("Research topic"),
      llmOutput(),
      toolCall("web_search", { query: "q1" }),
      toolCall("web_fetch", { url: "https://a.com" }),
      toolCall("write", { file_path: "/out.md" }),
    ];
    const defaultAnalysis = computeSessionAnalysis(events, "research");
    resetIds();
    const guidedAnalysis = computeSessionAnalysis(events, "research", undefined, undefined, "ignore cost");
    // Same regions
    assert.equal(defaultAnalysis.regions.length, guidedAnalysis.regions.length);
    // Same activity
    assert.equal(defaultAnalysis.activitySummary.searchCount, guidedAnalysis.activitySummary.searchCount);
    // Different overall (weight redistribution)
    assert.notEqual(defaultAnalysis.qualityScores.overall, guidedAnalysis.qualityScores.overall);
  });
});
