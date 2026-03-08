/**
 * Unit tests for gateway event-log pure functions.
 *
 * The gateway plugin (extensions/openclaw-deck-sync/event-log.ts) cannot be
 * imported directly into the dashboard test environment, so we re-implement the
 * pure functions locally with identical logic and test them thoroughly.
 *
 * Run: npx tsx --test __tests__/gateway-event-log.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// 1. estimateCost
// ============================================================================

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  opus:      { input: 15,    output: 75,    cacheRead: 1.5,   cacheWrite: 18.75 },
  sonnet:    { input: 3,     output: 15,    cacheRead: 0.3,   cacheWrite: 3.75 },
  haiku:     { input: 0.25,  output: 1.25,  cacheRead: 0.025, cacheWrite: 0.3125 },
  "gpt-4o":  { input: 2.5,   output: 10,    cacheRead: 1.25,  cacheWrite: 0 },
  "gpt-4":   { input: 30,    output: 60,    cacheRead: 0,     cacheWrite: 0 },
  deepseek:  { input: 0.27,  output: 1.10,  cacheRead: 0.07,  cacheWrite: 0 },
  gemini:    { input: 0.15,  output: 0.60,  cacheRead: 0.04,  cacheWrite: 0 },
  llama:     { input: 0.20,  output: 0.80,  cacheRead: 0,     cacheWrite: 0 },
  qwen:      { input: 0.15,  output: 0.60,  cacheRead: 0,     cacheWrite: 0 },
  nemotron:  { input: 0.20,  output: 0.80,  cacheRead: 0,     cacheWrite: 0 },
};

const FALLBACK_PRICING: ModelPricing = { input: 1.0, output: 4.0, cacheRead: 0.25, cacheWrite: 0 };
const OPENROUTER_AUTO_PRICING: ModelPricing = { input: 0.10, output: 0.40, cacheRead: 0.025, cacheWrite: 0 };

/**
 * Re-implementation of estimateCost from event-log.ts.
 * Uses activePricing (defaults to DEFAULT_PRICING), no learned pricing in tests.
 */
function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number = 0,
): number {
  const lower = model.toLowerCase();
  let pricing: ModelPricing | undefined;

  // Substring match against pricing table (longest key first)
  const keys = Object.keys(DEFAULT_PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key.toLowerCase())) {
      pricing = DEFAULT_PRICING[key];
      break;
    }
  }

  // OpenRouter models without a match
  if (!pricing && lower.includes("openrouter/")) {
    pricing = (lower.includes("/auto") || lower.includes("/free"))
      ? OPENROUTER_AUTO_PRICING
      : FALLBACK_PRICING;
  }

  if (!pricing) return 0;

  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    (cacheWrite / 1_000_000) * pricing.cacheWrite
  );
}

