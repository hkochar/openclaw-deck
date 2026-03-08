import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { agents } from "@/lib/agent-config";
import { GATEWAY_URL } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

const HOME = process.env.HOME || "~";
const AGENTS_DIR = path.join(HOME, ".openclaw", "agents");

// ── Types ───────────────────────────────────────────────────────

interface SessionEntry {
  sessionId?: string;
  updatedAt?: number;
  channel?: string;
  groupChannel?: string;
  displayName?: string;
  model?: string;
  modelProvider?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  sessionFile?: string;
  label?: string;
  spawnDepth?: number;
}

interface SessionInfo {
  key: string;
  fullKey: string;
  sessionId: string;
  displayName: string;
  channel: string;
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  updatedAt: number | null;
  groupChannel: string;
  label: string;
  hasTranscript: boolean;
  transcriptSizeKB: number;
  status: "active" | "deleted" | "compacted" | "reset";
  archiveType?: "deleted" | "compacted" | "reset";
  archivedAt?: string;
  filename?: string;
}

interface ArchivedSession {
  filename: string;
  sessionId: string;
  sessionKey: string;
  archiveType: "deleted" | "compacted" | "reset";
  archivedAt: string;
  sizeKB: number;
}

interface AgentSessionSummary {
  key: string;
  name: string;
  emoji: string;
  agentId: string;
  sessionCount: number;
  totalTokens: number;
  lastActive: number | null;
  sessions: SessionInfo[];
  archived: ArchivedSession[];
}

// ── SQLite row shape from gateway /sessions endpoint ────────────

interface SessionRow {
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
  transcript_size_kb: number;
  updated_at: number;
  status: string;
  origin: string | null;
  archived_at: number | null;
  archive_file: string | null;
}

// ── GET handler ─────────────────────────────────────────────────

export async function GET() {
  try {
    // Try SQLite via gateway first
    const gatewayResult = await tryGateway();
    if (gatewayResult) {
      return NextResponse.json({ ok: true, agents: gatewayResult });
    }

    // Fallback: read from filesystem
    return NextResponse.json({ ok: true, agents: readFromFilesystem() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), agents: [] },
      { status: 500 }
    );
  }
}

// ── Gateway path (SQLite) ───────────────────────────────────────

