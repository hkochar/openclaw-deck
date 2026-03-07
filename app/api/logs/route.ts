import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { GATEWAY_URL, USAGE_DB } from "@/app/api/_lib/paths";

/**
 * Resolve all variant session keys for a given session key.
 * Events may be stored under different key formats for the same logical session.
 */
function resolveSessionKeys(db: InstanceType<typeof Database>, session: string): string[] {
  const keys = new Set([session]);
  try {
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
      const rows = db.prepare(
        "SELECT session_key FROM sessions WHERE session_id = ?"
      ).all(sessionId) as Array<{ session_key: string }>;
      for (const r of rows) keys.add(r.session_key);
      const evtKeys = db.prepare(
        "SELECT DISTINCT session FROM events WHERE session LIKE ? LIMIT 5"
      ).all(`%${sessionId}%`) as Array<{ session: string }>;
      for (const r of evtKeys) keys.add(r.session);
    }
  } catch { /* ignore */ }
  return [...keys];
}

// Direct SQLite fallback when gateway is down
function queryDbStream(since: number, limit: number, source?: string, session?: string) {
  if (!fs.existsSync(USAGE_DB)) return null;
  try {
    const db = new Database(USAGE_DB, { readonly: true });
    const conditions = ["ts >= ?"];
    const params: unknown[] = [since];
    if (source && ["agent", "heartbeat", "cron"].includes(source)) {
      conditions.push("session IN (SELECT session_key FROM sessions WHERE source = ?)");
      params.push(source);
    }
    if (session) {
      // Split comma-separated session variants and resolve each
      const inputKeys = session.split(",").map(s => s.trim()).filter(Boolean);
      const allKeys = new Set<string>();
      for (const key of inputKeys) {
        for (const resolved of resolveSessionKeys(db, key)) {
          allKeys.add(resolved);
        }
      }
      const sessionKeys = [...allKeys];
      if (sessionKeys.length === 1) {
        conditions.push("session = ?");
        params.push(sessionKeys[0]);
      } else {
        conditions.push(`session IN (${sessionKeys.map(() => "?").join(",")})`);
        params.push(...sessionKeys);
      }
    }
    const where = conditions.join(" AND ");
    // Use ASC order when filtering by session (chronological view), DESC otherwise
    const order = session ? "ASC" : "DESC";
    const rows = db.prepare(
      `SELECT id, ts, agent, session, type, model, input_tokens, output_tokens,
       cache_read, cache_write, cost, detail, run_id, resolved_model, provider_cost, billing,
       CASE WHEN thinking IS NOT NULL THEN 1 ELSE 0 END as has_thinking,
       CASE WHEN prompt IS NOT NULL THEN 1 ELSE 0 END as has_prompt,
       CASE WHEN response IS NOT NULL THEN 1 ELSE 0 END as has_response
       FROM events WHERE ${where} ORDER BY ts ${order}, id ${order} LIMIT ?`
    ).all(...params, limit);
    db.close();
    return rows;
  } catch { return null; }
}

function queryDbSummary(since: number) {
  if (!fs.existsSync(USAGE_DB)) return null;
  try {
    const db = new Database(USAGE_DB, { readonly: true });
    const rows = db.prepare(`
      SELECT agent, model,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read) as cache_read,
        SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read,0) + COALESCE(cache_write,0)) as total_tokens,
        SUM(CASE WHEN billing = 'subscription' THEN 0 ELSE COALESCE(provider_cost, cost, 0) END) as cost,
        SUM(cost) as equiv_cost,
        COUNT(*) as calls
      FROM events
      WHERE ts >= ? AND type = 'llm_output'
      GROUP BY agent, model
    `).all(since) as Array<{
      agent: string; model: string;
      input_tokens: number; output_tokens: number; cache_read: number;
      total_tokens: number; cost: number; equiv_cost: number; calls: number;
    }>;
    db.close();

    const byAgent: Record<string, {
      agent: string; inputTokens: number; outputTokens: number; cacheRead: number;
      totalTokens: number; cost: number; equivCost: number; calls: number;
      models: Record<string, { input: number; output: number; cache: number }>;
    }> = {};

    for (const r of rows) {
      if (!byAgent[r.agent]) {
        byAgent[r.agent] = {
          agent: r.agent, inputTokens: 0, outputTokens: 0, cacheRead: 0,
          totalTokens: 0, cost: 0, equivCost: 0, calls: 0, models: {},
        };
      }
      const a = byAgent[r.agent];
      a.inputTokens += r.input_tokens ?? 0;
      a.outputTokens += r.output_tokens ?? 0;
      a.cacheRead += r.cache_read ?? 0;
      a.totalTokens += r.total_tokens ?? 0;
      a.cost += r.cost ?? 0;
      a.equivCost += r.equiv_cost ?? 0;
      a.calls += r.calls;
      if (r.model) {
        if (!a.models[r.model]) a.models[r.model] = { input: 0, output: 0, cache: 0 };
        a.models[r.model].input += r.input_tokens ?? 0;
        a.models[r.model].output += r.output_tokens ?? 0;
        a.models[r.model].cache += r.cache_read ?? 0;
      }
    }

    return Object.values(byAgent).sort((a, b) => b.totalTokens - a.totalTokens);
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint") || "stream";

  // Build the gateway URL, forwarding all params except "endpoint"
  const params = new URLSearchParams();
  searchParams.forEach((v, k) => {
    if (k !== "endpoint") params.set(k, v);
  });

  // Map endpoint names to gateway paths
  const prefix = endpoint.startsWith("reliability-") || endpoint === "poller-status" ? "" : "logs/";
  const gwEndpoint = endpoint.startsWith("reliability-") ? `reliability/${endpoint.replace("reliability-", "")}` : endpoint === "poller-status" ? "logs/poller-status" : endpoint;
  const url = `${GATEWAY_URL}/${prefix}${gwEndpoint}?${params}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("Gateway error");
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    // Gateway down — fall back to direct SQLite read
    const since = Number(searchParams.get("since") || 0);
    const limit = Math.min(Math.max(Number(searchParams.get("limit") || 500), 1), 5000);

    if (endpoint === "stream") {
      const source = searchParams.get("source") || undefined;
      const session = searchParams.get("session") || undefined;
      const data = queryDbStream(since, limit, source, session);
      if (data) return NextResponse.json(data, { headers: { "X-Source": "sqlite-fallback" } });
    } else if (endpoint === "summary") {
      const data = queryDbSummary(since);
      if (data) return NextResponse.json(data, { headers: { "X-Source": "sqlite-fallback" } });
    }

    return NextResponse.json({ error: "Cannot connect to gateway and SQLite fallback failed" }, { status: 502 });
  }
}
