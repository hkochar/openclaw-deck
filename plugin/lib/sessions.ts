import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import { getDb } from "./db-core";
import { getLogger } from "../logger";

// ── Session Persistence ─────────────────────────────────────────

export interface SessionUpsertData {
  sessionKey: string;
  agent: string;
  sessionId?: string;
  channel?: string;
  model?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  displayName?: string;
  label?: string;
  groupChannel?: string;
  origin?: string;
  compactionCount?: number;
  transcriptSizeKb?: number;
  updatedAt?: number;
  status?: "active" | "deleted" | "reset" | "compacted";
  archivedAt?: number;
  archiveFile?: string;
  source?: "agent" | "heartbeat" | "cron";
}

let upsertSessionStmt: Database.Statement | null = null;

export function upsertSession(data: SessionUpsertData): void {
  try {
    const db = getDb();
    if (!upsertSessionStmt) {
      upsertSessionStmt = db.prepare(`
        INSERT INTO sessions (
          session_key, agent, session_id, channel, model,
          total_tokens, input_tokens, output_tokens, context_tokens,
          display_name, label, group_channel, origin,
          compaction_count, transcript_size_kb,
          created_at, updated_at, status, archived_at, archive_file, source
        ) VALUES (
          @sessionKey, @agent, @sessionId, @channel, @model,
          @totalTokens, @inputTokens, @outputTokens, @contextTokens,
          @displayName, @label, @groupChannel, @origin,
          @compactionCount, @transcriptSizeKb,
          @createdAt, @updatedAt, @status, @archivedAt, @archiveFile, @source
        )
        ON CONFLICT(session_key) DO UPDATE SET
          agent = COALESCE(excluded.agent, agent),
          session_id = COALESCE(excluded.session_id, session_id),
          channel = COALESCE(NULLIF(excluded.channel, ''), channel),
          model = COALESCE(NULLIF(excluded.model, ''), model),
          total_tokens = COALESCE(excluded.total_tokens, total_tokens),
          input_tokens = COALESCE(excluded.input_tokens, input_tokens),
          output_tokens = COALESCE(excluded.output_tokens, output_tokens),
          context_tokens = COALESCE(excluded.context_tokens, context_tokens),
          display_name = COALESCE(NULLIF(excluded.display_name, ''), display_name),
          label = COALESCE(NULLIF(excluded.label, ''), label),
          group_channel = COALESCE(NULLIF(excluded.group_channel, ''), group_channel),
          origin = COALESCE(NULLIF(excluded.origin, ''), origin),
          compaction_count = COALESCE(excluded.compaction_count, compaction_count),
          transcript_size_kb = COALESCE(excluded.transcript_size_kb, transcript_size_kb),
          updated_at = excluded.updated_at,
          status = COALESCE(excluded.status, status),
          archived_at = COALESCE(excluded.archived_at, archived_at),
          archive_file = COALESCE(excluded.archive_file, archive_file),
          source = COALESCE(NULLIF(excluded.source, 'agent'), source)
      `);
    }
    const now = data.updatedAt ?? Date.now();
    upsertSessionStmt.run({
      sessionKey: data.sessionKey,
      agent: data.agent,
      sessionId: data.sessionId ?? null,
      channel: data.channel ?? null,
      model: data.model ?? null,
      totalTokens: data.totalTokens ?? null,
      inputTokens: data.inputTokens ?? null,
      outputTokens: data.outputTokens ?? null,
      contextTokens: data.contextTokens ?? null,
      displayName: data.displayName ?? null,
      label: data.label ?? null,
      groupChannel: data.groupChannel ?? null,
      origin: data.origin ?? null,
      compactionCount: data.compactionCount ?? null,
      transcriptSizeKb: data.transcriptSizeKb ?? null,
      createdAt: now,
      updatedAt: now,
      status: data.status ?? "active",
      archivedAt: data.archivedAt ?? null,
      archiveFile: data.archiveFile ?? null,
      source: data.source ?? "agent",
    });
  } catch (err) {
    getLogger().warn(`[deck-sync] session upsert failed for ${data.sessionKey}: ${String(err)}`);
  }
}

