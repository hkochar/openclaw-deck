"use client";

import { useState, useEffect, useMemo, useCallback, useRef, startTransition, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useAgentConfig } from "@/lib/use-agent-config";
import { useHashTab } from "@/components/use-hash-tab";
import { useUrlState } from "@/components/use-url-state";

type Tab = "openclaw" | "system";

const API_BASE = "/api/logs";

const EVENT_TYPES = ["", "llm_output", "llm_input", "tool_call", "msg_in"];
const TYPE_LABELS: Record<string, string> = {
  "": "All Types",
  llm_output: "LLM Response",
  llm_input: "LLM Input",
  tool_call: "Tool Call",
  msg_in: "Message In",
  cron_error: "Cron Error",
  cron_recovery: "Cron Recovery",
  model_drift: "Model Drift",
  provider_limit_exceeded: "Provider Limit",
  provider_limit_warning: "Provider Warning",
  loop_detected: "Stuck Loop",
  agent_silence: "Agent Silent",
  agent_paused: "Agent Paused",
  agent_resumed: "Agent Resumed",
};
const TYPE_COLORS: Record<string, string> = {
  llm_output: "#2563eb",
  llm_input: "#7c3aed",
  tool_call: "#d97706",
  msg_in: "#059669",
  cron_error: "#ef4444",
  cron_recovery: "#22c55e",
  model_drift: "#f97316",
  provider_limit_exceeded: "#ef4444",
  provider_limit_warning: "#eab308",
  loop_detected: "#ef4444",
  agent_silence: "#eab308",
  agent_paused: "#ef4444",
  agent_resumed: "#22c55e",
};

function modelColor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "#7c3aed";
  if (m.includes("sonnet")) return "#2563eb";
  if (m.includes("haiku")) return "#059669";
  if (m.includes("codex")) return "#dc2626";
  if (m.includes("free") || m.includes("auto")) return "#d97706";
  if (m.includes("kimi") || m.includes("nemotron")) return "#ea580c";
  return "#6b7280";
}

// ── Sub-type filter config ───────────────────────────────────────────────────
const READ_TOOLS = ["read", "sessions_list", "session_status", "web_search", "image", "gateway"];
const WRITE_TOOLS = ["exec", "edit", "write", "sessions_send", "message", "process"];
const SUB_FILTERS: Record<string, Array<{ key: string; label: string }>> = {
  llm_output: [
    { key: "thinking", label: "Has Thinking" },
    { key: "cached", label: "Cached" },
    { key: "no-cache", label: "No Cache" },
    { key: "sub-billing", label: "Subscription" },
    { key: "metered-billing", label: "Metered" },
  ],
  llm_input: [
    { key: "has-compaction", label: "Compaction" },
    { key: "has-tool-use", label: "Has Tool Use" },
    { key: "has-images", label: "Has Images" },
    { key: "large-context", label: "Large Context" },
  ],
  tool_call: [
    { key: "tool-read", label: "Read" },
    { key: "tool-write", label: "Write" },
    { key: "tool-failed", label: "Failed" },
    { key: "tool-cron", label: "Cron" },
    { key: "tool:exec", label: "exec" },
    { key: "tool:read", label: "read" },
    { key: "tool:sessions_list", label: "sessions_list" },
    { key: "tool:edit", label: "edit" },
    { key: "tool:message", label: "message" },
  ],
  msg_in: [
    { key: "msg-discord", label: "Discord" },
    { key: "msg-hook", label: "Hook" },
  ],
};

const SESSION_KINDS = ["cron", "discord", "main", "hook", "jsonl"];
const SESSION_KIND_LABELS: Record<string, string> = {
  cron: "Heartbeat",
  discord: "Discord",
  main: "Main",
  hook: "Hook",
  jsonl: "Tool Calls",
};
// Static channel name lookup for module-level helpers
import agentsJson from "@/config/deck-agents.json";
const CHANNEL_NAMES_STATIC: Record<string, string> = Object.fromEntries([
  ...agentsJson.agents.map((a) => [a.discordChannelId, `#${a.key}`]),
  ...Object.entries(agentsJson.systemChannels).map(([name, id]) => [id, `#${name.replace(/([A-Z])/g, "-$1").toLowerCase()}`]),
  ...Object.entries(agentsJson.pluginChannels).map(([name, id]) => [id, `#${name}`]),
  ...Object.entries(agentsJson.logChannels).map(([name, id]) => [id, `#${name}`]),
]);

const SESSION_KIND_COLORS: Record<string, string> = {
  cron: "#78350f",
  discord: "#1e3a5f",
  main: "#365314",
  hook: "#4a1d6e",
  jsonl: "#374151",
};

const DATE_RANGES = [
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "Today", ms: 24 * 60 * 60 * 1000 },
  { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "14d", ms: 14 * 24 * 60 * 60 * 1000 },
  { label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "90d", ms: 90 * 24 * 60 * 60 * 1000 },
  { label: "All", ms: 365 * 24 * 60 * 60 * 1000 },
];

interface LogEvent {
  id: number;
  ts: number;
  agent: string;
  session: string | null;
  type: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost: number | null;
  detail: string | null;
  run_id: string | null;
  // v2 columns (full text loaded on-demand via event-detail endpoint)
  prompt: string | null;
  response: string | null;
  thinking: string | null;
  has_thinking: number | null;
  has_prompt: number | null;
  has_response: number | null;
  resolved_model: string | null;
  provider_cost: number | null;
  billing: string | null;
}

interface MemoryTimelineEvent {
  id: number;
  ts: number;
  agent: string;
  session: string;
  op: string;
  file_path: string;
  params: string;
  trigger: string | null;
}

interface MemorySessionGroup {
  session: string;
  agent: string;
  trigger: string | null;
  events: MemoryTimelineEvent[];
  startTs: number;
}

interface ModelBreakdown {
  input: number;
  output: number;
  cache: number;
}

