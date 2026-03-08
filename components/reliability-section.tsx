"use client";

import { useEffect, useState, useCallback } from "react";
import { useUrlState } from "@/components/use-url-state";
import { FilterChips } from "@/components/filter-chips";

interface ProviderHealthRow {
  provider: string;
  successes: number;
  failures: number;
  errorRate: number;
  lastSuccess: number;
  lastFailure: number;
  lastError: string;
  avgLatencyMs: number;
}

interface SessionContextRow {
  agent: string;
  session: string;
  model: string;
  promptTokens: number;
  maxContext: number;
  contextPercent: number;
  lastCallTs: number;
  turnCount: number;
  avgTokensPerTurn: number;
  estimatedTurnsLeft: number | null;
}

interface MessageDeliveryRow {
  agent: string;
  sent: number;
  received: number;
  lastSent: number;
  lastReceived: number;
}

interface SessionCostRow {
  agent: string;
  session: string;
  cost: number;
  calls: number;
  firstTs: number;
  lastTs: number;
}

interface PollerStatus {
  running: boolean;
  lastPollMs: number;
  filesTracked: number;
  eventsInsertedTotal: number;
  eventsInsertedLastPoll: number;
  pendingCallsInFlight: number;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function shortSession(s: string): string {
  // Strip agent:xxx: prefix → show "discord:channel:123" or "channel:123"
  const m = s.match(/^[^:]+:[^:]+:(.+)$/);
  return m ? m[1] : s;
}

function contextColor(pct: number): string | undefined {
  if (pct > 80) return "var(--accent-danger)";
  if (pct > 50) return "var(--accent-warning)";
  return "var(--accent)";
}

export function ReliabilitySection() {
  const [providers, setProviders] = useState<ProviderHealthRow[]>([]);
  const [context, setContext] = useState<SessionContextRow[]>([]);
  const [messages, setMessages] = useState<MessageDeliveryRow[]>([]);
  const [sessions, setSessions] = useState<{ cap: number | Record<string, unknown>; sessions: SessionCostRow[] }>({ cap: 5, sessions: [] });
  const [poller, setPoller] = useState<PollerStatus | null>(null);
  const [relFilters, setRelFilter] = useUrlState({
    "rel.tab": { type: "string" as const, default: "providers" },
  });
  const tab = relFilters["rel.tab"] as "providers" | "context" | "messages" | "sessions" | "poller";
  const setTab = useCallback((v: string) => setRelFilter("rel.tab", v), [setRelFilter]);

  useEffect(() => {
    const since = Date.now() - 7 * 86400000;
    Promise.all([
      fetch("/api/logs?endpoint=reliability-providers").then(r => r.json()).catch(() => []),
      fetch("/api/session-context").then(r => r.json()).then(d => d.sessions ?? []).catch(() => []),
      fetch(`/api/logs?endpoint=reliability-messages&since=${since}`).then(r => r.json()).catch(() => []),
      fetch("/api/logs?endpoint=reliability-sessions").then(r => r.json()).catch(() => ({ cap: 5, sessions: [] })),
      fetch("/api/logs?endpoint=poller-status").then(r => r.json()).catch(() => null),
    ]).then(([p, c, m, s, pol]) => {
      if (Array.isArray(p)) setProviders(p);
      if (Array.isArray(c)) setContext(c);
      if (Array.isArray(m)) setMessages(m);
      if (s && s.sessions) setSessions(s);
      if (pol) setPoller(pol);
    });
  }, []);

  // cap may be a number or {default, agents, action} object from the API
  const rawCap = sessions.cap;
  const capNum = typeof rawCap === "number" ? rawCap : (rawCap as Record<string, unknown>)?.default as number ?? 5;

  const hasData = providers.length > 0 || context.length > 0 || messages.length > 0;
  if (!hasData && !poller) return null;

  return (
    <div className="cg-tool-costs">
      <div className="cg-tool-costs-header">
        <h3>Reliability</h3>
        <FilterChips
          label=""
          options={[
            { key: "providers", label: "Providers" },
            { key: "context", label: "Context %" },
            { key: "messages", label: "Messages" },
            { key: "sessions", label: "Sessions" },
            { key: "poller", label: "Poller" },
          ]}
          selected={tab}
          onChange={setTab}
        />
      </div>

      {tab === "providers" && (
        <table className="cg-tool-table">
          <thead><tr><th>Provider</th><th>Success</th><th>Failures</th><th>Error Rate</th><th>Avg Latency</th><th>Last Error</th></tr></thead>
          <tbody>
            {providers.length === 0 && <tr><td colSpan={6} className="muted">No provider data yet (populates after LLM calls)</td></tr>}
            {providers.map(p => (
              <tr key={p.provider} className="cg-tool-row">
                <td className="cg-tool-name">{p.provider}</td>
                <td>{p.successes}</td>
                <td>{p.failures > 0 ? <span style={{ color: "var(--accent-danger)" }}>{p.failures}</span> : "0"}</td>
                <td>{(p.errorRate * 100).toFixed(1)}%</td>
                <td>{p.avgLatencyMs > 0 ? `${p.avgLatencyMs}ms` : "—"}</td>
                <td className="muted" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{p.lastError || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "context" && (
        <table className="cg-tool-table">
          <thead><tr><th>Agent</th><th>Session</th><th>Context</th><th>~Turns Left</th><th>Model</th><th>Last Call</th></tr></thead>
          <tbody>
            {context.length === 0 && <tr><td colSpan={6} className="muted">No session context data yet</td></tr>}
            {context.map((c, i) => (
              <tr key={i} className="cg-tool-row" style={c.contextPercent > 80 ? { background: "rgba(239,68,68,0.1)" } : undefined}>
                <td className="cg-tool-name">{c.agent}</td>
                <td className="muted" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }} title={c.session}>{shortSession(c.session)}</td>
                <td>
                  <span style={{ color: contextColor(c.contextPercent) }}>
                    {formatTokens(c.promptTokens)} / {formatTokens(c.maxContext)}
                  </span>
                  {c.contextPercent > 80 && " \u26A0\uFE0F"}
                  <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>({c.contextPercent.toFixed(1)}%)</span>
                </td>
                <td>
                  {c.estimatedTurnsLeft != null ? (
                    <span style={{ color: c.estimatedTurnsLeft <= 3 ? "var(--accent-danger)" : c.estimatedTurnsLeft <= 10 ? "var(--accent-warning)" : undefined }}>
                      ~{c.estimatedTurnsLeft}
                    </span>
                  ) : "—"}
                  {c.turnCount > 0 && <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>({c.turnCount} done)</span>}
                </td>
                <td><span className="muted">{c.model.replace(/^claude-/, "").replace(/^anthropic\//, "")}</span></td>
                <td className="muted">{c.lastCallTs > 0 ? timeAgo(c.lastCallTs) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "messages" && (
        <table className="cg-tool-table">
          <thead><tr><th>Agent</th><th>Sent</th><th>Received</th><th>Last Sent</th><th>Last Received</th></tr></thead>
          <tbody>
            {messages.map(m => (
              <tr key={m.agent} className="cg-tool-row">
                <td className="cg-tool-name">{m.agent}</td>
                <td>{m.sent}</td>
                <td>{m.received}</td>
                <td className="muted">{m.lastSent > 0 ? timeAgo(m.lastSent) : "never"}</td>
                <td className="muted">{m.lastReceived > 0 ? timeAgo(m.lastReceived) : "never"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "sessions" && (
        <>
          <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Session cost cap: ${capNum}. Sessions exceeding cap trigger alerts.</p>
          <table className="cg-tool-table">
            <thead><tr><th>Agent</th><th>Session</th><th>Cost</th><th>Calls</th><th>Duration</th></tr></thead>
            <tbody>
              {sessions.sessions.length === 0 && <tr><td colSpan={5} className="muted">No expensive sessions tracked yet</td></tr>}
              {sessions.sessions.map((s, i) => (
                <tr key={i} className="cg-tool-row" style={(s.cost ?? 0) >= capNum ? { background: "rgba(239,68,68,0.1)" } : undefined}>
                  <td className="cg-tool-name">{s.agent}</td>
                  <td className="muted" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{s.session.split("/").pop()}</td>
                  <td className="cg-tool-cost" style={(s.cost ?? 0) >= capNum ? { color: "var(--accent-danger)" } : undefined}>${(s.cost ?? 0).toFixed(4)}</td>
                  <td>{s.calls}</td>
                  <td className="muted">{s.lastTs > 0 && s.firstTs > 0 ? `${Math.round((s.lastTs - s.firstTs) / 60000)}m` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === "poller" && poller && (
        <table className="cg-tool-table">
          <thead><tr><th>Metric</th><th>Value</th></tr></thead>
          <tbody>
            <tr className="cg-tool-row"><td>Status</td><td>{poller.running ? <span style={{ color: "var(--accent)" }}>Running</span> : <span style={{ color: "var(--accent-danger)" }}>Stopped</span>}</td></tr>
            <tr className="cg-tool-row"><td>Files Tracked</td><td>{poller.filesTracked}</td></tr>
            <tr className="cg-tool-row"><td>Events Inserted (Total)</td><td>{poller.eventsInsertedTotal}</td></tr>
            <tr className="cg-tool-row"><td>Events Inserted (Last Poll)</td><td>{poller.eventsInsertedLastPoll}</td></tr>
            <tr className="cg-tool-row"><td>Pending Tool Calls</td><td>{poller.pendingCallsInFlight}</td></tr>
            <tr className="cg-tool-row"><td>Last Poll</td><td className="muted">{poller.lastPollMs > 0 ? timeAgo(poller.lastPollMs) : "never"}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