export interface SessionRow {
  id: number;
  session_key: string;
  agent: string;
  session_id: string | null;
  channel: string | null;
  model: string | null;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  context_tokens: number;
  display_name: string | null;
  label: string | null;
  group_channel: string | null;
  origin: string | null;
  compaction_count: number;
  transcript_size_kb: number;
  created_at: number;
  updated_at: number;
  status: string;
  archived_at: number | null;
  archive_file: string | null;
  source: string;
}

export function querySessions(opts?: {
  agent?: string;
  status?: string;
  includeArchived?: boolean;
}): SessionRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.agent) {
    conditions.push("agent = ?");
    params.push(opts.agent);
  }

  if (opts?.status && opts.status !== "all") {
    conditions.push("status = ?");
    params.push(opts.status);
  } else if (!opts?.includeArchived && opts?.status !== "all") {
    conditions.push("status = 'active'");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(
    `SELECT * FROM sessions ${where} ORDER BY updated_at DESC`
  ).all(...params) as SessionRow[];
}

export function getSessionCount(): number {
  const db = getDb();
  return (db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number }).cnt;
}

// Heartbeat detection constants (shared with Activity view)
const HEARTBEAT_MAX_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const HEARTBEAT_MAX_CALLS = 2;
const HEARTBEAT_MAX_COST = 0.50;

/**
 * Classify a session's source based on its events.
 * - "cron" if channel = "cron"
 * - "heartbeat" if short duration, few LLM calls, low cost
 * - "agent" otherwise
 */
function classifySessionSource(db: Database.Database, sessionKey: string, channel: string | null): "agent" | "heartbeat" | "cron" {
  if (channel === "cron") return "cron";

  // Check event stats for this session to detect heartbeats
  const stats = db.prepare(`
    SELECT
      MIN(ts) as first_ts, MAX(ts) as last_ts,
      COUNT(CASE WHEN type = 'llm_output' THEN 1 END) as llm_calls,
      COALESCE(SUM(CASE WHEN type = 'llm_output' AND billing = 'subscription' THEN 0
                        WHEN type = 'llm_output' THEN COALESCE(provider_cost, cost, 0)
                        ELSE 0 END), 0) as total_cost
    FROM events WHERE session = ?
  `).get(sessionKey) as { first_ts: number | null; last_ts: number | null; llm_calls: number; total_cost: number } | undefined;

  if (!stats || !stats.first_ts) return "agent";

  const duration = (stats.last_ts ?? stats.first_ts) - stats.first_ts;
  if (duration <= HEARTBEAT_MAX_DURATION_MS && stats.llm_calls <= HEARTBEAT_MAX_CALLS && stats.total_cost < HEARTBEAT_MAX_COST) {
    return "heartbeat";
  }
  return "agent";
}

/**
 * Backfill/reclassify source column for sessions.
 * On first call (recentOnly=false): checks all sessions with source='agent' or NULL.
 * On subsequent calls (recentOnly=true): only checks sessions updated in the last 10 minutes.
 * Returns number of sessions updated.
 */
export function backfillSessionSources(recentOnly = false): number {
  const db = getDb();
  let sessions: Array<{ session_key: string; channel: string | null; source: string | null }>;

  if (recentOnly) {
    const since = Date.now() - 10 * 60 * 1000;
    sessions = db.prepare(
      `SELECT session_key, channel, source FROM sessions WHERE updated_at >= ?`
    ).all(since) as typeof sessions;
  } else {
    sessions = db.prepare(
      `SELECT session_key, channel, source FROM sessions WHERE source = 'agent' OR source IS NULL`
    ).all() as typeof sessions;
  }

  if (sessions.length === 0) return 0;

  const updateStmt = db.prepare("UPDATE sessions SET source = ? WHERE session_key = ?");
  let updated = 0;

  const txn = db.transaction(() => {
    for (const s of sessions) {
      const source = classifySessionSource(db, s.session_key, s.channel);
      if (source !== (s.source ?? "agent")) {
        updateStmt.run(source, s.session_key);
        updated++;
      }
    }
  });
  txn();

  if (updated > 0) getLogger().info(`[deck-sync] backfilled source for ${updated} sessions (${sessions.length} checked)`);
  return updated;
}

/**
 * Reclassify source for a single session (called after session events are updated).
 */
