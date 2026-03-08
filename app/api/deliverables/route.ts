/**
 * GET /api/deliverables
 *
 * Returns agent deliverables from the `deliverables` table.
 * Runs an incremental refresh on each request to pick up new events.
 *
 * Query params:
 *   agent  — filter by agent name
 *   offset — pagination offset (default: 0)
 *   limit  — max groups returned (default: 50, max: 200)
 */

import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "fs";
import { USAGE_DB } from "@/app/api/_lib/paths";
import {
  type ToolEvent,
  type DeliverableItem,
  type DeliverableGroup,
  classifyEvent,
  buildDeliverableGroups,
  ruleToolNames,
  DEFAULT_RULES,
  CLUSTER_GAP_MS,
} from "@/lib/deliverable-classifier";

// ── Incremental refresh ──────────────────────────────────────────────

const TYPE_PRIORITY: Record<string, number> = {};
for (const rule of DEFAULT_RULES) {
  if (!(rule.type in TYPE_PRIORITY) || rule.priority > TYPE_PRIORITY[rule.type]) {
    TYPE_PRIORITY[rule.type] = rule.priority;
  }
}

function refreshDeliverables(db: InstanceType<typeof Database>): void {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='deliverables'"
  ).get();
  if (!tableExists) return;

  const maxRow = db.prepare("SELECT MAX(events_max_id) as maxId FROM deliverables").get() as { maxId: number | null };
  const highWater = maxRow?.maxId ?? 0;

  const eventsMax = (db.prepare("SELECT MAX(id) as maxId FROM events").get() as { maxId: number | null })?.maxId ?? 0;
  if (eventsMax <= highWater) return;

  const toolNames = ruleToolNames();
  const toolPlaceholders = toolNames.map(() => "?").join(",");
  const newRows = db.prepare(
    `SELECT id, ts, agent, session, tool_name, tool_query, tool_target, detail
     FROM events
     WHERE type = 'tool_call' AND tool_name IN (${toolPlaceholders}) AND id > ?
     ORDER BY ts ASC`
  ).all(...toolNames, highWater) as ToolEvent[];

  if (newRows.length === 0) return;

  const newGroups = buildDeliverableGroups(newRows);
  if (newGroups.length === 0) return;

  const now = Date.now();

  const findExisting = db.prepare(
    `SELECT id, last_ts, events_max_id, supporting, main_type, main_label, main_target
     FROM deliverables WHERE agent = ? AND session = ? AND last_ts >= ? ORDER BY last_ts DESC LIMIT 1`
  );
  const updateExisting = db.prepare(
    `UPDATE deliverables SET main_type = ?, main_label = ?, main_target = ?,
     supporting = ?, item_count = ?, last_ts = ?, events_max_id = ?, updated_at = ?
     WHERE id = ?`
  );
  const insertNew = db.prepare(
    `INSERT OR IGNORE INTO deliverables
      (agent, session, group_key, main_type, main_label, main_target, supporting,
       item_count, first_ts, last_ts, events_max_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (const g of newGroups) {
      const threshold = g.firstTs - CLUSTER_GAP_MS;
      const existing = findExisting.get(g.agent, g.session, threshold) as {
        id: number; last_ts: number; events_max_id: number; supporting: string;
        main_type: string; main_label: string; main_target: string | null;
      } | undefined;

      if (existing && g.firstTs - existing.last_ts <= CLUSTER_GAP_MS) {
        mergeIntoExisting(db, existing, g, updateExisting, now);
      } else {
        insertNew.run(
          g.agent, g.session, g.groupKey,
          g.main.type, g.main.label, g.main.target,
          JSON.stringify(g.supporting),
          g.itemCount, g.firstTs, g.lastTs, g.eventsMaxId,
          now, now,
        );
      }
    }
  });
  tx();
}

function mergeIntoExisting(
  _db: InstanceType<typeof Database>,
  existing: { id: number; last_ts: number; supporting: string; main_type: string; main_label: string; main_target: string | null },
  g: DeliverableGroup,
  updateStmt: Database.Statement,
  now: number,
): void {
  const oldSupporting: DeliverableItem[] = JSON.parse(existing.supporting);
  const allSupporting = [...oldSupporting, ...g.supporting];

  const existPri = TYPE_PRIORITY[existing.main_type] ?? 0;
  const newPri = TYPE_PRIORITY[g.main.type] ?? 0;
  let mainType = existing.main_type, mainLabel = existing.main_label, mainTarget = existing.main_target;

  if (newPri > existPri) {
    allSupporting.unshift({ type: existing.main_type, label: existing.main_label, target: existing.main_target, ts: existing.last_ts });
    mainType = g.main.type;
    mainLabel = g.main.label;
    mainTarget = g.main.target;
  } else {
    allSupporting.push(g.main);
  }

  // Dedup
  const seen = new Set<string>();
  if (mainTarget) seen.add(mainTarget);
  const deduped: DeliverableItem[] = [];
  for (let i = allSupporting.length - 1; i >= 0; i--) {
    const s = allSupporting[i];
    const key = s.target ?? `${s.type}:${s.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }
  deduped.reverse();

  updateStmt.run(
    mainType, mainLabel, mainTarget,
    JSON.stringify(deduped), 1 + deduped.length,
    g.lastTs, g.eventsMaxId, now, existing.id,
  );
}

