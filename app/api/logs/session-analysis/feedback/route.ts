/**
 * POST /api/logs/session-analysis/feedback
 *
 * Submit feedback for a session analysis.
 */

import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { USAGE_DB } from "@/app/api/_lib/paths";

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

  if (!fs.existsSync(USAGE_DB)) {
    return NextResponse.json(
      { ok: false, error: "usage db not found" },
      { status: 404 },
    );
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(USAGE_DB);
  } catch {
    return NextResponse.json(
      { ok: false, error: "cannot open usage db" },
      { status: 500 },
    );
  }

  try {
    const rating = typeof body.rating === "number" ? body.rating : null;
    const outcomeQuality =
      typeof body.outcomeQuality === "string" ? body.outcomeQuality : null;
    const notes = typeof body.notes === "string" ? body.notes : null;
    const tags =
      Array.isArray(body.tags) ? JSON.stringify(body.tags) : null;
    const flagged = body.flagged ? 1 : 0;

    db.prepare(
      `INSERT INTO session_feedback (session_key, created_at, rating, outcome_quality, notes, tags, flagged)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionKey, Date.now(), rating, outcomeQuality, notes, tags, flagged);

    db.close();
    return NextResponse.json({ ok: true });
  } catch (err) {
    try {
      db.close();
    } catch {}
    const errMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