export function updateSessionSource(sessionKey: string): void {
  const db = getDb();
  const row = db.prepare("SELECT channel FROM sessions WHERE session_key = ?").get(sessionKey) as { channel: string | null } | undefined;
  if (!row) return;
  const source = classifySessionSource(db, sessionKey, row.channel);
  db.prepare("UPDATE sessions SET source = ? WHERE session_key = ?").run(source, sessionKey);
}

// ── enrichSessionsFromTranscripts setter ──────────────────────────
// backfillOrphanedTranscripts needs enrichSessionsFromTranscripts from backfill-transcripts.
// To avoid a circular import, we use a setter that backfill-transcripts calls at module init.
type EnrichFn = (db: Database.Database, agentsDir: string, agentIds: string[], agentKeyMap: Record<string, string>) => number;
let _enrichSessionsFromTranscripts: EnrichFn | null = null;

/** Register the enrichSessionsFromTranscripts function (called by backfill-transcripts at import). */
export function setEnrichSessionsFromTranscripts(fn: EnrichFn): void {
  _enrichSessionsFromTranscripts = fn;
}

// ── extractTranscriptMetadata (used by backfillSessionsFromFilesystem) ──
// This is a forward-reference setter to avoid circular deps with backfill-transcripts.
type ExtractMetaFn = (filePath: string) => {
  model?: string; channel?: string; channelId?: string; groupChannel?: string;
  displayName?: string; label?: string; totalTokens: number; inputTokens: number; outputTokens: number;
};
let _extractTranscriptMetadata: ExtractMetaFn | null = null;

/** Register the extractTranscriptMetadata function (called by backfill-transcripts at import). */
export function setExtractTranscriptMetadata(fn: ExtractMetaFn): void {
  _extractTranscriptMetadata = fn;
}

/**
 * Backfill sessions table from filesystem (sessions.json + archive files).
 * Called once on first run when the sessions table is empty.
 * agentKeyMap: { agentId → agentKey } e.g. { "main" → "alpha" }
 */