// ── Route handler ────────────────────────────────────────────────────

interface DeliverableRow {
  id: number;
  agent: string;
  session: string;
  group_key: string;
  main_type: string;
  main_label: string;
  main_target: string | null;
  supporting: string;
  item_count: number;
  first_ts: number;
  last_ts: number;
}

export async function GET(req: NextRequest) {
  const agent = req.nextUrl.searchParams.get("agent") || null;
  const offset = Math.max(Number(req.nextUrl.searchParams.get("offset")) || 0, 0);
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 50, 1), 200);

  if (!fs.existsSync(USAGE_DB)) {
    return NextResponse.json({ ok: false, error: "usage db not found" }, { status: 404 });
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(USAGE_DB);
  } catch {
    return NextResponse.json({ ok: false, error: "cannot open usage db" }, { status: 500 });
  }

  try {
    // Ensure table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS deliverables (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        agent           TEXT NOT NULL,
        session         TEXT NOT NULL,
        group_key       TEXT NOT NULL UNIQUE,
        main_type       TEXT NOT NULL,
        main_label      TEXT NOT NULL,
        main_target     TEXT,
        supporting      TEXT NOT NULL DEFAULT '[]',
        item_count      INTEGER NOT NULL DEFAULT 1,
        first_ts        INTEGER NOT NULL,
        last_ts         INTEGER NOT NULL,
        events_max_id   INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_del_agent     ON deliverables(agent);
      CREATE INDEX IF NOT EXISTS idx_del_last_ts   ON deliverables(last_ts);
      CREATE INDEX IF NOT EXISTS idx_del_group_key ON deliverables(group_key);
    `);

    // Incremental refresh
    refreshDeliverables(db);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (agent) {
      conditions.push("agent = ?");
      params.push(agent);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM deliverables ${where}`)
      .get(...params) as { cnt: number };

    const rows = db
      .prepare(
        `SELECT id, agent, session, group_key, main_type, main_label, main_target,
                supporting, item_count, first_ts, last_ts
         FROM deliverables ${where}
         ORDER BY last_ts DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as DeliverableRow[];

    const agentRows = db
      .prepare("SELECT DISTINCT agent FROM deliverables ORDER BY agent")
      .all() as Array<{ agent: string }>;

    db.close();

    const groups = rows.map((r) => ({
      id: r.group_key,
      agent: r.agent,
      session: r.session,
      date: r.last_ts,
      main: {
        type: r.main_type,
        label: r.main_label,
        target: r.main_target,
        ts: r.last_ts,
      },
      supporting: JSON.parse(r.supporting) as Array<{
        type: string; label: string; target: string | null; ts: number;
      }>,
    }));

    return NextResponse.json({
      ok: true,
      groups,
      agents: agentRows.map((r) => r.agent),
      total: countRow.cnt,
      hasMore: offset + limit < countRow.cnt,
    });
  } catch (err) {
    try { db.close(); } catch {}
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[deliverables] Error:", errMsg);
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