describe("estimateCost", () => {
  it("calculates opus cost correctly", () => {
    // 1000 input * 15/1M + 500 output * 75/1M = 0.015 + 0.0375 = 0.0525
    const cost = estimateCost("opus", 1000, 500, 0, 0);
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.0525);
  });

  it("calculates sonnet cost correctly", () => {
    const cost = estimateCost("sonnet", 10000, 2000, 5000, 0);
    // 10000*3/1M + 2000*15/1M + 5000*0.3/1M = 0.03 + 0.03 + 0.0015 = 0.0615
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.0615);
  });

  it("calculates haiku cost correctly", () => {
    const cost = estimateCost("haiku", 50000, 10000, 0, 0);
    // 50000*0.25/1M + 10000*1.25/1M = 0.0125 + 0.0125 = 0.025
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.025);
  });

  it("calculates gpt-4o cost correctly", () => {
    const cost = estimateCost("gpt-4o", 5000, 1000, 2000, 0);
    // 5000*2.5/1M + 1000*10/1M + 2000*1.25/1M = 0.0125 + 0.01 + 0.0025 = 0.025
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.025);
  });

  it("matches model by substring: anthropic/claude-opus-4-6 -> opus pricing", () => {
    const cost = estimateCost("anthropic/claude-opus-4-6", 1000, 500, 0, 0);
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.0525);
  });

  it("matches model case-insensitively: OPUS -> opus pricing", () => {
    const cost = estimateCost("OPUS", 1000, 500, 0, 0);
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.0525);
  });

  it("longest key wins: gpt-4o matches before gpt-4", () => {
    // "gpt-4o" (len 6) sorted before "gpt-4" (len 5), so gpt-4o pricing applies
    const costGpt4o = estimateCost("gpt-4o-mini", 1000, 1000, 0, 0);
    const expectedGpt4o = (1000 / 1e6) * 2.5 + (1000 / 1e6) * 10; // gpt-4o rates
    assert.equal(Math.round(costGpt4o * 1e6) / 1e6, Math.round(expectedGpt4o * 1e6) / 1e6);

    // Verify it does NOT use gpt-4 rates
    const costGpt4 = (1000 / 1e6) * 30 + (1000 / 1e6) * 60; // gpt-4 rates would give 0.09
    assert.notEqual(Math.round(costGpt4o * 1e6) / 1e6, Math.round(costGpt4 * 1e6) / 1e6);
  });

  it("openrouter/auto uses OPENROUTER_AUTO_PRICING", () => {
    const cost = estimateCost("openrouter/auto", 10000, 5000, 0, 0);
    // 10000*0.10/1M + 5000*0.40/1M = 0.001 + 0.002 = 0.003
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.003);
  });

  it("openrouter/free uses OPENROUTER_AUTO_PRICING", () => {
    const cost = estimateCost("openrouter/free", 10000, 5000, 0, 0);
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.003);
  });

  it("openrouter/something-else uses FALLBACK_PRICING", () => {
    const cost = estimateCost("openrouter/some-custom-model", 10000, 5000, 0, 0);
    // 10000*1.0/1M + 5000*4.0/1M = 0.01 + 0.02 = 0.03
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.03);
  });

  it("unknown model without openrouter returns 0", () => {
    assert.equal(estimateCost("totally-unknown-model", 1000, 500, 0, 0), 0);
  });

  it("zero tokens returns 0", () => {
    assert.equal(estimateCost("opus", 0, 0, 0, 0), 0);
  });

  it("includes cacheWrite in calculation", () => {
    const withoutCW = estimateCost("opus", 1000, 500, 0, 0);
    const withCW = estimateCost("opus", 1000, 500, 0, 10000);
    // cacheWrite cost = 10000 * 18.75 / 1M = 0.1875
    assert.ok(withCW > withoutCW);
    const diff = Math.round((withCW - withoutCW) * 1e6) / 1e6;
    assert.equal(diff, 0.1875);
  });

  it("handles large token counts (1M tokens)", () => {
    const cost = estimateCost("opus", 1_000_000, 1_000_000, 0, 0);
    // 1M * 15/1M + 1M * 75/1M = 15 + 75 = 90
    assert.equal(cost, 90);
  });

  it("includes cacheRead in calculation", () => {
    const cost = estimateCost("sonnet", 0, 0, 100_000, 0);
    // 100000 * 0.3/1M = 0.03
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.03);
  });

  it("deepseek pricing works", () => {
    const cost = estimateCost("deepseek-chat", 100_000, 50_000, 0, 0);
    // 100000*0.27/1M + 50000*1.10/1M = 0.027 + 0.055 = 0.082
    assert.equal(Math.round(cost * 1e6) / 1e6, 0.082);
  });
});

// ============================================================================
// 2. checkForLoop
// ============================================================================

const LOOP_WINDOW = 20;
const LOOP_THRESHOLD = 5;
const LOOP_COOLDOWN = 300_000;

interface LoopInfo {
  count: number;
  firstTs: number;
  lastTs: number;
}

interface LoopState {
  recentCalls: string[];
  lastAlertTs: number;
  detectedLoops: Map<string, LoopInfo>;
}

const agentLoopState = new Map<string, LoopState>();
const loopAlerts: Array<{ agent: string; tool: string; count: number; signature: string }> = [];

function resetLoopState(): void {
  agentLoopState.clear();
  loopAlerts.length = 0;
}

