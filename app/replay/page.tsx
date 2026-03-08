"use client";

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import "./replay.css";
import RunSummaryCard from "@/components/run-summary-card";

// ── Types ────────────────────────────────────────────────────────

type EventType = "llm_input" | "llm_output" | "tool_call" | "msg_in" | "msg_out";

interface RawLogEvent {
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
  has_thinking: number | null;
  has_prompt: number | null;
  has_response: number | null;
  resolved_model: string | null;
  provider_cost: number | null;
  billing: string | null;
}

interface EventDetail {
  id: number;
  prompt: string | null;
  response: string | null;
  thinking: string | null;
}

interface ParsedDetail {
  tool?: string;
  params?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  isError?: boolean;
  content?: string;
  message?: string;
  channel?: string;
  success?: number;
  promptPreview?: string;
  historyCount?: number;
}

interface ReplayStep {
  id: number;
  ts: number;
  type: EventType;
  agent: string;
  model: string | null;
  cost: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  resolvedModel: string | null;
  providerCost: number | null;
  billing: string | null;
  runId: string | null;
  toolName: string | null;
  toolParams: Record<string, unknown> | null;
  toolResult: string | null;
  toolDuration: number | null;
  toolError: boolean;
  messageContent: string | null;
  messageChannel: string | null;
  promptPreview: string | null;
  historyCount: number | null;
  hasThinking: boolean;
  hasPrompt: boolean;
  hasResponse: boolean;
  stepIndex: number;
  runningCost: number;
  runningTokens: number;
  deltaTime: number;
  relativeTime: number;
  isAnomaly: boolean;
  anomalyReason: string | null;
}

