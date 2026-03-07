import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { GATEWAY_URL, USAGE_DB } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

interface ActivityChunk {
  session_key: string;
  agent: string;
  session_id: string | null;
  channel: string | null;
  display_name: string | null;
  model: string | null;
  chunk_start: number;
  chunk_end: number;
  cost: number;
  api_equiv_cost: number;
  calls: number;
  tokens: number;
  billing: "metered" | "subscription" | null;
  source: "agent" | "heartbeat" | "cron";
}

const IDLE_GAP_MS = 5 * 60 * 1000;
const CHUNK_PADDING_MS = 60 * 1000;
const HEARTBEAT_MAX_MS = 3 * 60 * 1000;

function queryDirect(dateStr: string): ActivityChunk[] | null {
  if (!fs.existsSync(USAGE_DB)) return null;
  try {
    const db = new Database(USAGE_DB, { readonly: true });
    const [y, m, d] = dateStr.split("-").map(Number);
    const dayStart = new Date(y, m - 1, d).getTime();
    const dayEnd = dayStart + 86400000;

    // Query events directly by time range — don't depend on sessions table
    // This ensures events with orphaned/legacy session keys are included
    const events = db.prepare(`
      SELECT session, agent, ts, type, billing,
        CASE WHEN type = 'llm_output' AND billing = 'subscription' THEN 0
             WHEN type = 'llm_output' THEN COALESCE(provider_cost, cost, 0)
             ELSE 0 END as actual_cost,
        CASE WHEN type = 'llm_output' THEN COALESCE(cost, 0) ELSE 0 END as api_equiv,
        CASE WHEN type = 'llm_output' THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read, 0) ELSE 0 END as tokens
      FROM events
      WHERE ts >= ? AND ts < ?
      ORDER BY ts ASC
    `).all(dayStart, dayEnd) as Array<{
      session: string; agent: string; ts: number; type: string;
      actual_cost: number; api_equiv: number; tokens: number; billing: string | null;
    }>;

    if (events.length === 0) { db.close(); return []; }

    // Collect unique session keys to look up metadata
    const sessionKeys = [...new Set(events.map((e) => e.session))];
    const placeholders = sessionKeys.map(() => "?").join(",");
    const sessionRows = db.prepare(`
      SELECT session_key, agent, session_id, channel, display_name, model
      FROM sessions
      WHERE session_key IN (${placeholders})
    `).all(...sessionKeys) as Array<{
      session_key: string; agent: string; session_id: string | null;
      channel: string | null; display_name: string | null; model: string | null;
    }>;
    const sessionMap = new Map(sessionRows.map((s) => [s.session_key, s]));

    db.close();

    // Group events by agent (use event.agent directly, not session metadata)
    const eventsByAgent = new Map<string, Array<{ ts: number; type: string; actual_cost: number; api_equiv: number; tokens: number; session: string; billing: string | null }>>();
    for (const e of events) {
      const agent = e.agent;
      if (!agent) continue;
      const arr = eventsByAgent.get(agent) ?? [];
      arr.push(e);
      eventsByAgent.set(agent, arr);
    }

    // Dedupe within each agent
    eventsByAgent.forEach((agentEvents) => {
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
      agentEvents.length = 0;
      agentEvents.push(...deduped);
    });

    const chunks: ActivityChunk[] = [];

    eventsByAgent.forEach((agentEvents, agent) => {
      if (agentEvents.length === 0) return;

      // Find best session metadata for this agent
      let bestMeta: { session_id: string | null; channel: string | null; display_name: string | null; model: string | null } | null = null;
      for (const s of sessionRows) {
        if (s.agent === agent && s.channel) { bestMeta = s; break; }
      }
      if (!bestMeta) {
        const meta = sessionMap.get(agentEvents[0].session);
        bestMeta = meta ?? { session_id: null, channel: null, display_name: null, model: null };
      }

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
        const channel = "channel" in meta ? meta.channel : null;
        const isCron = channel === "cron";
        const isHeartbeat = !isCron && duration <= HEARTBEAT_MAX_MS && chunkCalls <= 2 && chunkCost < 0.50;
        const source: "agent" | "heartbeat" | "cron" = isCron ? "cron" : isHeartbeat ? "heartbeat" : "agent";
        chunks.push({
          session_key: chunkSession,
          agent,
          session_id: "session_id" in meta ? meta.session_id : null,
          channel,
          display_name: "display_name" in meta ? meta.display_name : null,
          model: "model" in meta ? meta.model : null,
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
        if (evt.type === "llm_output") chunkSession = evt.session;
        if (evt.billing === "metered") chunkBilling = "metered";
        else if (evt.billing === "subscription" && !chunkBilling) chunkBilling = "subscription";
      }
      flushChunk();
    });

    chunks.sort((a, b) => a.chunk_start - b.chunk_start);
    return chunks;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Missing date param (YYYY-MM-DD)" }, { status: 400 });
  }

  // Try gateway first
  try {
    const res = await fetch(`${GATEWAY_URL}/activity/day-sessions?date=${date}`, {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return NextResponse.json(data);
    }
  } catch { /* fall through */ }

  // Direct SQLite fallback
  const result = queryDirect(date);
  if (result) return NextResponse.json(result);

  return NextResponse.json([], { status: 502 });
}