function checkForLoop(agent: string, detail: Record<string, unknown>): void {
  const tool = detail.tool as string;
  if (!tool) return;

  const params = detail.params ? JSON.stringify(detail.params) : "";
  const sig = `${tool}:${params.slice(0, 500)}`;

  if (!agentLoopState.has(agent)) {
    agentLoopState.set(agent, { recentCalls: [], lastAlertTs: 0, detectedLoops: new Map() });
  }
  const state = agentLoopState.get(agent)!;

  state.recentCalls.push(sig);
  if (state.recentCalls.length > LOOP_WINDOW) state.recentCalls.shift();

  const count = state.recentCalls.filter(s => s === sig).length;

  if (count >= LOOP_THRESHOLD) {
    const now = Date.now();
    const existing = state.detectedLoops.get(sig);
    if (existing) {
      existing.count = count;
      existing.lastTs = now;
    } else {
      state.detectedLoops.set(sig, { count, firstTs: now, lastTs: now });
    }

    if (now - state.lastAlertTs > LOOP_COOLDOWN) {
      state.lastAlertTs = now;
      loopAlerts.push({ agent, tool, count, signature: sig });
    }
  } else {
    state.detectedLoops.delete(sig);
  }
}

interface StuckLoopInfo {
  agent: string;
  tool: string;
  signature: string;
  count: number;
  firstTs: number;
  lastTs: number;
}

function getActiveLoops(): StuckLoopInfo[] {
  const result: StuckLoopInfo[] = [];
  const now = Date.now();
  for (const [agent, state] of agentLoopState) {
    for (const [sig, info] of state.detectedLoops) {
      if (now - info.lastTs < 120_000) {
        const tool = sig.split(":")[0];
        result.push({ agent, tool, signature: sig, count: info.count, firstTs: info.firstTs, lastTs: info.lastTs });
      }
    }
  }
  return result;
}

describe("checkForLoop", () => {
  beforeEach(() => {
    resetLoopState();
  });

  it("no loop when different tools called", () => {
    for (let i = 0; i < 20; i++) {
      checkForLoop("jane", { tool: `tool_${i}`, params: "abc" });
    }
    const state = agentLoopState.get("jane")!;
    assert.equal(state.detectedLoops.size, 0);
  });

  it("detects loop after 5 identical tool calls", () => {
    for (let i = 0; i < 5; i++) {
      checkForLoop("jane", { tool: "read", params: { file: "test.ts" } });
    }
    const state = agentLoopState.get("jane")!;
    assert.equal(state.detectedLoops.size, 1);
    const loop = [...state.detectedLoops.values()][0];
    assert.equal(loop.count, 5);
  });

  it("different params produce different signatures (no loop)", () => {
    for (let i = 0; i < 5; i++) {
      checkForLoop("jane", { tool: "read", params: { file: `file_${i}.ts` } });
    }
    const state = agentLoopState.get("jane")!;
    assert.equal(state.detectedLoops.size, 0);
  });

  it("circular buffer wraps at LOOP_WINDOW (20)", () => {
    // Add 4 matching calls (below threshold)
    for (let i = 0; i < 4; i++) {
      checkForLoop("jane", { tool: "read", params: "same" });
    }
    // Fill buffer with 20 different calls, pushing all 4 "read" calls out
    for (let i = 0; i < 20; i++) {
      checkForLoop("jane", { tool: `other_${i}` });
    }
    const state = agentLoopState.get("jane")!;
    assert.equal(state.recentCalls.length, 20);
    // The original 4 "read" calls should be pushed out
    const readCount = state.recentCalls.filter(s => s.startsWith("read:")).length;
    assert.equal(readCount, 0);
  });

  it("loop clears when count drops below threshold", () => {
    // Trigger a loop with 5 identical calls
    for (let i = 0; i < 5; i++) {
      checkForLoop("jane", { tool: "read", params: "same" });
    }
    assert.equal(agentLoopState.get("jane")!.detectedLoops.size, 1);

    // Push most matching calls out of the window with different calls,
    // then make one more "read:same" call. At that point only 1 matching
    // call remains in the window (the new one), which is below threshold,
    // so the loop entry gets deleted.
    for (let i = 0; i < 19; i++) {
      checkForLoop("jane", { tool: `other_${i}` });
    }
    // Now the window has 19 "other" + 1 leftover "read" call. Fire one more
    // "read:same" -- count will be 1 (only this new one is in window after
    // the buffer trims to 20), which is < LOOP_THRESHOLD, so it clears.
    checkForLoop("jane", { tool: "read", params: "same" });
    const sig = 'read:"same"';
    assert.equal(agentLoopState.get("jane")!.detectedLoops.has(sig), false);
  });

  it("alert cooldown prevents re-alerting within 5 minutes", () => {
    // Trigger loop and alert
    for (let i = 0; i < 5; i++) {
      checkForLoop("jane", { tool: "read", params: "same" });
    }
    assert.equal(loopAlerts.length, 1);

    // Trigger more identical calls -- should NOT produce a second alert
    for (let i = 0; i < 5; i++) {
      checkForLoop("jane", { tool: "read", params: "same" });
    }
    assert.equal(loopAlerts.length, 1, "should not re-alert during cooldown");
  });

  it("multiple agents tracked independently", () => {
    for (let i = 0; i < 5; i++) {
      checkForLoop("jane", { tool: "read", params: "same" });
    }
    for (let i = 0; i < 3; i++) {
      checkForLoop("forge", { tool: "read", params: "same" });
    }
    assert.equal(agentLoopState.get("jane")!.detectedLoops.size, 1);
    assert.equal(agentLoopState.get("forge")!.detectedLoops.size, 0);
  });

  it("no tool in detail results in no tracking", () => {
    checkForLoop("jane", { params: "something" });
    assert.equal(agentLoopState.has("jane"), false);
  });

  it("params are truncated at 500 chars for signature", () => {
    const longParams = "x".repeat(1000);
    checkForLoop("jane", { tool: "read", params: longParams });
    const state = agentLoopState.get("jane")!;
    // Signature should have params truncated to 500
    const sig = state.recentCalls[0];
    // JSON.stringify("xxx...") adds quotes, so total is "read:" + quoted string truncated at 500
    assert.ok(sig.length <= "read:".length + 500 + 2); // +2 for JSON quotes
  });
});

