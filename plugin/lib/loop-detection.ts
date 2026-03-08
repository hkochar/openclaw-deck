import { getLogger } from "../logger";

// ── Stuck Agent Loop Detection ────────────────────────────────────
// Tracks recent tool_call signatures per agent. If the same tool+args
// repeats N times within M calls, the agent is likely stuck in a loop.

const LOOP_WINDOW = 20;       // check last N tool calls per agent
const LOOP_THRESHOLD = 5;     // same signature N times = stuck
const LOOP_COOLDOWN = 300_000; // don't re-alert for 5 minutes

interface LoopState {
  recentCalls: string[];       // circular buffer of tool call signatures
  lastAlertTs: number;
  detectedLoops: Map<string, { count: number; firstTs: number; lastTs: number }>;
}

const agentLoopState = new Map<string, LoopState>();
let loopAlertCallbacks: Array<(agent: string, tool: string, count: number, signature: string) => void> = [];

export function onLoopDetected(cb: (agent: string, tool: string, count: number, signature: string) => void): void {
  loopAlertCallbacks.push(cb);
}

export interface StuckLoopInfo {
  agent: string;
  tool: string;
  signature: string;
  count: number;
  firstTs: number;
  lastTs: number;
}

export function getActiveLoops(): StuckLoopInfo[] {
  const result: StuckLoopInfo[] = [];
  const now = Date.now();
  for (const [agent, state] of agentLoopState) {
    for (const [sig, info] of state.detectedLoops) {
      // Only show loops that are still active (last occurrence within 2 minutes)
      if (now - info.lastTs < 120_000) {
        const tool = sig.split(":")[0];
        result.push({ agent, tool, signature: sig, count: info.count, firstTs: info.firstTs, lastTs: info.lastTs });
      }
    }
  }
  return result;
}

/**
 * Reset loop detection state for an agent. Called when a new cron invocation
 * starts so that repeated tool calls across separate invocations don't
 * accumulate into a false-positive loop detection.
 */
export function resetLoopState(agent: string): void {
  const state = agentLoopState.get(agent);
  if (state) {
    state.recentCalls = [];
    // Keep detectedLoops — they auto-expire via the 2-minute window in getActiveLoops
  }
}

export function checkForLoop(agent: string, detail: Record<string, unknown>): void {
  const tool = detail.tool as string;
  if (!tool) return;

  // Build a signature from tool name + params (deterministic)
  const params = detail.params ? JSON.stringify(detail.params) : "";
  const sig = `${tool}:${params.slice(0, 500)}`;

  if (!agentLoopState.has(agent)) {
    agentLoopState.set(agent, { recentCalls: [], lastAlertTs: 0, detectedLoops: new Map() });
  }
  const state = agentLoopState.get(agent)!;

  // Add to circular buffer
  state.recentCalls.push(sig);
  if (state.recentCalls.length > LOOP_WINDOW) state.recentCalls.shift();

  // Count occurrences of this signature in the window
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

    // Fire alert (with cooldown)
    if (now - state.lastAlertTs > LOOP_COOLDOWN) {
      state.lastAlertTs = now;
      getLogger().warn(`[deck-sync] STUCK LOOP DETECTED: agent=${agent} tool=${tool} repeated ${count}/${LOOP_WINDOW} times`);
      for (const cb of loopAlertCallbacks) {
        try { cb(agent, tool, count, sig); } catch { /* don't crash */ }
      }
    }
  } else {
    // Clear loop state for this signature if it drops below threshold
    state.detectedLoops.delete(sig);
  }
}
