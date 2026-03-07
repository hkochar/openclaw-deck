import { getDb } from "./db-core";

// ── Memory Operations ──────────────────────────────────────────

export interface MemoryOpRow {
  file_path: string;
  reads: number;
  writes: number;
  edits: number;
  execs: number;
  agents: string[];
  last_ts: number;
  sessions: number;
}

export interface MemoryTimelineEvent {
  id: number;
  ts: number;
  agent: string;
  session: string;
  op: string;
  file_path: string;
  params: string;
  trigger: string | null;
}

const MEMORY_PATTERNS = ["%memory/%", "%MEMORY.md%", "%memory-checkpoint%", "%memory-decay%", "%working-sync%"];

function isMemoryEvent(params: string): boolean {
  const lower = params.toLowerCase();
  return lower.includes("memory/") || lower.includes("memory.md") || lower.includes("memory-checkpoint") || lower.includes("memory-decay") || lower.includes("working-sync");
}

function extractFilePath(tool: string, params: string): string {
  try {
    const p = JSON.parse(params);
    // read/write/edit have file_path or path in params
    if (p.file_path) return normalizeMemoryPath(p.file_path);
    if (p.path) return normalizeMemoryPath(p.path);
    // exec — extract from command string
    if (p.command && typeof p.command === "string") {
      // Look for memory file patterns in the command
      const memMatch = p.command.match(/memory\/[\w._-]+\.(?:md|sh)/i);
      if (memMatch) return memMatch[0];
      const scriptMatch = p.command.match(/memory-checkpoint\.sh|memory-decay|working-sync/i);
      if (scriptMatch) return `scripts/${scriptMatch[0]}`;
      return "exec (memory-related)";
    }
  } catch { /* ignore parse errors */ }
  return "unknown";
}

function normalizeMemoryPath(fp: string): string {
  // Strip absolute path prefixes, keep relative from memory/
  const memIdx = fp.indexOf("memory/");
  if (memIdx >= 0) return fp.slice(memIdx);
  if (fp.endsWith("MEMORY.md")) return "MEMORY.md";
  return fp;
}

export function queryMemoryOps(since: number, agent?: string): MemoryOpRow[] {
  const db = getDb();
  const conditions = ["type = 'tool_call'", "ts >= ?"];
  const params: unknown[] = [since];
  if (agent) {
    conditions.push("agent = ?");
    params.push(agent);
  }
  // Use OR across patterns
  const patternClauses = MEMORY_PATTERNS.map(() => "json_extract(detail, '$.params') LIKE ?").join(" OR ");
  conditions.push(`(${patternClauses})`);
  params.push(...MEMORY_PATTERNS);

  const rows = db.prepare(
    `SELECT ts, agent, session,
            json_extract(detail, '$.tool') as tool,
            json_extract(detail, '$.params') as params_json
     FROM events WHERE ${conditions.join(" AND ")}
     ORDER BY ts DESC LIMIT 2000`
  ).all(...params) as Array<{ ts: number; agent: string; session: string; tool: string; params_json: string }>;

  const byFile: Record<string, {
    reads: number; writes: number; edits: number; execs: number;
    agents: Set<string>; sessions: Set<string>; last_ts: number;
  }> = {};

  for (const r of rows) {
    if (!r.params_json || !isMemoryEvent(r.params_json)) continue;
    const fp = extractFilePath(r.tool, r.params_json);
    if (!byFile[fp]) byFile[fp] = { reads: 0, writes: 0, edits: 0, execs: 0, agents: new Set(), sessions: new Set(), last_ts: 0 };
    const f = byFile[fp];
    if (r.tool === "read") f.reads++;
    else if (r.tool === "write") f.writes++;
    else if (r.tool === "edit") f.edits++;
    else if (r.tool === "exec") f.execs++;
    f.agents.add(r.agent);
    if (r.session) f.sessions.add(r.session);
    if (r.ts > f.last_ts) f.last_ts = r.ts;
  }

  return Object.entries(byFile)
    .map(([file_path, f]) => ({
      file_path,
      reads: f.reads,
      writes: f.writes,
      edits: f.edits,
      execs: f.execs,
      agents: [...f.agents],
      last_ts: f.last_ts,
      sessions: f.sessions.size,
    }))
    .sort((a, b) => (b.reads + b.writes + b.edits + b.execs) - (a.reads + a.writes + a.edits + a.execs));
}

