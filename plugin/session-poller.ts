/**
 * Session JSONL → tool_call events poller.
 * Extracted from index.ts — reads agent session transcripts and inserts events into SQLite.
 * The after_tool_call plugin hook doesn't fire (bundling issue), so we parse JSONL files directly.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { logEvent, enrichEvent, upsertSession } from "./event-log.js";
import { trackReplayToolCall } from "./budget.js";

// Injected by index.ts before start()
export let resolveAgentKey: (id: string | undefined) => string | undefined = () => undefined;

export function setResolveAgentKey(fn: (id: string | undefined) => string | undefined): void {
  resolveAgentKey = fn;
}

/** Parse archive timestamp: "2026-02-24T23-05-05.844Z" → epoch ms */
function parseArchiveTs(ts: string): number {
  const iso = ts.replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1T$2:$3:$4");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

export class SessionJsonlPoller {
  private readonly agentsDir: string;
  private readonly cursorPath: string;
  private cursor: Record<string, number> = {};
  private readonly logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  // In-flight toolCalls waiting for their toolResult (keyed by toolCallId)
  private readonly pendingCalls = new Map<string, { name: string; args: Record<string, unknown>; ts: number }>();

  // Populated on plugin init from gateway config
  static AGENT_IDS: string[] = [];
  private static readonly FRESHNESS_MS = 5 * 60 * 1000;
  private static readonly PENDING_TTL_MS = 10 * 60 * 1000;

  // Stats for status endpoint
  private lastPollMs = 0;
  private eventsInsertedTotal = 0;
  private eventsInsertedLastPoll = 0;

  constructor(logger: { warn: (msg: string) => void; info?: (msg: string) => void }) {
    this.logger = logger;
    this.agentsDir = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");
    this.cursorPath = path.join(os.homedir(), ".openclaw-deck", "state", "session-poller-cursor.json");
    this.loadCursor();
  }

  private loadCursor(): void {
    try {
      const raw = fs.readFileSync(this.cursorPath, "utf-8");
      this.cursor = JSON.parse(raw);
    } catch {
      // First run — initialize cursors to current file sizes (skip history)
      this.initCursor();
    }
  }

  private initCursor(): void {
    for (const agentId of SessionJsonlPoller.AGENT_IDS) {
      const dir = path.join(this.agentsDir, agentId, "sessions");
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        try {
          const stat = fs.statSync(path.join(dir, file));
          this.cursor[`${agentId}/${file}`] = stat.size;
        } catch { /* skip */ }
      }
    }
    this.saveCursor();
    this.logger.info?.("openclaw-deck-sync: session poller initialized cursors (cold start)");
  }

  private saveCursor(): void {
    try {
      const dir = path.dirname(this.cursorPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cursorPath, JSON.stringify(this.cursor), "utf-8");
    } catch { /* non-fatal */ }
  }

  start(intervalMs = 15_000): void {
    this.logger.info?.("openclaw-deck-sync: session JSONL poller starting");
    this.poll();
    this.intervalHandle = setInterval(() => this.poll(), intervalMs);
  }

  getStatus(): Record<string, unknown> {
    return {
      running: this.intervalHandle !== null,
      lastPollMs: this.lastPollMs,
      filesTracked: Object.keys(this.cursor).length,
      eventsInsertedTotal: this.eventsInsertedTotal,
      eventsInsertedLastPoll: this.eventsInsertedLastPoll,
      pendingCallsInFlight: this.pendingCalls.size,
    };
  }

  private poll(): void {
    let inserted = 0;
    const now = Date.now();

    // Evict stale pending calls
    for (const [id, call] of this.pendingCalls) {
      if (now - call.ts > SessionJsonlPoller.PENDING_TTL_MS) this.pendingCalls.delete(id);
    }

    for (const agentId of SessionJsonlPoller.AGENT_IDS) {
      const sessionsDir = path.join(this.agentsDir, agentId, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;

      let files: string[];
      try { files = fs.readdirSync(sessionsDir); } catch { continue; }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(sessionsDir, file);
        const fileKey = `${agentId}/${file}`;

        let stat: fs.Stats;
        try { stat = fs.statSync(filePath); } catch { continue; }

        // Skip stale files
        if (now - stat.mtimeMs > SessionJsonlPoller.FRESHNESS_MS) continue;

        const cursorOffset = this.cursor[fileKey] ?? 0;
        if (stat.size <= cursorOffset) continue; // no new data

        try {
          inserted += this.processNewBytes(filePath, fileKey, cursorOffset, stat.size, agentId);
        } catch (err) {
          this.logger.warn(`openclaw-deck-sync: session poller error for ${fileKey}: ${String(err)}`);
        }
      }
    }

    // Clean up cursor entries for deleted files
    for (const key of Object.keys(this.cursor)) {
      const [aId, fname] = key.split("/", 2);
      if (!aId || !fname) { delete this.cursor[key]; continue; }
      const fp = path.join(this.agentsDir, aId, "sessions", fname);
      if (!fs.existsSync(fp)) delete this.cursor[key];
    }

    this.saveCursor();
    this.lastPollMs = now;
    this.eventsInsertedLastPoll = inserted;
    this.eventsInsertedTotal += inserted;

    // Sync session metadata to SQLite (every poll cycle)
    this.syncSessionMetadata();
  }

  /** Read sessions.json + archive files per agent, upsert into sessions table */
  private syncSessionMetadata(): void {
    for (const agentId of SessionJsonlPoller.AGENT_IDS) {
      const agentKey = resolveAgentKey(agentId);
      if (!agentKey) continue;
      const sessionsDir = path.join(this.agentsDir, agentId, "sessions");

      // 1. Sync active sessions from sessions.json
      const storePath = path.join(sessionsDir, "sessions.json");
      try {
        const raw = fs.readFileSync(storePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;

        for (const [key, entry] of Object.entries(store)) {
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
            } catch { /* missing transcript */ }
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
        }
      } catch { /* no sessions.json or parse error */ }

      // 2. Read .bak files to build sessionId→metadata lookup for enriching deleted sessions
      let files: string[];
      try { files = fs.readdirSync(sessionsDir); } catch { continue; }

      // Build metadata map from all .bak snapshots (sessionId → {channel, model, tokens, ...})
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
        } catch { /* skip unreadable bak */ }
      }

      // 3. Scan archive files (.deleted, .bak, .reset)
      for (const f of files) {
        const deletedMatch = f.match(/^([0-9a-f-]+(?:-topic-[\d.]+)?)\.jsonl\.deleted\.(.+)$/);
        if (deletedMatch) {
          try {
            const stat = fs.statSync(path.join(sessionsDir, f));
            const archivedAt = parseArchiveTs(deletedMatch[2]);
            const sessionId = deletedMatch[1];
            // Strip topic suffix to look up base session ID in bak metadata
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
              // Store original session key for log URL matching
              origin: (meta?._sessionKey as string) || undefined,
              status: "deleted",
              archivedAt,
              archiveFile: f,
              transcriptSizeKb: Math.round(stat.size / 1024),
              updatedAt: archivedAt,
            });
          } catch { /* skip */ }
          continue;
        }

        const bakMatch2 = f.match(/^sessions\.json\.bak\.(\d+)$/);
        if (bakMatch2) {
          try {
            const stat = fs.statSync(path.join(sessionsDir, f));
            const archivedAt = Number(bakMatch2[1]) * 1000;
            // Count sessions in the snapshot
            const raw = fs.readFileSync(path.join(sessionsDir, f), "utf-8");
            const bakStore = JSON.parse(raw) as Record<string, unknown>;
            const sessionCount = Object.keys(bakStore).length;
            upsertSession({
              sessionKey: `archived:${agentId}:compacted:${bakMatch2[1]}`,
              agent: agentKey,
              sessionId: `${sessionCount} sessions snapshot`,
              status: "compacted",
              archivedAt,
              archiveFile: f,
              transcriptSizeKb: Math.round(stat.size / 1024),
              updatedAt: archivedAt,
            });
          } catch { /* skip */ }
          continue;
        }

        const resetMatch = f.match(/^([0-9a-f-]+)\.jsonl\.reset\.(.+)$/);
        if (resetMatch) {
          try {
            const stat = fs.statSync(path.join(sessionsDir, f));
            const archivedAt = parseArchiveTs(resetMatch[2]);
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
          } catch { /* skip */ }
        }
      }
    }
  }

  private processNewBytes(filePath: string, fileKey: string, offset: number, size: number, agentId: string): number {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      const raw = buf.toString("utf-8");

      // Only process up to the last complete line
      const lastNewline = raw.lastIndexOf("\n");
      if (lastNewline < 0) {
        // No complete line yet — don't advance cursor
        return 0;
      }
      const completeContent = raw.slice(0, lastNewline + 1);
      this.cursor[fileKey] = offset + Buffer.byteLength(completeContent, "utf-8");

      const agentKey = resolveAgentKey(agentId);
      if (!agentKey) return 0;

      let inserted = 0;
      const lines = completeContent.split("\n").filter(Boolean);

      for (const line of lines) {
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== "message") continue;

        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg) continue;
        const ts = entry.timestamp as string | undefined;

        // Type A: assistant message with toolCall content blocks
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content as Array<Record<string, unknown>>) {
            if (block.type === "toolCall" && block.id) {
              this.pendingCalls.set(block.id as string, {
                name: (block.name as string) ?? "unknown",
                args: (block.arguments as Record<string, unknown>) ?? {},
                ts: ts ? new Date(ts).getTime() : Date.now(),
              });
            }
          }

          // Type C: assistant message with usage data — enrich matching llm_output event
          const usage = msg.usage as Record<string, unknown> | undefined;
          if (usage) {
            const eventTs = ts ? new Date(ts).getTime() : Date.now();
            const costObj = usage.cost as Record<string, number> | undefined;
            const providerCost = costObj?.total ?? undefined;
            const resolvedModel = msg.model as string | undefined;

            // Extract text response and thinking blocks
            const contentBlocks = msg.content as Array<Record<string, unknown>>;
            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            for (const block of contentBlocks) {
              if (block.type === "text" && block.text) {
                textParts.push(block.text as string);
              } else if (block.type === "thinking" && block.thinking) {
                thinkingParts.push(block.thinking as string);
              }
            }

            const responseText = textParts.join("\n") || undefined;
            const thinkingText = thinkingParts.join("\n") || undefined;

            if (providerCost != null || resolvedModel) {
              enrichEvent({
                agent: agentKey,
                session: fileKey,
                tsApprox: eventTs,
                resolvedModel,
                providerCost,
                response: responseText,
                thinking: thinkingText,
              });
            }
          }
        }

        // Type B: toolResult — pair with pending toolCall and log
        if (msg.role === "toolResult" && msg.toolCallId) {
          const callId = msg.toolCallId as string;
          const pending = this.pendingCalls.get(callId);
          this.pendingCalls.delete(callId);

          // Truncate params
          const truncatedParams: Record<string, unknown> = {};
          const rawArgs = pending?.args ?? {};
          for (const [k, v] of Object.entries(rawArgs)) {
            const str = typeof v === "string" ? v : JSON.stringify(v);
            truncatedParams[k] = str.length > 500 ? str.slice(0, 500) + "…" : v;
          }

          const details = msg.details as Record<string, unknown> | undefined;
          const durationMs = (details?.durationMs as number) ?? 0;
          const success = !(msg.isError as boolean);
          const toolName = (msg.toolName as string) ?? pending?.name ?? "unknown";
          const eventTs = ts ? new Date(ts).getTime() : Date.now();

          // Extract error text if failed
          let errorText: string | undefined;
          if (!success && Array.isArray(msg.content)) {
            errorText = (msg.content as Array<Record<string, unknown>>)
              .filter((c) => c.type === "text")
              .map((c) => c.text as string)
              .join("\n")
              .slice(0, 200);
          }

          logEvent({
            agent: agentKey,
            session: fileKey,
            type: "tool_call",
            detail: {
              tool: toolName,
              params: truncatedParams,
              success,
              durationMs,
              ...(errorText ? { error: errorText } : {}),
            },
          });
          trackReplayToolCall(agentKey, fileKey);
          inserted++;
        }
      }
      return inserted;
    } finally {
      fs.closeSync(fd);
    }
  }
}