interface SummaryRow {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  totalTokens: number;
  cost: number;
  equivCost?: number;
  calls: number;
  models: Record<string, ModelBreakdown>;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortModel(model: string): string {
  if (!model) return "—";
  const parts = model.split("/");
  const last = parts[parts.length - 1];
  if (last.includes("opus")) return "opus";
  if (last.includes("sonnet")) return "sonnet";
  if (last.includes("haiku")) return "haiku";
  if (last.includes("nemotron")) return "nemotron";
  if (last.includes("auto")) return "auto";
  return last.length > 15 ? last.slice(0, 15) + "…" : last;
}

function parseDetail(detail: string | null): Record<string, unknown> {
  if (!detail) return {};
  try { return JSON.parse(detail); } catch { return {}; }
}

function sessionKind(session: string | null): string {
  if (!session) return "";
  if (session.includes(":cron:")) return "cron";
  if (session.includes(":discord:")) return "discord";
  if (session.includes(":hook:")) return "hook";
  if (session.endsWith(":main")) return "main";
  if (session.includes(".jsonl")) return "jsonl";
  return "";
}

function shortSession(session: string | null): string {
  if (!session) return "";
  // Handle JSON session objects (some gateway contexts return serialized JSON)
  if (session.startsWith("{")) {
    try {
      const obj = JSON.parse(session);
      // Extract channel name or label
      if (obj.from?.includes("channel:")) {
        const chanId = obj.from.split("channel:")[1];
        return CHANNEL_NAMES_STATIC[chanId] || "#" + chanId.slice(-6);
      }
      if (obj.label) return obj.label.length > 20 ? obj.label.slice(0, 20) + "…" : obj.label;
      return "session";
    } catch { /* not valid JSON, fall through */ }
  }
  // agent:main:cron:40127939-... → cron:40127939
  if (session.includes(":cron:")) {
    const cronId = session.split(":cron:")[1] || "";
    // Show name if present after uuid prefix, else first 8 chars
    const dashIdx = cronId.indexOf("-", 9);
    if (dashIdx > 0 && dashIdx < cronId.length - 1) {
      return "cron:" + cronId.slice(dashIdx + 1);
    }
    return "cron:" + cronId.slice(0, 8);
  }
  // agent:main:discord:channel:1472... → discord:#agent-name or discord:#1472
  if (session.includes(":discord:channel:")) {
    const chanId = session.split(":channel:")[1] || "";
    return CHANNEL_NAMES_STATIC[chanId] || "discord:#" + chanId.slice(-4);
  }
  // agent:main:main → main session
  if (session.endsWith(":main")) return "main";
  // main/9de7d054-....jsonl → jsonl:9de7
  if (session.includes(".jsonl")) {
    const file = session.split("/").pop() || "";
    return "ses:" + file.slice(0, 8);
  }
  // channel:1472... → #agent-name or ch:#1472
  if (session.startsWith("channel:")) {
    const chanId = session.split(":")[1] || "";
    return CHANNEL_NAMES_STATIC[chanId] || "ch:#" + chanId.slice(-4);
  }
  return session.length > 16 ? session.slice(0, 16) + "…" : session;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchSubFilter(e: any, sf: string): boolean {
  const d: Record<string, unknown> = e.detail ? JSON.parse(e.detail) : {};
  switch (sf) {
    case "thinking": return !!e.has_thinking;
    case "cached": return !!(e.cache_read && e.cache_read > 0);
    case "no-cache": return !e.cache_read || e.cache_read === 0;
    case "sub-billing": return e.billing === "subscription";
    case "metered-billing": return e.billing === "metered";
    case "has-compaction": return !!d.hasCompaction;
    case "has-tool-use": return !!d.hasToolUse;
    case "has-images": return !!(d.imagesCount && (d.imagesCount as number) > 0);
    case "large-context": return !!(d.systemPromptLen && (d.systemPromptLen as number) >= 10000);
    case "tool-read": return READ_TOOLS.includes(d.tool as string);
    case "tool-write": return WRITE_TOOLS.includes(d.tool as string);
    case "tool-failed": return d.success === 0 || d.success === false;
    case "tool-cron": return d.tool === "cron";
    case "msg-discord": return !!e.session?.includes("discord");
    case "msg-hook": return !!e.session?.includes("hook");
    default:
      if (sf.startsWith("tool:")) return d.tool === sf.slice(5);
      return true;
  }
}

function toggleSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// ── System Log Tab ──────────────────────────────────────────────────────────

const SYSTEM_CATEGORIES = ["cron", "config", "model", "gateway", "git", "auto-recovery", "budget", "ops-bot"];
const CATEGORY_LABELS: Record<string, string> = {
  cron: "Cron", config: "Config", model: "Model", gateway: "Gateway", git: "Git",
  "auto-recovery": "Auto-Recovery", budget: "Budget", "ops-bot": "Ops Bot",
};
const CATEGORY_COLORS: Record<string, string> = {
  cron: "#78350f", config: "#1e3a5f", model: "#7c3aed", gateway: "#059669", git: "#d97706",
  "auto-recovery": "#6366f1", budget: "#dc2626", "ops-bot": "#0ea5e9",
};
const STATUS_COLORS: Record<string, string> = {
  ok: "#059669", error: "#dc2626", rollback: "#d97706", warning: "#f59e0b",
};

interface SystemEvent {
  id: number;
  ts: number;
  category: string;
  action: string;
  summary: string;
  detail: string | null;
  status: string;
}

function SystemLogTab() {
  const [events, setEvents] = useState<SystemEvent[] | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // System tab filters synced to URL with sys. prefix
  const [sysFilters, setSysFilter] = useUrlState({
    "sys.cat":    { type: "set" as const, default: new Set<string>() },
    "sys.status": { type: "string" as const, default: "" },
    "sys.date":   { type: "number" as const, default: 2 },
    "sys.q":      { type: "string" as const, default: "" },
  });
  const catFilters = sysFilters["sys.cat"];
  const setCatFilters = useCallback((v: Set<string>) => setSysFilter("sys.cat", v), [setSysFilter]);
  const statusFilter = sysFilters["sys.status"];
  const setStatusFilter = useCallback((v: string) => setSysFilter("sys.status", v), [setSysFilter]);
  const dateIdx = sysFilters["sys.date"];
  const setDateIdx = useCallback((v: number) => setSysFilter("sys.date", v), [setSysFilter]);
  const searchQ = sysFilters["sys.q"];
  const setSearchQ = useCallback((v: string) => setSysFilter("sys.q", v), [setSysFilter]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const since = useMemo(() => Date.now() - DATE_RANGES[dateIdx].ms, [dateIdx]);

  const sysAbortRef = useRef<AbortController | null>(null);

  const fetchEvents = useCallback(async () => {
    sysAbortRef.current?.abort();
    const ac = new AbortController();
    sysAbortRef.current = ac;
    try {
      const params = new URLSearchParams();
      params.set("since", String(since));
      params.set("limit", "300");
      if (catFilters.size > 0) {
        params.set("categories", Array.from(catFilters).join(","));
      }
      const res = await fetch(`/api/system-log?${params}`, { signal: ac.signal });
      if (ac.signal.aborted) return;
      if (res.ok) {
        const data = await res.json();
        if (ac.signal.aborted) return;
        startTransition(() => {
          setEvents(data.events ?? []);
        });
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }, [since, catFilters]);

  useEffect(() => {
    fetchEvents();
    const interval = setInterval(fetchEvents, 30_000);
    return () => {
      clearInterval(interval);
      sysAbortRef.current?.abort();
    };
  }, [fetchEvents]);

  const filtered = useMemo(() => {
    if (!events) return null;
    let list = events;
    if (statusFilter) {
      list = list.filter((e) => e.status === statusFilter);
    }
    if (searchQ) {
      const q = searchQ.toLowerCase();
      list = list.filter((e) => e.summary.toLowerCase().includes(q) || e.action.toLowerCase().includes(q));
    }
    return list;
  }, [events, statusFilter, searchQ]);

  return (
    <div className="syslog-tab">
      {/* Filters */}
      <div className="logs-filters">
        <div className="logs-filter-group">
          <span className="logs-filter-label">Category</span>
          <div className="logs-chips">
            {SYSTEM_CATEGORIES.map((c) => (
              <button
                key={c}
                className={`logs-chip${catFilters.has(c) ? " active" : ""}`}
                style={catFilters.has(c) ? { background: CATEGORY_COLORS[c], borderColor: CATEGORY_COLORS[c], color: "#fff" } : {}}
                onClick={() => setCatFilters(toggleSet(catFilters, c))}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
            {catFilters.size > 0 && (
              <button className="logs-chip logs-chip-clear" onClick={() => setCatFilters(new Set())}>Clear</button>
            )}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Status</span>
          <div className="logs-chips">
            {["", "ok", "error", "rollback"].map((s) => (
              <button
                key={s || "all"}
                className={`logs-chip${statusFilter === s ? " active" : ""}`}
                style={statusFilter === s && s ? { background: STATUS_COLORS[s], borderColor: STATUS_COLORS[s], color: "#fff" } : {}}
                onClick={() => setStatusFilter(s)}
              >
                {s || "All"}
              </button>
            ))}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Range</span>
          <div className="logs-chips">
            {DATE_RANGES.map((d, i) => (
              <button key={d.label} className={`logs-chip${dateIdx === i ? " active" : ""}`} onClick={() => setDateIdx(i)}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
        {searchQ && (
          <div className="logs-filter-group">
            <span className="logs-filter-label">Search</span>
            <div className="logs-chips" style={{ gap: 4 }}>
              <span className="logs-chip active" style={{ background: "#555", borderColor: "#555", color: "#fff" }}>
                {searchQ}
                <button
                  onClick={() => setSearchQ("")}
                  style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", marginLeft: 4, padding: 0, fontSize: 12, lineHeight: 1 }}
                >
                  ✕
                </button>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Event list */}
      {filtered === null ? (
        <div className="loading">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="logs-empty">No system events found for this period.</div>
      ) : (
        <div className="syslog-stream">
          {filtered.map((e) => {
            const isExpanded = expandedId === e.id;
            let detail: Record<string, unknown> | null = null;
            if (isExpanded && e.detail) {
              try { detail = JSON.parse(e.detail); } catch { detail = null; }
            }
            return (
              <div
                key={e.id}
                className={`syslog-event${isExpanded ? " expanded" : ""}`}
                onClick={() => setExpandedId(isExpanded ? null : e.id)}
              >
                <div className="syslog-header">
                  <span className="syslog-time">{timeAgo(e.ts)}</span>
                  <span className="syslog-cat" style={{ background: CATEGORY_COLORS[e.category] || "#666" }}>
                    {CATEGORY_LABELS[e.category] || e.category}
                  </span>
                  <span className="syslog-action">{e.action}</span>
                  <span className="syslog-summary">{e.summary}</span>
                  <span className="syslog-status" style={{ color: STATUS_COLORS[e.status] || "#999" }}>
                    {e.status}
                  </span>
                </div>
                {isExpanded && detail && (
                  <div className="syslog-detail">
                    <div className="syslog-ts-full">{new Date(e.ts).toLocaleString()}</div>
                    {Object.entries(detail).map(([k, v]) => (
                      <div key={k} className="syslog-detail-row">
                        <span className="syslog-detail-key">{k}</span>
                        <span className="syslog-detail-val">
                          {typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Prompt Message Viewer (chat-style view of LLM Input messages) ───────────

interface PromptContent {
  system?: string;
  history?: Array<{ role: string; content: Array<{ type: string; text?: string; thinking?: string; name?: string; input?: unknown; arguments?: unknown; content?: unknown; toolName?: string }>; timestamp?: number }>;
  prompt?: string;
}

/** Format a message timestamp with relative age context (e.g. "09:21 PM today", "09:21 PM yesterday", "09:21 PM · 3d ago") */
function formatMsgAge(ts: number | string): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0 && d.getDate() === now.getDate()) return time;
  // Yesterday: either same calendar day-1, or crossed midnight (diffDays=0 but different date, or diffDays=1)
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth()) return `${time} yesterday`;
  if (diffDays < 7) return `${time} · ${diffDays}d ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}

function PromptMessageViewer({ raw }: { raw: string }) {
  const viewerRef = useRef<HTMLDivElement>(null);


  let parsed: PromptContent | null = null;
  try { parsed = JSON.parse(raw); } catch { /* not JSON, fall back to raw */ }

  if (!parsed || !parsed.history) {
    return <pre className="logs-se-pre">{raw.length > 50000 ? raw.slice(0, 50000) + "\n…(truncated)" : raw}</pre>;
  }

  const { system, history, prompt } = parsed;

  const ROLE_DISPLAY: Record<string, string> = {
    user: "USER", assistant: "ASSISTANT", system: "SYSTEM",
    toolResult: "TOOL RESULT", compactionSummary: "SUMMARY",
  };

  function toggleAll(open: boolean) {
    if (!viewerRef.current) return;
    viewerRef.current.querySelectorAll("details").forEach((d) => { d.open = open; });
    setAllOpen(open);
  }

  function renderContent(blocks: PromptContent["history"] extends Array<infer T> ? T extends { content: infer C } ? C : never : never, role?: string) {
    if (!Array.isArray(blocks)) return <span>{String(blocks)}</span>;
    return blocks.map((b, i) => {
      if (b.type === "text" && b.text) {
        // Large text blocks in tool results — make collapsible
        if (b.text.length > 500 && (role === "toolResult" || role === "compactionSummary")) {
          return (
            <details key={i} className="logs-msg-tool-result" onClick={(ev) => ev.stopPropagation()}>
              <summary>{b.text.slice(0, 80)}… ({b.text.length.toLocaleString()} chars)</summary>
              <pre className="logs-se-pre">{b.text.slice(0, 10000)}</pre>
            </details>
          );
        }
        return <div key={i} className="logs-msg-text">{b.text}</div>;
      }
      if (b.type === "thinking" && b.thinking) {
        return (
          <details key={i} className="logs-msg-thinking" onClick={(ev) => ev.stopPropagation()}>
            <summary>Thinking ({b.thinking.length.toLocaleString()} chars)</summary>
            <pre className="logs-se-pre logs-se-thinking">{b.thinking.slice(0, 10000)}</pre>
          </details>
        );
      }
      if (b.type === "tool_use" || b.type === "toolCall") {
        const name = b.name ?? b.toolName ?? "unknown";
        const args = b.input ?? b.arguments;
        const argsStr = args ? JSON.stringify(args) : "";
        return (
          <details key={i} className="logs-msg-tool" onClick={(ev) => ev.stopPropagation()}>
            <summary><span className="logs-msg-tool-badge">tool</span> {name}{argsStr ? ` (${argsStr.length.toLocaleString()} chars)` : ""}</summary>
            {argsStr && <pre className="logs-se-pre">{argsStr.slice(0, 5000)}</pre>}
          </details>
        );
      }
      if (b.type === "tool_result" || b.type === "toolResult") {
        const text = Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("") : String(b.content ?? b.text ?? "");
        return (
          <details key={i} className="logs-msg-tool-result" onClick={(ev) => ev.stopPropagation()}>
            <summary><span className="logs-msg-tool-badge">result</span> ({text.length.toLocaleString()} chars)</summary>
            <pre className="logs-se-pre">{text.slice(0, 5000)}</pre>
          </details>
        );
      }
      // Unknown block type — show type + truncated content
      return <div key={i} className="logs-msg-text"><span className="logs-msg-tool-badge">{b.type}</span> {JSON.stringify(b).slice(0, 300)}</div>;
    });
  }

  return (
    <div className="logs-msg-viewer" ref={viewerRef} onClick={(ev) => ev.stopPropagation()}>
      {/* Expand/Collapse All toolbar */}
      <div className="logs-msg-toolbar">
        <span className="logs-msg-toolbar-label">{history.length} messages</span>
        <span className="logs-msg-toolbar-actions">
          <button className="logs-chip" onClick={() => toggleAll(true)}>Expand All</button>
          <button className="logs-chip" onClick={() => toggleAll(false)}>Collapse All</button>
        </span>
      </div>
      {/* System prompt */}
      {system && (
        <details className="logs-msg-system">
          <summary>System ({system.length.toLocaleString()} chars)</summary>
          <pre className="logs-se-pre">{system.slice(0, 20000)}{system.length > 20000 ? "\n…(truncated)" : ""}</pre>
        </details>
      )}

      {/* History messages (newest first) */}
      <div className="logs-msg-history">
        {[...history].reverse().map((msg, i) => (
          <div key={i} className={`logs-msg-row logs-msg-${msg.role}`}>
            <div className="logs-msg-role">
              {ROLE_DISPLAY[msg.role] ?? msg.role.toUpperCase()}
              {msg.timestamp && <span className="logs-msg-ts">{formatMsgAge(msg.timestamp)}</span>}
            </div>
            <div className="logs-msg-content">{renderContent(msg.content, msg.role)}</div>
          </div>
        ))}
      </div>

      {/* Current prompt (the new message about to be sent) */}
      {prompt && (
        <div className="logs-msg-row logs-msg-current">
          <div className="logs-msg-role">user <span className="logs-msg-badge-new">current</span></div>
          <div className="logs-msg-content"><div className="logs-msg-text">{prompt}</div></div>
        </div>
      )}
    </div>
  );
}

// ── Main Logs Page ──────────────────────────────────────────────────────────

function LogsPageInner() {
  const searchParams = useSearchParams();
  const { agentKeys: configAgentKeys, agentLabels: configAgentLabels, channelNames: configChannelNames } = useAgentConfig();
  const AGENTS = ["", ...configAgentKeys];
  const AGENT_LABELS: Record<string, string> = { "": "All Agents", ...configAgentLabels };
  const CHANNEL_NAMES = configChannelNames;

  // Cross-page params (read-only, for compatibility with Costs→Logs links)
  const urlSession = searchParams.get("session");
  const urlSince = searchParams.get("since");
  const urlUntil = searchParams.get("until");
  const urlTimeRangeLabel = searchParams.get("timeRangeLabel");
  const fromCosts = !!(urlTimeRangeLabel || searchParams.get("provider") || searchParams.get("model") || searchParams.get("costView") || (searchParams.get("billing") && searchParams.get("billing") !== "all"));

  const [activeTab, setActiveTab] = useHashTab<Tab>("openclaw", ["openclaw", "system"]);

  // All filter state synced bidirectionally to URL params
  const [filters, setFilter, batchFilters] = useUrlState({
    agents:     { type: "set" as const, default: new Set<string>(), aliases: ["agent"] },
    types:      { type: "set" as const, default: new Set<string>(), aliases: ["type"] },
    sub:        { type: "set" as const, default: new Set<string>() },
    models:     { type: "set" as const, default: new Set<string>(), aliases: ["model"] },
    sessions:   { type: "set" as const, default: new Set<string>() },
    search:     { type: "string" as const, default: "" },
    sort:       { type: "string" as const, default: "time" },
    date:       { type: "number" as const, default: urlSince ? -1 : 2 },
    minTokens:  { type: "number" as const, default: 0 },
    minCost:    { type: "number" as const, default: 0 },
    data:       { type: "string" as const, default: "" },
    billing:    { type: "string" as const, default: "all" },
    costView:   { type: "string" as const, default: "total" },
    source:     { type: "string" as const, default: "all" },
    provider:   { type: "string" as const, default: "" },
    groupByRun: { type: "boolean" as const, default: false },
    memory:     { type: "boolean" as const, default: false },
    since:      { type: "string" as const, default: "" },
    until:      { type: "string" as const, default: "" },
  });

  // Expose filter values with convenient names (same variable names as before)
  const agentFilters = filters.agents;
  const setAgentFilters = useCallback((v: Set<string> | ((p: Set<string>) => Set<string>)) => {
    const next = typeof v === "function" ? v(filters.agents) : v;
    setFilter("agents", next);
  }, [filters.agents, setFilter]);
  const typeFilters = filters.types;
  const setTypeFilters = useCallback((v: Set<string> | ((p: Set<string>) => Set<string>)) => {
    const next = typeof v === "function" ? v(filters.types) : v;
    setFilter("types", next);
  }, [filters.types, setFilter]);
  const subFilters = filters.sub;
  const setSubFilters = useCallback((v: Set<string> | ((p: Set<string>) => Set<string>)) => {
    const next = typeof v === "function" ? v(filters.sub) : v;
    setFilter("sub", next);
  }, [filters.sub, setFilter]);
  const modelFilters = filters.models;
  const setModelFilters = useCallback((v: Set<string> | ((p: Set<string>) => Set<string>)) => {
    const next = typeof v === "function" ? v(filters.models) : v;
    setFilter("models", next);
  }, [filters.models, setFilter]);
  const sessionFilters = filters.sessions;
  const setSessionFilters = useCallback((v: Set<string> | ((p: Set<string>) => Set<string>)) => {
    const next = typeof v === "function" ? v(filters.sessions) : v;
    setFilter("sessions", next);
  }, [filters.sessions, setFilter]);
  const search = filters.search;
  const setSearch = useCallback((v: string) => setFilter("search", v), [setFilter]);
  const sortBy = filters.sort as "time" | "total" | "input" | "output" | "cache" | "cost";
  const setSortBy = useCallback((v: string) => setFilter("sort", v), [setFilter]);
  const dateIdx = filters.date;
  const setDateIdx = useCallback((v: number) => setFilter("date", v), [setFilter]);
  const minTokens = filters.minTokens;
  const setMinTokens = useCallback((v: number) => setFilter("minTokens", v), [setFilter]);
  const minCost = filters.minCost;
  const setMinCost = useCallback((v: number) => setFilter("minCost", v), [setFilter]);
  const dataFilter = filters.data as "" | "has-thinking" | "has-prompt" | "has-response" | "has-provider-cost";
  const setDataFilter = useCallback((v: string) => setFilter("data", v), [setFilter]);
  const billingFilter = filters.billing as "all" | "metered" | "subscription";
  const setBillingFilter = useCallback((v: string) => setFilter("billing", v), [setFilter]);
  const costViewFilter = filters.costView as "actual" | "equiv" | "total";
  const setCostViewFilter = useCallback((v: string) => setFilter("costView", v), [setFilter]);
  const sourceFilter = filters.source as "all" | "agent" | "heartbeat" | "cron";
  const setSourceFilter = useCallback((v: string) => setFilter("source", v), [setFilter]);
  const providerFilter = filters.provider;
  const setProviderFilter = useCallback((v: string) => setFilter("provider", v), [setFilter]);
  const groupByRun = filters.groupByRun;
  const setGroupByRun = useCallback((v: boolean) => setFilter("groupByRun", v), [setFilter]);
  const memoryMode = filters.memory;
  const setMemoryMode = useCallback((v: boolean) => setFilter("memory", v), [setFilter]);

  // Custom range from URL since/until params
  const customRange = useMemo<{ since: number; until: number } | null>(() => {
    if (filters.since) return { since: Number(filters.since), until: filters.until ? Number(filters.until) : Date.now() };
    if (urlSince) return { since: Number(urlSince), until: urlUntil ? Number(urlUntil) : Date.now() };
    return null;
  }, [filters.since, filters.until, urlSince, urlUntil]);

  const [resolvedModelFilters, setResolvedModelFilters] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<LogEvent[] | null>(null);
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [eventDetails, setEventDetails] = useState<Record<number, { prompt: string | null; response: string | null; thinking: string | null }>>({});
  const [stale, setStale] = useState(false);
  const [failCount, setFailCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [memoryTimeline, setMemoryTimeline] = useState<MemoryTimelineEvent[] | null>(null);
  const [expandedMemSession, setExpandedMemSession] = useState<string | null>(null);
  // "Show context" — when set, shows all events ±Nmin around a specific event
  // Uses a separate fetch so filtered results stay visible
  const [contextEvent, setContextEvent] = useState<{ ts: number; agent: string; session: string | null } | null>(null);
  const [contextRadius, setContextRadius] = useState(2); // minutes
  const [contextEvents, setContextEvents] = useState<LogEvent[] | null>(null);

  // Stabilize `since` so it doesn't change every render (Date.now() changes every ms).
  // Recalculate only when dateIdx changes. The 30s polling interval handles freshness.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const since = useMemo(() => {
    if (dateIdx === -1 && customRange) return customRange.since;
    return Date.now() - DATE_RANGES[Math.max(dateIdx, 0)].ms;
  }, [dateIdx, customRange]);
  const until = dateIdx === -1 && customRange ? customRange.until : undefined;

  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const params = new URLSearchParams();
      params.set("since", String(since));
      if (until) params.set("until", String(until));
      const activeSession = sessionFilters.size > 0 ? [...sessionFilters][0] : urlSession;
      const activeAgent = agentFilters.size > 0 ? [...agentFilters][0] : null;
      params.set("limit", activeSession ? "5000" : "2000");
      if (activeSession) params.set("session", activeSession);
      if (activeAgent) params.set("agent", activeAgent);
      // Pass type, sub-filters, and source server-side so results span the full time range
      if (typeFilters.size > 0) params.set("types", [...typeFilters].join(","));
      if (subFilters.size > 0) params.set("sub_filters", [...subFilters].join(","));
      if (sourceFilter !== "all") params.set("source", sourceFilter);

      const [eventsRes, summaryRes] = await Promise.all([
        fetch(`${API_BASE}?endpoint=stream&${params}`, { signal: ac.signal }),
        fetch(`${API_BASE}?endpoint=summary&since=${since}`, { signal: ac.signal }),
      ]);

      if (ac.signal.aborted) return;

      if (!eventsRes.ok || !summaryRes.ok) {
        setFailCount((c) => c + 1);
        return;
      }

      const [evData, sumData] = await Promise.all([eventsRes.json(), summaryRes.json()]);
      if (ac.signal.aborted) return;

      startTransition(() => {
        setEvents(evData);
        setSummary(sumData);
        setFailCount(0);
        setStale(false);
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setFailCount((c) => c + 1);
    }
  }, [since, until, urlSession, agentFilters, sessionFilters, typeFilters, subFilters, sourceFilter]);

  // Show stale only after 2+ consecutive failures
  useEffect(() => {
    setStale(failCount >= 2);
  }, [failCount]);

  // Pause polling when an event is expanded (so you can read/copy)
  useEffect(() => {
    fetchData();
    if (paused) return;
    const interval = setInterval(fetchData, 30_000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [fetchData, paused]);

  // Fetch context events separately (±N min around target) so filtered results stay visible
  const contextAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!contextEvent) { setContextEvents(null); return; }
    contextAbortRef.current?.abort();
    const ac = new AbortController();
    contextAbortRef.current = ac;
    const windowMs = (contextRadius + 1) * 60 * 1000;
    const params = new URLSearchParams();
    params.set("since", String(contextEvent.ts - windowMs));
    params.set("until", String(contextEvent.ts + windowMs));
    params.set("limit", "5000");
    params.set("agent", contextEvent.agent);
    fetch(`${API_BASE}?endpoint=stream&${params}`, { signal: ac.signal })
      .then(r => r.ok ? r.json() : [])
      .then(data => { if (!ac.signal.aborted) setContextEvents(data); })
      .catch(() => {});
    return () => { ac.abort(); };
  }, [contextEvent, contextRadius]);

  // Fetch event detail (prompt/response/thinking) on-demand when expanding
  useEffect(() => {
    for (const id of expandedIds) {
      if (eventDetails[id]) continue; // already loaded
      fetch(`${API_BASE}?endpoint=event-detail&id=${id}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data && data.id) {
            setEventDetails((prev) => ({ ...prev, [data.id]: { prompt: data.prompt, response: data.response, thinking: data.thinking } }));
          }
        })
        .catch(() => {});
    }
  }, [expandedIds, eventDetails]);

  const toggleExpanded = useCallback((id: number) => {
    setExpandedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  /** Get detail (prompt/response/thinking) for an event, merging on-demand data */
  const getEventDetail = useCallback((e: LogEvent) => {
    const detail = eventDetails[e.id];
    return {
      prompt: detail?.prompt ?? e.prompt,
      response: detail?.response ?? e.response,
      thinking: detail?.thinking ?? e.thinking,
    };
  }, [eventDetails]);

  // Fetch memory timeline when memory mode is active
  useEffect(() => {
    if (!memoryMode) { setMemoryTimeline(null); return; }
    fetch(`/api/logs?endpoint=memory-timeline&since=${since}`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setMemoryTimeline(d); })
      .catch(() => {});
  }, [memoryMode, since]);

  // Group memory timeline by session
  const memorySessionGroups = useMemo(() => {
    if (!memoryTimeline) return null;
    const groups = new Map<string, MemoryTimelineEvent[]>();
    for (const e of memoryTimeline) {
      const key = e.session || "no-session";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }
    const result: MemorySessionGroup[] = [];
    for (const [session, evts] of groups) {
      evts.sort((a, b) => a.ts - b.ts);
      result.push({
        session,
        agent: evts[0].agent,
        trigger: evts[0].trigger,
        events: evts,
        startTs: evts[0].ts,
      });
    }
    result.sort((a, b) => b.startTs - a.startTs);
    return result;
  }, [memoryTimeline]);

  // Extract unique models from events for the filter dropdown
  const modelOptions = useMemo(() => {
    if (!events) return [];
    const models = new Set<string>();
    for (const e of events) {
      if (e.model) models.add(e.model);
    }
    return Array.from(models).sort();
  }, [events]);

  // Extract unique providers from model names (e.g. "anthropic" from "anthropic/claude-sonnet-4-20250514")
  const providerOptions = useMemo(() => {
    if (!events) return [];
    const providers = new Set<string>();
    for (const e of events) {
      if (e.model) {
        const slash = e.model.indexOf("/");
        if (slash > 0) providers.add(e.model.slice(0, slash));
      }
    }
    return Array.from(providers).sort();
  }, [events]);

  // Extract unique resolved models
  const resolvedModelOptions = useMemo(() => {
    if (!events) return [];
    const models = new Set<string>();
    for (const e of events) {
      if (e.resolved_model) models.add(e.resolved_model);
    }
    return Array.from(models).sort();
  }, [events]);

  // Client-side filtering: agents + types + models + search
  const filteredEvents = useMemo(() => {
    if (!events) return null;
    let filtered = events;

    // Context mode: merge context events with original filtered results
    if (contextEvent && contextEvents) {
      const windowMs = contextRadius * 60 * 1000;
      const seen = new Set<number>();
      // Start with the context window events
      const merged: LogEvent[] = [];
      for (const e of contextEvents) {
        if (seen.has(e.id)) continue;
        if (e.agent !== contextEvent.agent) continue;
        if (Math.abs(e.ts - contextEvent.ts) > windowMs) continue;
        seen.add(e.id);
        merged.push(e);
      }
      // Add all events from the original filtered set (they match active filters)
      for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        merged.push(e);
      }
      return merged.sort((a, b) => b.ts - a.ts);
    }

    if (agentFilters.size > 0) {
      filtered = filtered.filter((e) => agentFilters.has(e.agent));
    }

    if (typeFilters.size > 0) {
      filtered = filtered.filter((e) => typeFilters.has(e.type));
    }

    // Sub-type filters (within each event type)
    if (subFilters.size > 0) {
      filtered = filtered.filter((e) => {
        for (const sf of subFilters) {
          if (!matchSubFilter(e, sf)) return false;
        }
        return true;
      });
    }

    if (modelFilters.size > 0) {
      filtered = filtered.filter((e) => e.model !== null && modelFilters.has(e.model));
    }

    if (providerFilter) {
      filtered = filtered.filter((e) => e.model !== null && e.model.startsWith(providerFilter + "/"));
    }

    if (sessionFilters.size > 0) {
      // Only apply session-kind filtering when filter values are actual session kinds
      // (not raw session keys from cross-page ?session= links)
      const validKinds = new Set(["cron", "discord", "main", "hook", "jsonl", "other"]);
      const hasKindFilters = [...sessionFilters].some((v) => validKinds.has(v));
      if (hasKindFilters) {
        filtered = filtered.filter((e) => {
          const kind = sessionKind(e.session);
          return kind ? sessionFilters.has(kind) : sessionFilters.has("other");
        });
      }
    }

    if (resolvedModelFilters.size > 0) {
      filtered = filtered.filter((e) => e.resolved_model !== null && resolvedModelFilters.has(e.resolved_model));
    }

    if (billingFilter === "metered") {
      filtered = filtered.filter((e) => e.billing === "metered");
    } else if (billingFilter === "subscription") {
      filtered = filtered.filter((e) => e.billing === "subscription");
    }

    if (dataFilter === "has-thinking") {
      filtered = filtered.filter((e) => e.has_thinking || e.thinking != null);
    } else if (dataFilter === "has-prompt") {
      filtered = filtered.filter((e) => e.has_prompt || e.prompt != null);
    } else if (dataFilter === "has-response") {
      filtered = filtered.filter((e) => e.has_response || e.response != null);
    } else if (dataFilter === "has-provider-cost") {
      filtered = filtered.filter((e) => e.provider_cost != null);
    }

    if (minCost > 0) {
      filtered = filtered.filter((e) => (e.provider_cost ?? e.cost ?? 0) >= minCost);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter((e) => {
        // Search across: detail JSON, agent, model, type, session, run_id, prompt, response, thinking
        const detailStr = e.detail?.toLowerCase() ?? "";
        const agentStr = (AGENT_LABELS[e.agent] || e.agent).toLowerCase();
        const modelStr = (e.model ?? "").toLowerCase();
        const typeStr = (TYPE_LABELS[e.type] || e.type).toLowerCase();
        const sessionStr = (e.session ?? "").toLowerCase();
        const runStr = (e.run_id ?? "").toLowerCase();
        // Full text search works on detail JSON (which contains previews).
        // Full prompt/response/thinking are loaded on-demand only when expanded.
        const responseStr = "";
        const thinkingStr = "";
        const promptStr = "";
        return (
          detailStr.includes(q) ||
          agentStr.includes(q) ||
          modelStr.includes(q) ||
          typeStr.includes(q) ||
          sessionStr.includes(q) ||
          runStr.includes(q) ||
          responseStr.includes(q) ||
          thinkingStr.includes(q) ||
          promptStr.includes(q)
        );
      });
    }

    // Token minimum filter (based on total: input + output + cache)
    if (minTokens > 0) {
      filtered = filtered.filter((e) => {
        const total = (e.input_tokens ?? 0) + (e.output_tokens ?? 0) + (e.cache_read ?? 0);
        return total >= minTokens;
      });
    }

    // Sort
    if (sortBy !== "time") {
      filtered = [...filtered].sort((a, b) => {
        if (sortBy === "total") {
          const aTotal = (a.input_tokens ?? 0) + (a.output_tokens ?? 0) + (a.cache_read ?? 0);
          const bTotal = (b.input_tokens ?? 0) + (b.output_tokens ?? 0) + (b.cache_read ?? 0);
          return bTotal - aTotal;
        }
        if (sortBy === "cost") {
          return (b.provider_cost ?? b.cost ?? 0) - (a.provider_cost ?? a.cost ?? 0);
        }
        const field = sortBy === "input" ? "input_tokens" : sortBy === "output" ? "output_tokens" : "cache_read";
        return (b[field] ?? 0) - (a[field] ?? 0);
      });
    }

    return filtered;
  }, [events, agentFilters, typeFilters, subFilters, modelFilters, providerFilter, sessionFilters, resolvedModelFilters, billingFilter, dataFilter, minCost, search, sortBy, minTokens, contextEvent, contextEvents, contextRadius]);

  // Sub-filter counts: fetched server-side for accuracy over the full dataset
  const [subFilterCounts, setSubFilterCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (typeFilters.size === 0) { setSubFilterCounts({}); return; }
    const params = new URLSearchParams();
    params.set("since", String(since));
    if (until) params.set("until", String(until));
    fetch(`${API_BASE}?endpoint=sub-filter-counts&${params}`)
      .then(r => r.ok ? r.json() : {})
      .then(data => setSubFilterCounts(data))
      .catch(() => {});
  }, [since, until, typeFilters]);

  const totals = useMemo(() => {
    const source = filteredEvents ?? [];
    if (source.length === 0) return { newIn: 0, cacheRead: 0, output: 0, cost: 0, equivCost: 0, topAgent: "—", topModel: "—" };
    let newIn = 0, cacheRead = 0, output = 0, cost = 0, equivCost = 0;
    const agentTokens: Record<string, number> = {};
    const modelTokens: Record<string, number> = {};

    for (const e of source) {
      newIn += e.input_tokens ?? 0;
      cacheRead += e.cache_read ?? 0;
      output += e.output_tokens ?? 0;
      // Actual cost: use provider_cost for metered, 0 for subscription
      cost += e.billing === "subscription" ? 0 : (e.provider_cost ?? e.cost ?? 0);
      // API-equivalent cost: what it would cost if all usage were metered
      equivCost += e.cost ?? 0;
      const total = (e.input_tokens ?? 0) + (e.output_tokens ?? 0) + (e.cache_read ?? 0);
      agentTokens[e.agent] = (agentTokens[e.agent] ?? 0) + total;
      if (e.model) modelTokens[e.model] = (modelTokens[e.model] ?? 0) + total;
    }

    let topAgent = "—", topAgentTokens = 0;
    for (const [a, t] of Object.entries(agentTokens)) {
      if (t > topAgentTokens) { topAgent = AGENT_LABELS[a] || a; topAgentTokens = t; }
    }
    let topModel = "—", topModelTokens = 0;
    for (const [m, t] of Object.entries(modelTokens)) {
      if (t > topModelTokens) { topModel = shortModel(m); topModelTokens = t; }
    }

    return { newIn, cacheRead, output, cost, equivCost, topAgent, topModel };
  }, [filteredEvents]);

  // Run grouping for trace view
  interface RunGroup {
    runId: string;
    events: LogEvent[];
    totalCost: number;
    totalTokens: number;
    agent: string;
    startTs: number;
  }

  const groupedRuns = useMemo(() => {
    if (!groupByRun || !filteredEvents) return null;
    const groups = new Map<string, LogEvent[]>();
    const ungrouped: LogEvent[] = [];
    for (const e of filteredEvents) {
      if (e.run_id) {
        if (!groups.has(e.run_id)) groups.set(e.run_id, []);
        groups.get(e.run_id)!.push(e);
      } else {
        ungrouped.push(e);
      }
    }
    const runs: RunGroup[] = [];
    for (const [runId, evts] of groups) {
      evts.sort((a, b) => a.ts - b.ts);
      const totalCost = evts.reduce((s, e) => s + (e.billing === "subscription" ? 0 : (e.provider_cost ?? e.cost ?? 0)), 0);
      const totalTokens = evts.reduce((s, e) => s + (e.input_tokens ?? 0) + (e.output_tokens ?? 0) + (e.cache_read ?? 0), 0);
      runs.push({ runId, events: evts, totalCost, totalTokens, agent: evts[0].agent, startTs: evts[0].ts });
    }
    runs.sort((a, b) => b.startTs - a.startTs);
    return { runs, ungrouped };
  }, [groupByRun, filteredEvents]);

  // Compute per-agent actual cost from filtered events (server summary doesn't distinguish sub vs metered)
  const agentActualCosts = useMemo(() => {
    const costs: Record<string, number> = {};
    const equivCosts: Record<string, number> = {};
    for (const e of (filteredEvents ?? [])) {
      costs[e.agent] = (costs[e.agent] ?? 0) + (e.billing === "subscription" ? 0 : (e.provider_cost ?? e.cost ?? 0));
      equivCosts[e.agent] = (equivCosts[e.agent] ?? 0) + (e.cost ?? 0);
    }
    return { costs, equivCosts };
  }, [filteredEvents]);

  const maxAgentTokens = summary ? Math.max(...summary.map((a) => a.totalTokens), 1) : 1;

  return (
    <div className="logs-page">
      <h2>Logs & Analytics{stale && activeTab === "openclaw" && <span className="logs-stale" title="Gateway connection lost — showing last data"> (stale)</span>}</h2>

      {/* Tab Switcher */}
      <div className="ds-tabs">
        <button className={`ds-tab${activeTab === "openclaw" ? " active" : ""}`} onClick={() => setActiveTab("openclaw")}>OpenClaw</button>
        <button className={`ds-tab${activeTab === "system" ? " active" : ""}`} onClick={() => setActiveTab("system")}>System</button>
      </div>

      {activeTab === "system" && <SystemLogTab />}

      {activeTab === "openclaw" && <>
      {/* Filters */}
      <div className="logs-filters">
        {(agentFilters.size > 0 || typeFilters.size > 0 || modelFilters.size > 0 || sessionFilters.size > 0
          || resolvedModelFilters.size > 0 || providerFilter || billingFilter !== "all" || costViewFilter !== "actual"
          || sourceFilter !== "all"
          || dataFilter || sortBy !== "time" || minTokens > 0 || minCost > 0 || search || groupByRun || memoryMode || subFilters.size > 0) && (
          <button
            className="logs-reset-all"
            onClick={() => {
              setAgentFilters(new Set()); setTypeFilters(new Set()); setSubFilters(new Set()); setModelFilters(new Set());
              setSessionFilters(new Set()); setResolvedModelFilters(new Set()); setProviderFilter("");
              setBillingFilter("all"); setCostViewFilter("actual"); setSourceFilter("all"); setDataFilter(""); setSortBy("time");
              setMinTokens(0); setMinCost(0); setSearch(""); setGroupByRun(false); setMemoryMode(false);
              setContextEvent(null); setContextEvents(null); setContextRadius(2);
            }}
          >
            Reset All
          </button>
        )}
        <div className="logs-filter-group">
          <span className="logs-filter-label">Agents</span>
          <div className="logs-chips">
            {AGENTS.filter((a) => a !== "").map((a) => (
              <button
                key={a}
                className={`logs-chip${agentFilters.has(a) ? " active" : ""}`}
                onClick={() => setAgentFilters(toggleSet(agentFilters, a))}
              >
                {AGENT_LABELS[a]}
              </button>
            ))}
            {agentFilters.size > 0 && (
              <button className="logs-chip logs-chip-clear" onClick={() => setAgentFilters(new Set())}>Clear</button>
            )}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Types</span>
          <div className="logs-chips">
            {EVENT_TYPES.filter((t) => t !== "").map((t) => (
              <button
                key={t}
                className={`logs-chip${typeFilters.has(t) ? " active" : ""}`}
                style={typeFilters.has(t) ? { background: TYPE_COLORS[t], borderColor: TYPE_COLORS[t], color: "#fff" } : {}}
                onClick={() => {
                  const next = toggleSet(typeFilters, t);
                  setTypeFilters(next);
                  // Auto-clear sub-filters for deselected types
                  if (!next.has(t) && subFilters.size > 0) {
                    const keysForType = new Set((SUB_FILTERS[t] ?? []).map(sf => sf.key));
                    setSubFilters(prev => {
                      const filtered = new Set([...prev].filter(k => !keysForType.has(k)));
                      return filtered.size === prev.size ? prev : filtered;
                    });
                  }
                }}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
            {typeFilters.size > 0 && (
              <button className="logs-chip logs-chip-clear" onClick={() => { setTypeFilters(new Set()); setSubFilters(new Set()); }}>Clear</button>
            )}
          </div>
        </div>
        {typeFilters.size > 0 && (
          <div className="logs-filter-group logs-sub-filters">
            <span className="logs-filter-label">Sub</span>
            <div className="logs-chips">
              {[...typeFilters].flatMap(t => (SUB_FILTERS[t] ?? []).map(sf => {
                const count = subFilterCounts[sf.key] ?? 0;
                return (
                  <button
                    key={sf.key}
                    className={`logs-chip logs-chip-sub${subFilters.has(sf.key) ? " active" : ""}${count === 0 ? " logs-chip-empty" : ""}`}
                    onClick={() => setSubFilters(toggleSet(subFilters, sf.key))}
                    title={`${count} events`}
                  >
                    {sf.label} <span className="logs-chip-count">{count}</span>
                  </button>
                );
              }))}
              {subFilters.size > 0 && (
                <button className="logs-chip logs-chip-clear" onClick={() => setSubFilters(new Set())}>Clear</button>
              )}
            </div>
          </div>
        )}
        <div className="logs-filter-group">
          <span className="logs-filter-label">Models</span>
          <div className="logs-chips">
            {modelOptions.map((m) => (
              <button
                key={m}
                className={`logs-chip${modelFilters.has(m) ? " active" : ""}`}
                onClick={() => setModelFilters(toggleSet(modelFilters, m))}
              >
                {shortModel(m)}
              </button>
            ))}
            {modelFilters.size > 0 && (
              <button className="logs-chip logs-chip-clear" onClick={() => setModelFilters(new Set())}>Clear</button>
            )}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Session</span>
          <div className="logs-chips">
            {SESSION_KINDS.map((k) => (
              <button
                key={k}
                className={`logs-chip${sessionFilters.has(k) ? " active" : ""}`}
                style={sessionFilters.has(k) ? { background: SESSION_KIND_COLORS[k], borderColor: SESSION_KIND_COLORS[k], color: "#fff" } : {}}
                onClick={() => setSessionFilters(toggleSet(sessionFilters, k))}
              >
                {SESSION_KIND_LABELS[k]}
              </button>
            ))}
            {sessionFilters.size > 0 && (
              <button className="logs-chip logs-chip-clear" onClick={() => setSessionFilters(new Set())}>Clear</button>
            )}
          </div>
        </div>
        {providerOptions.length > 0 && (
        <div className="logs-filter-group">
          <span className="logs-filter-label">Provider</span>
          <div className="logs-chips">
            {providerOptions.map((p) => (
              <button
                key={p}
                className={`logs-chip${providerFilter === p ? " active" : ""}`}
                onClick={() => setProviderFilter(providerFilter === p ? "" : p)}
              >
                {p}
              </button>
            ))}
            {providerFilter && (
              <button className="logs-chip logs-chip-clear" onClick={() => setProviderFilter("")}>Clear</button>
            )}
          </div>
        </div>
        )}
        {resolvedModelOptions.length > 0 && (
        <div className="logs-filter-group">
          <span className="logs-filter-label">Resolved</span>
          <div className="logs-chips">
            {resolvedModelOptions.map((m) => (
              <button
                key={m}
                className={`logs-chip${resolvedModelFilters.has(m) ? " active" : ""}`}
                onClick={() => setResolvedModelFilters(toggleSet(resolvedModelFilters, m))}
              >
                {shortModel(m)}
              </button>
            ))}
            {resolvedModelFilters.size > 0 && (
              <button className="logs-chip logs-chip-clear" onClick={() => setResolvedModelFilters(new Set())}>Clear</button>
            )}
          </div>
        </div>
        )}
        <div className="logs-filter-group">
          <span className="logs-filter-label">Billing</span>
          <div className="logs-chips">
            {([["all", "All"], ["metered", "API"], ["subscription", "Sub"]] as const).map(([key, label]) => (
              <button
                key={key}
                className={`logs-chip${billingFilter === key ? " active" : ""}`}
                onClick={() => setBillingFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Source</span>
          <div className="logs-chips">
            {([["all", "All"], ["agent", "Agent"], ["heartbeat", "Heartbeat"], ["cron", "Cron"]] as const).map(([key, label]) => (
              <button
                key={key}
                className={`logs-chip${sourceFilter === key ? " active" : ""}`}
                onClick={() => setSourceFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Cost View</span>
          <div className="logs-chips">
            {([["actual", "Actual"], ["equiv", "API Equiv"], ["total", "Total"]] as const).map(([key, label]) => (
              <button
                key={key}
                className={`logs-chip${costViewFilter === key ? " active" : ""}`}
                onClick={() => setCostViewFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Data</span>
          <div className="logs-chips">
            {([["", "All"], ["has-thinking", "Thinking"], ["has-response", "Response"], ["has-prompt", "Prompt"], ["has-provider-cost", "Provider $"]] as const).map(([key, label]) => (
              <button
                key={key || "all"}
                className={`logs-chip${dataFilter === key ? " active" : ""}`}
                onClick={() => setDataFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Sort</span>
          <div className="logs-chips">
            {([["time", "Recent"], ["cost", "Cost"], ["total", "Total Tokens"], ["input", "New Input"], ["output", "Output"], ["cache", "Cache Read"]] as const).map(([key, label]) => (
              <button
                key={key}
                className={`logs-chip${sortBy === key ? " active" : ""}`}
                onClick={() => setSortBy(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">View</span>
          <div className="logs-chips">
            <button
              className={`logs-chip${groupByRun ? " active" : ""}`}
              onClick={() => { setGroupByRun(!groupByRun); setExpandedRunId(null); }}
            >
              Group by run
            </button>
            <button
              className={`logs-chip${memoryMode ? " active" : ""}`}
              onClick={() => { setMemoryMode(!memoryMode); setExpandedMemSession(null); }}
            >
              Memory ops
            </button>
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Min Tokens</span>
          <div className="logs-chips">
            {[0, 1000, 10000, 50000, 100000].map((t) => (
              <button
                key={t}
                className={`logs-chip${minTokens === t ? " active" : ""}`}
                onClick={() => setMinTokens(t)}
              >
                {t === 0 ? "Any" : formatTokens(t) + "+"}
              </button>
            ))}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Min Cost</span>
          <div className="logs-chips">
            {[0, 0.01, 0.05, 0.10, 0.50].map((c) => (
              <button
                key={c}
                className={`logs-chip${minCost === c ? " active" : ""}`}
                onClick={() => setMinCost(c)}
              >
                {c === 0 ? "Any" : `$${c}+`}
              </button>
            ))}
          </div>
        </div>
        <div className="logs-filter-group">
          <span className="logs-filter-label">Range</span>
          <div className="logs-chips">
            {DATE_RANGES.map((d, i) => (
              <button key={d.label} className={`logs-chip${dateIdx === i ? " active" : ""}`} onClick={() => setDateIdx(i)}>
                {d.label}
              </button>
            ))}
            {customRange && (
              <button
                className={`logs-chip${dateIdx === -1 ? " active" : ""}`}
                onClick={() => setDateIdx(-1)}
                title={`${new Date(customRange.since).toLocaleString()} – ${new Date(customRange.until).toLocaleString()}`}
              >
                {urlTimeRangeLabel ?? `${new Date(customRange.since).toLocaleDateString([], { month: "short", day: "numeric" })}–${new Date(customRange.until).toLocaleDateString([], { month: "short", day: "numeric" })}`}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Active filters banner (from Costs page drill-down) */}
      {fromCosts && (
        <div style={{
          display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
          padding: "8px 12px", marginBottom: "8px",
          background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.3)",
          borderRadius: "6px", fontSize: "12px",
        }}>
          <span style={{ color: "#c4b5fd", fontWeight: 600 }}>From Costs</span>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>(sorted by cost, LLM responses only{minCost > 0 ? `, min $${minCost}` : ""})</span>
          {urlTimeRangeLabel && <span className="logs-chip active" style={{ fontSize: 11, padding: "2px 8px" }}>{urlTimeRangeLabel}</span>}
          {agentFilters.size > 0 && <span className="logs-chip active" style={{ fontSize: 11, padding: "2px 8px" }}>Agent: {[...agentFilters].map((a) => AGENT_LABELS[a] || a).join(", ")}</span>}
          {billingFilter !== "all" && <span className="logs-chip active" style={{ fontSize: 11, padding: "2px 8px" }}>Billing: {billingFilter}</span>}
          {providerFilter && <span className="logs-chip active" style={{ fontSize: 11, padding: "2px 8px" }}>Provider: {providerFilter}</span>}
          {modelFilters.size > 0 && <span className="logs-chip active" style={{ fontSize: 11, padding: "2px 8px" }}>Model: {[...modelFilters].map((m) => m.split("/").pop()).join(", ")}</span>}
          {costViewFilter !== "actual" && <span className="logs-chip active" style={{ fontSize: 11, padding: "2px 8px" }}>Cost View: {costViewFilter === "equiv" ? "API Equiv" : "Total"}</span>}
          <button
            className="logs-chip logs-chip-clear"
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => {
              batchFilters({
                agents: new Set(), types: new Set(), sub: new Set(), models: new Set(),
                sessions: new Set(), search: "", sort: "time", date: 2, minTokens: 0,
                minCost: 0, data: "", billing: "all", costView: "actual", source: "all",
                provider: "", groupByRun: false, memory: false, since: "", until: "",
              });
            }}
          >
            Clear all
          </button>
        </div>
      )}

      {/* Context mode banner */}
      {contextEvent && (
        <div style={{
          display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
          padding: "8px 12px", marginBottom: "8px",
          background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)",
          borderRadius: "6px", fontSize: "12px",
        }}>
          <span style={{ color: "#fbbf24", fontWeight: 600 }}>Context view:</span>
          <span style={{ color: "var(--text-muted)" }}>
            Showing events ±{contextRadius} min around {new Date(contextEvent.ts).toLocaleTimeString()} for {AGENT_LABELS[contextEvent.agent] || contextEvent.agent}
          </span>
          <button
            className="logs-chip"
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => setContextRadius(r => r + 2)}
          >
            +2 min wider
          </button>
          <button
            className="logs-chip logs-chip-clear"
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => { setContextEvent(null); setContextEvents(null); setContextRadius(2); }}
          >
            Exit context view
          </button>
        </div>
      )}

      {/* Session filter banner */}
      {urlSession && (
        <div style={{
          display: "flex", alignItems: "center", gap: "8px",
          padding: "8px 12px", marginBottom: "8px",
          background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.3)",
          borderRadius: "6px", fontSize: "12px",
        }}>
          <span style={{ color: "#93c5fd", fontWeight: 600 }}>Session filter:</span>
          <code style={{ fontSize: "11px", color: "var(--text-primary)" }}>
            {urlSession.split(",")[0]}
          </code>
          {urlSession.includes(",") && (
            <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
              (+{urlSession.split(",").length - 1} variant{urlSession.split(",").length > 2 ? "s" : ""})
            </span>
          )}
          <a
            href="/logs"
            style={{ marginLeft: "auto", color: "#93c5fd", textDecoration: "none", fontSize: "11px" }}
          >
            Clear filter
          </a>
        </div>
      )}

      {/* Search */}
      <div className="logs-search-wrap">
        <input
          className="logs-search"
          type="text"
          placeholder="Search events... (tool names, message content, session keys, etc.)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="logs-search-clear" onClick={() => setSearch("")}>
            &times;
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="logs-summary-cards">
        <div className="logs-card">
          <div className="logs-card-label">New Input</div>
          <div className="logs-card-value">{formatTokens(totals.newIn)}</div>
        </div>
        <div className="logs-card">
          <div className="logs-card-label">Cache Read</div>
          <div className="logs-card-value">{formatTokens(totals.cacheRead)}</div>
        </div>
        <div className="logs-card">
          <div className="logs-card-label">Output</div>
          <div className="logs-card-value">{formatTokens(totals.output)}</div>
        </div>
        <div className="logs-card">
          <div className="logs-card-label">{costViewFilter === "actual" ? "Actual Cost" : costViewFilter === "equiv" ? "API Equiv" : "Est. Cost"}</div>
          <div className="logs-card-value">${(costViewFilter === "equiv" ? totals.equivCost : costViewFilter === "actual" ? totals.cost : totals.equivCost).toFixed(2)}</div>
        </div>
        <div className="logs-card">
          <div className="logs-card-label">Top Agent</div>
          <div className="logs-card-value">{totals.topAgent}</div>
        </div>
        <div className="logs-card">
          <div className="logs-card-label">Top Model</div>
          <div className="logs-card-value">{totals.topModel}</div>
        </div>
      </div>

      {/* Token Guide */}
      <details className="logs-guide">
        <summary className="logs-guide-toggle">Token &amp; Cost Guide</summary>
        <div className="logs-guide-content">
          <div className="logs-guide-section">
            <h4>What each number means in the event stream</h4>
            <table className="logs-guide-table">
              <tbody>
                <tr><td><strong>ctx</strong></td><td>Total context size (cache_read + input + cache_write). This is the full conversation — system prompt, message history, tool results, everything. Bigger = longer conversation.</td></tr>
                <tr><td><strong>cached</strong></td><td>Portion of ctx served from Anthropic&apos;s prompt cache (cache_read). These tokens already existed in cache from a previous call. 10x cheaper than fresh input. High ratio = good.</td></tr>
                <tr><td><strong>new</strong></td><td>Portion of ctx being written to cache for the first time (cache_write). Costs 1.25x input price. On the next call, these become &quot;cached&quot;. This is where long conversations get expensive.</td></tr>
                <tr><td><strong>out</strong></td><td>Tokens the model generated in its response. This is the most expensive token type (5x input cost for Sonnet, same ratio for Opus).</td></tr>
              </tbody>
            </table>
          </div>
          <div className="logs-guide-section">
            <h4>What you pay for (Sonnet pricing)</h4>
            <table className="logs-guide-table">
              <tbody>
                <tr><td>New input tokens</td><td>$3.00 / 1M tokens</td><td>Fresh tokens not in cache — usually tiny</td></tr>
                <tr><td>Cache write</td><td>$3.75 / 1M tokens</td><td>First time context is cached (1.25x input). Paid once, then subsequent calls get cache hits</td></tr>
                <tr><td>Cache read (hit)</td><td>$0.30 / 1M tokens</td><td>Cached tokens reused — 10x cheaper than input. This is why long conversations stay affordable</td></tr>
                <tr><td>Output tokens</td><td>$15.00 / 1M tokens</td><td>Model&apos;s response — 5x input cost. Short replies save money</td></tr>
              </tbody>
            </table>
          </div>
          <div className="logs-guide-section">
            <h4>Why two channels show different costs</h4>
            <p>Each channel has its own conversation session. A channel with 500 messages of history sends ~160K context tokens per turn. A new channel with 3 messages sends ~12K. The system prompt (~35K) is shared and cached across all sessions, so the &quot;hit&quot; number is similar — but the cache_write (new context) is vastly different.</p>
            <p><strong>TL;DR:</strong> Long conversations cost more because cache_write grows. The &quot;ctx&quot; number tells you the real conversation size. If ctx is 160K vs 12K, the first one costs ~13x more per turn.</p>
          </div>
          <div className="logs-guide-section">
            <h4>Session types</h4>
            <table className="logs-guide-table">
              <tbody>
                <tr><td><span className="logs-se-badge logs-se-badge-cron">heartbeat</span></td><td>Scheduled cron job — agent wakes up, checks messages, responds HEARTBEAT_OK. Uses free model (zero cost).</td></tr>
                <tr><td><span className="logs-se-badge logs-se-badge-discord">discord</span></td><td>Discord channel session — agent responding to messages in a specific channel. Each channel is a separate session with its own context.</td></tr>
                <tr><td><span className="logs-se-badge logs-se-badge-main">main</span></td><td>Persistent main session — long-running agent session, usually the primary work session.</td></tr>
                <tr><td><span className="logs-se-badge logs-se-badge-jsonl">tool calls</span></td><td>Tool call events captured from session transcripts (JSONL files). Shows what tools agents used.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {/* Per-Agent Breakdown with stacked model bars */}
      {summary && summary.length > 0 && (
        <div className="logs-agent-breakdown">
          <h3>Per-Agent Breakdown</h3>
          {summary.filter((a) => a.totalTokens > 0).map((a) => {
            const barWidth = Math.max((a.totalTokens / maxAgentTokens) * 100, 2);
            // Build segments: each model gets a proportional slice
            const segments: Array<{ model: string; input: number; cache: number; output: number; total: number }> = [];
            for (const [m, b] of Object.entries(a.models)) {
              const total = b.input + b.output + b.cache;
              if (total > 0) segments.push({ model: m, input: b.input, cache: b.cache, output: b.output, total });
            }
            segments.sort((x, y) => y.total - x.total);

            return (
              <div key={a.agent} className="logs-agent-row">
                <span className="logs-agent-name">{AGENT_LABELS[a.agent] || a.agent}</span>
                <div className="logs-agent-bar-wrap" style={{ width: `${barWidth}%` }}>
                  {segments.map((seg) => {
                    const pct = (seg.total / a.totalTokens) * 100;
                    const color = modelColor(seg.model);
                    const cachePct = seg.total > 0 ? (seg.cache / seg.total) * 100 : 0;
                    const inputPct = seg.total > 0 ? (seg.input / seg.total) * 100 : 0;
                    return (
                      <div
                        key={seg.model}
                        className="logs-bar-segment"
                        style={{ width: `${pct}%`, background: color }}
                        title={`${shortModel(seg.model)}: ${formatTokens(seg.input)} input, ${formatTokens(seg.cache)} cache, ${formatTokens(seg.output)} output`}
                      >
                        {/* Cache sub-segment (lighter) */}
                        {cachePct > 0 && (
                          <div className="logs-bar-cache" style={{ width: `${cachePct}%`, background: color, opacity: 0.4 }} />
                        )}
                        {/* Input sub-segment (full color) */}
                        {inputPct > 0 && (
                          <div className="logs-bar-input" style={{ width: `${inputPct}%`, background: color }} />
                        )}
                      </div>
                    );
                  })}
                </div>
                <span className="logs-agent-tokens">{formatTokens(a.totalTokens)}</span>
                <span className="logs-agent-cost">${(costViewFilter === "equiv" ? (agentActualCosts.equivCosts[a.agent] ?? a.cost) : (agentActualCosts.costs[a.agent] ?? 0)).toFixed(2)}</span>
              </div>
            );
          })}
          {/* Legend */}
          <div className="logs-bar-legend">
            {(() => {
              const allModels = new Set<string>();
              for (const a of summary) {
                for (const m of Object.keys(a.models)) allModels.add(m);
              }
              return Array.from(allModels).map((m) => (
                <span key={m} className="logs-legend-item">
                  <span className="logs-legend-swatch" style={{ background: modelColor(m) }} />
                  {shortModel(m)}
                </span>
              ));
            })()}
            <span className="logs-legend-item">
              <span className="logs-legend-swatch" style={{ background: "#666", opacity: 0.4 }} />
              = cache
            </span>
          </div>
        </div>
      )}

      {/* Memory Timeline (when memory mode active) */}
      {memoryMode && (
        <div className="logs-events">
          <div className="logs-events-header">
            <h3>Memory Operations</h3>
            {memorySessionGroups && (
              <span className="logs-result-count">
                {memorySessionGroups.length} session{memorySessionGroups.length !== 1 ? "s" : ""}, {memoryTimeline?.length ?? 0} ops
              </span>
            )}
          </div>
          {!memorySessionGroups ? (
            <div className="loading">Loading memory timeline…</div>
          ) : memorySessionGroups.length === 0 ? (
            <div className="logs-empty">No memory operations found for this period.</div>
          ) : (
            <div className="logs-stream">
              {memorySessionGroups.map((sg) => {
                const isExpanded = expandedMemSession === sg.session;
                const triggerLabel = sg.trigger
                  ? sg.trigger.includes("HEARTBEAT") || sg.trigger.includes("[cron:")
                    ? "cron"
                    : sg.trigger === "Discord message"
                      ? "discord"
                      : "session"
                  : "unknown";
                return (
                  <div key={sg.session} className="logs-run-group">
                    <div
                      className={`logs-run-header${isExpanded ? " expanded" : ""}`}
                      onClick={() => setExpandedMemSession(isExpanded ? null : sg.session)}
                    >
                      <span className={`logs-mem-trigger logs-mem-trigger-${triggerLabel}`}>{triggerLabel}</span>
                      <span className="logs-se-agent">{AGENT_LABELS[sg.agent] || sg.agent}</span>
                      <span className="logs-run-stat">{sg.events.length} op{sg.events.length !== 1 ? "s" : ""}</span>
                      <span className="logs-run-stat">
                        {sg.events.filter(e => e.op === "read").length}r / {sg.events.filter(e => e.op === "write" || e.op === "edit").length}w
                      </span>
                      <span className="logs-se-time">{timeAgo(sg.startTs)}</span>
                    </div>
                    {isExpanded && (
                      <div className="logs-run-events">
                        {sg.trigger && (
                          <div className="logs-mem-trigger-detail">
                            Trigger: {sg.trigger.slice(0, 200)}
                          </div>
                        )}
                        {sg.events.map((me) => {
                          let paramPreview = "";
                          try {
                            const p = JSON.parse(me.params);
                            if (p.file_path || p.path) paramPreview = p.file_path || p.path;
                            else if (p.command) paramPreview = p.command.slice(0, 120);
                          } catch { /* ignore */ }
                          return (
                            <div key={me.id} className="logs-stream-event logs-stream-tool_call">
                              <div className="logs-se-header">
                                <span className="logs-se-type" style={{ background: me.op === "read" ? "#2d7d46" : me.op === "exec" ? "#7d6b2d" : "#2d5a7d" }}>
                                  {me.op}
                                </span>
                                <span className="logs-se-tool">{me.file_path}</span>
                                <span className="logs-se-time">{timeAgo(me.ts)}</span>
                              </div>
                              {paramPreview && paramPreview !== me.file_path && (
                                <div className="logs-mem-param-preview">{paramPreview}</div>
                              )}
                            </div>
                          );
                        })}
                        <button
                          className="logs-run-link"
                          onClick={(ev) => { ev.stopPropagation(); setMemoryMode(false); setSearch(sg.session); }}
                        >
                          View full session trace →
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Event Stream */}
      {!memoryMode && (
      <div className="logs-events">
        <div className="logs-events-header">
          <h3>{groupByRun ? "Trace View" : "Event Stream"}</h3>
          {filteredEvents && search && (
            <span className="logs-result-count">{filteredEvents.length} result{filteredEvents.length !== 1 ? "s" : ""}</span>
          )}
          {groupByRun && groupedRuns && (
            <span className="logs-result-count">{groupedRuns.runs.length} run{groupedRuns.runs.length !== 1 ? "s" : ""}{groupedRuns.ungrouped.length > 0 ? ` + ${groupedRuns.ungrouped.length} ungrouped` : ""}</span>
          )}
          <span className="logs-events-header-actions">
            {expandedIds.size > 0 && (
              <button className="logs-chip" onClick={() => setExpandedIds(new Set())}>Collapse All</button>
            )}
            {filteredEvents && filteredEvents.length > 0 && expandedIds.size < filteredEvents.length && (
              <button className="logs-chip" onClick={() => setExpandedIds(new Set(filteredEvents.map(e => e.id)))}>Expand All</button>
            )}
          </span>
        </div>
        {filteredEvents === null ? (
          <div className="loading">Loading…</div>
        ) : filteredEvents.length === 0 ? (
          <div className="logs-empty">{search ? "No events match your search." : "No events found for this period."}</div>
        ) : groupByRun && groupedRuns ? (
          <div className="logs-stream">
            {groupedRuns.runs.map((run) => {
              const isRunExpanded = expandedRunId === run.runId;
              return (
                <div key={run.runId} className="logs-run-group">
                  <div
                    className={`logs-run-header${isRunExpanded ? " expanded" : ""}`}
                    onClick={() => { setExpandedRunId(isRunExpanded ? null : run.runId); setPaused(!isRunExpanded); }}
                  >
                    <span className="logs-run-id">{run.runId.slice(0, 8)}</span>
                    <span className="logs-se-agent">{AGENT_LABELS[run.agent] || run.agent}</span>
                    <span className="logs-run-stat">{run.events.length} event{run.events.length !== 1 ? "s" : ""}</span>
                    {run.totalCost > 0 && <span className="logs-run-stat">${run.totalCost.toFixed(3)}</span>}
                    {run.totalTokens > 0 && <span className="logs-run-stat">{formatTokens(run.totalTokens)} tokens</span>}
                    <span className="logs-se-time">{timeAgo(run.startTs)}</span>
                  </div>
                  {isRunExpanded && (
                    <div className="logs-run-events">
                      {run.events.map((e) => {
                        const d = parseDetail(e.detail);
                        const isEvtExpanded = expandedIds.has(e.id);
                        return (
                          <div
                            key={e.id}
                            className={`logs-stream-event logs-stream-${e.type}${isEvtExpanded ? " expanded" : ""}`}
                            onClick={(ev) => { ev.stopPropagation(); toggleExpanded(e.id); }}
                          >
                            <div className="logs-se-header">
                              <span className="logs-se-type" style={{ background: TYPE_COLORS[e.type] || "#666" }}>{TYPE_LABELS[e.type] || e.type}</span>
                              {e.model && <span className="logs-se-model">{shortModel(e.model)}</span>}
                              {e.type === "llm_output" && (
                                <span className="logs-se-tokens">
                                  {formatTokens((e.input_tokens ?? 0) + (e.cache_read ?? 0))} ctx / {formatTokens(e.output_tokens ?? 0)} out
                                  {e.billing === "subscription"
                                    ? (e.cost ? ` · ~$${e.cost.toFixed(3)} equiv` : "")
                                    : e.provider_cost != null ? ` · $${e.provider_cost.toFixed(3)}` : e.cost ? ` · ~$${e.cost.toFixed(3)}` : ""}
                                </span>
                              )}
                              {e.type === "tool_call" && (
                                <span className="logs-se-tool">
                                  {(d.success as boolean) ? "✓" : "✗"} {d.tool as string}
                                  {d.durationMs ? ` · ${d.durationMs}ms` : ""}
                                </span>
                              )}
                              {e.type === "msg_in" && typeof d.content === "string" && (
                                <span className="logs-se-tool">{d.content.slice(0, 60)}</span>
                              )}
                            </div>
                            {isEvtExpanded && (() => {
                              const ed = getEventDetail(e);
                              return (
                                <div className="logs-se-detail">
                                  {ed.response ? (
                                    <details open onClick={(ev) => ev.stopPropagation()}><summary>Response</summary><pre className="logs-se-pre">{ed.response.slice(0, 3000)}</pre></details>
                                  ) : null}
                                  {ed.thinking ? (
                                    <details onClick={(ev) => ev.stopPropagation()}><summary>Thinking</summary><pre className="logs-se-pre">{ed.thinking.slice(0, 3000)}</pre></details>
                                  ) : null}
                                  {ed.prompt ? (
                                    <details onClick={(ev) => ev.stopPropagation()}><summary>Prompt</summary><pre className="logs-se-pre">{ed.prompt.slice(0, 5000)}</pre></details>
                                  ) : null}
                                </div>
                              );
                            })()}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {groupedRuns.ungrouped.length > 0 && (
              <>
                <div className="logs-run-ungrouped-label">Ungrouped events ({groupedRuns.ungrouped.length})</div>
                {groupedRuns.ungrouped.map((e) => {
                  const d = parseDetail(e.detail);
                  const isExpanded = expandedIds.has(e.id);
                  return (
                    <div
                      key={e.id}
                      className={`logs-stream-event logs-stream-${e.type}${isExpanded ? " expanded" : ""}`}
                      onClick={() => { if (window.getSelection()?.toString()) return; toggleExpanded(e.id); }}
                    >
                      <div className="logs-se-header">
                        <span className="logs-se-time">{timeAgo(e.ts)}</span>
                        <span className="logs-se-agent">{AGENT_LABELS[e.agent] || e.agent}</span>
                        <span className="logs-se-type" style={{ background: TYPE_COLORS[e.type] || "#666" }}>{TYPE_LABELS[e.type] || e.type}</span>
                        {e.type === "tool_call" && <span className="logs-se-tool">{(d.success as boolean) ? "✓" : "✗"} {d.tool as string}</span>}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        ) : (
          <div className="logs-stream">
            {filteredEvents.map((e) => {
              const d = parseDetail(e.detail);
              const isExpanded = expandedIds.has(e.id);
              const kind = sessionKind(e.session);
              const ed = isExpanded ? getEventDetail(e) : null;
              return (
                <div
                  key={e.id}
                  className={`logs-stream-event logs-stream-${e.type}${isExpanded ? " expanded" : ""}`}
                  onClick={() => { if (window.getSelection()?.toString()) return; toggleExpanded(e.id); }}
                >
                  <div className="logs-se-header">
                    <span className="logs-se-time" title={new Date(e.ts).toLocaleString()}>{timeAgo(e.ts)}</span>
                    <span className="logs-se-agent">{AGENT_LABELS[e.agent] || e.agent}</span>
                    {kind === "cron" && <span className="logs-se-badge logs-se-badge-cron">heartbeat</span>}
                    {kind !== "cron" && e.session && (
                      <span className={`logs-se-badge logs-se-badge-${kind || "default"}`} title={e.session}>
                        {shortSession(e.session)}
                      </span>
                    )}
                    <span className="logs-se-type" style={{ background: TYPE_COLORS[e.type] || "#666" }}>
                      {TYPE_LABELS[e.type] || e.type}
                    </span>
                    {e.model && <span className="logs-se-model">{shortModel(e.model)}</span>}
                    {e.resolved_model && e.resolved_model !== e.model && (
                      <span className="logs-se-resolved" title={e.resolved_model}>→ {e.resolved_model}</span>
                    )}
                    {(e.has_thinking || e.thinking != null) && <span className="logs-se-badge logs-se-badge-thinking" title="Has reasoning/thinking">T</span>}
                    {e.type === "llm_output" && (
                      <span className="logs-se-tokens">
                        {formatTokens((e.input_tokens ?? 0) + (e.cache_read ?? 0) + (e.cache_write ?? 0))} ctx
                        {e.cache_read ? ` (${formatTokens(e.cache_read)} cached` : ""}
                        {e.cache_read && e.cache_write ? `, ${formatTokens(e.cache_write)} new)` : e.cache_read ? ")" : ""}
                        {" / "}{formatTokens(e.output_tokens ?? 0)} out
                        {e.billing === "subscription"
                          ? (costViewFilter !== "actual" && e.cost ? ` · ~$${e.cost.toFixed(3)} equiv` : " · sub")
                          : e.provider_cost != null
                            ? ` · $${e.provider_cost.toFixed(3)}`
                            : e.cost ? ` · ~$${e.cost.toFixed(3)}` : ""}
                      </span>
                    )}
                    {e.type === "tool_call" && (
                      <span className="logs-se-tool">
                        {(d.success as boolean) ? "✓" : "✗"} {d.tool as string}
                        {d.durationMs ? ` · ${d.durationMs}ms` : ""}
                      </span>
                    )}
                    {e.type === "llm_input" && (
                      <span className="logs-se-context">
                        {d.historyCount as number} msgs · sys:{formatTokens((d.systemPromptLen as number) ?? 0)} chars
                      </span>
                    )}
                    {e.type === "msg_in" && (
                      <span className="logs-se-msg">
                        {d.from ? <span className="logs-se-from">{CHANNEL_NAMES[String(d.from).split(":").pop() || ""] || String(d.from).split(":").pop()?.slice(-6)}</span> : null}
                        → {AGENT_LABELS[e.agent] || e.agent}
                        {" · "}{((d.content as string) ?? "").slice(0, 60)}
                      </span>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="logs-se-detail">
                      {/* Exact timestamp in user's timezone */}
                      <div className="logs-se-timestamp">{new Date(e.ts).toLocaleString([], { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" })}</div>
                      {/* Dual cost comparison */}
                      {(e.provider_cost != null || e.cost != null || e.billing) && (
                        <div className="logs-se-cost-compare">
                          {e.billing && (
                            <span className={`logs-se-badge-billing ${e.billing === "subscription" ? "logs-se-badge-sub" : ""}`}>
                              {e.billing === "subscription" ? "subscription" : "metered"}
                            </span>
                          )}
                          {e.billing === "subscription" && costViewFilter !== "actual" && e.cost != null && e.cost > 0 && (
                            <span className="logs-se-cost-item">
                              <span className="logs-se-cost-label">API Equiv</span>
                              <span className="logs-se-cost-value">~${e.cost.toFixed(4).replace(/0+$/, "0")}</span>
                            </span>
                          )}
                          {e.billing !== "subscription" && e.provider_cost != null && (
                            <span className="logs-se-cost-item">
                              <span className="logs-se-cost-label">Provider</span>
                              <span className="logs-se-cost-value">${e.provider_cost > 0 && e.provider_cost < 0.0001 ? e.provider_cost.toPrecision(2) : e.provider_cost.toFixed(6).replace(/0+$/, "0")}</span>
                            </span>
                          )}
                          {e.billing !== "subscription" && e.cost != null && e.cost > 0 && (
                            <span className="logs-se-cost-item">
                              <span className="logs-se-cost-label">Calculated</span>
                              <span className="logs-se-cost-value">${e.cost > 0 && e.cost < 0.0001 ? e.cost.toPrecision(2) : e.cost.toFixed(6).replace(/0+$/, "0")}</span>
                            </span>
                          )}
                          {e.billing !== "subscription" && e.provider_cost != null && e.cost != null && e.cost > 0 && (
                            <span className="logs-se-cost-item">
                              <span className="logs-se-cost-label">Diff</span>
                              <span className={`logs-se-cost-value ${Math.abs(e.provider_cost - e.cost) / e.cost > 0.1 ? "logs-se-cost-warn" : ""}`}>
                                {((e.provider_cost - e.cost) / e.cost * 100).toFixed(0)}%
                              </span>
                            </span>
                          )}
                        </div>
                      )}
                      {/* Model resolution */}
                      {e.resolved_model && e.resolved_model !== e.model && (
                        <div className="logs-se-model-resolve">
                          Requested: <code>{e.model}</code> → Resolved: <code>{e.resolved_model}</code>
                        </div>
                      )}
                      {/* Full response */}
                      {ed?.response ? (
                        <details className="logs-se-payload" open onClick={(ev) => ev.stopPropagation()}>
                          <summary>Response ({ed.response.length.toLocaleString()} chars)</summary>
                          <pre className="logs-se-pre">{ed.response}</pre>
                        </details>
                      ) : (d.assistantPreview) ? (
                        <div className="logs-se-preview">
                          {String(d.assistantPreview).split("\n").map((line, i) => (
                            <span key={i}>{line}<br /></span>
                          ))}
                        </div>
                      ) : null}
                      {/* Thinking/reasoning */}
                      {ed?.thinking && (
                        <details className="logs-se-payload" onClick={(ev) => ev.stopPropagation()}>
                          <summary>Thinking ({ed.thinking.length.toLocaleString()} chars)</summary>
                          <pre className="logs-se-pre logs-se-thinking">{ed.thinking}</pre>
                        </details>
                      )}
                      {/* Full prompt — chat viewer for llm_input, raw for others */}
                      {ed?.prompt ? (
                        e.type === "llm_input" ? (
                          <details className="logs-se-payload" onClick={(ev) => ev.stopPropagation()}>
                            <summary>Messages ({(d.historyCount as number) ?? "?"} messages, {ed.prompt.length.toLocaleString()} chars)</summary>
                            <PromptMessageViewer raw={ed.prompt} />
                          </details>
                        ) : (
                          <details className="logs-se-payload" onClick={(ev) => ev.stopPropagation()}>
                            <summary>Prompt ({ed.prompt.length.toLocaleString()} chars)</summary>
                            <pre className="logs-se-pre">{ed.prompt.length > 50000 ? ed.prompt.slice(0, 50000) + "\n…(truncated)" : ed.prompt}</pre>
                          </details>
                        )
                      ) : (d.promptPreview) ? (
                        <div className="logs-se-preview">
                          {String(d.promptPreview).split("\n").map((line, i) => (
                            <span key={i}>{line}<br /></span>
                          ))}
                        </div>
                      ) : null}
                      {/* Other detail fields (skip large/redundant keys) */}
                      <div className="logs-se-meta">
                        {Object.entries(d).filter(([k, v]) =>
                          !["assistantPreview", "promptPreview", "system", "prompt", "response", "thinking"].includes(k)
                          && !(typeof v === "string" && v.length > 500)
                        ).map(([k, v]) => (
                          <div key={k} className="logs-se-meta-row">
                            <span className="logs-se-meta-key">{k}</span>
                            <span className="logs-se-meta-val">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                          </div>
                        ))}
                        {/* System prompt in collapsible detail */}
                        {typeof d.system === "string" && d.system.length > 0 && (
                          <details className="logs-se-payload" onClick={(ev) => ev.stopPropagation()}>
                            <summary>System prompt ({d.system.length.toLocaleString()} chars)</summary>
                            <pre className="logs-se-pre">{(d.system as string).length > 30000 ? (d.system as string).slice(0, 30000) + "\n…(truncated)" : d.system as string}</pre>
                          </details>
                        )}
                      </div>
                      {e.run_id && <div className="logs-se-run">Run: <button className="logs-run-link" onClick={(ev) => { ev.stopPropagation(); setSearch(e.run_id!); setGroupByRun(true); }}>{e.run_id}</button></div>}
                      {e.session && <div className="logs-se-session">Session: {e.session.startsWith("{") ? shortSession(e.session) : e.session}</div>}
                      {e.session && (
                        <a
                          href={`/replay?session=${encodeURIComponent(e.session)}&step=${e.id}`}
                          style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}
                        >
                          ▶ Replay full session
                        </a>
                      )}
                      {e.cache_read ? <div>Cache read: {formatTokens(e.cache_read)}</div> : null}
                      {e.cache_write ? <div>Cache write: {formatTokens(e.cache_write)}</div> : null}
                      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                        {!contextEvent ? (
                          <button
                            className="logs-chip"
                            style={{ fontSize: 11, padding: "3px 10px" }}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setContextRadius(2);
                              setContextEvent({ ts: e.ts, agent: e.agent, session: e.session });
                              setExpandedIds(new Set([e.id]));
                            }}
                          >
                            Show surrounding context (±2 min)
                          </button>
                        ) : (
                          <button
                            className="logs-chip"
                            style={{ fontSize: 11, padding: "3px 10px" }}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setContextRadius(r => r + 2);
                            }}
                          >
                            Expand context (+2 min)
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}
      </>}
    </div>
  );
}

export default function LogsPage() {
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <LogsPageInner />
    </Suspense>
  );
}
