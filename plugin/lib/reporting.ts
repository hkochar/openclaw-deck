import { getDb } from "./db-core";

// ── Daily Activity Aggregation ──────────────────────────────────────

export interface DailyActivity {
  agent: string;
  date: string;           // "2026-02-27"
  sessions: number;
  activeMinutes: number;  // sum of session durations clipped to day boundaries
  cost: number;
  api_equiv_cost: number; // estimated API-rate cost (for subscription events)
  calls: number;
  tokens: number;
}

export function queryDailyActivity(opts?: { days?: number }): DailyActivity[] {
  const days = Math.min(Math.max(opts?.days ?? 30, 1), 90);
  const db = getDb();

  // Compute day boundaries (local timezone, start of day)
  const now = new Date();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime(); // midnight tonight
  const since = endOfToday - days * 86400000;

  // 1. Cost/calls/tokens from events (group by agent + date)
  const costRows = db.prepare(`
    SELECT agent,
      DATE(ts / 1000, 'unixepoch', 'localtime') as date,
      COALESCE(SUM(
        CASE WHEN billing = 'subscription' THEN 0
             ELSE COALESCE(provider_cost, cost, 0) END
      ), 0) as cost,
      COALESCE(SUM(COALESCE(cost, 0)), 0) as api_equiv_cost,
      COUNT(*) as calls,
      COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read, 0)), 0) as tokens
    FROM events
    WHERE type = 'llm_output' AND ts >= ?
    GROUP BY agent, date
  `).all(since) as Array<{ agent: string; date: string; cost: number; api_equiv_cost: number; calls: number; tokens: number }>;

  // 2. Session active time — compute overlap of each session with each day
  const sessionRows = db.prepare(`
    SELECT agent, created_at, updated_at
    FROM sessions
    WHERE updated_at >= ? AND created_at < ?
    ORDER BY agent, created_at
  `).all(since, endOfToday) as Array<{ agent: string; created_at: number; updated_at: number }>;

  // Build day-keyed map: agent:date → { sessions, activeMs }
  const activityMap = new Map<string, { sessions: number; activeMs: number }>();

  for (const s of sessionRows) {
    const start = Math.max(s.created_at, since);
    const end = Math.min(s.updated_at, endOfToday);
    if (end <= start) continue;

    // Walk day boundaries this session spans
    let cursor = start;
    while (cursor < end) {
      const d = new Date(cursor);
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const dayEnd = dayStart + 86400000;
      const overlapStart = Math.max(cursor, dayStart);
      const overlapEnd = Math.min(end, dayEnd);
      const overlapMs = overlapEnd - overlapStart;

      if (overlapMs > 0) {
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const key = `${s.agent}:${dateStr}`;
        const existing = activityMap.get(key) ?? { sessions: 0, activeMs: 0 };
        existing.sessions += 1;
        existing.activeMs += overlapMs;
        activityMap.set(key, existing);
      }

      cursor = dayEnd;
    }
  }

  // 3. Merge cost data + session data into result
  const resultMap = new Map<string, DailyActivity>();

  for (const r of costRows) {
    const key = `${r.agent}:${r.date}`;
    resultMap.set(key, {
      agent: r.agent,
      date: r.date,
      sessions: 0,
      activeMinutes: 0,
      cost: Math.round(r.cost * 10000) / 10000,
      api_equiv_cost: Math.round(r.api_equiv_cost * 10000) / 10000,
      calls: r.calls,
      tokens: r.tokens,
    });
  }

  activityMap.forEach((activity, key) => {
    const existing = resultMap.get(key);
    if (existing) {
      existing.sessions = activity.sessions;
      existing.activeMinutes = Math.round(activity.activeMs / 60000);
    } else {
      const [agent, date] = key.split(":");
      resultMap.set(key, {
        agent,
        date,
        sessions: activity.sessions,
        activeMinutes: Math.round(activity.activeMs / 60000),
        cost: 0,
        api_equiv_cost: 0,
        calls: 0,
        tokens: 0,
      });
    }
  });

  return Array.from(resultMap.values()).sort((a, b) => b.date.localeCompare(a.date) || a.agent.localeCompare(b.agent));
}

// ── Activity chunks for a specific day (for timeline day view) ──
// Instead of showing full session spans (created_at→updated_at), we cluster
// individual LLM events into "active work chunks". A gap of ≥15 min = idle.

