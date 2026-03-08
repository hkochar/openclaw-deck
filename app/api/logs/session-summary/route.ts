/**
 * GET /api/logs/session-summary?session={sessionKey}
 *
 * Compute-on-demand run summary with LRU cache.
 * Queries events table directly (SQLite), computes metrics, returns with baselines.
 */

import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { USAGE_DB } from "@/app/api/_lib/paths";
import {
  computeRunSummary,
  computeComparison,
  type EventRow,
  type RunSummary,
  type Comparison,
  type SessionAggregate,
} from "@/lib/run-intelligence";

// ── LRU Cache ────────────────────────────────────────────────────────

interface CacheEntry {
  summary: RunSummary;
  comparison: Comparison;
  expiresAt: number;
}

const MAX_CACHE = 100;
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  // Move to end (LRU)
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (cache.size >= MAX_CACHE) {
    // Delete oldest (first key)
    const oldest = cache.keys().next().value;
    if (oldest != null) cache.delete(oldest);
  }
  cache.set(key, entry);
}

// ── Route Handler ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session");
  if (!session) {
    return NextResponse.json({ ok: false, error: "missing session" }, { status: 400 });
  }

  if (!fs.existsSync(USAGE_DB)) {
    return NextResponse.json({ ok: false, error: "usage db not found" }, { status: 404 });
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(USAGE_DB, { readonly: true });
  } catch {
    return NextResponse.json({ ok: false, error: "cannot open usage db" }, { status: 500 });
  }

  try {
    // Resolve session key variants — events may be stored under different key formats
    // for the same logical session (e.g. "agent:main:discord:..." vs "main/uuid.jsonl")
    const sessionKeys = resolveSessionKeys(db, session);
    const sessionPlaceholders = sessionKeys.map(() => "?").join(",");
    const sessionWhere = sessionKeys.length === 1 ? "session = ?" : `session IN (${sessionPlaceholders})`;

    // 1. Get max event id for cache key
    const maxRow = db.prepare(
      `SELECT MAX(id) as maxId FROM events WHERE ${sessionWhere}`
    ).get(...sessionKeys) as { maxId: number | null } | undefined;

    const maxId = maxRow?.maxId;
    if (maxId == null) {
      db.close();
      return NextResponse.json({ ok: false, error: "no events for session" }, { status: 404 });
    }

    const cacheKey = `${session}:${maxId}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      db.close();
      return NextResponse.json({ ok: true, summary: cached.summary, comparison: cached.comparison });
    }

    // 2. Fetch events (capped at 5000)
    const events = db.prepare(
      `SELECT id, ts, type, agent, session, model, resolved_model,
              cost, input_tokens, output_tokens, cache_read, cache_write,
              billing, provider_cost, detail,
              CASE WHEN thinking IS NOT NULL AND thinking != '' THEN 1 ELSE 0 END as has_thinking,
              CASE WHEN prompt IS NOT NULL AND prompt != '' THEN 1 ELSE 0 END as has_prompt,
              CASE WHEN response IS NOT NULL AND response != '' THEN 1 ELSE 0 END as has_response
       FROM events
       WHERE ${sessionWhere}
       ORDER BY ts ASC, id ASC
       LIMIT 5000`
    ).all(...sessionKeys) as EventRow[];

    if (!events.length) {
      db.close();
      return NextResponse.json({ ok: false, error: "no events" }, { status: 404 });
    }

    // 3. Compute summary
    const summary = computeRunSummary(events);

    // 4. Compute baselines
    const agentId = events[0].agent;
    const agentSessions = agentId
      ? querySessionAggregates(db, agentId, 200, 30)
      : [];
    const globalSessions = querySessionAggregates(db, null, 500, 14);
    const comparison = computeComparison(summary, agentSessions, globalSessions);

    // 5. Cache and return
    const ttl = summary.status === "live" ? 5 * 60_000 : 60 * 60_000;
    cacheSet(cacheKey, {
      summary,
      comparison,
      expiresAt: Date.now() + ttl,
    });

    db.close();
    return NextResponse.json({ ok: true, summary, comparison });
  } catch (err) {
    try { db.close(); } catch {}
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : "";
    console.error("[session-summary] Error:", errMsg, errStack);
    return NextResponse.json(
      { ok: false, error: errMsg },
      { status: 500 }
    );
  }
}

// ── Session Key Resolution ───────────────────────────────────────────

/**
 * Resolve all variant session keys for a given session key.
 * Events may be stored under different key formats for the same logical session:
 *   - "agent:main:discord:channel:123..." (gateway hooks)
 *   - "main/9de7d054-....jsonl" (JSONL poller / backfill)
 *   - "channel:123..." (legacy format)
 */
function resolveSessionKeys(db: InstanceType<typeof Database>, session: string): string[] {
  const keys = new Set([session]);
  try {
    // Step 1: Find session_id — either embedded in the key or via DB lookup
    let sessionId: string | null = null;
    const uuidMatch = session.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (uuidMatch) {
      sessionId = uuidMatch[1];
    } else {
      const row = db.prepare(
        "SELECT session_id FROM sessions WHERE session_key = ?"
      ).get(session) as { session_id: string | null } | undefined;
      if (row?.session_id) sessionId = row.session_id;
    }

    if (sessionId) {
      // Step 2: Find all session_keys for this session_id
      const rows = db.prepare(
        "SELECT session_key FROM sessions WHERE session_id = ?"
      ).all(sessionId) as Array<{ session_key: string }>;
      for (const r of rows) keys.add(r.session_key);

      // Step 3: Check event key formats (backfill may use agentDir/uuid.jsonl)
      const evtKeys = db.prepare(
        "SELECT DISTINCT session FROM events WHERE session LIKE ? LIMIT 5"
      ).all(`%${sessionId}%`) as Array<{ session: string }>;
      for (const r of evtKeys) keys.add(r.session);
    }
  } catch { /* ignore */ }
  return [...keys];
}

// ── Baseline Queries ─────────────────────────────────────────────────

function querySessionAggregates(
  db: InstanceType<typeof Database>,
  agentId: string | null,
  limit: number,
  windowDays: number,
): SessionAggregate[] {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const agentClause = agentId ? "AND agent = ?" : "";
  const params: (string | number)[] = [cutoff];
  if (agentId) params.push(agentId);

  try {
    const rows = db.prepare(`
      SELECT
        session,
        agent,
        MIN(ts) as minTs,
        MAX(ts) as maxTs,
        SUM(CASE WHEN type = 'llm_output' THEN cost ELSE 0 END) as totalCost,
        SUM(CASE WHEN type = 'llm_output' THEN input_tokens ELSE 0 END) as totalTokensIn,
        SUM(CASE WHEN type = 'llm_output' THEN output_tokens ELSE 0 END) as totalTokensOut,
        SUM(CASE WHEN type = 'tool_call' THEN 1 ELSE 0 END) as toolCallCount
      FROM events
      WHERE ts >= ? ${agentClause}
      GROUP BY session
      HAVING COUNT(*) >= 3
      ORDER BY MIN(ts) DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      session: string;
      agent: string | null;
      minTs: number;
      maxTs: number;
      totalCost: number;
      totalTokensIn: number;
      totalTokensOut: number;
      toolCallCount: number;
    }>;

    return rows.map(r => ({
      session: r.session,
      agent: r.agent,
      minTs: r.minTs,
      totalCost: r.totalCost ?? 0,
      totalTokensIn: r.totalTokensIn ?? 0,
      totalTokensOut: r.totalTokensOut ?? 0,
      toolCallCount: r.toolCallCount ?? 0,
      durationMs: (r.maxTs ?? r.minTs) - r.minTs,
      maxLoopDepth: 0, // Not computed for baselines (too expensive)
    }));
  } catch {
    return [];
  }
}
