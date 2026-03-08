/**
 * POST /api/logs/session-analysis/run
 *
 * Run a new analysis with optional custom guidelines.
 * Body: { sessionKey: string, guidelines?: string }
 * Deduplicates: same session + guidelines_hash + events_max_id → return existing.
 */

import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { USAGE_DB } from "@/app/api/_lib/paths";
import {
  computeSessionAnalysis,
  guidelinesHash,
  type SessionAnalysis,
} from "@/lib/session-intelligence";
import {
  fetchAnalysisContext,
  storeAnalysis,
} from "@/app/api/logs/session-analysis/route";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON" },
      { status: 400 },
    );
  }

  const sessionKey = body.sessionKey as string;
  if (!sessionKey) {
    return NextResponse.json(
      { ok: false, error: "missing sessionKey" },
      { status: 400 },
    );
  }

  const guidelines = (body.guidelines as string) || null;

  if (!fs.existsSync(USAGE_DB)) {
    return NextResponse.json(
      { ok: false, error: "usage db not found" },
      { status: 404 },
    );
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(USAGE_DB, { readonly: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "cannot open usage db" },
      { status: 500 },
    );
  }

  try {
    const ctx = fetchAnalysisContext(db, sessionKey);
    db.close();

    if (!ctx) {
      return NextResponse.json(
        { ok: false, error: "no events for session" },
        { status: 404 },
      );
    }

    // Dedup check: same session + guidelines + events
    const gHash = guidelinesHash(guidelines);
    const rdb = new Database(USAGE_DB, { readonly: true });
    const existing = rdb
      .prepare(
        `SELECT id, computed_at, guidelines, events_max_id,
                agent_type, regions, outcomes, activity_summary, quality_scores, critique
         FROM session_analysis
         WHERE session_key = ? AND guidelines_hash IS ? AND events_max_id = ?
         LIMIT 1`,
      )
      .get(sessionKey, gHash, ctx.maxId) as {
      id: number;
      computed_at: number;
      guidelines: string | null;
      events_max_id: number;
      agent_type: string | null;
      regions: string;
      outcomes: string;
      activity_summary: string;
      quality_scores: string;
      critique: string;
    } | undefined;
    rdb.close();

    if (existing) {
      return NextResponse.json({
        ok: true,
        record: {
          id: existing.id,
          computedAt: existing.computed_at,
          guidelines: existing.guidelines,
          eventsMaxId: existing.events_max_id,
          analysis: {
            agentType: existing.agent_type ?? "general",
            regions: JSON.parse(existing.regions),
            outcomes: JSON.parse(existing.outcomes),
            activitySummary: JSON.parse(existing.activity_summary),
            qualityScores: JSON.parse(existing.quality_scores),
            critique: JSON.parse(existing.critique),
            task: null,
          },
        },
        deduplicated: true,
      });
    }

    // Compute fresh analysis
    const analysis = computeSessionAnalysis(
      ctx.events,
      ctx.agentType,
      ctx.runSummary,
      ctx.costBaseline,
      guidelines,
    );

    const id = storeAnalysis(sessionKey, ctx, analysis, guidelines);

    return NextResponse.json({
      ok: true,
      record: {
        id,
        computedAt: Date.now(),
        guidelines,
        eventsMaxId: ctx.maxId,
        analysis,
      },
      deduplicated: false,
    });
  } catch (err) {
    try {
      db.close();
    } catch {}
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[session-analysis/run] Error:", errMsg);
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