export function queryMemoryTimeline(since: number, opts?: { agent?: string; file?: string }): MemoryTimelineEvent[] {
  const db = getDb();
  const conditions = ["type = 'tool_call'", "ts >= ?"];
  const params: unknown[] = [since];
  if (opts?.agent) {
    conditions.push("agent = ?");
    params.push(opts.agent);
  }
  const patternClauses = MEMORY_PATTERNS.map(() => "json_extract(detail, '$.params') LIKE ?").join(" OR ");
  conditions.push(`(${patternClauses})`);
  params.push(...MEMORY_PATTERNS);

  const rows = db.prepare(
    `SELECT id, ts, agent, session,
            json_extract(detail, '$.tool') as tool,
            json_extract(detail, '$.params') as params_json
     FROM events WHERE ${conditions.join(" AND ")}
     ORDER BY ts DESC LIMIT 500`
  ).all(...params) as Array<{ id: number; ts: number; agent: string; session: string; tool: string; params_json: string }>;

  // Find triggers: for each unique session, find the first llm_input promptPreview
  const sessionTriggers = new Map<string, string>();
  const uniqueSessions = [...new Set(rows.map(r => r.session).filter(Boolean))];

  if (uniqueSessions.length > 0) {
    const findTrigger = db.prepare(
      `SELECT session, json_extract(detail, '$.promptPreview') as preview
       FROM events
       WHERE type = 'llm_input' AND session = ?
       ORDER BY ts ASC LIMIT 1`
    );
    for (const sess of uniqueSessions.slice(0, 100)) {
      const t = findTrigger.get(sess) as { session: string; preview: string } | undefined;
      if (t?.preview) {
        // Extract trigger type from preview
        const preview = t.preview;
        if (preview.includes("[cron:")) sessionTriggers.set(sess, preview.slice(0, 120));
        else if (preview.includes("message_received") || preview.includes("ACK:")) sessionTriggers.set(sess, "Discord message");
        else sessionTriggers.set(sess, preview.slice(0, 120));
      }
    }

    // Fallback: check for agent-matched llm_input within ±60s of the session's first event
    for (const sess of uniqueSessions.slice(0, 100)) {
      if (sessionTriggers.has(sess)) continue;
      const firstRow = rows.filter(r => r.session === sess).at(-1); // rows are DESC, so last = earliest
      if (!firstRow) continue;
      const agentTrigger = db.prepare(
        `SELECT json_extract(detail, '$.promptPreview') as preview
         FROM events WHERE type = 'llm_input' AND agent = ?
           AND ts BETWEEN ? AND ?
         ORDER BY ts ASC LIMIT 1`
      ).get(firstRow.agent, firstRow.ts - 60000, firstRow.ts + 5000) as { preview: string } | undefined;
      if (agentTrigger?.preview) {
        const preview = agentTrigger.preview;
        if (preview.includes("[cron:")) sessionTriggers.set(sess, preview.slice(0, 120));
        else if (preview.includes("message_received") || preview.includes("ACK:")) sessionTriggers.set(sess, "Discord message");
        else sessionTriggers.set(sess, preview.slice(0, 120));
      }
    }
  }

  // Filter by file if requested
  let filtered = rows.filter(r => r.params_json && isMemoryEvent(r.params_json));
  if (opts?.file) {
    filtered = filtered.filter(r => {
      const fp = extractFilePath(r.tool, r.params_json);
      return fp.includes(opts.file!);
    });
  }

  return filtered.map(r => ({
    id: r.id,
    ts: r.ts,
    agent: r.agent,
    session: r.session ?? "",
    op: r.tool,
    file_path: extractFilePath(r.tool, r.params_json),
    params: r.params_json,
    trigger: sessionTriggers.get(r.session) ?? null,
  }));
}

