import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { GATEWAY_URL, USAGE_DB } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

interface DailyActivity {
  agent: string;
  date: string;
  sessions: number;
  activeMinutes: number;
  cost: number;
  api_equiv_cost: number;
  calls: number;
  tokens: number;
}

function queryDirectFromDb(days: number): DailyActivity[] | null {
  if (!fs.existsSync(USAGE_DB)) return null;
  try {
    const db = new Database(USAGE_DB, { readonly: true });

    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const since = endOfToday - days * 86400000;

    // Cost/calls/tokens from events
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

    // Session active time
    const sessionRows = db.prepare(`
      SELECT agent, created_at, updated_at
      FROM sessions
      WHERE updated_at >= ? AND created_at < ?
      ORDER BY agent, created_at
    `).all(since, endOfToday) as Array<{ agent: string; created_at: number; updated_at: number }>;

    db.close();

    // Build activity map from sessions
    const activityMap = new Map<string, { sessions: number; activeMs: number }>();
    for (const s of sessionRows) {
      const start = Math.max(s.created_at, since);
      const end = Math.min(s.updated_at, endOfToday);
      if (end <= start) continue;

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

    // Merge
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
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("days") ?? "30", 10) || 30, 1), 90);

  // Try gateway first
  try {
    const res = await fetch(`${GATEWAY_URL}/activity/daily?days=${days}`, {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return NextResponse.json(data);
    }
  } catch { /* fall through to direct DB */ }

  // Direct SQLite fallback
  const result = queryDirectFromDb(days);
  if (result) return NextResponse.json(result);

  return NextResponse.json([], { status: 502 });
}