interface SessionSummary {
  agent: string;
  model: string | null;
  origin: string;
  channel: string | null;
  stepCount: number;
  duration: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  toolCallCount: number;
  llmCallCount: number;
  uniqueTools: string[];
  hasAnomalies: boolean;
  billing: string | null;
  totalProviderCost: number;
  truncated: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

const API_BASE = "/api/logs";
const MAX_EVENTS = 5000;
const REPLAY_EVENT_TYPES = new Set(["llm_input", "llm_output", "tool_call", "msg_in", "msg_out"]);

const TYPE_ICONS: Record<string, string> = {
  msg_in: "\u{1F4AC}",
  llm_input: "\u2192",
  llm_output: "\u2190",
  tool_call: "\u{1F527}",
  msg_out: "\u{1F4E4}",
};

const TYPE_LABELS: Record<string, string> = {
  llm_output: "LLM Response",
  llm_input: "Prompt Sent",
  tool_call: "Tool Call",
  msg_in: "Message In",
  msg_out: "Message Out",
};

const TYPE_COLORS: Record<string, string> = {
  llm_output: "#2563eb",
  llm_input: "#7c3aed",
  tool_call: "#d97706",
  msg_in: "#059669",
  msg_out: "#059669",
};

function parseDetail(raw: string | null): ParsedDetail {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatRelTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

/** Format session cost showing both actual and API equiv when they differ */
function fmtSessionCost(summary: SessionSummary): string {
  if (summary.totalCost <= 0) return "$0";
  const actual = summary.totalProviderCost;
  const equiv = summary.totalCost;
  if (summary.billing === "subscription") {
    return `$${actual.toFixed(2)} actual · ~${fmtCost(equiv)} equiv`;
  }
  if (summary.billing === "mixed" && Math.abs(actual - equiv) > 0.01) {
    return `${fmtCost(actual)} actual · ~${fmtCost(equiv)} equiv`;
  }
  return fmtCost(actual > 0 ? actual : equiv);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function shortModel(m: string | null): string {
  if (!m) return "";
  const parts = m.split("/");
  const name = parts[parts.length - 1];
  return name.replace(/claude-|-20\d{6,}/g, "").replace(/-/g, " ").trim();
}

/** Parse origin and channel from session key format */
function parseSessionKey(key: string): { origin: string; channel: string | null } {
  // Format: agent:main:discord:channel:123456 or main/uuid.jsonl or channel:123
  if (key.includes(":discord:")) return { origin: "discord", channel: key.split(":channel:")[1] ?? null };
  if (key.includes(":telegram:")) return { origin: "telegram", channel: key.split(":channel:")[1] ?? null };
  if (key.includes(":slack:")) return { origin: "slack", channel: key.split(":channel:")[1] ?? null };
  if (key.includes(":signal:")) return { origin: "signal", channel: null };
  if (key.includes(":web:")) return { origin: "web", channel: null };
  if (key.includes(":cron:")) return { origin: "cron", channel: null };
  if (key.includes(":hook:")) return { origin: "hook", channel: null };
  return { origin: "main", channel: null };
}

/** Truncate text for timeline preview */
function truncatePreview(text: string, maxLen: number = 60): string {
  if (!text) return "";
  const clean = text.replace(/\n/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + "\u2026";
}

// ── Build replay steps ──────────────────────────────────────────

function buildReplaySteps(events: RawLogEvent[], avgCost: number): ReplayStep[] {
  const sorted = [...events]
    .filter(e => REPLAY_EVENT_TYPES.has(e.type))
    .sort((a, b) => a.ts - b.ts || a.id - b.id);

  let runningCost = 0;
  let runningTokens = 0;
  const firstTs = sorted[0]?.ts ?? 0;

  return sorted.map((ev, i) => {
    // For subscription billing, use the `cost` field (API-equivalent estimate) since
    // provider_cost also reflects API rates, not the user's flat subscription fee.
    // For metered billing, prefer provider_cost (real spend).
    const isSub = ev.billing === "subscription";
    const effectiveCost = isSub ? (ev.cost ?? 0) : (ev.provider_cost ?? ev.cost ?? 0);
    runningCost += effectiveCost;
    runningTokens += (ev.input_tokens ?? 0) + (ev.output_tokens ?? 0);
    const d = parseDetail(ev.detail);

    let isAnomaly = false;
    let anomalyReason: string | null = null;
    if (effectiveCost > avgCost * 3 && avgCost > 0) {
      isAnomaly = true;
      anomalyReason = `Cost spike: ${fmtCost(effectiveCost)} (${(effectiveCost / avgCost).toFixed(1)}x avg)`;
    }
    // Compare normalized model names to avoid false positives from provider prefix differences
    if (ev.resolved_model && ev.model) {
      const normalizeModel = (m: string) => m.replace(/^(anthropic|openai|google|meta)\//i, "");
      const expected = normalizeModel(ev.model);
      const actual = normalizeModel(ev.resolved_model);
      if (actual !== expected) {
        isAnomaly = true;
        anomalyReason = `Model drift: expected ${shortModel(ev.model)}, got ${shortModel(ev.resolved_model)}`;
      }
    }
    if (d.isError || d.success === 0) {
      isAnomaly = true;
      anomalyReason = `Tool error: ${d.tool ?? "unknown"}`;
    }
    // Slow tool detection (>5000ms)
    if (d.durationMs != null && d.durationMs > 5000) {
      isAnomaly = true;
      anomalyReason = anomalyReason
        ? `${anomalyReason} | Slow tool: ${formatDuration(d.durationMs)}`
        : `Slow tool: ${d.tool ?? "unknown"} took ${formatDuration(d.durationMs)}`;
    }

    return {
      id: ev.id, ts: ev.ts, type: ev.type as EventType, agent: ev.agent,
      model: ev.model, cost: effectiveCost,
      inputTokens: ev.input_tokens, outputTokens: ev.output_tokens,
      cacheRead: ev.cache_read, cacheWrite: ev.cache_write,
      resolvedModel: ev.resolved_model, providerCost: ev.provider_cost,
      billing: ev.billing, runId: ev.run_id,
      toolName: d.tool ?? null, toolParams: d.params ?? null,
      toolResult: d.result ?? null, toolDuration: d.durationMs ?? null,
      toolError: (d.isError ?? (d.success === 0)) || false,
      messageContent: d.content ?? d.message ?? null,
      messageChannel: d.channel ?? null,
      promptPreview: d.promptPreview ?? null,
      historyCount: d.historyCount ?? null,
      hasThinking: (ev.has_thinking ?? 0) === 1,
      hasPrompt: (ev.has_prompt ?? 0) === 1,
      hasResponse: (ev.has_response ?? 0) === 1,
      stepIndex: i + 1, runningCost, runningTokens,
      deltaTime: i > 0 ? ev.ts - sorted[i - 1].ts : 0,
      relativeTime: ev.ts - firstTs,
      isAnomaly, anomalyReason,
    };
  });
}

function buildSummary(steps: ReplayStep[], sessionKey: string, truncated: boolean): SessionSummary {
  const tools = new Set<string>();
  let toolCalls = 0, llmCalls = 0;
  for (const s of steps) {
    if (s.type === "tool_call" && s.toolName) { tools.add(s.toolName); toolCalls++; }
    if (s.type === "llm_output") llmCalls++;
  }
  const last = steps[steps.length - 1];
  const { origin, channel } = parseSessionKey(sessionKey);
  // Determine agent by majority vote (most frequent), not first event
  const agentCounts: Record<string, number> = {};
  for (const s of steps) { agentCounts[s.agent] = (agentCounts[s.agent] ?? 0) + 1; }
  const majorityAgent = Object.entries(agentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? steps[0]?.agent ?? "";
  // Determine primary model from llm_output events (most frequent)
  const modelCounts: Record<string, number> = {};
  for (const s of steps) { if (s.type === "llm_output" && s.model) modelCounts[s.model] = (modelCounts[s.model] ?? 0) + 1; }
  const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? steps[0]?.model ?? null;
  return {
    agent: majorityAgent,
    model: primaryModel,
    origin,
    channel,
    stepCount: steps.length,
    duration: last ? last.relativeTime : 0,
    totalCost: last?.runningCost ?? 0,
    totalInputTokens: steps.reduce((s, e) => s + (e.inputTokens ?? 0), 0),
    totalOutputTokens: steps.reduce((s, e) => s + (e.outputTokens ?? 0), 0),
    totalCacheRead: steps.reduce((s, e) => s + (e.cacheRead ?? 0), 0),
    toolCallCount: toolCalls,
    llmCallCount: llmCalls,
    uniqueTools: Array.from(tools).sort(),
    hasAnomalies: steps.some(s => s.isAnomaly),
    billing: (() => {
      const bc: Record<string, number> = {};
      for (const s of steps) { if (s.billing) bc[s.billing] = (bc[s.billing] ?? 0) + 1; }
      return Object.entries(bc).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    })(),
    totalProviderCost: steps.reduce((sum, s) => sum + (s.providerCost ?? 0), 0),
    truncated,
  };
}

// ── Collapsible Section ─────────────────────────────────────────

function CollapsibleSection({
  label, defaultOpen, children, copyText,
}: {
  label: string; defaultOpen: boolean; children: React.ReactNode; copyText?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="replay-detail-section">
      <div className="replay-detail-section-label" onClick={() => setOpen(!open)}>
        <span className={`chevron ${open ? "chevron--open" : ""}`}>&#9654;</span>
        {label}
        {copyText && open && (
          <button className="replay-copy-btn" onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(copyText);
          }}>Copy</button>
        )}
      </div>
      {open && children}
    </div>
  );
}

// ── Thinking Block with line-limit expander ─────────────────────

function ThinkingBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const [expanded, setExpanded] = useState(lines.length <= 500);
  const displayed = expanded ? text : lines.slice(0, 500).join("\n");

  return (
    <div className="replay-detail-block replay-detail-block--mono replay-detail-block--thinking">
      {displayed}
      {!expanded && (
        <div style={{ marginTop: 8 }}>
          <button
            className="replay-copy-btn"
            style={{ fontSize: 12 }}
            onClick={() => setExpanded(true)}
          >
            Show all ({lines.length} lines)
          </button>
        </div>
      )}
    </div>
  );
}

// ── Detail Panel ────────────────────────────────────────────────

function DetailPanel({ step, detail, sessionKey }: { step: ReplayStep | null; detail: EventDetail | null; sessionKey: string }) {
  const [copiedLink, setCopiedLink] = useState(false);

  if (!step) return <div className="replay-detail"><div className="replay-detail-empty">Select a step to view details</div></div>;

  const typeLabel = TYPE_LABELS[step.type] ?? step.type;
  const typeColor = TYPE_COLORS[step.type] ?? "#888";
  const typeIcon = TYPE_ICONS[step.type] ?? "";
  const ts = new Date(step.ts).toLocaleTimeString();

  const copyStepLink = () => {
    const url = `${window.location.origin}/replay?session=${encodeURIComponent(sessionKey)}&step=${step.id}`;
    navigator.clipboard.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  return (
    <div className="replay-detail">
      <div className="replay-detail-header">
        <div className="replay-detail-title">
          <span style={{ color: typeColor }}>{typeIcon} Step {step.stepIndex}</span> &middot; {typeLabel} &middot; {ts}
          <button
            className="replay-copy-btn"
            style={{ marginLeft: 8 }}
            onClick={copyStepLink}
            title="Copy link to this step"
          >
            {copiedLink ? "Copied!" : "Link"}
          </button>
        </div>
        {step.model && (
          <div className="replay-detail-subtitle">
            Model: {step.model}
            {step.resolvedModel && step.resolvedModel !== step.model ? ` (resolved: ${step.resolvedModel})` : ""}
          </div>
        )}
        {step.type === "tool_call" && step.toolName && (
          <div className="replay-detail-subtitle">
            Tool: {step.toolName}
            {step.toolDuration != null ? ` \u00b7 ${formatDuration(step.toolDuration)}` : ""}
            {step.toolError
              ? <span style={{ color: "var(--accent-danger)" }}> \u00b7 Failed</span>
              : " \u00b7 Success"
            }
          </div>
        )}
        {(step.type === "msg_in" || step.type === "msg_out") && step.messageChannel && (
          <div className="replay-detail-subtitle">
            Channel: {step.messageChannel}
          </div>
        )}
      </div>

      {/* Message content (msg_in) — from detail.content or on-demand prompt */}
      {step.type === "msg_in" && (step.messageContent || step.hasPrompt) && (
        <CollapsibleSection label="Message" defaultOpen copyText={step.messageContent ?? detail?.prompt ?? undefined}>
          <div className="replay-detail-block replay-detail-block--message">
            {step.messageContent ?? detail?.prompt ?? "Loading message content..."}
          </div>
        </CollapsibleSection>
      )}

      {/* Message content (msg_out) */}
      {step.type === "msg_out" && step.messageContent && (
        <CollapsibleSection label="Outgoing Message" defaultOpen copyText={step.messageContent}>
          <div className="replay-detail-block replay-detail-block--message">{step.messageContent}</div>
        </CollapsibleSection>
      )}

      {/* Thinking */}
      {step.type === "llm_output" && step.hasThinking && (
        <CollapsibleSection label="Extended Thinking" defaultOpen copyText={detail?.thinking ?? undefined}>
          {detail?.thinking ? (
            <ThinkingBlock text={detail.thinking} />
          ) : (
            <div className="replay-detail-loading">Loading thinking content...</div>
          )}
        </CollapsibleSection>
      )}

      {/* Response */}
      {step.type === "llm_output" && step.hasResponse && (
        <CollapsibleSection label="Response" defaultOpen copyText={detail?.response ?? undefined}>
          {detail?.response ? (
            <div className="replay-detail-block replay-detail-block--response">{detail.response}</div>
          ) : (
            <div className="replay-detail-loading">Loading response...</div>
          )}
        </CollapsibleSection>
      )}

      {/* Prompt (llm_input) */}
      {step.type === "llm_input" && step.hasPrompt && (
        <CollapsibleSection label="Prompt" defaultOpen={false} copyText={detail?.prompt ?? undefined}>
          {detail?.prompt ? (
            <div className="replay-detail-block replay-detail-block--mono">
              {detail.prompt.length > 20000 ? detail.prompt.slice(0, 20000) + "\n\n... (truncated)" : detail.prompt}
            </div>
          ) : (
            <div className="replay-detail-loading">Loading prompt...</div>
          )}
        </CollapsibleSection>
      )}
      {step.type === "llm_input" && !step.hasPrompt && step.promptPreview && (
        <CollapsibleSection label="Prompt Preview" defaultOpen copyText={step.promptPreview}>
          <div className="replay-detail-block replay-detail-block--mono">
            {step.promptPreview}
          </div>
          {step.historyCount != null && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              {step.historyCount} messages in history
            </div>
          )}
        </CollapsibleSection>
      )}
      {step.type === "llm_input" && !step.hasPrompt && !step.promptPreview && (
        <div className="replay-detail-section">
          <div style={{ padding: "8px 12px", fontSize: "12px", color: "var(--text-muted)", fontStyle: "italic" }}>
            Prompt data not available for this event.
          </div>
        </div>
      )}

      {/* Tool params */}
      {step.type === "tool_call" && step.toolParams && (
        <CollapsibleSection label="Parameters" defaultOpen>
          <div className="replay-detail-block replay-detail-block--mono replay-detail-block--tool-params">
            {JSON.stringify(step.toolParams, null, 2)}
          </div>
        </CollapsibleSection>
      )}

      {/* Tool result */}
      {step.type === "tool_call" && step.toolResult && (
        <CollapsibleSection label="Result" defaultOpen={step.toolResult.length < 2000}>
          <div className={`replay-detail-block replay-detail-block--mono ${step.toolError ? "replay-detail-block--error" : "replay-detail-block--tool-result"}`}>
            {step.toolResult.length > 10000 ? step.toolResult.slice(0, 10000) + "\n\n... (truncated)" : step.toolResult}
          </div>
        </CollapsibleSection>
      )}

      {/* Token breakdown */}
      {(step.inputTokens || step.outputTokens) && (
        <CollapsibleSection label="Token Breakdown" defaultOpen>
          <div className="replay-tokens-grid">
            {step.inputTokens != null && step.inputTokens > 0 && (
              <><span className="replay-tokens-label">Input</span><span className="replay-tokens-value">{formatTokens(step.inputTokens)} tokens</span></>
            )}
            {step.outputTokens != null && step.outputTokens > 0 && (
              <><span className="replay-tokens-label">Output</span><span className="replay-tokens-value">{formatTokens(step.outputTokens)} tokens</span></>
            )}
            {step.cacheRead != null && step.cacheRead > 0 && (
              <><span className="replay-tokens-label">Cache Read</span><span className="replay-tokens-value">{formatTokens(step.cacheRead)} tokens ({((step.cacheRead / (step.inputTokens ?? 1)) * 100).toFixed(0)}%)</span></>
            )}
            {step.cacheWrite != null && step.cacheWrite > 0 && (
              <><span className="replay-tokens-label">Cache Write</span><span className="replay-tokens-value">{formatTokens(step.cacheWrite)} tokens</span></>
            )}
            <div className="replay-tokens-divider" />
            {step.cost != null && step.cost > 0 && (
              <><span className="replay-tokens-label">Cost</span><span className="replay-tokens-value">{step.billing === "subscription" ? `~${fmtCost(step.cost)} equiv` : fmtCost(step.cost)}</span></>
            )}
            {step.billing && (
              <><span className="replay-tokens-label">Billing</span><span className="replay-tokens-value">{step.billing}</span></>
            )}
          </div>
        </CollapsibleSection>
      )}

      {/* Anomaly banner */}
      {step.isAnomaly && step.anomalyReason && (
        <div className="replay-detail-section">
          <div className="replay-detail-block replay-detail-block--error" style={{ fontSize: 13 }}>
            {step.anomalyReason}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Timeline Step ───────────────────────────────────────────────

function TimelineStepRow({ step, isSelected, totalCost, onClick }: {
  step: ReplayStep; isSelected: boolean; totalCost: number; onClick: () => void;
}) {
  const icon = TYPE_ICONS[step.type] ?? "";
  const label = step.type === "tool_call" && step.toolName
    ? step.toolName
    : TYPE_LABELS[step.type] ?? step.type;

  // Content preview for timeline
  let preview = "";
  if (step.type === "msg_in" && (step.messageContent || step.hasPrompt)) {
    preview = step.messageContent ? truncatePreview(step.messageContent) : "(click to view)";
  } else if (step.type === "msg_out" && step.messageContent) {
    preview = truncatePreview(step.messageContent);
  } else if (step.type === "tool_call" && step.toolDuration != null) {
    preview = formatDuration(step.toolDuration);
  }

  // Anomaly badge character
  let anomalyBadge = "";
  if (step.isAnomaly) {
    if (step.anomalyReason?.includes("Cost spike")) anomalyBadge = "$";
    else if (step.anomalyReason?.includes("Model drift")) anomalyBadge = "\u26A0";
    else if (step.anomalyReason?.includes("Tool error")) anomalyBadge = "\u2717";
    else if (step.anomalyReason?.includes("Slow tool")) anomalyBadge = "\u{1F40C}";
    else anomalyBadge = "!";
  }

  return (
    <div
      className={`replay-step${isSelected ? " replay-step--selected" : ""}`}
      data-step-index={step.stepIndex - 1}
      onClick={onClick}
    >
      <div className="replay-step-top">
        <span className="replay-step-index">{step.stepIndex}</span>
        <span className="replay-step-type" style={{ color: TYPE_COLORS[step.type] ?? "#888" }}>
          {icon} {label}
        </span>
        {(step.cost ?? 0) > 0 && (
          <span className="replay-step-cost" style={step.isAnomaly && step.anomalyReason?.includes("Cost") ? { color: "var(--accent-danger)", fontWeight: 600 } : {}}>
            {step.billing === "subscription" ? `~${fmtCost(step.cost!)}` : fmtCost(step.cost!)}
          </span>
        )}
      </div>
      {preview && (
        <div className="replay-step-preview">{preview}</div>
      )}
      <div className="replay-step-bottom">
        {step.model && <span className="replay-step-model">{shortModel(step.model)}</span>}
        <span className="replay-step-time">{formatRelTime(step.relativeTime)}</span>
        {anomalyBadge && <span className="replay-step-anomaly">{anomalyBadge}</span>}
      </div>
      {totalCost > 0 && (
        <div className="replay-step-cost-bar">
          <div className="replay-step-cost-bar-fill" style={{ width: `${(step.runningCost / totalCost) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

// ── Main Replay Component ───────────────────────────────────────

export function ReplayContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionKey = searchParams.get("session") ?? "";
  const initialStepId = searchParams.get("step") ? Number(searchParams.get("step")) : null;

  const [steps, setSteps] = useState<ReplayStep[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [eventDetails, setEventDetails] = useState<Map<number, EventDetail>>(new Map());
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // Measure header + container padding and set exact height so controls bar is always visible
  useEffect(() => {
    function measure() {
      if (!pageRef.current) return;
      const rect = pageRef.current.getBoundingClientRect();
      const available = window.innerHeight - rect.top;
      pageRef.current.style.setProperty("--replay-h", `${available}px`);
    }
    requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [loading, error]);

  // Fetch all events for this session
  useEffect(() => {
    if (!sessionKey) { setError("No session key provided"); setLoading(false); return; }
    setLoading(true);

    const since = Date.now() - 90 * 24 * 60 * 60 * 1000;
    fetch(`${API_BASE}?endpoint=stream&session=${encodeURIComponent(sessionKey)}&limit=10000&since=${since}`)
      .then(r => { if (!r.ok) throw new Error("Failed to load session"); return r.json(); })
      .then((data: RawLogEvent[]) => {
        if (!Array.isArray(data) || data.length === 0) {
          setError("No events found for this session");
          setLoading(false);
          return;
        }
        const isTruncated = data.length >= MAX_EVENTS;
        setTruncated(isTruncated);
        // Use API-equiv cost for subscription, provider_cost for metered
        const costs = data
          .map(e => {
            const isSub = e.billing === "subscription";
            return isSub ? (e.cost ?? 0) : (e.provider_cost ?? e.cost ?? 0);
          })
          .filter(c => c > 0);
        const avgCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
        const built = buildReplaySteps(data, avgCost);
        setSteps(built);

        if (initialStepId) {
          const idx = built.findIndex(s => s.id === initialStepId);
          if (idx >= 0) setSelectedIndex(idx);
        }
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [sessionKey, initialStepId]);

  // On-demand detail loading
  useEffect(() => {
    const step = steps[selectedIndex];
    if (!step) return;
    if (eventDetails.has(step.id)) return;

    fetch(`${API_BASE}?endpoint=event-detail&id=${step.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.id) {
          setEventDetails(prev => new Map(prev).set(data.id, data));
        }
      })
      .catch(() => {});
  }, [selectedIndex, steps, eventDetails]);

  // Playback timer
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setSelectedIndex(prev => {
        if (prev >= steps.length - 1) { setIsPlaying(false); return prev; }
        return prev + 1;
      });
    }, 1000 / playSpeed);
    return () => clearInterval(interval);
  }, [isPlaying, playSpeed, steps.length]);

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) {
            setSelectedIndex(prev => { for (let i = prev - 1; i >= 0; i--) if (steps[i].type === "llm_output") return i; return 0; });
          } else {
            setSelectedIndex(prev => Math.max(0, prev - 1));
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) {
            setSelectedIndex(prev => { for (let i = prev + 1; i < steps.length; i++) if (steps[i].type === "llm_output") return i; return steps.length - 1; });
          } else {
            setSelectedIndex(prev => Math.min(steps.length - 1, prev + 1));
          }
          break;
        case " ":
          e.preventDefault();
          setIsPlaying(prev => !prev);
          break;
        case "Home": e.preventDefault(); setSelectedIndex(0); break;
        case "End": e.preventDefault(); setSelectedIndex(steps.length - 1); break;
        case "Escape": setIsPlaying(false); break;
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [steps]);

  // Scroll timeline to keep selected step visible
  useEffect(() => {
    if (!timelineRef.current) return;
    const el = timelineRef.current.querySelector(`[data-step-index="${selectedIndex}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIndex]);

  // Sync step index to URL for deep-linking
  useEffect(() => {
    if (steps.length === 0) return;
    const url = new URL(window.location.href);
    const step = steps[selectedIndex];
    if (step) {
      url.searchParams.set("step", String(step.id));
    }
    const newUrl = `${url.pathname}${url.search}${url.hash}`;
    if (newUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      history.replaceState(null, "", newUrl);
    }
  }, [selectedIndex, steps]);

  const summary = useMemo(() => steps.length > 0 ? buildSummary(steps, sessionKey, truncated) : null, [steps, sessionKey, truncated]);
  const currentStep = steps[selectedIndex] ?? null;
  const currentDetail = currentStep ? eventDetails.get(currentStep.id) ?? null : null;

  const handleStepClick = useCallback((index: number) => {
    setSelectedIndex(index);
    setIsPlaying(false);
  }, []);

  const handleJumpToStep = useCallback((index: number) => {
    setSelectedIndex(Math.max(0, Math.min(steps.length - 1, index)));
  }, [steps.length]);

  if (loading) {
    return <div className="replay-page" ref={pageRef}><div className="replay-loading">Loading session replay...</div></div>;
  }

  if (error || !summary) {
    return (
      <div className="replay-page">
        <div className="replay-error">
          <h2>Cannot load replay</h2>
          <p>{error || "No session data found"}</p>
          <button onClick={() => router.back()} className="replay-header-back">Go back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="replay-page" ref={pageRef}>
      {/* Session Header */}
      <div className="replay-header">
        <button className="replay-header-back" onClick={() => router.back()}>
          <span className="replay-header-back-full">Back</span>
          <span className="replay-header-back-compact">{"\u25C0"}</span>
        </button>
        <div className="replay-header-info">
          <div className="replay-header-primary">
            <span className="replay-header-agent">{summary.agent}</span>
            {summary.model && <span className="replay-header-model">{shortModel(summary.model)}</span>}
            {summary.origin !== "main" && (
              <span className="replay-header-origin">
                {summary.channel ? `#${summary.channel.slice(-6)} (${summary.origin})` : summary.origin}
              </span>
            )}
            {/* Inline stats for mobile */}
            <span className="replay-header-inline-stats">
              <span>{summary.stepCount} steps</span>
              <span className="replay-header-stat-cost">
                {fmtSessionCost(summary)}
              </span>
            </span>
          </div>
          <div className="replay-header-stats">
            <span>{summary.stepCount} steps</span>
            <span>{formatDuration(summary.duration)}</span>
            <span className="replay-header-stat-cost">
              {fmtSessionCost(summary)}
            </span>
            <span>{formatTokens(summary.totalInputTokens)} in / {formatTokens(summary.totalOutputTokens)} out</span>
            {summary.billing && <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>{summary.billing}</span>}
            {summary.hasAnomalies && <span style={{ color: "var(--accent-danger)" }}>Has anomalies</span>}
          </div>
        </div>
        <button
          className="replay-header-back"
          onClick={() => router.push(`/analysis?session=${encodeURIComponent(sessionKey)}`)}
          style={{ background: "rgba(99,102,241,0.15)", borderColor: "#818cf8", color: "#818cf8" }}
        >
          Analyze
        </button>
      </div>

      {/* Session too large warning */}
      {summary.truncated && (
        <div className="replay-truncation-warning">
          Session has {summary.stepCount}+ events. Showing first {MAX_EVENTS}.{" "}
          <a href={`/logs?session=${encodeURIComponent(sessionKey)}`}>View full session on Logs page</a>
        </div>
      )}

      {/* Run Intelligence Summary */}
      {sessionKey && (
        <div style={{ flexShrink: 0, overflow: "auto", maxHeight: "30vh" }}>
          <RunSummaryCard sessionKey={sessionKey} />
        </div>
      )}

      {/* Body: Timeline + Detail */}
      <div className="replay-body">
        <div className="replay-timeline" ref={timelineRef}>
          {steps.map((step, i) => {
            const showGap = step.deltaTime > 60_000 && i > 0;
            return (
              <div key={step.id}>
                {showGap && (
                  <div className="replay-time-gap">{formatDuration(step.deltaTime)} gap</div>
                )}
                <TimelineStepRow
                  step={step}
                  isSelected={i === selectedIndex}
                  totalCost={summary.totalCost}
                  onClick={() => handleStepClick(i)}
                />
              </div>
            );
          })}
        </div>

        {/* Mobile cost progress bar */}
        {summary.totalCost > 0 && currentStep && (
          <div className="replay-cost-bar-mobile">
            <span>{summary.billing === "subscription" ? "~" : ""}{fmtCost(currentStep.runningCost)}</span>
            <div className="replay-cost-bar-mobile-track">
              <div className="replay-cost-bar-mobile-fill" style={{ width: `${(currentStep.runningCost / summary.totalCost) * 100}%` }} />
            </div>
            <span>{fmtSessionCost(summary)}</span>
          </div>
        )}

        <DetailPanel step={currentStep} detail={currentDetail} sessionKey={sessionKey} />
      </div>

      {/* Playback Controls */}
      <div className="replay-controls">
        <div className="replay-controls-buttons">
          <button className="replay-controls-btn replay-controls-jump-btn" title="Previous LLM response (Shift+Left)" onClick={() => {
            for (let i = selectedIndex - 1; i >= 0; i--) if (steps[i].type === "llm_output") { handleJumpToStep(i); return; }
            handleJumpToStep(0);
          }}>&#9664;&#9664;</button>
          <button className="replay-controls-btn" title="Step back (Left)" onClick={() => handleJumpToStep(selectedIndex - 1)}>&#9664;</button>
          <button className={`replay-controls-btn${isPlaying ? " replay-controls-btn--active" : ""}`} title="Play/Pause (Space)" onClick={() => setIsPlaying(p => !p)}>
            {isPlaying ? "\u23F8" : "\u25B6"}
          </button>
          <button className="replay-controls-btn" title="Step forward (Right)" onClick={() => handleJumpToStep(selectedIndex + 1)}>&#9654;</button>
          <button className="replay-controls-btn replay-controls-jump-btn" title="Next LLM response (Shift+Right)" onClick={() => {
            for (let i = selectedIndex + 1; i < steps.length; i++) if (steps[i].type === "llm_output") { handleJumpToStep(i); return; }
            handleJumpToStep(steps.length - 1);
          }}>&#9654;&#9654;</button>
        </div>

        <span className="replay-controls-step-info">
          Step {(currentStep?.stepIndex ?? 0)} of {steps.length}
        </span>

        <div className="replay-controls-speed">
          {[1, 2, 4].map(speed => (
            <button
              key={speed}
              className={`replay-controls-speed-btn${playSpeed === speed ? " replay-controls-speed-btn--active" : ""}`}
              onClick={() => setPlaySpeed(speed)}
            >{speed}x</button>
          ))}
        </div>

        <input
          type="range"
          className="replay-controls-scrubber"
          min={0}
          max={Math.max(steps.length - 1, 0)}
          value={selectedIndex}
          onChange={(e) => handleJumpToStep(Number(e.target.value))}
        />

        <span className="replay-controls-time">
          {currentStep ? formatRelTime(currentStep.relativeTime) : "0:00"} / {formatRelTime(summary.duration)}
        </span>
      </div>
    </div>
  );
}

export default function ReplayPage() {
  return (
    <Suspense fallback={<div className="replay-page"><div className="replay-loading">Loading...</div></div>}>
      <ReplayContent />
    </Suspense>
  );
}