// ── Provider Health Tracking ──────────────────────────────────────
// Tracks success/failure per LLM provider for dashboard display.

interface ProviderHealthState {
  successes: number;
  failures: number;
  lastSuccess: number;
  lastFailure: number;
  lastError: string;
  avgLatencyMs: number;
  latencyCount: number;
}

const providerHealth = new Map<string, ProviderHealthState>();

export function trackProviderCall(provider: string, success: boolean, latencyMs?: number, error?: string): void {
  if (!provider) return;
  const state = providerHealth.get(provider) ?? { successes: 0, failures: 0, lastSuccess: 0, lastFailure: 0, lastError: "", avgLatencyMs: 0, latencyCount: 0 };
  if (success) {
    state.successes++;
    state.lastSuccess = Date.now();
  } else {
    state.failures++;
    state.lastFailure = Date.now();
    if (error) state.lastError = error.slice(0, 200);
  }
  if (latencyMs != null && latencyMs > 0) {
    state.avgLatencyMs = (state.avgLatencyMs * state.latencyCount + latencyMs) / (state.latencyCount + 1);
    state.latencyCount++;
  }
  providerHealth.set(provider, state);
}

export function getProviderHealth(): Array<{ provider: string; successes: number; failures: number; errorRate: number; lastSuccess: number; lastFailure: number; lastError: string; avgLatencyMs: number }> {
  return [...providerHealth.entries()].map(([provider, s]) => ({
    provider,
    successes: s.successes,
    failures: s.failures,
    errorRate: s.successes + s.failures > 0 ? s.failures / (s.successes + s.failures) : 0,
    lastSuccess: s.lastSuccess,
    lastFailure: s.lastFailure,
    lastError: s.lastError,
    avgLatencyMs: Math.round(s.avgLatencyMs),
  }));
}

