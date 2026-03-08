"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useHashTab } from "@/components/use-hash-tab";
import { ReplayContent } from "@/app/replay/page";
import { ActivityView } from "@/components/activity-view";
import "@/app/replay/replay.css";

// ── Types ────────────────────────────────────────────────────────────────────

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
  origin?: string;
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/^anthropic\//, "")
    .replace(/^openai\//, "");
}

function sessionLogUrl(agentKey: string, _agentId: string, s: SessionInfo): string {
  // Pass the primary session key only — the API resolves variants server-side.
  // Comma-separated variants break the logs page useUrlState session-kind filter.
  const p = new URLSearchParams();
  p.set("session", s.fullKey);
  // Pass time range so logs page doesn't default to "today" for older sessions
  if (s.updatedAt) {
    p.set("since", String(s.updatedAt - 86_400_000));
    p.set("until", String(s.updatedAt + 3_600_000));
  }
  return `/logs?${p.toString()}`;
}

function archivedLogUrl(agentKey: string, agentId: string, a: ArchivedSession, origin?: string): string {
  // Pick the best single session key — the API resolves variants server-side
  const key = (origin && !origin.startsWith("archived:"))
    ? origin
    : (a.sessionKey && !a.sessionKey.startsWith("archived:"))
      ? a.sessionKey
      : a.sessionId ? `${agentId}/${a.sessionId}.jsonl` : null;
  if (!key) return `/logs?agent=${agentKey}`;
  const p = new URLSearchParams();
  p.set("session", key);
  if (a.archivedAt) {
    const ts = new Date(a.archivedAt).getTime();
    if (ts) { p.set("since", String(ts - 86_400_000)); p.set("until", String(ts + 3_600_000)); }
  }
  return `/logs?${p.toString()}`;
}

// ── Agent Sessions Tab ───────────────────────────────────────────────────────

interface SessionContextInfo {
  session: string;
  contextPercent: number;
  promptTokens: number;
  maxContext: number;
  estimatedTurnsLeft: number | null;
}

function contextColor(pct: number): string | undefined {
  if (pct > 80) return "var(--accent-danger)";
  if (pct > 50) return "var(--accent-warning)";
  return "var(--accent)";
}