// ============================================================================
// 3. getActiveLoops
// ============================================================================

describe("getActiveLoops", () => {
  beforeEach(() => {
    resetLoopState();
  });

  it("returns empty when no loops", () => {
    assert.deepEqual(getActiveLoops(), []);
  });

  it("returns active loops within 120s", () => {
    // Trigger a loop (sets lastTs to Date.now())
    for (let i = 0; i < 5; i++) {
      checkForLoop("jane", { tool: "read", params: "same" });
    }
    const loops = getActiveLoops();
    assert.equal(loops.length, 1);
    assert.equal(loops[0].agent, "jane");
    assert.equal(loops[0].tool, "read");
    assert.equal(loops[0].count, 5);
  });

  it("filters out stale loops (>120s old)", () => {
    // Trigger a loop
    for (let i = 0; i < 5; i++) {
      checkForLoop("jane", { tool: "read", params: "same" });
    }
    // Manually backdate lastTs by 130s
    const state = agentLoopState.get("jane")!;
    for (const info of state.detectedLoops.values()) {
      info.lastTs = Date.now() - 130_000;
    }
    const loops = getActiveLoops();
    assert.equal(loops.length, 0);
  });

  it("returns loops from multiple agents", () => {
    for (let i = 0; i < 5; i++) {
      checkForLoop("jane", { tool: "read", params: "same" });
    }
    for (let i = 0; i < 5; i++) {
      checkForLoop("forge", { tool: "write", params: "same" });
    }
    const loops = getActiveLoops();
    assert.equal(loops.length, 2);
    const agents = loops.map(l => l.agent).sort();
    assert.deepEqual(agents, ["forge", "jane"]);
  });
});

// ============================================================================
// 4. isMemoryEvent and normalizeMemoryPath
// ============================================================================

function isMemoryEvent(params: string): boolean {
  const lower = params.toLowerCase();
  return (
    lower.includes("memory/") ||
    lower.includes("memory.md") ||
    lower.includes("memory-checkpoint") ||
    lower.includes("memory-decay") ||
    lower.includes("working-sync")
  );
}

function normalizeMemoryPath(fp: string): string {
  const memIdx = fp.indexOf("memory/");
  if (memIdx >= 0) return fp.slice(memIdx);
  if (fp.endsWith("MEMORY.md")) return "MEMORY.md";
  return fp;
}

