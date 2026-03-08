import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import { getDb } from "./db-core";
import { getLogger } from "../logger";
import { estimateCost, getBillingMode } from "./billing";
import { extractToolFields } from "./event-logging";
import { setExtractTranscriptMetadata, setEnrichSessionsFromTranscripts } from "./sessions";

// ── Event Backfill from JSONL Transcripts ────────────────────────

/**
 * Backfill events from JSONL transcript files into the events table.
 * Reads all active + archived transcripts and creates llm_output and tool_call events.
 * Idempotent: skips agents that already have events in the DB.
 */
export function backfillEventsFromTranscripts(agentKeyMap: Record<string, string>): number {
  const db = getDb();
  const agentsDir = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");

  let agentIds = Object.keys(agentKeyMap);
  if (agentIds.length === 0) {
    try { agentIds = fs.readdirSync(agentsDir).filter(d => fs.statSync(path.join(agentsDir, d)).isDirectory()); } catch { return 0; }
  }

  // Build session key lookup: sessionId → normalized session key (from sessions table)
  // IMPORTANT: prefer session_key over origin — origin can be a raw JSON session descriptor
  // from the gateway (e.g. {"label":"Guild #jane ...","provider":"discord",...}) which should
  // NOT be used as a session key in the events table.
  const sessionKeyLookup = new Map<string, string>();
  try {
    const rows = db.prepare("SELECT session_id, session_key, origin FROM sessions").all() as Array<{ session_id: string | null; session_key: string; origin: string | null }>;
    for (const row of rows) {
      if (!row.session_id) continue;
      // Use session_key (normalized: "agent:main:discord:channel:...") as the canonical key.
      // Only fall back to origin if it's NOT a JSON blob (legacy format safety).
      const origin = row.origin;
      const useOrigin = origin && !origin.startsWith("{") ? origin : null;
      sessionKeyLookup.set(row.session_id, useOrigin || row.session_key);
    }
  } catch { /* sessions table may not exist yet */ }

  // Build set of session keys that already have events (skip these)
  const sessionsWithEvents = new Set<string>();
  // Track sessions missing specific event types (need targeted backfill)
  // Only do targeted backfill ONCE — check backfill_meta to avoid duplicate inserts
  // caused by session key format mismatches between hooks and poller.
  const sessionsNeedingMsgIn = new Set<string>();
  const sessionsNeedingLlmInput = new Set<string>();

  let msgInBackfillDone = false;
  let llmInputBackfillDone = false;
  try {
    const meta = db.prepare("SELECT key FROM backfill_meta WHERE key IN ('targeted_msg_in', 'targeted_llm_input')").all() as Array<{ key: string }>;
    for (const row of meta) {
      if (row.key === "targeted_msg_in") msgInBackfillDone = true;
      if (row.key === "targeted_llm_input") llmInputBackfillDone = true;
    }
  } catch { /* table may not exist yet */ }

  try {
    const eventSessions = db.prepare("SELECT DISTINCT session FROM events").all() as Array<{ session: string }>;
    for (const row of eventSessions) {
      if (row.session) sessionsWithEvents.add(row.session);
    }
    // Only build targeted backfill sets if the backfill hasn't been marked complete
    if (!msgInBackfillDone || !llmInputBackfillDone) {
      const withMsgIn = msgInBackfillDone ? new Set<string>() :
        new Set((db.prepare("SELECT DISTINCT session FROM events WHERE type = 'msg_in'").all() as Array<{ session: string }>).map(r => r.session));
      const withLlmInput = llmInputBackfillDone ? new Set<string>() :
        new Set((db.prepare("SELECT DISTINCT session FROM events WHERE type = 'llm_input'").all() as Array<{ session: string }>).map(r => r.session));
      for (const sess of sessionsWithEvents) {
        if (!msgInBackfillDone && !withMsgIn.has(sess)) sessionsNeedingMsgIn.add(sess);
        if (!llmInputBackfillDone && !withLlmInput.has(sess)) sessionsNeedingLlmInput.add(sess);
      }
    }
  } catch { /* ignore */ }

  const insertStmt = db.prepare(`
    INSERT INTO events (ts, agent, session, type, model, input_tokens, output_tokens, cache_read, cache_write, cost, detail, run_id, prompt, response, thinking, resolved_model, provider_cost, billing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalEvents = 0;

  const txn = db.transaction(() => {
    for (const agentId of agentIds) {
      const agentKey = agentKeyMap[agentId] || agentId;
      const sessionsDir = path.join(agentsDir, agentId, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;

      let files: string[];
      try { files = fs.readdirSync(sessionsDir); } catch { continue; }

      for (const file of files) {
        // Match active .jsonl files and archived .jsonl.deleted.* / .jsonl.reset.* files
        if (!file.includes(".jsonl")) continue;
        if (file.startsWith("sessions.json")) continue;

        const filePath = path.join(sessionsDir, file);
        let stat: fs.Stats;
        try { stat = fs.statSync(filePath); } catch { continue; }
        if (stat.size === 0) continue;

        // Extract session ID from filename
        const sessionIdMatch = file.match(/^([0-9a-f-]+(?:-topic-[\d.]+)?)\./);
        if (!sessionIdMatch) continue;
        const sessionId = sessionIdMatch[1];

        // Determine session key for events
        const sessionKey = sessionKeyLookup.get(sessionId) || `${agentId}/${sessionId}.jsonl`;

        // Skip if this session already has full events (from live hooks or previous backfill)
        const pollerKey = `${agentId}/${sessionId}.jsonl`;
        const hasEvents = sessionsWithEvents.has(sessionKey) || sessionsWithEvents.has(pollerKey);
        const needsMsgIn = sessionsNeedingMsgIn.has(sessionKey) || sessionsNeedingMsgIn.has(pollerKey);
        const needsLlmInput = sessionsNeedingLlmInput.has(sessionKey) || sessionsNeedingLlmInput.has(pollerKey);
        if (hasEvents && !needsMsgIn && !needsLlmInput) continue;

        // For targeted backfill, use the session key the events are actually stored under
        const effectiveKey = (hasEvents && (needsMsgIn || needsLlmInput))
          ? (sessionsWithEvents.has(pollerKey) ? pollerKey : sessionKey)
          : sessionKey;

        try {
          const events = parseTranscriptEvents(filePath, agentKey, effectiveKey, sessionId, agentId);
          // If session already has events, only insert missing types
          let eventsToInsert = events;
          if (hasEvents) {
            const neededTypes = new Set<string>();
            if (needsMsgIn) neededTypes.add("msg_in");
            if (needsLlmInput) neededTypes.add("llm_input");
            eventsToInsert = events.filter(e => neededTypes.has(e.type));
          }
          for (const evt of eventsToInsert) {
            insertStmt.run(
              evt.ts,
              evt.agent,
              evt.session,
              evt.type,
              evt.model ?? null,
              evt.inputTokens ?? null,
              evt.outputTokens ?? null,
              evt.cacheRead ?? null,
              evt.cacheWrite ?? null,
              evt.cost ?? null,
              evt.detail ? JSON.stringify(evt.detail) : null,
              null, // run_id
              evt.prompt ?? null,
              evt.response ?? null,
              evt.thinking ?? null,
              evt.resolvedModel ?? null,
              evt.providerCost ?? null,
              evt.billing ?? null,
            );
            totalEvents++;
          }
        } catch (err) {
          getLogger().warn(`[deck-sync] event backfill error for ${agentId}/${file}: ${String(err)}`);
        }
      }
    }
  });

  txn();
  getLogger().info(`[deck-sync] event backfill complete: ${totalEvents} events from transcripts`);

  // Mark targeted backfills as complete so they don't re-run on next restart
  try {
    const markDone = db.prepare("INSERT OR REPLACE INTO backfill_meta (key, value, ts) VALUES (?, ?, ?)");
    if (!msgInBackfillDone && sessionsNeedingMsgIn.size > 0) {
      markDone.run("targeted_msg_in", `${sessionsNeedingMsgIn.size} sessions`, Date.now());
    }
    if (!llmInputBackfillDone && sessionsNeedingLlmInput.size > 0) {
      markDone.run("targeted_llm_input", `${sessionsNeedingLlmInput.size} sessions`, Date.now());
    }
    // Also mark done if there were no sessions needing backfill (all caught up)
    if (!msgInBackfillDone && sessionsNeedingMsgIn.size === 0 && sessionsWithEvents.size > 0) {
      markDone.run("targeted_msg_in", "no sessions needed", Date.now());
    }
    if (!llmInputBackfillDone && sessionsNeedingLlmInput.size === 0 && sessionsWithEvents.size > 0) {
      markDone.run("targeted_llm_input", "no sessions needed", Date.now());
    }
  } catch { /* non-critical */ }

  // Enrich sessions missing metadata by reading transcript headers
  const enriched = enrichSessionsFromTranscripts(db, agentsDir, agentIds, agentKeyMap);
  if (enriched > 0) {
    getLogger().info(`[deck-sync] enriched ${enriched} sessions with metadata from transcripts`);
  }

  return totalEvents;
}

/**
 * Enrich sessions that are missing model/channel/displayName by reading
 * transcript file headers. Fills gaps when .bak files don't exist.
 */
export function enrichSessionsFromTranscripts(
  db: Database.Database, agentsDir: string, agentIds: string[], agentKeyMap: Record<string, string>,
): number {
  // Find sessions missing metadata
  const missing = db.prepare(
    "SELECT id, session_id, agent, session_key FROM sessions WHERE (model IS NULL OR model = '') AND session_id IS NOT NULL AND session_id != ''"
  ).all() as Array<{ id: number; session_id: string; agent: string; session_key: string }>;

  if (missing.length === 0) return 0;

  const updateStmt = db.prepare(`
    UPDATE sessions SET
      model = COALESCE(NULLIF(@model, ''), model),
      channel = COALESCE(NULLIF(@channel, ''), channel),
      display_name = COALESCE(NULLIF(@displayName, ''), display_name),
      group_channel = COALESCE(NULLIF(@groupChannel, ''), group_channel),
      label = COALESCE(NULLIF(@label, ''), label),
      origin = COALESCE(NULLIF(@origin, ''), origin),
      total_tokens = CASE WHEN total_tokens = 0 AND @totalTokens > 0 THEN @totalTokens ELSE total_tokens END,
      input_tokens = CASE WHEN input_tokens = 0 AND @inputTokens > 0 THEN @inputTokens ELSE input_tokens END,
      output_tokens = CASE WHEN output_tokens = 0 AND @outputTokens > 0 THEN @outputTokens ELSE output_tokens END
    WHERE id = @id
  `);

  // Build sessionId → agentId map
  const sessionAgentMap = new Map<string, string>();
  for (const row of missing) {
    // agent key → agentId
    for (const [agentId, agentKey] of Object.entries(agentKeyMap)) {
      if (agentKey === row.agent) {
        sessionAgentMap.set(row.session_id, agentId);
        break;
      }
    }
  }

  let enriched = 0;
  const txn = db.transaction(() => {
    for (const row of missing) {
      const agentId = sessionAgentMap.get(row.session_id);
      if (!agentId) continue;

      const sessionsDir = path.join(agentsDir, agentId, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;

      // Find the transcript file (active or archived)
      let transcriptPath: string | null = null;
      try {
        const files = fs.readdirSync(sessionsDir);
        for (const f of files) {
          if (f.startsWith(row.session_id) && f.includes(".jsonl")) {
            transcriptPath = path.join(sessionsDir, f);
            break;
          }
        }
      } catch { continue; }

      if (!transcriptPath) continue;

      const meta = extractTranscriptMetadata(transcriptPath);
      if (!meta.model && !meta.channel && !meta.groupChannel && !meta.channelId) continue;

      // Build origin from channel context if available
      let origin: string | undefined;
      if (meta.channelId) {
        origin = `agent:${agentId}:discord:channel:${meta.channelId}`;
      } else if (meta.channel === "cron" || meta.channel === "main") {
        origin = `agent:${agentId}:${meta.channel}`;
      }

      updateStmt.run({
        id: row.id,
        model: meta.model || "",
        channel: meta.channel || "",
        displayName: meta.displayName || "",
        groupChannel: meta.groupChannel || "",
        label: meta.label || "",
        origin: origin || "",
        totalTokens: meta.totalTokens,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
      });
      enriched++;
    }
  });

  txn();
  return enriched;
}

export interface TranscriptMeta {
  model?: string;
  channel?: string;
  channelId?: string;
  groupChannel?: string;
  displayName?: string;
  label?: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export function extractTranscriptMetadata(filePath: string): TranscriptMeta {
  const meta: TranscriptMeta = { totalTokens: 0, inputTokens: 0, outputTokens: 0 };

  let fd: number;
  try { fd = fs.openSync(filePath, "r"); } catch { return meta; }

  try {
    // Read first 64KB — enough for session header + first few messages
    const buf = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const content = buf.toString("utf-8");
    const lastNewline = content.lastIndexOf("\n");
    const lines = (lastNewline > 0 ? content.slice(0, lastNewline) : content).split("\n").filter(Boolean);

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }

      // Extract model from model-snapshot custom entries
      if (entry.type === "custom" && entry.customType === "model-snapshot" && !meta.model) {
        const data = entry.data as Record<string, unknown> | undefined;
        const modelId = data?.modelId as string | undefined;
        if (modelId && modelId !== "delivery-mirror") {
          meta.model = modelId;
        }
      }

      if (entry.type !== "message") continue;
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg) continue;

      // Extract model from assistant messages (skip delivery-mirror)
      if (msg.role === "assistant" && !meta.model) {
        const model = msg.model as string | undefined;
        if (model && model !== "delivery-mirror") {
          meta.model = model;
        }
      }

      // Extract channel info from first user message with conversation context
      if (msg.role === "user" && !meta.channel && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type !== "text") continue;
          const text = block.text as string;
          if (!text.includes("conversation_label")) continue;
          try {
            const jsonStart = text.indexOf("{");
            const jsonEnd = text.lastIndexOf("}");
            if (jsonStart < 0 || jsonEnd < 0) continue;
            const convMeta = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<string, string>;
            if (convMeta.group_channel) meta.groupChannel = convMeta.group_channel;
            if (convMeta.conversation_label) meta.displayName = convMeta.conversation_label;
            // Extract channel ID from conversation_label: "Guild #tasks channel id:1000000000000000001"
            const channelIdMatch = convMeta.conversation_label?.match(/channel id:(\d+)/);
            if (channelIdMatch) {
              meta.channelId = channelIdMatch[1];
              meta.channel = "discord";
            }
          } catch { /* parse error — skip */ }
          break;
        }
      }

      // Stop early once we have both model and channel
      if (meta.model && meta.channel) break;
    }

    // If no channel found from conversation context, check if it looks like a cron/main session
    if (!meta.channel) {
      // Re-scan for clues
      for (const line of lines.slice(0, 5)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "session" && entry.cwd) {
            // Main sessions typically have cwd set
            meta.channel = "main";
          }
        } catch { /* skip */ }
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  // Now scan full file for total tokens (read in chunks to avoid OOM on large files)
  try {
    const stat = fs.statSync(filePath);
    const chunkSize = 256 * 1024;
    const readFd = fs.openSync(filePath, "r");
    let offset = 0;
    let remainder = "";

    try {
      while (offset < stat.size) {
        const readSize = Math.min(chunkSize, stat.size - offset);
        const chunk = Buffer.alloc(readSize);
        fs.readSync(readFd, chunk, 0, readSize, offset);
        const text = remainder + chunk.toString("utf-8");
        const lastNl = text.lastIndexOf("\n");
        if (lastNl < 0) { offset += readSize; continue; }
        remainder = text.slice(lastNl + 1);
        const completeLines = text.slice(0, lastNl).split("\n");

        for (const line of completeLines) {
          if (!line.includes('"usage"')) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type !== "message") continue;
            const msg = entry.message;
            if (msg?.role !== "assistant" || !msg?.usage) continue;
            const usage = msg.usage;
            meta.totalTokens += (usage.totalTokens as number) ?? 0;
            meta.inputTokens += (usage.input as number) ?? 0;
            meta.outputTokens += (usage.output as number) ?? 0;
          } catch { /* skip */ }
        }
        offset += readSize;
      }
    } finally {
      fs.closeSync(readFd);
    }
  } catch { /* non-fatal */ }

  return meta;
}

interface BackfillEvent {
  ts: number;
  agent: string;
  session: string;
  type: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  detail?: Record<string, unknown>;
  prompt?: string;
  response?: string;
  thinking?: string;
  resolvedModel?: string;
  providerCost?: number;
  billing?: string;
}

function parseTranscriptEvents(
  filePath: string, agentKey: string, sessionKey: string, _sessionId: string, _agentId: string,
): BackfillEvent[] {
  const events: BackfillEvent[] = [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  // Track pending tool calls for pairing with results
  const pendingCalls = new Map<string, { name: string; args: Record<string, unknown>; ts: number }>();
  // Track last user message for prompt context
  let lastUserPrompt: string | undefined;
  // Track provider from model-snapshot entries (most recent wins)
  let sessionProvider: string | undefined;
  // Track context for synthetic llm_input events
  let messageCount = 0;
  let hasCompaction = false;
  let hasToolUse = false;
  let systemPromptLen = 0;
  let imagesCount = 0;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }

    // Extract provider from model-snapshot custom entries
    if (entry.type === "custom" && entry.customType === "model-snapshot") {
      const data = entry.data as Record<string, unknown> | undefined;
      const provider = data?.provider as string | undefined;
      if (provider) sessionProvider = provider;
      continue;
    }

    // Track compaction events for llm_input flags
    if (entry.type === "compaction") {
      hasCompaction = true;
      // Compaction resets history — new summary replaces old messages
      messageCount = 1; // the compaction summary itself
      continue;
    }

    if (entry.type !== "message") continue;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const ts = entry.timestamp as string | undefined;
    const eventTs = ts ? new Date(ts).getTime() : 0;
    if (!eventTs) continue;

    messageCount++;

    // Track system prompt length from first system message
    if (msg.role === "system" && !systemPromptLen) {
      const sysContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      systemPromptLen = sysContent.length;
    }

    // Track tool use in history
    if (msg.role === "toolResult") hasToolUse = true;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.type === "toolCall" || b.type === "tool_use") hasToolUse = true;
        if (b.type === "image") imagesCount++;
      }
    }

    // Track user messages for prompt context + emit msg_in events
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const textParts = (msg.content as Array<Record<string, unknown>>)
        .filter(c => c.type === "text")
        .map(c => c.text as string);
      if (textParts.length > 0) {
        lastUserPrompt = textParts.join("\n");
        // Truncate to 10KB
        if (lastUserPrompt.length > 10240) lastUserPrompt = lastUserPrompt.slice(0, 10240) + "\u2026";

        // Emit msg_in event — store content in both prompt (full) and detail.content (truncated)
        // so the replay timeline can show a preview without on-demand loading
        events.push({
          ts: eventTs,
          agent: agentKey,
          session: sessionKey,
          type: "msg_in",
          prompt: lastUserPrompt,
          detail: { source: "backfill", content: lastUserPrompt.slice(0, 500) },
        });
      }
    }

    // Assistant messages with usage = llm_output events
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const contentBlocks = msg.content as Array<Record<string, unknown>>;

      // Collect tool calls for pairing
      for (const block of contentBlocks) {
        if (block.type === "toolCall" && block.id) {
          pendingCalls.set(block.id as string, {
            name: (block.name as string) ?? "unknown",
            args: (block.arguments as Record<string, unknown>) ?? {},
            ts: eventTs,
          });
        }
      }

      // Process usage data
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage && (usage.totalTokens as number) > 0) {
        const costObj = usage.cost as Record<string, number> | undefined;
        const rawModel = (msg.model as string) || undefined;

        // Build full provider/model name — transcripts store bare model names
        let model: string | undefined;
        let resolvedModel = rawModel;
        if (rawModel) {
          if (rawModel.includes("/")) {
            model = rawModel; // already has provider prefix
          } else if (sessionProvider) {
            model = `${sessionProvider}/${rawModel}`;
          } else {
            model = rawModel;
          }
        }

        // Determine billing mode from provider
        let billing: string | undefined;
        if (model) {
          const providerSlash = model.indexOf("/");
          if (providerSlash > 0) {
            const provider = model.slice(0, providerSlash);
            billing = getBillingMode(provider) ?? "metered";
          }
        }

        // Extract text and thinking
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        for (const block of contentBlocks) {
          if (block.type === "text" && block.text) textParts.push(block.text as string);
          else if (block.type === "thinking" && block.thinking) thinkingParts.push(block.thinking as string);
        }

        const inputTokens = (usage.input as number) ?? 0;
        const outputTokens = (usage.output as number) ?? 0;
        const cacheRead = (usage.cacheRead as number) ?? 0;
        const cacheWrite = (usage.cacheWrite as number) ?? 0;

        // Use provider cost from transcript if available, otherwise estimate
        // Subscription = $0 actual cost (flat rate plan, not per-token)
        const rawProviderCost = costObj?.total ?? undefined;
        const providerCost = billing === "subscription" ? 0 : rawProviderCost;
        const estimatedCost = billing === "subscription"
          ? 0
          : (providerCost ?? (model ? estimateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite) : 0));

        // Emit synthetic llm_input event (paired with the llm_output below)
        events.push({
          ts: eventTs - 1, // 1ms before the output
          agent: agentKey,
          session: sessionKey,
          type: "llm_input",
          model,
          billing,
          detail: {
            historyCount: messageCount,
            systemPromptLen,
            promptPreview: lastUserPrompt?.slice(0, 2000),
            imagesCount,
            hasCompaction: hasCompaction || undefined,
            hasToolUse: hasToolUse || undefined,
            source: "backfill",
          },
        });

        events.push({
          ts: eventTs,
          agent: agentKey,
          session: sessionKey,
          type: "llm_output",
          model,
          inputTokens,
          outputTokens,
          cacheRead,
          cacheWrite,
          cost: estimatedCost,
          prompt: lastUserPrompt,
          response: textParts.join("\n") || undefined,
          thinking: thinkingParts.join("\n") || undefined,
          resolvedModel,
          providerCost,
          billing,
        });

        // Reset per-call flags (compaction/toolUse persist until next compaction resets them,
        // but hasCompaction should only flag the first call after compaction)
        hasCompaction = false;
        lastUserPrompt = undefined; // consumed
      }
    }

    // Tool results
    if (msg.role === "toolResult" && msg.toolCallId) {
      const callId = msg.toolCallId as string;
      const pending = pendingCalls.get(callId);
      pendingCalls.delete(callId);

      const toolName = (msg.toolName as string) ?? pending?.name ?? "unknown";
      const details = msg.details as Record<string, unknown> | undefined;
      const durationMs = (details?.durationMs as number) ?? 0;
      const success = !(msg.isError as boolean);

      // Truncate params
      const truncatedParams: Record<string, unknown> = {};
      const rawArgs = pending?.args ?? {};
      for (const [k, v] of Object.entries(rawArgs)) {
        const str = typeof v === "string" ? v : JSON.stringify(v);
        truncatedParams[k] = str.length > 500 ? str.slice(0, 500) + "\u2026" : v;
      }

      let errorText: string | undefined;
      if (!success && Array.isArray(msg.content)) {
        errorText = (msg.content as Array<Record<string, unknown>>)
          .filter(c => c.type === "text")
          .map(c => c.text as string)
          .join("\n")
          .slice(0, 200);
      }

      events.push({
        ts: eventTs,
        agent: agentKey,
        session: sessionKey,
        type: "tool_call",
        detail: {
          tool: toolName,
          params: truncatedParams,
          success,
          durationMs,
          ...(errorText ? { error: errorText } : {}),
        },
      });
    }
  }

  return events;
}

// ── Startup Backfill: Tool Metadata ──────────────────────────────────

/**
 * Extract tool_name/tool_query/tool_target from event detail JSON for tool_call
 * events that are missing this metadata. Runs on startup to fill gaps from
 * events inserted before tool extraction was added.
 */
export function backfillToolMetadata(): number {
  const db = getDb();
  const total = (db.prepare(
    "SELECT COUNT(*) as cnt FROM events WHERE type = 'tool_call' AND tool_name IS NULL AND detail IS NOT NULL"
  ).get() as { cnt: number }).cnt;
  if (total === 0) return 0;

  const selectBatch = db.prepare(
    "SELECT id, detail FROM events WHERE type = 'tool_call' AND tool_name IS NULL AND detail IS NOT NULL ORDER BY id ASC LIMIT 1000"
  );
  const updateStmt = db.prepare(
    "UPDATE events SET tool_name = ?, tool_query = ?, tool_target = ? WHERE id = ?"
  );

  let updated = 0;
  while (true) {
    const rows = selectBatch.all() as Array<{ id: number; detail: string }>;
    if (rows.length === 0) break;
    const tx = db.transaction(() => {
      for (const row of rows) {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(row.detail); } catch { continue; }
        const { toolName, toolQuery, toolTarget } = extractToolFields(parsed);
        if (!toolName) continue;
        updateStmt.run(toolName, toolQuery, toolTarget, row.id);
        updated++;
      }
    });
    tx();
  }
  return updated;
}

// ── Startup Backfill: Missing Costs ──────────────────────────────────

/**
 * Calculate provider_cost from token counts for llm_output events that are
 * missing cost data. Uses the same pricing table as estimateCost().
 */
export function backfillMissingCosts(): number {
  const db = getDb();
  const total = (db.prepare(`
    SELECT COUNT(*) as cnt FROM events
    WHERE type = 'llm_output'
      AND provider_cost IS NULL
      AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
      AND COALESCE(resolved_model, model) IS NOT NULL
  `).get() as { cnt: number }).cnt;
  if (total === 0) return 0;

  const selectBatch = db.prepare(`
    SELECT id, COALESCE(resolved_model, model) as model,
      COALESCE(input_tokens, 0) as input_tokens,
      COALESCE(output_tokens, 0) as output_tokens,
      COALESCE(cache_read, 0) as cache_read,
      COALESCE(cache_write, 0) as cache_write
    FROM events
    WHERE type = 'llm_output'
      AND provider_cost IS NULL
      AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
      AND COALESCE(resolved_model, model) IS NOT NULL
      AND id > ?
    ORDER BY id ASC LIMIT 1000
  `);
  const updateEvtStmt = db.prepare("UPDATE events SET provider_cost = ?, cost = COALESCE(cost, ?) WHERE id = ?");

  let updated = 0;
  let lastId = 0;
  while (true) {
    const rows = selectBatch.all(lastId) as Array<{
      id: number; model: string;
      input_tokens: number; output_tokens: number;
      cache_read: number; cache_write: number;
    }>;
    if (rows.length === 0) break;
    const tx = db.transaction(() => {
      for (const row of rows) {
        const est = estimateCost(row.model, row.input_tokens, row.output_tokens, row.cache_read, row.cache_write);
        if (est > 0 && est <= 100) {
          updateEvtStmt.run(est, est, row.id);
          updated++;
        }
        if (row.id > lastId) lastId = row.id;
      }
    });
    tx();
  }
  return updated;
}

// ── Register setters for sessions.ts (avoids circular dependency) ──
// Called at module load time so sessions.ts can use these functions.
setExtractTranscriptMetadata(extractTranscriptMetadata);
setEnrichSessionsFromTranscripts(enrichSessionsFromTranscripts);