function AgentSessionsTab() {
  const [sessionAgents, setSessionAgents] = useState<AgentSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [contextMap, setContextMap] = useState<Map<string, SessionContextInfo>>(new Map());

  const loadSessions = useCallback(() => {
    Promise.all([
      fetch("/api/agent-sessions").then(r => r.json()),
      fetch("/api/session-context").then(r => r.json()).catch(() => ({ sessions: [] })),
    ]).then(([data, ctxData]) => {
      if (data.ok) setSessionAgents(data.agents);
      if (ctxData.sessions) {
        const m = new Map<string, SessionContextInfo>();
        for (const s of ctxData.sessions) {
          m.set(s.session, { session: s.session, contextPercent: s.contextPercent, promptTokens: s.promptTokens, maxContext: s.maxContext, estimatedTurnsLeft: s.estimatedTurnsLeft });
        }
        setContextMap(m);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 15_000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: 0 }}>
            Active sessions per agent with token usage and transcript info.
          </p>
        </div>
        <button
          className="svc-btn svc-btn--sm"
          onClick={() => { setLoading(true); loadSessions(); }}
          disabled={loading}
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {loading && sessionAgents.length === 0 ? (
        <div style={{ padding: "12px", color: "var(--text-muted)", fontSize: "13px" }}>Loading sessions...</div>
      ) : (
        <div className="svc-sessions-list">
          {sessionAgents.map((agent) => (
            <div key={agent.key} className="svc-sessions-agent">
              <div
                className="svc-sessions-agent-row"
                onClick={() => setExpandedAgent(expandedAgent === agent.key ? null : agent.key)}
                style={{ cursor: "pointer" }}
              >
                <span className="svc-sessions-agent-name">
                  <span style={{ marginRight: "6px" }}>{expandedAgent === agent.key ? "▼" : "▶"}</span>
                  {agent.emoji !== "X" ? agent.emoji : ""} {agent.name}
                </span>
                <span className="svc-sessions-agent-stats">
                  <span className="svc-badge svc-badge--mono">{agent.sessionCount} active</span>
                  {agent.archived.length > 0 && (
                    <span className="svc-badge svc-badge--stopped" style={{ fontSize: "10px" }}>{agent.archived.length} archived</span>
                  )}
                  <span className="svc-badge svc-badge--mono">{formatTokens(agent.totalTokens)} tokens</span>
                  {agent.lastActive && (
                    <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      {timeAgo(agent.lastActive)}
                    </span>
                  )}
                </span>
              </div>

              {expandedAgent === agent.key && agent.sessions.length > 0 && (
                <div className="svc-sessions-detail">
                  <table className="svc-sessions-table">
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th>Status</th>
                        <th>Channel</th>
                        <th>Model</th>
                        <th>Context</th>
                        <th>Tokens</th>
                        <th>Transcript</th>
                        <th>Last Active</th>
                        <th>Logs</th>
                        <th>Replay</th>
                        <th>Analysis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agent.sessions.map((s, i) => {
                        const isArchived = s.status !== "active";
                        const logUrl = isArchived
                          ? archivedLogUrl(agent.key, agent.agentId, { sessionId: s.sessionId, sessionKey: s.fullKey, archiveType: s.archiveType!, archivedAt: s.archivedAt || "", sizeKB: s.transcriptSizeKB, filename: s.filename || "" }, s.origin)
                          : sessionLogUrl(agent.key, agent.agentId, s);
                        return (
                          <tr key={i} style={isArchived ? { opacity: 0.7 } : undefined}>
                            <td>
                              <a
                                className="svc-sessions-key svc-sessions-link"
                                href={logUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={isArchived ? (s.filename || s.displayName) : `View logs for ${s.displayName}`}
                              >
                                {s.label || s.groupChannel || s.key}
                              </a>
                            </td>
                            <td>
                              {isArchived ? (
                                <span className={`svc-badge svc-badge--${s.status === "deleted" ? "stopped" : s.status === "compacted" ? "idle" : "mono"}`}>
                                  archived
                                </span>
                              ) : (
                                <span className="svc-badge svc-badge--running">live</span>
                              )}
                            </td>
                            <td>{s.channel || "—"}</td>
                            <td>
                              {s.model ? (
                                <span className="svc-badge svc-badge--mono">{shortModel(s.model)}</span>
                              ) : "—"}
                            </td>
                            <td>
                              {(() => {
                                const ctx = contextMap.get(s.fullKey);
                                if (!ctx || s.status !== "active") return <span style={{ color: "var(--text-muted)" }}>—</span>;
                                const turnsTitle = ctx.estimatedTurnsLeft != null ? ` · ~${ctx.estimatedTurnsLeft} turns left` : "";
                                return (
                                  <span style={{ color: contextColor(ctx.contextPercent), fontWeight: ctx.contextPercent > 80 ? 600 : undefined }}
                                    title={`${formatTokens(ctx.promptTokens)} / ${formatTokens(ctx.maxContext)}${turnsTitle}`}>
                                    {ctx.contextPercent.toFixed(1)}%
                                    {ctx.estimatedTurnsLeft != null && ctx.estimatedTurnsLeft <= 10 && (
                                      <span style={{ fontSize: 10, marginLeft: 3, opacity: 0.7 }}>~{ctx.estimatedTurnsLeft}t</span>
                                    )}
                                  </span>
                                );
                              })()}
                            </td>
                            <td>
                              {s.totalTokens > 0 ? (
                                <span title={`In: ${formatTokens(s.inputTokens)} | Out: ${formatTokens(s.outputTokens)} | Ctx: ${formatTokens(s.contextTokens)}`}>
                                  {formatTokens(s.totalTokens)}
                                </span>
                              ) : "—"}
                            </td>
                            <td>
                              {s.hasTranscript ? (
                                <span className="svc-badge svc-badge--mono">{s.transcriptSizeKB} KB</span>
                              ) : (
                                <span style={{ color: "var(--text-muted)" }}>none</span>
                              )}
                            </td>
                            <td style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                              {s.updatedAt ? timeAgo(s.updatedAt) : "—"}
                            </td>
                            <td>
                              {s.status !== "compacted" ? (
                                <a
                                  className="svc-btn svc-btn--sm svc-sessions-logs-btn"
                                  href={logUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  Logs
                                </a>
                              ) : "—"}
                            </td>
                            <td>
                              <a
                                href={`/replay?session=${encodeURIComponent((s as Record<string, string>).session_key || s.fullKey || '')}`}
                                className="svc-btn svc-btn--sm"
                                title="Replay session"
                              >
                                ▶
                              </a>
                            </td>
                            <td>
                              <a
                                href={`/analysis?session=${encodeURIComponent((s as Record<string, string>).session_key || s.fullKey || '')}`}
                                className="svc-btn svc-btn--sm"
                                title="Analyze session"
                              >
                                Analysis
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {expandedAgent === agent.key && agent.sessions.length === 0 && (
                <div style={{ padding: "8px 16px", fontSize: "12px", color: "var(--text-muted)", fontStyle: "italic" }}>
                  No sessions found.
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Replay Tab ───────────────────────────────────────────────────────────────

function ReplayTab() {
  const searchParams = useSearchParams();
  const sessionKey = searchParams.get("session") ?? "";

  if (!sessionKey) {
    return (
      <div style={{ padding: "48px 24px", textAlign: "center", color: "var(--text-muted)" }}>
        <p style={{ fontSize: "15px", marginBottom: 8 }}>No session selected</p>
        <p style={{ fontSize: "13px" }}>
          Click a ▶ replay button in the Agent Sessions tab to load a session replay.
        </p>
      </div>
    );
  }

  return <ReplayContent />;
}

// ── Page ─────────────────────────────────────────────────────────────────────

type Tab = "sessions" | "activity" | "replay";

function SessionsPageContent() {
  const [activeTab, setActiveTab] = useHashTab<Tab>("sessions", ["sessions", "activity", "replay"]);

  return (
    <div style={{ padding: "0 0 40px" }}>
      <div style={{ marginBottom: "16px" }}>
        <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 4px" }}>Sessions</h2>
      </div>

      <div className="ds-tabs" style={{ marginBottom: 16 }}>
        <button
          className={`ds-tab${activeTab === "sessions" ? " active" : ""}`}
          onClick={() => setActiveTab("sessions")}
        >
          Agent Sessions
        </button>
        <button
          className={`ds-tab${activeTab === "activity" ? " active" : ""}`}
          onClick={() => setActiveTab("activity")}
        >
          Activity
        </button>
        <button
          className={`ds-tab${activeTab === "replay" ? " active" : ""}`}
          onClick={() => setActiveTab("replay")}
        >
          Replay
        </button>
      </div>

      {activeTab === "sessions" && <AgentSessionsTab />}
      {activeTab === "activity" && <ActivityView />}
      {activeTab === "replay" && <ReplayTab />}
    </div>
  );
}

export default function SessionsPage() {
  return (
    <Suspense fallback={<div className="loading">Loading...</div>}>
      <SessionsPageContent />
    </Suspense>
  );
}