describe("isMemoryEvent", () => {
  it("returns true for memory/ path", () => {
    assert.equal(isMemoryEvent('{"file_path":"/home/user/memory/foo.md"}'), true);
  });

  it("returns true for MEMORY.md", () => {
    assert.equal(isMemoryEvent('{"file_path":"MEMORY.md"}'), true);
  });

  it("returns true for memory-checkpoint", () => {
    assert.equal(isMemoryEvent('{"command":"bash memory-checkpoint.sh"}'), true);
  });

  it("returns true for memory-decay", () => {
    assert.equal(isMemoryEvent('{"command":"memory-decay run"}'), true);
  });

  it("returns true for working-sync", () => {
    assert.equal(isMemoryEvent('{"command":"working-sync push"}'), true);
  });

  it("returns false for unrelated file", () => {
    assert.equal(isMemoryEvent('{"file_path":"some-random-file.ts"}'), false);
  });

  it("is case insensitive", () => {
    assert.equal(isMemoryEvent('{"file_path":"MEMORY/FOO.MD"}'), true);
    assert.equal(isMemoryEvent('{"file_path":"Memory.md"}'), true);
    assert.equal(isMemoryEvent('{"command":"WORKING-SYNC push"}'), true);
  });

  it("returns false for empty string", () => {
    assert.equal(isMemoryEvent(""), false);
  });
});

describe("normalizeMemoryPath", () => {
  it("strips prefix before memory/", () => {
    assert.equal(normalizeMemoryPath("/home/user/.claude/memory/MEMORY.md"), "memory/MEMORY.md");
  });

  it("returns MEMORY.md for absolute path ending with MEMORY.md (no memory/ segment)", () => {
    assert.equal(normalizeMemoryPath("/absolute/path/MEMORY.md"), "MEMORY.md");
  });

  it("returns path unchanged if no memory/ and not MEMORY.md", () => {
    assert.equal(normalizeMemoryPath("some/other/file.ts"), "some/other/file.ts");
  });

  it("handles path with memory/ in the middle", () => {
    assert.equal(normalizeMemoryPath("/foo/bar/memory/plans/plan.md"), "memory/plans/plan.md");
  });

  it("uses first occurrence of memory/", () => {
    assert.equal(
      normalizeMemoryPath("/root/memory/sub/memory/deep.md"),
      "memory/sub/memory/deep.md",
    );
  });
});

// ============================================================================
// 5. extractFilePath
// ============================================================================

function extractFilePath(tool: string, params: string): string {
  try {
    const p = JSON.parse(params);
    if (p.file_path) return normalizeMemoryPath(p.file_path);
    if (p.path) return normalizeMemoryPath(p.path);
    if (p.command && typeof p.command === "string") {
      const memMatch = p.command.match(/memory\/[\w._-]+\.(?:md|sh)/i);
      if (memMatch) return memMatch[0];
      const scriptMatch = p.command.match(/memory-checkpoint\.sh|memory-decay|working-sync/i);
      if (scriptMatch) return `scripts/${scriptMatch[0]}`;
      return "exec (memory-related)";
    }
  } catch { /* ignore parse errors */ }
  return "unknown";
}

describe("extractFilePath", () => {
  it("extracts file_path and normalizes it", () => {
    const params = JSON.stringify({ file_path: "/home/user/.claude/memory/MEMORY.md" });
    assert.equal(extractFilePath("read", params), "memory/MEMORY.md");
  });

  it("extracts path field and normalizes it", () => {
    const params = JSON.stringify({ path: "/home/user/.claude/memory/plans/plan.md" });
    assert.equal(extractFilePath("write", params), "memory/plans/plan.md");
  });

  it("prefers file_path over path", () => {
    const params = JSON.stringify({
      file_path: "/home/user/memory/a.md",
      path: "/home/user/memory/b.md",
    });
    assert.equal(extractFilePath("read", params), "memory/a.md");
  });

  it("extracts memory file from exec command", () => {
    const params = JSON.stringify({ command: "cat /home/user/memory/notes.md" });
    assert.equal(extractFilePath("exec", params), "memory/notes.md");
  });

  it("extracts memory-checkpoint.sh from exec command", () => {
    const params = JSON.stringify({ command: "bash memory-checkpoint.sh --force" });
    assert.equal(extractFilePath("exec", params), "scripts/memory-checkpoint.sh");
  });

  it("extracts memory-decay from exec command", () => {
    const params = JSON.stringify({ command: "run memory-decay" });
    assert.equal(extractFilePath("exec", params), "scripts/memory-decay");
  });

  it("extracts working-sync from exec command", () => {
    const params = JSON.stringify({ command: "working-sync push" });
    assert.equal(extractFilePath("exec", params), "scripts/working-sync");
  });

  it("returns 'exec (memory-related)' for exec with no matching pattern", () => {
    const params = JSON.stringify({ command: "echo hello memory" });
    assert.equal(extractFilePath("exec", params), "exec (memory-related)");
  });

  it("returns 'unknown' for invalid JSON", () => {
    assert.equal(extractFilePath("read", "not-json"), "unknown");
  });

  it("returns 'unknown' for JSON with no recognized fields", () => {
    const params = JSON.stringify({ foo: "bar" });
    assert.equal(extractFilePath("read", params), "unknown");
  });

  it("normalizes MEMORY.md in file_path without memory/ segment", () => {
    const params = JSON.stringify({ file_path: "/absolute/MEMORY.md" });
    assert.equal(extractFilePath("read", params), "MEMORY.md");
  });
});