export function backfillSessionsFromFilesystem(agentKeyMap: Record<string, string>): number {
  const agentsDir = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");
  let count = 0;

  if (getSessionCount() > 0) return 0;

  const agentIds = Object.keys(agentKeyMap);
  if (agentIds.length === 0) {
    try {
      const dirs = fs.readdirSync(agentsDir);
      for (const d of dirs) {
        if (fs.statSync(path.join(agentsDir, d)).isDirectory()) {
          agentIds.push(d);
          if (!agentKeyMap[d]) agentKeyMap[d] = d;
        }
      }
    } catch { /* no agents dir */ }
  }

  const extractTranscriptMetadata = _extractTranscriptMetadata;
  if (!extractTranscriptMetadata) {
    getLogger().warn("[deck-sync] extractTranscriptMetadata not registered — skipping orphan scan in backfillSessionsFromFilesystem");
  }

  const db = getDb();
  const txn = db.transaction(() => {
    for (const agentId of agentIds) {
      const agentKey = agentKeyMap[agentId] ?? agentId;
      const sessionsDir = path.join(agentsDir, agentId, "sessions");

      // 1. Read sessions.json → active sessions
      const trackedSessionIds = new Set<string>();
      const storePath = path.join(sessionsDir, "sessions.json");
      try {
        const raw = fs.readFileSync(storePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;

        for (const [key, entry] of Object.entries(store)) {
          if (entry.sessionId) trackedSessionIds.add(entry.sessionId as string);
          let channel = (entry.channel as string) || "";
          if (!channel) {
            const parts = key.split(":");
            if (parts.length >= 3) channel = parts[2];
          }

          let transcriptSizeKb = 0;
          if (entry.sessionFile) {
            try {
              const stat = fs.statSync(entry.sessionFile as string);
              transcriptSizeKb = Math.round(stat.size / 1024);
            } catch { /* missing file */ }
          }

          upsertSession({
            sessionKey: key,
            agent: agentKey,
            sessionId: (entry.sessionId as string) || undefined,
            channel,
            model: (entry.model as string) || undefined,
            totalTokens: (entry.totalTokens as number) ?? 0,
            inputTokens: (entry.inputTokens as number) ?? 0,
            outputTokens: (entry.outputTokens as number) ?? 0,
            contextTokens: (entry.contextTokens as number) ?? 0,
            displayName: (entry.displayName as string) || undefined,
            label: (entry.label as string) || undefined,
            groupChannel: (entry.groupChannel as string) || undefined,
            origin: typeof entry.origin === "string" ? entry.origin : (entry.origin ? JSON.stringify(entry.origin) : undefined),
            compactionCount: (entry.compactionCount as number) ?? 0,
            transcriptSizeKb,
            updatedAt: (entry.updatedAt as number) ?? Date.now(),
            status: "active",
          });
          count++;
        }
      } catch { /* no sessions.json */ }

      // 2. Read .bak files to build sessionId→metadata lookup
      let files: string[];
      try { files = fs.readdirSync(sessionsDir); } catch { continue; }

      const bakMeta = new Map<string, Record<string, unknown>>();
      for (const f of files) {
        const bakMatch = f.match(/^sessions\.json\.bak\.(\d+)$/);
        if (!bakMatch) continue;
        try {
          const raw = fs.readFileSync(path.join(sessionsDir, f), "utf-8");
          const bakStore = JSON.parse(raw) as Record<string, Record<string, unknown>>;
          for (const [key, entry] of Object.entries(bakStore)) {
            const sid = entry.sessionId as string;
            if (sid) bakMeta.set(sid, { ...entry, _sessionKey: key });
          }
        } catch { /* skip */ }
      }

      // 3. Scan archive files, enriching with bak metadata
      for (const f of files) {
        const deletedMatch = f.match(/^([0-9a-f-]+(?:-topic-[\d.]+)?)\.jsonl\.deleted\.(.+)$/);
        if (deletedMatch) {
          try {
            const stat = fs.statSync(path.join(sessionsDir, f));
            const archivedAt = parseArchiveTimestamp(deletedMatch[2]);
            const sessionId = deletedMatch[1];
            const baseId = sessionId.replace(/-topic-[\d.]+$/, "");
            const meta = bakMeta.get(baseId) || bakMeta.get(sessionId);
            let channel = (meta?.channel as string) || "";
            if (!channel && meta?._sessionKey) {
              const parts = (meta._sessionKey as string).split(":");
              if (parts.length >= 3) channel = parts[2];
            }
            upsertSession({
              sessionKey: `archived:${agentId}:deleted:${sessionId}`,
              agent: agentKey,
              sessionId,
              channel,
              model: (meta?.model as string) || undefined,
              totalTokens: (meta?.totalTokens as number) ?? 0,
              inputTokens: (meta?.inputTokens as number) ?? 0,
              outputTokens: (meta?.outputTokens as number) ?? 0,
              contextTokens: (meta?.contextTokens as number) ?? 0,
              displayName: (meta?.displayName as string) || (meta?.label as string) || undefined,
              label: (meta?.label as string) || undefined,
              groupChannel: (meta?.groupChannel as string) || undefined,
              origin: (meta?._sessionKey as string) || undefined,
              status: "deleted",
              archivedAt,
              archiveFile: f,
              transcriptSizeKb: Math.round(stat.size / 1024),
              updatedAt: archivedAt,
            });
            count++;
          } catch { /* skip */ }
          continue;
        }

        const bakMatchFile = f.match(/^sessions\.json\.bak\.(\d+)$/);
        if (bakMatchFile) {
          try {
            const stat = fs.statSync(path.join(sessionsDir, f));
            const archivedAt = Number(bakMatchFile[1]) * 1000;
            const raw = fs.readFileSync(path.join(sessionsDir, f), "utf-8");
            const bakStore = JSON.parse(raw) as Record<string, unknown>;
            const sessionCount = Object.keys(bakStore).length;
            upsertSession({
              sessionKey: `archived:${agentId}:compacted:${bakMatchFile[1]}`,
              agent: agentKey,
              sessionId: `${sessionCount} sessions snapshot`,
              status: "compacted",
              archivedAt,
              archiveFile: f,
              transcriptSizeKb: Math.round(stat.size / 1024),
              updatedAt: archivedAt,
            });
            count++;
          } catch { /* skip */ }
          continue;
        }

        const resetMatch = f.match(/^([0-9a-f-]+)\.jsonl\.reset\.(.+)$/);
        if (resetMatch) {
          try {
            const stat = fs.statSync(path.join(sessionsDir, f));
            const archivedAt = parseArchiveTimestamp(resetMatch[2]);
            const sessionId = resetMatch[1];
            const meta = bakMeta.get(sessionId);
            let channel = (meta?.channel as string) || "";
            if (!channel && meta?._sessionKey) {
              const parts = (meta._sessionKey as string).split(":");
              if (parts.length >= 3) channel = parts[2];
            }
            upsertSession({
              sessionKey: `archived:${agentId}:reset:${sessionId}`,
              agent: agentKey,
              sessionId,
              channel,
              model: (meta?.model as string) || undefined,
              totalTokens: (meta?.totalTokens as number) ?? 0,
              inputTokens: (meta?.inputTokens as number) ?? 0,
              outputTokens: (meta?.outputTokens as number) ?? 0,
              contextTokens: (meta?.contextTokens as number) ?? 0,
              displayName: (meta?.displayName as string) || (meta?.label as string) || undefined,
              label: (meta?.label as string) || undefined,
              groupChannel: (meta?.groupChannel as string) || undefined,
              origin: (meta?._sessionKey as string) || undefined,
              status: "reset",
              archivedAt,
              archiveFile: f,
              transcriptSizeKb: Math.round(stat.size / 1024),
              updatedAt: archivedAt,
            });
            count++;
          } catch { /* skip */ }
        }
      }

      // 4. Scan for orphaned transcripts — .jsonl files not tracked in sessions.json
      // These are sessions that exist on disk but were never recorded in sessions.json
      // (common after compaction or manual cleanup)
      if (extractTranscriptMetadata) {
        for (const f of files) {
          const orphanMatch = f.match(/^([0-9a-f-]+(?:-topic-[\d.]+)?)\.jsonl$/);
          if (!orphanMatch) continue;
          const sessionId = orphanMatch[1];
          const baseId = sessionId.replace(/-topic-[\d.]+$/, "");
          if (trackedSessionIds.has(sessionId) || trackedSessionIds.has(baseId)) continue;

          // Skip if an archive variant (.deleted.* or .reset.*) exists — step 3 already handled it
          const alreadyArchived = files.some(af =>
            af.startsWith(`${sessionId}.jsonl.deleted.`) || af.startsWith(`${sessionId}.jsonl.reset.`)
          );
          if (alreadyArchived) continue;

          try {
            const filePath = path.join(sessionsDir, f);
            const stat = fs.statSync(filePath);
            if (stat.size === 0) continue;

            const meta = extractTranscriptMetadata(filePath);
            let channel = meta.channel || "";
            let origin: string | undefined;
            if (meta.channelId) {
              origin = `agent:${agentId}:discord:channel:${meta.channelId}`;
              if (!channel) channel = "discord";
            } else if (meta.channel === "cron" || meta.channel === "main") {
              origin = `agent:${agentId}:${meta.channel}`;
            }

            upsertSession({
              sessionKey: `${agentId}/${sessionId}.jsonl`,
              agent: agentKey,
              sessionId,
              channel,
              model: meta.model || undefined,
              totalTokens: meta.totalTokens,
              inputTokens: meta.inputTokens,
              outputTokens: meta.outputTokens,
              displayName: meta.displayName || undefined,
              label: meta.label || undefined,
              groupChannel: meta.groupChannel || undefined,
              origin,
              transcriptSizeKb: Math.round(stat.size / 1024),
              updatedAt: stat.mtimeMs,
              status: "active",
            });
            count++;
          } catch { /* skip */ }
        }
      }

    }
  });

  txn();
  getLogger().info(`[deck-sync] session backfill complete: ${count} sessions imported`);
  return count;
}

/**
 * Scan for orphaned transcript files — .jsonl files on disk that have no
 * matching session row in SQLite. Creates session entries with metadata
 * extracted from transcript headers. Safe to call on every startup.
 */
export function backfillOrphanedTranscripts(agentKeyMap: Record<string, string>): number {
  const db = getDb();
  const agentsDir = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");

  const extractTranscriptMetadata = _extractTranscriptMetadata;
  if (!extractTranscriptMetadata) {
    getLogger().warn("[deck-sync] extractTranscriptMetadata not registered — skipping backfillOrphanedTranscripts");
    return 0;
  }

  let agentIds = Object.keys(agentKeyMap);
  if (agentIds.length === 0) {
    try {
      agentIds = fs.readdirSync(agentsDir).filter(d =>
        fs.statSync(path.join(agentsDir, d)).isDirectory()
      );
    } catch { return 0; }
  }

  // Build set of session IDs already in the sessions table
  const existingSessionIds = new Set<string>();
  try {
    const rows = db.prepare("SELECT session_id FROM sessions WHERE session_id IS NOT NULL").all() as Array<{ session_id: string }>;
    for (const r of rows) existingSessionIds.add(r.session_id);
  } catch { return 0; }

  let count = 0;

  const txn = db.transaction(() => {
    for (const agentId of agentIds) {
      const agentKey = agentKeyMap[agentId] || agentId;
      const sessionsDir = path.join(agentsDir, agentId, "sessions");

      let files: string[];
      try { files = fs.readdirSync(sessionsDir); } catch { continue; }

      for (const f of files) {
        if (!f.includes(".jsonl")) continue;
        if (f.startsWith("sessions.json")) continue;

        // Extract session ID from any .jsonl filename variant
        const idMatch = f.match(/^([0-9a-f-]+(?:-topic-[\d.]+)?)\./);
        if (!idMatch) continue;
        const sessionId = idMatch[1];
        const baseId = sessionId.replace(/-topic-[\d.]+$/, "");

        // Skip if already in sessions table
        if (existingSessionIds.has(sessionId) || existingSessionIds.has(baseId)) continue;
        // Skip duplicate filenames (only process first match per sessionId)
        if (existingSessionIds.has(`_processed_${sessionId}`)) continue;
        existingSessionIds.add(`_processed_${sessionId}`);

        const filePath = path.join(sessionsDir, f);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size === 0) continue;

          const meta = extractTranscriptMetadata(filePath);
          let channel = meta.channel || "";
          let origin: string | undefined;
          if (meta.channelId) {
            origin = `agent:${agentId}:discord:channel:${meta.channelId}`;
            if (!channel) channel = "discord";
          } else if (meta.channel === "cron" || meta.channel === "main") {
            origin = `agent:${agentId}:${meta.channel}`;
          }

          // Determine status from filename
          let status: "active" | "deleted" | "reset" = "active";
          let sessionKey = `${agentId}/${sessionId}.jsonl`;
          let archivedAt: number | undefined;
          let archiveFile: string | undefined;

          const deletedMatch = f.match(/\.jsonl\.deleted\.(.+)$/);
          const resetMatch = f.match(/\.jsonl\.reset\.(.+)$/);
          if (deletedMatch) {
            status = "deleted";
            archivedAt = parseArchiveTimestamp(deletedMatch[1]);
            archiveFile = f;
            sessionKey = `archived:${agentId}:deleted:${sessionId}`;
          } else if (resetMatch) {
            status = "reset";
            archivedAt = parseArchiveTimestamp(resetMatch[1]);
            archiveFile = f;
            sessionKey = `archived:${agentId}:reset:${sessionId}`;
          }

          upsertSession({
            sessionKey,
            agent: agentKey,
            sessionId,
            channel,
            model: meta.model || undefined,
            totalTokens: meta.totalTokens,
            inputTokens: meta.inputTokens,
            outputTokens: meta.outputTokens,
            displayName: meta.displayName || undefined,
            label: meta.label || undefined,
            groupChannel: meta.groupChannel || undefined,
            origin,
            transcriptSizeKb: Math.round(stat.size / 1024),
            updatedAt: archivedAt || stat.mtimeMs,
            status,
            archivedAt,
            archiveFile,
          });
          count++;
        } catch { /* skip */ }
      }
    }
  });

  txn();
  if (count > 0) {
    getLogger().info(`[deck-sync] orphan scan: ${count} orphaned transcripts imported as sessions`);
  }
  return count;
}

export function parseArchiveTimestamp(ts: string): number {
  const iso = ts.replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1T$2:$3:$4");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}