async function tryGateway(): Promise<AgentSessionSummary[] | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/sessions?status=all`, {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!res.ok) return null;

    const rows = await res.json() as SessionRow[];
    if (!Array.isArray(rows) || rows.length === 0) return null;

    return transformRowsToSummaries(rows);
  } catch {
    return null;
  }
}

function transformRowsToSummaries(rows: SessionRow[]): AgentSessionSummary[] {
  const agentList = agents();
  const agentMap = new Map(agentList.map(a => [a.key, a]));

  // Group rows by agent
  const byAgent = new Map<string, { active: SessionRow[]; archived: SessionRow[] }>();
  for (const row of rows) {
    if (!byAgent.has(row.agent)) byAgent.set(row.agent, { active: [], archived: [] });
    const group = byAgent.get(row.agent)!;
    if (row.status === "active") group.active.push(row);
    else group.archived.push(row);
  }

  const result: AgentSessionSummary[] = [];

  for (const agent of agentList) {
    const group = byAgent.get(agent.key);
    const activeRows = group?.active ?? [];
    const archivedRows = group?.archived ?? [];

    let totalTokens = 0;
    let lastActive: number | null = null;
    const sessions: SessionInfo[] = [];

    // Map all rows (active + archived) to unified SessionInfo
    for (const row of [...activeRows, ...archivedRows]) {
      const isActive = row.status === "active";
      if (isActive) {
        totalTokens += row.total_tokens;
        if (row.updated_at && (lastActive === null || row.updated_at > lastActive)) {
          lastActive = row.updated_at;
        }
      }

      sessions.push({
        key: shortKey(row.session_key),
        fullKey: row.session_key,
        sessionId: row.session_id || "",
        displayName: row.display_name || row.label || row.session_key,
        channel: row.channel || "",
        model: row.model || "",
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        contextTokens: row.context_tokens,
        updatedAt: row.updated_at || null,
        groupChannel: row.group_channel || "",
        label: row.label || "",
        hasTranscript: row.transcript_size_kb > 0,
        transcriptSizeKB: row.transcript_size_kb,
        status: row.status as SessionInfo["status"],
        archiveType: isActive ? undefined : row.status as "deleted" | "compacted" | "reset",
        archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
        filename: row.archive_file || undefined,
        origin: row.origin || undefined,
      });
    }

    // Active first (by updatedAt desc), then archived (by updatedAt desc)
    sessions.sort((a, b) => {
      const aActive = a.status === "active" ? 0 : 1;
      const bActive = b.status === "active" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });

    // Build legacy archived array for backward compat
    const archived: ArchivedSession[] = archivedRows.map(row => ({
      filename: row.archive_file || "",
      sessionId: row.session_id || "",
      sessionKey: row.session_key,
      archiveType: row.status as "deleted" | "compacted" | "reset",
      archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : "",
      sizeKB: row.transcript_size_kb,
    }));

    result.push({
      key: agent.key,
      name: agent.name,
      emoji: agent.emoji,
      agentId: agent.id,
      sessionCount: activeRows.length,
      totalTokens,
      lastActive,
      sessions,
      archived,
    });
  }

  // Include agents from SQLite not in config (auto-discovered from backfill)
  for (const [agentKey, group] of byAgent) {
    if (agentMap.has(agentKey)) continue;
    const allRows = [...group.active, ...group.archived];
    if (allRows.length === 0) continue;

    let totalTokens = 0;
    let lastActive: number | null = null;
    const sessions: SessionInfo[] = [];

    for (const row of allRows) {
      const isActive = row.status === "active";
      if (isActive) {
        totalTokens += row.total_tokens;
        if (row.updated_at && (lastActive === null || row.updated_at > lastActive)) {
          lastActive = row.updated_at;
        }
      }
      sessions.push({
        key: shortKey(row.session_key),
        fullKey: row.session_key,
        sessionId: row.session_id || "",
        displayName: row.display_name || row.label || row.session_key,
        channel: row.channel || "",
        model: row.model || "",
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        contextTokens: row.context_tokens,
        updatedAt: row.updated_at || null,
        groupChannel: row.group_channel || "",
        label: row.label || "",
        hasTranscript: row.transcript_size_kb > 0,
        transcriptSizeKB: row.transcript_size_kb,
        status: row.status as SessionInfo["status"],
        archiveType: isActive ? undefined : row.status as "deleted" | "compacted" | "reset",
        archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
        filename: row.archive_file || undefined,
      });
    }

    sessions.sort((a, b) => {
      const aActive = a.status === "active" ? 0 : 1;
      const bActive = b.status === "active" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });

    const archived: ArchivedSession[] = group.archived.map(row => ({
      filename: row.archive_file || "",
      sessionId: row.session_id || "",
      sessionKey: row.session_key,
      archiveType: row.status as "deleted" | "compacted" | "reset",
      archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : "",
      sizeKB: row.transcript_size_kb,
    }));

    // Capitalize agent key for display name
    const displayName = agentKey.charAt(0).toUpperCase() + agentKey.slice(1);
    result.push({
      key: agentKey,
      name: displayName,
      emoji: "🤖",
      agentId: agentKey,
      sessionCount: group.active.length,
      totalTokens,
      lastActive,
      sessions,
      archived,
    });
  }

  return result;
}

// ── Filesystem fallback ─────────────────────────────────────────

function readFromFilesystem(): AgentSessionSummary[] {
  const agentList = agents();
  const result: AgentSessionSummary[] = [];

  for (const agent of agentList) {
    const store = readSessionStore(agent.id);
    const entries = Object.entries(store);

    let agentTotalTokens = 0;
    let lastActive: number | null = null;
    const sessions: SessionInfo[] = [];

    for (const [key, entry] of entries) {
      const tokens = entry.totalTokens ?? 0;
      agentTotalTokens += tokens;

      if (entry.updatedAt && (lastActive === null || entry.updatedAt > lastActive)) {
        lastActive = entry.updatedAt;
      }

      let hasTranscript = false;
      let transcriptSizeKB = 0;
      if (entry.sessionFile) {
        try {
          const stat = fs.statSync(entry.sessionFile);
          hasTranscript = true;
          transcriptSizeKB = Math.round(stat.size / 1024);
        } catch {}
      }

      let channel = entry.channel || "";
      if (!channel) {
        const parts = key.split(":");
        if (parts.length >= 3) channel = parts[2];
      }

      sessions.push({
        key: shortKey(key),
        fullKey: key,
        sessionId: entry.sessionId || "",
        displayName: entry.displayName || entry.label || key,
        channel,
        model: entry.model || "",
        totalTokens: tokens,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        contextTokens: entry.contextTokens ?? 0,
        updatedAt: entry.updatedAt ?? null,
        groupChannel: entry.groupChannel || "",
        label: entry.label || "",
        hasTranscript,
        transcriptSizeKB,
        status: "active",
      });
    }

    const archived = scanArchived(agent.id);

    // Add archived sessions to the unified sessions list
    for (const a of archived) {
      sessions.push({
        key: shortKey(a.sessionKey),
        fullKey: a.sessionKey,
        sessionId: a.sessionId,
        displayName: a.sessionId.length > 24 ? a.sessionId.slice(0, 21) + "…" : a.sessionId,
        channel: "",
        model: "",
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        updatedAt: a.archivedAt ? new Date(a.archivedAt).getTime() : null,
        groupChannel: "",
        label: "",
        hasTranscript: a.sizeKB > 0,
        transcriptSizeKB: a.sizeKB,
        status: a.archiveType,
        archiveType: a.archiveType,
        archivedAt: a.archivedAt,
        filename: a.filename,
      });
    }

    // Active first, then archived, each sorted by updatedAt desc
    sessions.sort((a, b) => {
      const aActive = a.status === "active" ? 0 : 1;
      const bActive = b.status === "active" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });

    result.push({
      key: agent.key,
      name: agent.name,
      emoji: agent.emoji,
      agentId: agent.id,
      sessionCount: entries.length,
      totalTokens: agentTotalTokens,
      lastActive,
      sessions,
      archived,
    });
  }

  return result;
}

// ── Filesystem helpers ──────────────────────────────────────────

function readSessionStore(agentId: string): Record<string, SessionEntry> {
  const storePath = path.join(AGENTS_DIR, agentId, "sessions", "sessions.json");
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function scanArchived(agentId: string): ArchivedSession[] {
  const sessionsDir = path.join(AGENTS_DIR, agentId, "sessions");
  let files: string[];
  try { files = fs.readdirSync(sessionsDir); } catch { return []; }

  const archived: ArchivedSession[] = [];

  for (const f of files) {
    const deletedMatch = f.match(/^([0-9a-f-]+(?:-topic-[\d.]+)?)\.jsonl\.deleted\.(.+)$/);
    if (deletedMatch) {
      try {
        const stat = fs.statSync(path.join(sessionsDir, f));
        archived.push({
          filename: f,
          sessionId: deletedMatch[1],
          sessionKey: `archived:${agentId}:deleted:${deletedMatch[1]}`,
          archiveType: "deleted",
          archivedAt: deletedMatch[2].replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1-$2-$3T$4:$5:$6").replace(/\.\d+Z$/, "Z"),
          sizeKB: Math.round(stat.size / 1024),
        });
      } catch {}
      continue;
    }

    const bakMatch = f.match(/^sessions\.json\.bak\.(\d+)$/);
    if (bakMatch) {
      try {
        const stat = fs.statSync(path.join(sessionsDir, f));
        const raw = fs.readFileSync(path.join(sessionsDir, f), "utf-8");
        const bakStore = JSON.parse(raw) as Record<string, unknown>;
        const count = Object.keys(bakStore).length;
        archived.push({
          filename: f,
          sessionId: `${count} sessions snapshot`,
          sessionKey: `archived:${agentId}:compacted:${bakMatch[1]}`,
          archiveType: "compacted",
          archivedAt: new Date(Number(bakMatch[1]) * 1000).toISOString(),
          sizeKB: Math.round(stat.size / 1024),
        });
      } catch {}
      continue;
    }

    const resetMatch = f.match(/^([0-9a-f-]+)\.jsonl\.reset\.(.+)$/);
    if (resetMatch) {
      try {
        const stat = fs.statSync(path.join(sessionsDir, f));
        archived.push({
          filename: f,
          sessionId: resetMatch[1],
          sessionKey: `archived:${agentId}:reset:${resetMatch[1]}`,
          archiveType: "reset",
          archivedAt: resetMatch[2],
          sizeKB: Math.round(stat.size / 1024),
        });
      } catch {}
    }
  }

  archived.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  return archived;
}

function shortKey(key: string): string {
  const parts = key.split(":");
  if (parts.length >= 4) {
    const tail = parts.slice(2).join(":");
    return tail.length > 40 ? tail.slice(0, 37) + "…" : tail;
  }
  return key.length > 40 ? key.slice(0, 37) + "…" : key;
}