// ============================================================================
// 6. SUB_FILTER_SQL mapping
// ============================================================================

const SUB_FILTER_SQL: Record<string, string> = {
  "thinking": "thinking IS NOT NULL",
  "cached": "cache_read > 0",
  "no-cache": "(cache_read IS NULL OR cache_read = 0)",
  "sub-billing": "billing = 'subscription'",
  "metered-billing": "billing = 'metered'",
  "has-compaction": "json_extract(detail, '$.hasCompaction') = 1",
  "has-tool-use": "json_extract(detail, '$.hasToolUse') = 1",
  "has-images": "json_extract(detail, '$.imagesCount') > 0",
  "large-context": "json_extract(detail, '$.systemPromptLen') >= 10000",
  "tool-read": `json_extract(detail, '$.tool') IN ('read','sessions_list','session_status','web_search','image','gateway')`,
  "tool-write": `json_extract(detail, '$.tool') IN ('exec','edit','write','sessions_send','message','process')`,
  "tool-failed": "json_extract(detail, '$.success') = 0",
  "tool-cron": "json_extract(detail, '$.tool') = 'cron'",
  "msg-discord": "session LIKE '%discord%'",
  "msg-hook": "session LIKE '%hook%'",
};

describe("SUB_FILTER_SQL", () => {
  const EXPECTED_KEYS = [
    "thinking",
    "cached",
    "no-cache",
    "sub-billing",
    "metered-billing",
    "has-compaction",
    "has-tool-use",
    "has-images",
    "large-context",
    "tool-read",
    "tool-write",
    "tool-failed",
    "tool-cron",
    "msg-discord",
    "msg-hook",
  ];

  it("has all expected filter keys", () => {
    for (const key of EXPECTED_KEYS) {
      assert.ok(key in SUB_FILTER_SQL, `missing key: ${key}`);
    }
  });

  it("has no unexpected extra keys", () => {
    const actualKeys = Object.keys(SUB_FILTER_SQL);
    assert.equal(actualKeys.length, EXPECTED_KEYS.length);
    for (const key of actualKeys) {
      assert.ok(EXPECTED_KEYS.includes(key), `unexpected key: ${key}`);
    }
  });

  it("all values are non-empty strings", () => {
    for (const [key, sql] of Object.entries(SUB_FILTER_SQL)) {
      assert.equal(typeof sql, "string", `${key} value should be a string`);
      assert.ok(sql.length > 0, `${key} value should be non-empty`);
    }
  });

  it("billing filters reference the billing column", () => {
    assert.ok(SUB_FILTER_SQL["sub-billing"].includes("billing"));
    assert.ok(SUB_FILTER_SQL["metered-billing"].includes("billing"));
  });

  it("tool-read and tool-write list valid tool names", () => {
    assert.ok(SUB_FILTER_SQL["tool-read"].includes("read"));
    assert.ok(SUB_FILTER_SQL["tool-write"].includes("exec"));
    assert.ok(SUB_FILTER_SQL["tool-write"].includes("edit"));
    assert.ok(SUB_FILTER_SQL["tool-write"].includes("write"));
  });

  it("msg-discord uses LIKE with discord pattern", () => {
    assert.ok(SUB_FILTER_SQL["msg-discord"].includes("LIKE"));
    assert.ok(SUB_FILTER_SQL["msg-discord"].includes("discord"));
  });
});