export function backfillProviderHealth(): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      SUBSTR(model, 1, INSTR(model, '/') - 1) as provider,
      COUNT(*) as total,
      MAX(ts) as last_ts
    FROM events
    WHERE type = 'llm_output' AND model LIKE '%/%'
    GROUP BY provider
  `).all() as Array<{ provider: string; total: number; last_ts: number }>;

  for (const r of rows) {
    if (!r.provider) continue;
    const existing = providerHealth.get(r.provider);
    if (existing && existing.successes > 0) continue; // don't overwrite live data
    providerHealth.set(r.provider, {
      successes: r.total,
      failures: 0,
      lastSuccess: r.last_ts,
      lastFailure: 0,
      lastError: "",
      avgLatencyMs: 0,
      latencyCount: 0,
    });
  }
}

// ── Agent Silence Detection ──────────────────────────────────────
// Tracks last activity per agent. Reports agents that haven't been active.

const agentLastActivity = new Map<string, { ts: number; type: string }>();
let agentSilenceCallbacks: Array<(agent: string, silenceMinutes: number) => void> = [];
const SILENCE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes default
let silenceThresholdMs = SILENCE_THRESHOLD_MS;
const silenceAlerted = new Set<string>(); // don't re-alert until activity resumes

export function setSilenceThreshold(minutes: number): void { silenceThresholdMs = minutes * 60 * 1000; }

export function onAgentSilence(cb: (agent: string, silenceMinutes: number) => void): void {
  agentSilenceCallbacks = [cb]; // Replace (not push) to prevent stacking on plugin reload
}

export function trackAgentActivity(agent: string, type: string): void {
  agentLastActivity.set(agent, { ts: Date.now(), type });
  silenceAlerted.delete(agent); // activity resumes → clear alert
}

export function checkAgentSilence(knownAgents: string[]): Array<{ agent: string; lastActivityTs: number; lastType: string; silenceMinutes: number }> {
  const now = Date.now();
  const silent: Array<{ agent: string; lastActivityTs: number; lastType: string; silenceMinutes: number }> = [];
  for (const agent of knownAgents) {
    const last = agentLastActivity.get(agent);
    if (!last) continue; // never seen — skip (might not be running)
    const silence = now - last.ts;
    if (silence > silenceThresholdMs) {
      const minutes = Math.floor(silence / 60_000);
      silent.push({ agent, lastActivityTs: last.ts, lastType: last.type, silenceMinutes: minutes });
      if (!silenceAlerted.has(agent)) {
        silenceAlerted.add(agent);
        for (const cb of agentSilenceCallbacks) {
          try { cb(agent, minutes); } catch { /* don't crash */ }
        }
      }
    }
  }
  return silent;
}

export function getAgentActivity(): Array<{ agent: string; lastActivityTs: number; lastType: string }> {
  return [...agentLastActivity.entries()].map(([agent, a]) => ({
    agent,
    lastActivityTs: a.ts,
    lastType: a.type,
  }));
}

// ── Context Utilization ──────────────────────────────────────────
// Tracks how much of the context window each LLM call uses.

const MODEL_MAX_CONTEXT: Record<string, number> = {
  "opus": 200_000,
  "sonnet": 200_000,
  "haiku": 200_000,
  "gpt-4o": 128_000,
  "gpt-4": 128_000,
  "o3": 200_000,
  "o4-mini": 200_000,
  "codex": 200_000,
  "deepseek": 128_000,
  "gemini": 1_000_000,
  "kimi": 1_000_000,
  "llama": 128_000,
  "qwen": 128_000,
};

export function getMaxContext(model: string): number {
  const lower = model.toLowerCase();
  for (const [key, max] of Object.entries(MODEL_MAX_CONTEXT)) {
    if (lower.includes(key)) return max;
  }
  return 200_000; // conservative default
}

export function queryContextUtilization(since: number, agent?: string): Array<{
  agent: string;
  avgUtilization: number;
  maxUtilization: number;
  calls: number;
  highUtilCalls: number; // calls using >80% context
}> {
  const conditions = ["type = 'llm_output'", "ts >= ?", "input_tokens > 0"];
  const params: unknown[] = [since];
  if (agent) { conditions.push("agent = ?"); params.push(agent); }

  const rows = getDb().prepare(`
    SELECT agent, model, input_tokens, cache_read, cache_write
    FROM events WHERE ${conditions.join(" AND ")}
    ORDER BY ts DESC LIMIT 5000
  `).all(...params) as Array<{ agent: string; model: string; input_tokens: number; cache_read: number; cache_write: number }>;

  const byAgent: Record<string, { totalUtil: number; maxUtil: number; calls: number; highUtil: number }> = {};
  for (const r of rows) {
    if (!byAgent[r.agent]) byAgent[r.agent] = { totalUtil: 0, maxUtil: 0, calls: 0, highUtil: 0 };
    const a = byAgent[r.agent];
    const maxCtx = getMaxContext(r.model ?? "");
    // Context utilization: use non-cached input tokens as % of context window
    // cache_read/cache_write tokens are served from cache and don't represent
    // fresh context pressure — they inflate the number to 1000%+ with prompt caching
    const util = (r.input_tokens ?? 0) / maxCtx;
    a.totalUtil += util;
    if (util > a.maxUtil) a.maxUtil = util;
    a.calls++;
    if (util > 0.8) a.highUtil++;
  }

  return Object.entries(byAgent).map(([agent, a]) => ({
    agent,
    avgUtilization: a.calls > 0 ? Math.round((a.totalUtil / a.calls) * 1000) / 10 : 0, // percentage
    maxUtilization: Math.round(a.maxUtil * 1000) / 10,
    calls: a.calls,
    highUtilCalls: a.highUtil,
  }));
}

// ── Live Session Context ────────────────────────────────────────

export interface SessionContextRow {
  agent: string;
  session: string;
  model: string;
  promptTokens: number;
  maxContext: number;
  contextPercent: number;
  lastCallTs: number;
  turnCount: number;
  avgTokensPerTurn: number;
  estimatedTurnsLeft: number | null;
}

/**
 * Query the most recent llm_output event per session to determine
 * current context window fill level plus estimated remaining turns.
 * Returns sessions sorted by contextPercent descending (hottest first).
 */
export function querySessionContext(): SessionContextRow[] {
  const db = getDb();

  // Latest llm_output per session for current context fill
  const latest = db.prepare(`
    SELECT e.agent, e.session, e.model,
           e.input_tokens, e.cache_read, e.cache_write, e.ts
    FROM events e
    INNER JOIN (
      SELECT session, MAX(ts) as max_ts
      FROM events
      WHERE type = 'llm_output' AND input_tokens > 0
      GROUP BY session
    ) latest ON e.session = latest.session AND e.ts = latest.max_ts
    WHERE e.type = 'llm_output' AND e.input_tokens > 0
  `).all() as Array<{
    agent: string;
    session: string;
    model: string;
    input_tokens: number;
    cache_read: number;
    cache_write: number;
    ts: number;
  }>;

  // Turn count + total output tokens per session (for avg tokens-per-turn)
  const turnStats = db.prepare(`
    SELECT session, COUNT(*) as turns, SUM(COALESCE(output_tokens, 0)) as total_output
    FROM events
    WHERE type = 'llm_output' AND input_tokens > 0
    GROUP BY session
  `).all() as Array<{ session: string; turns: number; total_output: number }>;

  const statsMap = new Map(turnStats.map(s => [s.session, s]));

  return latest.map(r => {
    // Current context fill = input_tokens + cache_write (fresh uncached content).
    // cache_read is reused from prior turns and accumulates across the session —
    // it does NOT represent current window size. Using it inflates % to 800%+.
    const promptTokens = (r.input_tokens ?? 0) + (r.cache_write ?? 0);
    const maxCtx = getMaxContext(r.model ?? "");
    const stats = statsMap.get(r.session);
    const turnCount = stats?.turns ?? 1;
    // Avg growth per turn: total prompt tokens / turns (rough estimate)
    const avgTokensPerTurn = turnCount > 0 ? Math.round(promptTokens / turnCount) : 0;
    const remaining = maxCtx - promptTokens;
    const estimatedTurnsLeft = avgTokensPerTurn > 0 ? Math.max(0, Math.floor(remaining / avgTokensPerTurn)) : null;

    return {
      agent: r.agent ?? "",
      session: r.session ?? "",
      model: r.model ?? "",
      promptTokens,
      maxContext: maxCtx,
      contextPercent: Math.round((promptTokens / maxCtx) * 1000) / 10,
      lastCallTs: r.ts ?? 0,
      turnCount,
      avgTokensPerTurn,
      estimatedTurnsLeft,
    };
  }).sort((a, b) => b.contextPercent - a.contextPercent);
}

// ── Message Delivery Audit ──────────────────────────────────────

export function queryMessageDelivery(since: number): Array<{
  agent: string;
  sent: number;
  received: number;
  lastSent: number;
  lastReceived: number;
}> {
  const rows = getDb().prepare(`
    SELECT agent, type, COUNT(*) as cnt, MAX(ts) as last_ts
    FROM events
    WHERE ts >= ? AND type IN ('msg_in', 'message_sent', 'llm_output')
    GROUP BY agent, type
  `).all(since) as Array<{ agent: string; type: string; cnt: number; last_ts: number }>;

  const byAgent: Record<string, { sent: number; received: number; lastSent: number; lastReceived: number }> = {};
  for (const r of rows) {
    if (!byAgent[r.agent]) byAgent[r.agent] = { sent: 0, received: 0, lastSent: 0, lastReceived: 0 };
    const a = byAgent[r.agent];
    if (r.type === "msg_in") { a.received += r.cnt; a.lastReceived = Math.max(a.lastReceived, r.last_ts); }
    else if (r.type === "message_sent" || r.type === "llm_output") { a.sent += r.cnt; a.lastSent = Math.max(a.lastSent, r.last_ts); }
  }

  return Object.entries(byAgent).map(([agent, a]) => ({ agent, ...a }));
}