export interface ActivityChunk {
  session_key: string;
  agent: string;
  session_id: string | null;
  channel: string | null;
  display_name: string | null;
  model: string | null;
  chunk_start: number;  // ms — first event in this chunk
  chunk_end: number;    // ms — last event + buffer in this chunk
  cost: number;         // actual provider cost
  api_equiv_cost: number; // estimated API-rate cost (for subscription events)
  calls: number;
  tokens: number;
  billing: "metered" | "subscription" | null;
  source: "agent" | "heartbeat" | "cron";
}

const IDLE_GAP_MS = 5 * 60 * 1000; // 5 min gap = new chunk (heartbeats fire every 20 min)
const CHUNK_PADDING_MS = 60 * 1000; // add 1 min buffer after last event
const HEARTBEAT_MAX_MS = 3 * 60 * 1000; // chunks under 3 min with ≤2 LLM calls = heartbeat

export function queryActivityChunksForDay(dateStr: string): ActivityChunk[] {
  const db = getDb();
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayStart = new Date(y, m - 1, d).getTime();
  const dayEnd = dayStart + 86400000;

  // Get sessions that overlap this day
  const sessions = db.prepare(`
    SELECT session_key, agent, session_id, channel, display_name, model
    FROM sessions
    WHERE updated_at >= ? AND created_at < ?
    ORDER BY created_at ASC
  `).all(dayStart, dayEnd) as Array<{
    session_key: string; agent: string; session_id: string | null;
    channel: string | null; display_name: string | null; model: string | null;
  }>;

  if (sessions.length === 0) return [];

  const sessionMap = new Map(sessions.map((s) => [s.session_key, s]));
  const sessionKeys = sessions.map((s) => s.session_key);
  const placeholders = sessionKeys.map(() => "?").join(",");

  // Get ALL events for timeline positioning; track cost/calls from llm_output only
  // actual_cost = real spend (provider_cost for metered, 0 for subscription)
  // api_equiv = estimated cost at API rates (cost column)
  const events = db.prepare(`
    SELECT session, ts, type, billing,
      CASE WHEN type = 'llm_output' AND billing = 'subscription' THEN 0
           WHEN type = 'llm_output' THEN COALESCE(provider_cost, cost, 0)
           ELSE 0 END as actual_cost,
      CASE WHEN type = 'llm_output' THEN COALESCE(cost, 0) ELSE 0 END as api_equiv,
      CASE WHEN type = 'llm_output' THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) ELSE 0 END as tokens
    FROM events
    WHERE session IN (${placeholders})
      AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `).all(...sessionKeys, dayStart, dayEnd) as Array<{
    session: string; ts: number; type: string; actual_cost: number; api_equiv: number; tokens: number; billing: string | null;
  }>;

  // Group events by AGENT (not session) to merge duplicate session keys
  // The same logical session has 3 key formats — merging by agent avoids duplicates
  const eventsByAgent = new Map<string, Array<{ ts: number; type: string; actual_cost: number; api_equiv: number; tokens: number; session: string; billing: string | null }>>();
  for (const e of events) {
    const meta = sessionMap.get(e.session);
    if (!meta) continue;
    const arr = eventsByAgent.get(meta.agent) ?? [];
    arr.push(e);
    eventsByAgent.set(meta.agent, arr);
  }

  // Deduplicate events at the same timestamp per agent (same event logged under multiple session keys)
  eventsByAgent.forEach((agentEvents, agent) => {
    const seen = new Set<string>();
    const deduped: typeof agentEvents = [];
    for (const e of agentEvents) {
      const key = `${e.ts}:${e.type}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(e);
      }
    }
    deduped.sort((a, b) => a.ts - b.ts);
    eventsByAgent.set(agent, deduped);
  });

  // Cluster events into chunks per agent
  const chunks: ActivityChunk[] = [];

  eventsByAgent.forEach((agentEvents, agent) => {
    if (agentEvents.length === 0) return;

    // Find best session metadata for this agent (prefer one with channel info)
    let bestMeta = sessionMap.get(agentEvents[0].session);
    for (const s of sessions) {
      if (s.agent === agent && s.channel) { bestMeta = s; break; }
    }
    if (!bestMeta) return;

    let chunkStart = agentEvents[0].ts;
    let chunkEnd = agentEvents[0].ts;
    let chunkCost = 0;
    let chunkApiEquiv = 0;
    let chunkCalls = 0;
    let chunkTokens = 0;
    let chunkSession = agentEvents[0].session;
    let chunkBilling: string | null = null;

    const flushChunk = () => {
      const meta = sessionMap.get(chunkSession) ?? bestMeta!;
      const duration = Math.min(chunkEnd + CHUNK_PADDING_MS, dayEnd) - chunkStart;
      // Classify source: cron if channel is "cron", heartbeat if short/cheap, else agent
      const isCron = meta.channel === "cron";
      const isHeartbeat = !isCron && duration <= HEARTBEAT_MAX_MS && chunkCalls <= 2 && chunkCost < 0.50;
      const source: "agent" | "heartbeat" | "cron" = isCron ? "cron" : isHeartbeat ? "heartbeat" : "agent";
      chunks.push({
        session_key: chunkSession,
        agent,
        session_id: meta.session_id,
        channel: meta.channel,
        display_name: meta.display_name,
        model: meta.model,
        chunk_start: chunkStart,
        chunk_end: Math.min(chunkEnd + CHUNK_PADDING_MS, dayEnd),
        cost: Math.round(chunkCost * 10000) / 10000,
        api_equiv_cost: Math.round(chunkApiEquiv * 10000) / 10000,
        calls: chunkCalls,
        tokens: chunkTokens,
        billing: (chunkBilling as "metered" | "subscription") ?? null,
        source,
      });
    };

    for (const evt of agentEvents) {
      if (evt.ts - chunkEnd > IDLE_GAP_MS) {
        flushChunk();
        chunkStart = evt.ts;
        chunkEnd = evt.ts;
        chunkCost = 0;
        chunkApiEquiv = 0;
        chunkCalls = 0;
        chunkTokens = 0;
        chunkSession = evt.session;
        chunkBilling = null;
      }
      chunkEnd = evt.ts;
      chunkCost += evt.actual_cost;
      chunkApiEquiv += evt.api_equiv;
      chunkTokens += evt.tokens;
      if (evt.type === "llm_output") chunkCalls++;
      // Track which session this chunk primarily belongs to (for links)
      if (evt.type === "llm_output") chunkSession = evt.session;
      // Track billing — prefer "metered" if any event is metered
      if (evt.billing === "metered") chunkBilling = "metered";
      else if (evt.billing === "subscription" && !chunkBilling) chunkBilling = "subscription";
    }
    flushChunk();
  });

  // Return all chunks sorted — source classification lets UI filter heartbeats/cron
  chunks.sort((a, b) => a.chunk_start - b.chunk_start);
  return chunks;
}

// ══════════════════════════════════════════════════════════════════════
// Agent Heartbeats, Drift Events, Activity Feed
// ══════════════════════════════════════════════════════════════════════

export interface HeartbeatData {
  agentKey: string;
  status: string;
  model?: string;
  configuredModel?: string;
  sessionKey?: string;
  bio?: string;
}

export interface HeartbeatRow {
  agent_key: string;
  status: string;
  model: string | null;
  configured_model: string | null;
  session_key: string | null;
  cron_model: string | null;
  cron_model_updated_at: number | null;
  bio: string | null;
  last_heartbeat: number;
  updated_at: number;
}

export interface AgentWithHealth extends HeartbeatRow {
  computed_status: "active" | "stale" | "offline";
}

export interface DriftEventRow {
  id: number;
  agent_key: string;
  configured_model: string;
  actual_model: string;
  tag: string;
  timestamp: number;
  resolved: number;
  resolved_at: number | null;
}

export interface ActivityRow {
  id: number;
  type: string;
  agent_key: string | null;
  agent_name: string | null;
  message: string;
  timestamp: number;
}

// ── Heartbeats ──────────────────────────────────────────────────────

/** Upsert a heartbeat; logs an activity when status changes. */
export function upsertHeartbeat(data: HeartbeatData): void {
  const db = getDb();
  const now = Date.now();

  // Check previous status for activity logging
  const prev = db.prepare(
    "SELECT status FROM heartbeats WHERE agent_key = ?",
  ).get(data.agentKey) as { status: string } | undefined;

  db.prepare(`
    INSERT INTO heartbeats (agent_key, status, model, configured_model, session_key, bio, last_heartbeat, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_key) DO UPDATE SET
      status = excluded.status,
      model = excluded.model,
      configured_model = COALESCE(excluded.configured_model, configured_model),
      session_key = COALESCE(excluded.session_key, session_key),
      bio = COALESCE(excluded.bio, bio),
      last_heartbeat = excluded.last_heartbeat,
      updated_at = excluded.updated_at
  `).run(
    data.agentKey, data.status,
    data.model ?? null, data.configuredModel ?? null,
    data.sessionKey ?? null, data.bio ?? null,
    now, now,
  );

  // Log activity on status change
  if (prev && prev.status !== data.status) {
    logActivity("status_change", data.agentKey, data.agentKey, `Status: ${prev.status} → ${data.status}`);
  }
}

/** Update the cron model for an agent. */
export function updateCronModel(agentKey: string, cronModel: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "UPDATE heartbeats SET cron_model = ?, cron_model_updated_at = ?, updated_at = ? WHERE agent_key = ?",
  ).run(cronModel, now, now, agentKey);
}

/** Query all agents with computed health status based on heartbeat age. */
export function queryAgentsWithHealth(
  staleMs = 2 * 60 * 1000,   // 2 min → stale
  offlineMs = 5 * 60 * 1000, // 5 min → offline
): AgentWithHealth[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare("SELECT * FROM heartbeats ORDER BY agent_key").all() as HeartbeatRow[];

  return rows.map((row) => {
    const age = now - row.last_heartbeat;
    let computed_status: "active" | "stale" | "offline" = "active";
    if (age > offlineMs) computed_status = "offline";
    else if (age > staleMs) computed_status = "stale";
    return { ...row, computed_status };
  });
}

// ── Drift Events ────────────────────────────────────────────────────

/** Report a model drift event (deduplicates within 60s window). */
export function reportDrift(
  agentKey: string,
  configuredModel: string,
  actualModel: string,
  tag: string,
): void {
  const db = getDb();
  const now = Date.now();
  const dedupeWindow = 60_000; // 60s

  // Dedup: skip if identical unresolved drift within window
  const existing = db.prepare(`
    SELECT id FROM drift_events
    WHERE agent_key = ? AND configured_model = ? AND actual_model = ? AND tag = ?
      AND resolved = 0 AND timestamp > ?
    LIMIT 1
  `).get(agentKey, configuredModel, actualModel, tag, now - dedupeWindow);

  if (existing) return;

  db.prepare(`
    INSERT INTO drift_events (agent_key, configured_model, actual_model, tag, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentKey, configuredModel, actualModel, tag, now);

  logActivity("drift_detected", agentKey, agentKey, `Model drift: expected ${configuredModel}, got ${actualModel}`);
}

/** Resolve all unresolved drift events for an agent. */
export function resolveDrift(agentKey: string): void {
  const db = getDb();
  const now = Date.now();
  const changes = db.prepare(
    "UPDATE drift_events SET resolved = 1, resolved_at = ? WHERE agent_key = ? AND resolved = 0",
  ).run(now, agentKey);

  if (changes.changes > 0) {
    logActivity("drift_resolved", agentKey, agentKey, `Resolved ${changes.changes} drift event(s)`);
  }
}

/** Query all unresolved drift events. */
export function queryUnresolvedDrift(): DriftEventRow[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM drift_events WHERE resolved = 0 ORDER BY timestamp DESC",
  ).all() as DriftEventRow[];
}

/** Check if a specific agent has unresolved drift events. */
export function hasUnresolvedDrift(agentKey: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM drift_events WHERE agent_key = ? AND resolved = 0 LIMIT 1",
  ).get(agentKey);
  return !!row;
}

// ── Activity Feed ───────────────────────────────────────────────────

/** Log an activity. */
export function logActivity(
  type: string,
  agentKey: string | null,
  agentName: string | null,
  message: string,
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "INSERT INTO agent_activities (type, agent_key, agent_name, message, timestamp) VALUES (?, ?, ?, ?, ?)",
  ).run(type, agentKey, agentName, message, now);
}

/** Query recent activities. */
export function queryActivities(limit = 50): ActivityRow[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM agent_activities ORDER BY timestamp DESC LIMIT ?",
  ).all(limit) as ActivityRow[];
}
