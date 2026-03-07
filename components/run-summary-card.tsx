"use client";

import { useEffect, useState, useCallback } from "react";
import type { RunSummary, Comparison, BaselineComparison } from "@/lib/run-intelligence";

// ── Types ────────────────────────────────────────────────────────────

interface RunSummaryCardProps {
  sessionKey: string;
  /** Callback when a metric is clicked to filter timeline */
  onFilter?: (filter: string) => void;
}

interface SummaryResponse {
  ok: boolean;
  summary: RunSummary;
  comparison: Comparison;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function fmtCost(v: number): string {
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}

function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function shortModel(m: string): string {
  return m.replace(/^anthropic\//, "").replace(/-\d{8}$/, "");
}

// ── Status Badge ─────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { color: string; bg: string; label: string }> = {
  completed: { color: "#10b981", bg: "rgba(16,185,129,0.12)", label: "completed" },
  errored: { color: "#ef4444", bg: "rgba(239,68,68,0.12)", label: "errored" },
  live: { color: "#3b82f6", bg: "rgba(59,130,246,0.12)", label: "live" },
  unknown: { color: "#6b7280", bg: "rgba(107,114,128,0.12)", label: "unknown" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.unknown;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 10px", borderRadius: 12,
      fontSize: 12, fontWeight: 600,
      color: s.color, background: s.bg,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: s.color,
        ...(status === "live" ? { animation: "pulse 2s infinite" } : {}),
      }} />
      {s.label}
    </span>
  );
}

// ── Metric Cell ──────────────────────────────────────────────────────

function MetricCell({
  label, value, baseline, filterKey, onFilter,
}: {
  label: string;
  value: string;
  baseline?: BaselineComparison | null;
  filterKey?: string;
  onFilter?: (filter: string) => void;
}) {
  const clickable = filterKey && onFilter;
  return (
    <div
      className="ri-metric"
      style={{ cursor: clickable ? "pointer" : "default" }}
      onClick={() => clickable && onFilter(filterKey)}
      title={clickable ? `Filter timeline to ${label.toLowerCase()}` : undefined}
    >
      <div className="ri-metric-label">{label}</div>
      <div className="ri-metric-value">{value}</div>
      {baseline && (
        <div className="ri-metric-baseline">
          agent: {label.toLowerCase().includes("cost")
            ? fmtCost(baseline.median)
            : label.toLowerCase().includes("duration")
              ? fmtDuration(baseline.median)
              : fmtTokens(baseline.median)
          }
          {baseline.ratio != null && (
            <span className={`ri-ratio ${baseline.ratio > 1.5 ? "ri-ratio--high" : "ri-ratio--low"}`}>
              ({baseline.ratio}×)
            </span>
          )}
          <span className="ri-baseline-n">(n={baseline.count})</span>
        </div>
      )}
    </div>
  );
}

// ── Risk Flags ───────────────────────────────────────────────────────

function RiskFlags({ summary }: { summary: RunSummary }) {
  const flags: string[] = [];
  if (summary.touchedConfig) flags.push("config modified");
  if (summary.gatewayRestarted) flags.push("gateway restarted");
  if (summary.rollbackDuringRun) flags.push("config rollback");
  if (summary.blockedByBudget) flags.push("budget blocked");
  if (summary.throttledByBudget) flags.push("budget throttled");
  if (summary.overrideActive) flags.push("override active");

  if (!flags.length) return <span className="ri-risk-none">none</span>;

  return (
    <span className="ri-risk-flags">
      {flags.map(f => (
        <span key={f} className="ri-risk-flag">{f}</span>
      ))}
    </span>
  );
}

// ── Main Component ───────────────────────────────────────────────────

export default function RunSummaryCard({ sessionKey, onFilter }: RunSummaryCardProps) {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(() => {
    fetch(`/api/logs/session-summary?session=${encodeURIComponent(sessionKey)}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: SummaryResponse) => {
        if (!d.ok) throw new Error(d.error || "Unknown error");
        setData(d);
        setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [sessionKey]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  // Auto-refresh for live sessions
  useEffect(() => {
    if (!data?.summary || data.summary.status !== "live") return;
    const interval = setInterval(fetchSummary, 30_000);
    return () => clearInterval(interval);
  }, [data?.summary?.status, fetchSummary]);

  if (loading) {
    return (
      <div className="ri-card ri-card--loading">
        <div className="ri-skeleton" style={{ width: 120, height: 16 }} />
        <div className="ri-skeleton-row">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="ri-skeleton" style={{ width: 80, height: 32 }} />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data?.summary) {
    return null; // Silently hide if no data — replay still works without it
  }

  const { summary, comparison } = data;
  const agentComp = comparison?.agent ?? {};
  const globalComp = comparison?.global ?? {};

  return (
    <div className="ri-card">
      {/* Top row: status, duration, timestamp */}
      <div className="ri-header">
        <StatusBadge status={summary.status} />
        <span className="ri-duration">{fmtDuration(summary.durationMs)}</span>
        <span className="ri-started">Started {fmtDate(summary.startedTs)}</span>
        {summary.status === "live" && (
          <span className="ri-live-note">auto-refreshing</span>
        )}
      </div>

      {/* Metrics grid */}
      <div className="ri-metrics">
        <MetricCell
          label="Cost"
          value={`${summary.billing === "subscription" ? "~" : ""}${fmtCost(summary.totalCostUsd)}${summary.billing === "subscription" ? " equiv" : ""}`}
          baseline={agentComp.totalCostUsd ?? globalComp.totalCostUsd}
          filterKey="cost"
          onFilter={onFilter}
        />
        <MetricCell
          label="Tokens In / Out"
          value={`${fmtTokens(summary.totalTokensIn)} / ${fmtTokens(summary.totalTokensOut)}`}
          baseline={agentComp.totalTokensIn ?? globalComp.totalTokensIn}
        />
        <MetricCell
          label="Tools"
          value={`${summary.toolCallCount} calls`}
          baseline={agentComp.toolCallCount ?? globalComp.toolCallCount}
          filterKey="tools"
          onFilter={onFilter}
        />
        <MetricCell
          label="Loops"
          value={`depth: ${summary.maxLoopDepth}`}
          filterKey="loops"
          onFilter={onFilter}
        />
      </div>

      {/* Bottom row: models, errors, retries, risk */}
      <div className="ri-footer">
        <span className="ri-models">
          Models: {summary.modelSet.map(shortModel).join(", ") || "—"}
        </span>
        {summary.errorCount > 0 && (
          <span
            className="ri-errors"
            onClick={() => onFilter?.("errors")}
            style={{ cursor: onFilter ? "pointer" : "default" }}
          >
            Errors: {summary.errorCount}
          </span>
        )}
        {summary.retryCount > 0 && (
          <span
            className="ri-retries"
            onClick={() => onFilter?.("retries")}
            style={{ cursor: onFilter ? "pointer" : "default" }}
          >
            Retries: {summary.retryCount}
          </span>
        )}
        <span className="ri-risk">
          Risk: <RiskFlags summary={summary} />
        </span>
      </div>
    </div>
  );
}
