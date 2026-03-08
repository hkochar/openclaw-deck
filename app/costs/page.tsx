"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useUrlState } from "@/components/use-url-state";
import { FilterChips } from "@/components/filter-chips";

// ── Types ────────────────────────────────────────────────────────

interface TimelineBucket {
  ts: number;
  cost: number;
  calls: number;
  tokens: number;
}

interface AgentTimeline {
  agent: string;
  buckets: TimelineBucket[];
  total: number;
  billing: string;
}

interface ModelBreakdown {
  model: string;
  provider: string;
  requests: number;
  cost: number;
  billing: string;
  apiEquivalent?: number;
}

interface AgentCost {
  agent: string;
  daily: number;
  weekly: number;
  monthly: number;
  dailyRequests: number;
  weeklyRequests: number;
  monthlyRequests: number;
  hourly: Array<{ hour: number; cost: number; requests: number }>;
  billing: string;
  models: ModelBreakdown[];
  budget: { daily?: number; weekly?: number; monthly?: number; dailyRequests?: number; weeklyRequests?: number; action?: string } | null;
  paused: boolean;
  pauseReason: string | null;
  dailyPercent: number | null;
  apiEquivDaily?: number;
  apiEquivWeekly?: number;
  apiEquivMonthly?: number;
  cronDaily?: number;
  cronWeekly?: number;
  cronMonthly?: number;
  cronDailyReqs?: number;
  cronWeeklyReqs?: number;
  cronMonthlyReqs?: number;
  range?: number;
  rangeReqs?: number;
  apiEquivRange?: number;
  cronRange?: number;
  cronRangeReqs?: number;
  // Phase 1 enforcement fields
  budgetAction?: string;
  throttledTo?: string | null;
  blockedAttempts?: number;
  autoRecovery?: boolean;
  pausedSince?: number | null;
  override?: { agent: string; expiresAt: number; reason: string; createdAt: number } | null;
}

interface BudgetStatus {
  agents: AgentCost[];
  global: { daily?: number; weekly?: number; monthly?: number; dailyRequests?: number; weeklyRequests?: number };
  alertThresholds: number[];
  pricing: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
  error?: string;
}

interface ProviderWindowStatus {
  windowId: string;
  provider: string;
  label: string;
  used: number;
  limit: number;
  pct: number;
  breakdown?: { model: string; raw: number; weighted: number }[];
  windowStart?: number;
  resetsAt?: number;
  rolling?: boolean;
}

type TimeRange = "today" | "7d" | "14d" | "mtd" | "90d" | "ytd" | "all" | "custom";
type BillingFilter = "all" | "metered" | "subscription";
type SortBy = "cost" | "requests" | "name";

const TIME_RANGE_PRESETS: Record<Exclude<TimeRange, "custom">, { label: string; since: () => number }> = {
  today:  { label: "Today",  since: () => { const d = new Date(); d.setUTCHours(0,0,0,0); return d.getTime(); } },
  "7d":   { label: "7d",     since: () => Date.now() - 7 * 86400000 },
  "14d":  { label: "14d",    since: () => Date.now() - 14 * 86400000 },
  mtd:    { label: "MTD",    since: () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0,0,0,0); return d.getTime(); } },
  "90d":  { label: "90d",    since: () => Date.now() - 90 * 86400000 },
  ytd:    { label: "YTD",    since: () => { const d = new Date(); d.setUTCMonth(0,1); d.setUTCHours(0,0,0,0); return d.getTime(); } },
  all:    { label: "All",    since: () => Date.now() - 365 * 86400000 },
};

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getTimeRangeLabel(tr: TimeRange, customStart: string, customEnd: string): string {
  if (tr === "custom") return `${customStart} → ${customEnd}`;
  return TIME_RANGE_PRESETS[tr].label;
}

// ── Sparkline SVG ────────────────────────────────────────────────

function Sparkline({ data, width = 120, height = 28 }: { data: number[]; width?: number; height?: number }) {
  const max = Math.max(...data, 0.001);
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width={width} height={height} className="cg-sparkline">
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ── Progress Bar ─────────────────────────────────────────────────

function BudgetBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const color = pct >= 100 ? "#ef4444" : pct >= 80 ? "#f59e0b" : "#22c55e";
  return (
    <div className="cg-bar-track">
      <div className="cg-bar-fill" style={{ width: `${pct}%`, background: color }} />
      <span className="cg-bar-label">{pct.toFixed(0)}%</span>
    </div>
  );
}

// ── Provider Section (unified spend + rate limits per provider) ──

interface ProviderSpend {
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  limit: number | null;
  limitRemaining: number | null;
  ts: number;
}

const PROVIDER_DISPLAY: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

function providerDisplayName(key: string): string {
  return PROVIDER_DISPLAY[key.toLowerCase()] ?? key;
}

// ── Format helpers ───────────────────────────────────────────────

function fmtCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Agent Card ───────────────────────────────────────────────────

function formatRelativeTime(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return "expired";
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.ceil(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

function AgentCard({
  agent,
  agentMeta,
  onTogglePause,
  onStartOverride,
  onClearOverride,
  timeRange,
  costView,
  buildLogsUrl,
}: {
  agent: AgentCost;
  agentMeta: Record<string, { name: string; emoji: string }>;
  onTogglePause: (agent: string, paused: boolean) => void;
  onStartOverride: (agent: string, hours: number, reason: string) => void;
  onClearOverride: (agent: string) => void;
  timeRange: TimeRange;
  costView: "actual" | "equiv" | "total";
  buildLogsUrl: (extra?: Record<string, string>) => string;
}) {
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const meta = agentMeta[agent.agent];
  const emoji = meta?.emoji ?? "🤖";
  const name = meta?.name ?? agent.agent;
  const hasCostBudget = agent.budget?.daily && agent.budget.daily > 0;
  const hasReqBudget = (agent.budget?.dailyRequests && agent.budget.dailyRequests > 0) || (agent.budget?.weeklyRequests && agent.budget.weeklyRequests > 0);
  const isSub = agent.billing === "subscription";
  const isMixed = agent.billing === "mixed";
  const billingLabel = isSub ? "SUB" : isMixed ? "MIXED" : "API";
  const billingClass = isSub ? "cg-badge--sub" : isMixed ? "cg-badge--mixed" : "cg-badge--api";

  // Use range fields (from since param) as primary, fall back to monthly
  const periodCost = agent.range ?? agent.monthly;
  const periodReqs = agent.rangeReqs ?? agent.monthlyRequests;
  const periodApiEquiv = agent.apiEquivRange ?? (agent.apiEquivMonthly ?? 0);
  const periodCronCost = agent.cronRange ?? (agent.cronMonthly ?? 0);
  const periodCronReqs = agent.cronRangeReqs ?? (agent.cronMonthlyReqs ?? 0);
  const showApiEquiv = costView !== "actual";
  const showCost = !isSub || showApiEquiv;
  const periodLabel = timeRange === "custom" ? "Custom" : TIME_RANGE_PRESETS[timeRange].label;

  const visibleModels = modelsExpanded ? (agent.models ?? []) : (agent.models ?? []).slice(0, 3);
  const hiddenCount = (agent.models ?? []).length - 3;

  return (
    <div className={`cg-card${agent.paused ? " cg-card--paused" : ""}`}>
      <div className="cg-card-header">
        <span className="cg-card-emoji">{emoji}</span>
        <span className="cg-card-name cg-card-name-link" onClick={() => { window.location.href = buildLogsUrl({ agent: agent.agent }); }}>{name}</span>
        <a className="cg-card-logs-link" href={buildLogsUrl({ agent: agent.agent })}>Logs →</a>
        <span className={`cg-badge ${billingClass}`}>{billingLabel}</span>
        {agent.paused && <span className="cg-badge cg-badge--paused">PAUSED</span>}
        {agent.override && (
          <span className="cg-badge cg-badge--override">OVERRIDE</span>
        )}
        {agent.budgetAction === "throttle" && !agent.paused && (
          <span className="cg-badge cg-badge--throttle">
            THROTTLED{agent.throttledTo ? ` \u2192 ${agent.throttledTo.split("/").pop()?.replace(/claude-|-20\d+/g, "")}` : ""}
          </span>
        )}
      </div>

      {/* Primary stat for selected period */}
      <div className="cg-card-primary">
        {showCost && (
          <span className="cg-primary-cost">
            {costView === "total"
              ? fmtCost(periodCost + periodApiEquiv)
              : costView === "equiv" && periodApiEquiv > 0
                ? fmtCost(periodApiEquiv)
                : fmtCost(periodCost)}
            {costView === "equiv" && isSub && periodApiEquiv > 0 && <span style={{ fontSize: "0.7em", opacity: 0.6, marginLeft: 4 }}>equiv</span>}
          </span>
        )}
        <span className="cg-primary-reqs">{periodReqs} reqs</span>
        <span className="cg-primary-period">{periodLabel}</span>
        {showApiEquiv && periodApiEquiv > 0 && (
          <span style={{ color: "#22c55e", fontSize: "0.8em" }}>Saving {fmtCost(periodApiEquiv)}</span>
        )}
      </div>

      {/* Cost stats (show for metered/mixed, or API equiv mode) */}
      {showCost && (
        <div className="cg-card-costs">
          {([["Today", agent.daily, agent.apiEquivDaily ?? 0],
             ["Week", agent.weekly, agent.apiEquivWeekly ?? 0],
             ["Month", agent.monthly, agent.apiEquivMonthly ?? 0]] as const).map(([label, actual, equiv]) => (
            <div key={label} className="cg-cost-item">
              <span className="cg-cost-label">{label}</span>
              <span className="cg-cost-value">
                {costView === "total" ? fmtCost(actual + equiv) : costView === "equiv" && equiv > 0 ? fmtCost(equiv) : fmtCost(actual)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Request stats */}
      <div className="cg-card-costs">
        {([["Reqs Today", agent.dailyRequests],
           ["Reqs Week", agent.weeklyRequests],
           ["Reqs Month", agent.monthlyRequests]] as const).map(([label, count]) => (
          <div key={label} className="cg-cost-item">
            <span className="cg-cost-label">{label}</span>
            <span className="cg-cost-value">{count}</span>
          </div>
        ))}
      </div>

      {/* Cron cost attribution */}
      {periodCronReqs > 0 && (
        <div className="cg-card-costs" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 6, marginTop: 2 }}>
          <div className="cg-cost-item cg-cost-item--active">
            <span className="cg-cost-label" style={{ opacity: 0.7 }}>Cron</span>
            <span className="cg-cost-value">
              {periodCronCost > 0 ? `${fmtCost(periodCronCost)} · ` : ""}{periodCronReqs} reqs
            </span>
          </div>
        </div>
      )}

      {/* Model breakdown — expandable */}
      {agent.models && agent.models.length > 0 && (
        <div className="cg-card-models">
          {visibleModels.map((m) => (
            <div key={m.model} className="cg-model-row cg-model-row-link" onClick={() => { window.location.href = buildLogsUrl({ agent: agent.agent, model: m.model }); }} title={`View logs for ${m.model}`}>
              <span className="cg-model-name" title={m.model}>
                {m.model.split("/").pop()}
                <span className="cg-model-provider">{m.provider}</span>
              </span>
              <span className="cg-model-stats">
                {m.requests} reqs
                {costView === "total" && m.apiEquivalent ? ` · ${fmtCost(m.cost + m.apiEquivalent)}`
                  : costView === "equiv" && m.apiEquivalent ? ` · ${fmtCost(m.apiEquivalent)} equiv`
                  : m.cost > 0 ? ` · ${fmtCost(m.cost)}` : ""}
                {m.billing === "subscription" ? " · sub" : ""}
              </span>
            </div>
          ))}
          {hiddenCount > 0 && (
            <button className="cg-model-toggle" onClick={() => setModelsExpanded(!modelsExpanded)}>
              {modelsExpanded ? "Show less" : `+${hiddenCount} more models`}
            </button>
          )}
        </div>
      )}

      {/* Budget bars */}
      {hasCostBudget && (
        <div className="cg-card-budget">
          <BudgetBar used={agent.daily} limit={agent.budget!.daily!} />
          <span className="cg-budget-text">{fmtCost(agent.daily)} / {fmtCost(agent.budget!.daily!)} daily</span>
        </div>
      )}
      {agent.budget?.dailyRequests && agent.budget.dailyRequests > 0 && (
        <div className="cg-card-budget">
          <BudgetBar used={agent.dailyRequests} limit={agent.budget.dailyRequests} />
          <span className="cg-budget-text">{agent.dailyRequests} / {agent.budget.dailyRequests} reqs/day</span>
        </div>
      )}
      {agent.budget?.weeklyRequests && agent.budget.weeklyRequests > 0 && (
        <div className="cg-card-budget">
          <BudgetBar used={agent.weeklyRequests} limit={agent.budget.weeklyRequests} />
          <span className="cg-budget-text">{agent.weeklyRequests} / {agent.budget.weeklyRequests} reqs/week</span>
        </div>
      )}
      {!hasCostBudget && !hasReqBudget && (
        <div className="cg-card-budget cg-card-budget--none">
          <span className="cg-budget-text">No budget set</span>
        </div>
      )}

      <div className="cg-card-sparkline">
        <span className="cg-sparkline-label">24h {isSub ? "reqs" : ""}</span>
        <Sparkline data={agent.hourly.map((h) => isSub ? h.requests : h.cost)} />
      </div>

      {/* Override banner */}
      {agent.override && (
        <div className="cg-override-banner">
          <span className="cg-badge cg-badge--override">OVERRIDE</span>
          <span className="cg-override-expires">
            Expires in {formatRelativeTime(agent.override.expiresAt)}
          </span>
          <button
            className="cg-btn cg-btn--small cg-btn--danger"
            onClick={() => onClearOverride(agent.agent)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Blocked attempts + auto-recovery */}
      {agent.paused && (
        <div className="cg-paused-info">
          {(agent.blockedAttempts ?? 0) > 0 && (
            <span className="cg-blocked-count">
              {agent.blockedAttempts} blocked attempt{agent.blockedAttempts !== 1 ? "s" : ""}
            </span>
          )}
          {agent.autoRecovery && (
            <span className="cg-auto-recovery-note" title="Will auto-resume when budget resets">
              Auto-recovery at midnight
            </span>
          )}
        </div>
      )}

      <div className="cg-card-actions">
        <button
          className={`cg-btn ${agent.paused ? "cg-btn--resume" : "cg-btn--pause"}`}
          onClick={() => {
            if (!agent.paused || window.confirm(`Resume ${name}?`)) {
              if (agent.paused) {
                onTogglePause(agent.agent, false);
              } else if (window.confirm(`Pause ${name}? This will block all LLM calls for this agent.`)) {
                onTogglePause(agent.agent, true);
              }
            }
          }}
        >
          {agent.paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        {!agent.override ? (
          <button
            className="cg-btn cg-btn--small"
            onClick={() => {
              const hours = prompt("Override duration (hours):", "2");
              if (hours && Number(hours) > 0) {
                const reason = prompt("Reason (optional):", "emergency override") ?? "emergency override";
                onStartOverride(agent.agent, Number(hours), reason);
              }
            }}
          >
            Override
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── Timeline Chart ──────────────────────────────────────────────

function TimelineChart({ data, days, onBarClick }: { data: number[]; days: number; onBarClick?: (bucketIdx: number) => void }) {
  const width = 600;
  const height = 80;
  const max = Math.max(...data, 0.001);
  const barWidth = Math.max(width / data.length - 0.5, 0.5);

  const bucketsPerDay = 24;
  const dayLabels: Array<{ x: number; label: string }> = [];
  for (let d = 0; d < days; d++) {
    const bucketIdx = d * bucketsPerDay;
    const x = (bucketIdx / data.length) * width;
    const date = new Date(Date.now() - (days - d) * 24 * 60 * 60 * 1000);
    dayLabels.push({ x, label: `${date.getMonth() + 1}/${date.getDate()}` });
  }

  return (
    <svg width={width} height={height + 16} className="cg-timeline-svg" viewBox={`0 0 ${width} ${height + 16}`}>
      {dayLabels.map((d, i) => (
        <g key={i}>
          <line x1={d.x} y1={0} x2={d.x} y2={height} stroke="var(--border)" strokeWidth="0.5" strokeDasharray="2,2" />
          <text x={d.x + 2} y={height + 12} fill="var(--text-muted)" fontSize="9">{d.label}</text>
        </g>
      ))}
      {data.map((v, i) => {
        const x = (i / data.length) * width;
        const h = (v / max) * (height - 4);
        return (
          <rect
            key={i} x={x} y={height - h} width={barWidth} height={Math.max(h, 0)}
            fill="var(--accent)" opacity={0.7} rx={0.5}
            className={onBarClick ? "cg-timeline-bar-clickable" : ""}
            onClick={onBarClick && v > 0 ? () => onBarClick(i) : undefined}
          />
        );
      })}
    </svg>
  );
}

function TimelineSection({ agentMeta, buildLogsUrl }: { agentMeta: Record<string, { name: string; emoji: string }>; buildLogsUrl: (extra?: Record<string, string>) => string }) {
  const [tlFilters, setTlFilter] = useUrlState({
    "tl.days":  { type: "number" as const, default: 7 },
    "tl.agent": { type: "string" as const, default: "" },
  });
  const days = tlFilters["tl.days"];
  const setDays = useCallback((v: number) => setTlFilter("tl.days", v), [setTlFilter]);
  const agent = tlFilters["tl.agent"];
  const setAgent = useCallback((v: string) => setTlFilter("tl.agent", v), [setTlFilter]);
  const [timelines, setTimelines] = useState<AgentTimeline[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchTimeline = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams({ days: String(days) });
    if (agent) qs.set("agent", agent);
    fetch(`/api/agent-costs/timeline?${qs}`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setTimelines(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [days, agent]);

  useEffect(() => { fetchTimeline(); }, [fetchTimeline]);

  const combined = useMemo(() => {
    if (timelines.length === 0) return [];
    const bucketCount = timelines[0]?.buckets.length ?? 0;
    const agg: number[] = new Array(bucketCount).fill(0);
    for (const t of timelines) {
      for (let i = 0; i < t.buckets.length; i++) {
        agg[i] += t.buckets[i].cost;
      }
    }
    return agg;
  }, [timelines]);

  const agentNames = useMemo(() => {
    return timelines.map((t) => t.agent).sort();
  }, [timelines]);

  const totalCost = timelines.reduce((s, t) => s + t.total, 0);

  return (
    <div className="cg-timeline-section">
      <div className="cg-timeline-header">
        <h2>Cost Timeline</h2>
        <div className="cg-timeline-controls">
          <FilterChips
            label=""
            options={[{ key: "", label: "All Agents" }, ...agentNames.map((a) => ({ key: a, label: agentMeta[a]?.name ?? a }))]}
            selected={agent}
            onChange={setAgent}
          />
          <FilterChips
            label=""
            options={([1, 7, 14, 30] as const).map((d) => ({ key: String(d), label: `${d}d` }))}
            selected={String(days)}
            onChange={(v: string) => setDays(Number(v))}
          />
        </div>
      </div>

      {loading && timelines.length === 0 && <p className="muted">Loading timeline...</p>}

      {combined.length > 0 && (
        <div className="cg-timeline-chart">
          <div className="cg-timeline-chart-label">
            Total: {fmtCost(totalCost)} over {days}d
          </div>
          <TimelineChart data={combined} days={days} onBarClick={(bucketIdx) => {
            const bucketStart = Date.now() - days * 24 * 60 * 60 * 1000 + bucketIdx * 60 * 60 * 1000;
            const bucketEnd = bucketStart + 60 * 60 * 1000;
            const extra: Record<string, string> = { since: String(bucketStart), until: String(bucketEnd) };
            if (agent) extra.agent = agent;
            window.location.href = buildLogsUrl(extra);
          }} />
        </div>
      )}

      {!agent && timelines.length > 1 && (
        <div className="cg-timeline-agents">
          {timelines
            .sort((a, b) => b.total - a.total)
            .map((t) => (
              <div key={t.agent} className="cg-timeline-agent-row">
                <span className="cg-timeline-agent-name cg-timeline-agent-link" onClick={() => { window.location.href = buildLogsUrl({ agent: t.agent }); }}>
                  {agentMeta[t.agent]?.emoji ?? "🤖"} {agentMeta[t.agent]?.name ?? t.agent}
                  <span className="cg-timeline-agent-total">{fmtCost(t.total)}</span>
                  {t.billing === "subscription" && <span className="cg-timeline-badge-sub">sub</span>}
                </span>
                <TimelineChart data={t.buckets.map((b) => b.cost)} days={days} onBarClick={(bucketIdx) => {
                  const bucketStart = Date.now() - days * 24 * 60 * 60 * 1000 + bucketIdx * 60 * 60 * 1000;
                  const bucketEnd = bucketStart + 60 * 60 * 1000;
                  window.location.href = buildLogsUrl({ since: String(bucketStart), until: String(bucketEnd), agent: t.agent });
                }} />
              </div>
            ))}
        </div>
      )}

      {timelines.length === 0 && !loading && (
        <p className="muted" style={{ marginTop: "0.5rem" }}>No timeline data available.</p>
      )}
    </div>
  );
}

// ── Tool Costs ──────────────────────────────────────────────────

interface ToolCostRow {
  tool_name: string;
  call_count: number;
  success_count: number;
  avg_duration_ms: number;
  total_cost: number;
  total_tokens: number;
  metered_cost: number;
  metered_tokens: number;
  subscription_cost: number;
  subscription_tokens: number;
}

function ToolCostsSection({ buildLogsUrl }: { buildLogsUrl: (extra?: Record<string, string>) => string }) {
  const [tools, setTools] = useState<ToolCostRow[]>([]);
  const [tcFilters, setTcFilter] = useUrlState({
    "tc.days": { type: "number" as const, default: 7 },
  });
  const days = tcFilters["tc.days"];
  const setDays = useCallback((v: number) => setTcFilter("tc.days", v), [setTcFilter]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    fetch(`/api/logs?endpoint=tool-costs&since=${since}`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setTools(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [days]);

  if (!loading && tools.length === 0) return null;

  return (
    <div className="cg-tool-costs">
      <div className="cg-tool-costs-header">
        <h3>Tool / Skill Costs</h3>
        <FilterChips
          label=""
          options={([1, 7, 14, 30] as const).map((d) => ({ key: String(d), label: `${d}d` }))}
          selected={String(days)}
          onChange={(v: string) => setDays(Number(v))}
        />
      </div>
      {loading && tools.length === 0 && <p className="muted">Loading tool costs...</p>}
      {tools.length > 0 && (
        <table className="cg-tool-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Calls</th>
              <th>Success</th>
              <th>Avg Duration</th>
              <th>API Cost</th>
              <th>Sub Tokens</th>
              <th>Total Tokens</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.tool_name} className="cg-tool-row" onClick={() => { window.location.href = buildLogsUrl({ search: t.tool_name, type: "tool_call" }); }}>
                <td className="cg-tool-name">{t.tool_name}</td>
                <td>{t.call_count}</td>
                <td>{t.call_count > 0 ? Math.round((t.success_count / t.call_count) * 100) : 0}%</td>
                <td>{t.avg_duration_ms ? `${Math.round(t.avg_duration_ms)}ms` : "—"}</td>
                <td className="cg-tool-cost">{fmtCost(t.metered_cost ?? 0)}</td>
                <td className="muted">{formatTokens(t.subscription_tokens ?? 0)}</td>
                <td>{formatTokens(t.total_tokens ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Memory Operations ────────────────────────────────────────────

interface MemoryOpRow {
  file_path: string;
  reads: number;
  writes: number;
  edits: number;
  execs: number;
  agents: string[];
  last_ts: number;
  sessions: number;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function MemoryOpsSection({ buildLogsUrl }: { buildLogsUrl: (extra?: Record<string, string>) => string }) {
  const [ops, setOps] = useState<MemoryOpRow[]>([]);
  const [moFilters, setMoFilter] = useUrlState({
    "mo.days": { type: "number" as const, default: 7 },
  });
  const days = moFilters["mo.days"];
  const setDays = useCallback((v: number) => setMoFilter("mo.days", v), [setMoFilter]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    fetch(`/api/logs?endpoint=memory-ops&since=${since}`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setOps(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [days]);

  if (!loading && ops.length === 0) return null;

  return (
    <div className="cg-tool-costs">
      <div className="cg-tool-costs-header">
        <h3>Memory Operations</h3>
        <FilterChips
          label=""
          options={([1, 7, 14, 30] as const).map((d) => ({ key: String(d), label: `${d}d` }))}
          selected={String(days)}
          onChange={(v: string) => setDays(Number(v))}
        />
      </div>
      {loading && ops.length === 0 && <p className="muted">Loading memory ops...</p>}
      {ops.length > 0 && (
        <table className="cg-tool-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Reads</th>
              <th>Writes</th>
              <th>Edits</th>
              <th>Agents</th>
              <th>Sessions</th>
              <th>Last Access</th>
            </tr>
          </thead>
          <tbody>
            {ops.map((m) => (
              <tr key={m.file_path} className="cg-tool-row" onClick={() => { window.location.href = buildLogsUrl({ search: m.file_path, type: "tool_call" }); }}>
                <td className="cg-tool-name">{m.file_path}</td>
                <td>{m.reads || "—"}</td>
                <td>{m.writes || "—"}</td>
                <td>{m.edits || "—"}</td>
                <td>{m.agents.join(", ")}</td>
                <td>{m.sessions}</td>
                <td className="muted">{timeAgo(m.last_ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Provider Section (unified per-provider cards) ────────────────

function ProviderSection({ filteredAgents, costView }: { filteredAgents: AgentCost[]; costView: "actual" | "equiv" | "total" }) {
  const [orSpend, setOrSpend] = useState<ProviderSpend | null>(null);
  const [windows, setWindows] = useState<ProviderWindowStatus[]>([]);
  const [calibration, setCalibration] = useState<Record<string, { lastUpdated: string; parsed: { plan?: string; windows: Array<{ id: string; pct: number; resetAt?: string; note?: string }> } }>>({});

  useEffect(() => {
    function fetchSpend() {
      fetch("/api/provider-costs")
        .then((r) => { if (r.ok) return r.json(); return null; })
        .then((d) => { if (d && typeof d.usage === "number") setOrSpend(d); })
        .catch(() => {});
    }
    function fetchLimits() {
      fetch("/api/provider-limits")
        .then((r) => r.json())
        .then((d) => { if (Array.isArray(d.windows)) setWindows(d.windows); })
        .catch(() => {});
    }
    function fetchCalibration() {
      fetch("/api/deck-config")
        .then((r) => r.json())
        .then((d) => { if (d?.providerCalibration) setCalibration(d.providerCalibration); })
        .catch(() => {});
    }
    fetchSpend();
    fetchLimits();
    fetchCalibration();
    const si = setInterval(fetchSpend, 60_000);
    const li = setInterval(fetchLimits, 30_000);
    return () => { clearInterval(si); clearInterval(li); };
  }, []);

  // Aggregate provider costs from agent model breakdowns
  const providerTotals = useMemo(() => {
    const map: Record<string, { actual: number; equiv: number; reqs: number }> = {};
    for (const a of filteredAgents) {
      for (const m of a.models ?? []) {
        const p = m.provider;
        if (!map[p]) map[p] = { actual: 0, equiv: 0, reqs: 0 };
        map[p].actual += m.cost;
        map[p].equiv += m.apiEquivalent ?? 0;
        map[p].reqs += m.requests;
      }
    }
    return map;
  }, [filteredAgents]);

  // Group rate limit windows by provider
  const limitsByProvider: Record<string, ProviderWindowStatus[]> = {};
  for (const w of windows) {
    (limitsByProvider[w.provider] ??= []).push(w);
  }

  const showEquiv = costView === "total" || costView === "equiv";

  // Build unified provider list: all providers that have spend, equiv, or limits
  const allProviderKeys = new Set<string>();
  if (orSpend) allProviderKeys.add("openrouter");
  for (const k of Object.keys(providerTotals)) allProviderKeys.add(k.toLowerCase());
  for (const k of Object.keys(limitsByProvider)) allProviderKeys.add(k.toLowerCase());

  // Filter out providers that have nothing to show (no spend, no limits, no equiv)
  const visibleProviders = [...allProviderKeys].filter((pKey) => {
    if (pKey === "openrouter" && orSpend) return true;
    if (limitsByProvider[pKey]?.length) return true;
    const totals = Object.entries(providerTotals).find(([k]) => k.toLowerCase() === pKey)?.[1];
    if (showEquiv && totals && totals.equiv > 0) return true;
    return false;
  });

  // Sort: openrouter first (has real spend), then alphabetical
  const sortedProviders = visibleProviders.sort((a, b) => {
    if (a === "openrouter") return -1;
    if (b === "openrouter") return 1;
    return a.localeCompare(b);
  });

  if (sortedProviders.length === 0) return null;

  return (
    <div className="cg-provider-section">
      <h2 className="cg-section-title">Providers</h2>
      <div className="cg-provider-cards">
        {sortedProviders.map((pKey) => {
          const displayName = providerDisplayName(pKey);
          const spend = pKey === "openrouter" ? orSpend : null;
          const limits = limitsByProvider[pKey] ?? [];
          // Find equiv/actual from agent model data (case-insensitive match)
          const totals = Object.entries(providerTotals).find(([k]) => k.toLowerCase() === pKey)?.[1];
          const hasEquiv = showEquiv && totals && totals.equiv > 0;

          return (
            <div key={pKey} className="cg-provider-card">
              <div className="cg-provider-name">{displayName}</div>

              {/* OpenRouter real spend */}
              {spend && (
                <div className="cg-provider-spend-row">
                  <div className="cg-provider-spend-grid">
                    <div className="cg-spend-card">
                      <span className="cg-spend-label">Today</span>
                      <span className="cg-spend-value">{fmtCost(spend.usageDaily)}</span>
                    </div>
                    <div className="cg-spend-card">
                      <span className="cg-spend-label">This Week</span>
                      <span className="cg-spend-value">{fmtCost(spend.usageWeekly)}</span>
                    </div>
                    <div className="cg-spend-card">
                      <span className="cg-spend-label">This Month</span>
                      <span className="cg-spend-value">{fmtCost(spend.usageMonthly)}</span>
                    </div>
                    <div className="cg-spend-card">
                      <span className="cg-spend-label">All Time</span>
                      <span className="cg-spend-value">{fmtCost(spend.usage)}</span>
                    </div>
                    {spend.limit != null && (
                      <div className="cg-spend-card cg-spend-card--limit">
                        <span className="cg-spend-label">Limit</span>
                        <span className="cg-spend-value">{fmtCost(spend.limit)}</span>
                        <BudgetBar used={spend.usage} limit={spend.limit} />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* API Equivalent cost (for non-OpenRouter providers in Total/Equiv mode) */}
              {hasEquiv && totals && (
                <div className="cg-provider-equiv-row">
                  <span className="cg-provider-equiv-label">
                    {costView === "total" ? "Estimated Spend" : "API Equivalent"}
                  </span>
                  <span className="cg-provider-equiv-value">
                    {fmtCost(costView === "total" ? totals.actual + totals.equiv : totals.equiv)}
                  </span>
                  <span className="cg-provider-equiv-reqs">{totals.reqs} reqs</span>
                </div>
              )}

              {/* Rate limits */}
              {limits.length > 0 && (
                <div className="cg-provider-limits-row">
                  {limits.map((w) => (
                    <div key={w.windowId} className="cg-provider-window">
                      <div className="cg-provider-window-header">
                        <span className="cg-provider-window-label">{w.label}</span>
                        <span className="cg-provider-window-count">{w.used} / {w.limit}</span>
                      </div>
                      <BudgetBar used={w.used} limit={w.limit} />
                      {w.breakdown && w.breakdown.length > 0 && (
                        <div className="cg-provider-breakdown">
                          {w.breakdown.map((b) => {
                            const short = b.model.split("/").pop() ?? b.model;
                            return (
                              <span key={b.model} className="cg-provider-breakdown-item" title={b.model}>
                                {short}: {b.raw}{b.weighted !== b.raw ? ` (${b.weighted}w)` : ""}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {w.resetsAt && (() => {
                        const msLeft = w.resetsAt - Date.now();
                        const hLeft = Math.floor(msLeft / 3600000);
                        const mLeft = Math.round((msLeft % 3600000) / 60000);
                        const relStr = msLeft > 0
                          ? hLeft > 0 ? `${hLeft}h ${mLeft}m` : `${mLeft}m`
                          : "now";
                        return (
                          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>
                            {w.rolling
                              ? `Rolling · oldest request expires in ${relStr} (${new Date(w.resetsAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })})`
                              : `Resets in ${relStr} · ${new Date(w.resetsAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                            }
                          </div>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              )}

              {/* Calibrated usage from provider dashboard */}
              {calibration[pKey]?.parsed?.windows?.length > 0 && (() => {
                const cal = calibration[pKey];
                const staleness = Math.round((Date.now() - new Date(cal.lastUpdated).getTime()) / 3600000);
                return (
                  <div className="cg-provider-limits-row" style={{ marginTop: 4 }}>
                    <div style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Provider reported</span>
                      {cal.parsed.plan && <span style={{ fontSize: 10, background: "var(--bg-hover)", padding: "1px 6px", borderRadius: 3 }}>{cal.parsed.plan}</span>}
                      <span style={{ fontSize: 10, color: staleness > 6 ? "var(--accent-danger)" : "var(--text-muted)", marginLeft: "auto" }}>
                        {staleness < 1 ? "just now" : `${staleness}h ago`}
                      </span>
                    </div>
                    {cal.parsed.windows.map((cw) => {
                      // Cross-reference with gateway-tracked window to derive estimated total capacity
                      const gwWindow = limits.find((l) => l.windowId === cw.id);
                      const gwUsed = gwWindow?.used ?? 0;
                      const estimatedCapacity = cw.pct > 0 ? Math.round(gwUsed / (cw.pct / 100)) : null;
                      const configuredLimit = gwWindow?.limit ?? 0;

                      return (
                        <div key={cw.id} className="cg-provider-window">
                          <div className="cg-provider-window-header">
                            <span className="cg-provider-window-label">{cw.id}</span>
                            <span className="cg-provider-window-count">{cw.pct}%</span>
                          </div>
                          <BudgetBar used={cw.pct} limit={100} />
                          {cw.resetAt && (
                            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                              resets {new Date(cw.resetAt).toLocaleString()}
                            </span>
                          )}
                          {estimatedCapacity !== null && estimatedCapacity > 0 && (
                            <div style={{ fontSize: 11, marginTop: 2, display: "flex", gap: 8 }}>
                              <span style={{ color: "var(--text-muted)" }}>
                                Estimated capacity: <strong style={{ color: "var(--accent)" }}>{estimatedCapacity}</strong> units
                              </span>
                              {configuredLimit > 0 && estimatedCapacity !== configuredLimit && (
                                <span style={{ color: Math.abs(estimatedCapacity - configuredLimit) / configuredLimit > 0.2 ? "var(--accent-warning)" : "var(--text-muted)" }}>
                                  (configured: {configuredLimit})
                                </span>
                              )}
                            </div>
                          )}
                          {cw.pct === 0 && gwUsed === 0 && (
                            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>No usage yet — capacity will be estimated after some traffic</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* No data state — should not normally render (filtered below) */}
              {!spend && limits.length === 0 && !hasEquiv && (
                <div className="cg-provider-empty">No usage data</div>
              )}
            </div>
          );
        })}
      </div>
      {orSpend && (
        <p className="cg-provider-spend-note">
          OpenRouter costs are from their Activity API. Per-agent costs are estimates until end-of-day reconciliation.
        </p>
      )}
    </div>
  );
}

// ── Collapsible Advanced Sections ────────────────────────────────

function CostsAdvancedSections({ filteredAgents, costView, buildLogsUrl }: {
  filteredAgents: AgentCost[];
  costView: "actual" | "equiv" | "total";
  buildLogsUrl: (params: Record<string, string>) => string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="cg-advanced">
      <button
        className="cg-advanced-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "▼" : "▶"} Detailed Breakdowns
        <span className="cg-advanced-hint">Providers, tool costs, memory operations</span>
      </button>
      {expanded && (
        <div className="cg-advanced-content">
          <ProviderSection filteredAgents={filteredAgents} costView={costView} />
          <ToolCostsSection buildLogsUrl={buildLogsUrl} />
          <MemoryOpsSection buildLogsUrl={buildLogsUrl} />
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────

export default function CostsPage() {
  const [data, setData] = useState<BudgetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentMeta, setAgentMeta] = useState<Record<string, { name: string; emoji: string }>>({});

  // All filter state synced bidirectionally to URL params
  const [filters, setFilter] = useUrlState({
    range:       { type: "string" as const, default: "mtd" },
    customStart: { type: "string" as const, default: toDateStr(new Date(Date.now() - 30 * 86400000)) },
    customEnd:   { type: "string" as const, default: toDateStr(new Date()) },
    billing:     { type: "string" as const, default: "all" },
    provider:    { type: "string" as const, default: "" },
    model:       { type: "string" as const, default: "" },
    agent:       { type: "string" as const, default: "" },
    sort:        { type: "string" as const, default: "cost" },
    costView:    { type: "string" as const, default: "actual" },
  });
  const timeRange = filters.range as TimeRange;
  const setTimeRange = useCallback((v: TimeRange) => setFilter("range", v), [setFilter]);
  const customStart = filters.customStart;
  const setCustomStart = useCallback((v: string) => setFilter("customStart", v), [setFilter]);
  const customEnd = filters.customEnd;
  const setCustomEnd = useCallback((v: string) => setFilter("customEnd", v), [setFilter]);
  const billingFilter = filters.billing as BillingFilter;
  const setBillingFilter = useCallback((v: BillingFilter) => setFilter("billing", v), [setFilter]);
  const providerFilter = filters.provider;
  const setProviderFilter = useCallback((v: string) => setFilter("provider", v), [setFilter]);
  const modelFilter = filters.model;
  const setModelFilter = useCallback((v: string) => setFilter("model", v), [setFilter]);
  const agentFilter = filters.agent;
  const setAgentFilter = useCallback((v: string) => setFilter("agent", v), [setFilter]);
  const sortBy = filters.sort as SortBy;
  const setSortBy = useCallback((v: SortBy) => setFilter("sort", v), [setFilter]);
  const costView = filters.costView as "actual" | "equiv" | "total";
  const setCostView = useCallback((v: "actual" | "equiv" | "total") => setFilter("costView", v), [setFilter]);

  const fetchData = useCallback(() => {
    let since: number;
    let until: number | undefined;
    if (timeRange === "custom") {
      since = new Date(customStart + "T00:00:00Z").getTime();
      // End of the selected end date (23:59:59.999 UTC)
      until = new Date(customEnd + "T23:59:59.999Z").getTime();
    } else {
      since = TIME_RANGE_PRESETS[timeRange].since();
    }
    const params = new URLSearchParams({ since: String(since) });
    if (until) params.set("until", String(until));
    fetch(`/api/agent-costs?${params}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [timeRange, customStart, customEnd]);

  useEffect(() => {
    fetch("/api/deck-config")
      .then((r) => r.json())
      .then((d) => {
        if (d.agentMetadata) setAgentMeta(d.agentMetadata);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  async function togglePause(agent: string, paused: boolean) {
    await fetch("/api/agent-pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, paused, reason: "manual" }),
    });
    fetchData();
  }

  async function startOverride(agent: string, hours: number, reason: string) {
    await fetch("/api/budget-override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, durationHours: hours, reason }),
    });
    fetchData();
  }

  async function clearOverride(agent: string) {
    await fetch("/api/budget-override", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent }),
    });
    fetchData();
  }

  const allAgents = data?.agents ?? [];
  const global = data?.global ?? {};

  // Extract unique providers and agent names
  const allProviders = useMemo(() => {
    const set = new Set<string>();
    for (const a of allAgents) {
      for (const m of a.models ?? []) {
        if (m.provider) set.add(m.provider);
      }
    }
    return Array.from(set).sort();
  }, [allAgents]);

  // Extract unique models (short name for display, full for filtering)
  const allModels = useMemo(() => {
    const map = new Map<string, string>(); // model → short name
    for (const a of allAgents) {
      for (const m of a.models ?? []) {
        if (m.model && !map.has(m.model)) {
          map.set(m.model, m.model.split("/").pop() ?? m.model);
        }
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allAgents]);

  const allAgentNames = useMemo(() => allAgents.map((a) => a.agent).sort(), [allAgents]);

  // Filter agents
  const filteredAgents = useMemo(() => {
    let filtered = allAgents;
    if (agentFilter) {
      filtered = filtered.filter((a) => a.agent === agentFilter);
    }
    if (billingFilter !== "all") {
      filtered = filtered.filter((a) => a.billing === billingFilter || a.billing === "mixed");
    }
    if (providerFilter) {
      filtered = filtered.filter((a) => (a.models ?? []).some((m) => m.provider === providerFilter));
    }
    if (modelFilter) {
      filtered = filtered.filter((a) => (a.models ?? []).some((m) => m.model === modelFilter));
    }
    return filtered;
  }, [allAgents, agentFilter, billingFilter, providerFilter, modelFilter]);

  // Sort agents
  const sortedAgents = useMemo(() => {
    const getCost = (a: AgentCost) => a.range ?? a.monthly;
    const getReqs = (a: AgentCost) => a.rangeReqs ?? a.monthlyRequests;
    return [...filteredAgents].sort((a, b) => {
      if (sortBy === "cost") return getCost(b) - getCost(a);
      if (sortBy === "requests") return getReqs(b) - getReqs(a);
      return a.agent.localeCompare(b.agent);
    });
  }, [filteredAgents, sortBy]);

  /** Build a /logs URL carrying over all active cost filters */
  function buildLogsUrl(extra?: Record<string, string>): string {
    const p = new URLSearchParams();
    // Time range
    if (timeRange === "custom") {
      p.set("since", String(new Date(customStart + "T00:00:00Z").getTime()));
      p.set("until", String(new Date(customEnd + "T23:59:59.999Z").getTime()));
    } else {
      p.set("since", String(TIME_RANGE_PRESETS[timeRange].since()));
    }
    // Agent
    if (agentFilter) p.set("agent", agentFilter);
    // Billing
    if (billingFilter !== "all") p.set("billing", billingFilter);
    // Provider
    if (providerFilter) p.set("provider", providerFilter);
    // Model
    if (modelFilter) p.set("model", modelFilter);
    // Cost view (actual/equiv/total)
    if (costView !== "actual") p.set("costView", costView);
    // Time range label for display on Logs page
    p.set("timeRangeLabel", timeRange === "custom" ? `${customStart} → ${customEnd}` : TIME_RANGE_PRESETS[timeRange].label);
    // Merge extras (can override agent, add search, etc.)
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v) p.set(k, v);
      }
    }
    return `/logs?${p}`;
  }

  if (loading && !data) {
    return <div className="cg-page"><div className="cg-loading">Loading cost data...</div></div>;
  }

  if (data?.error && !data.agents?.length) {
    return (
      <div className="cg-page">
        <h1 className="cg-title">Agent Costs</h1>
        <div className="cg-error">Gateway unavailable — cost data requires a running gateway.</div>
      </div>
    );
  }

  // Use filtered agents for totals — range fields from backend
  const totalRange = filteredAgents.reduce((s, a) => s + (a.range ?? a.monthly), 0);
  const totalRangeReqs = filteredAgents.reduce((s, a) => s + (a.rangeReqs ?? a.monthlyRequests), 0);
  const totalDaily = filteredAgents.reduce((s, a) => s + a.daily, 0);
  const totalWeekly = filteredAgents.reduce((s, a) => s + a.weekly, 0);
  const totalMonthly = filteredAgents.reduce((s, a) => s + a.monthly, 0);
  const totalApiEquivDaily = filteredAgents.reduce((s, a) => s + (a.apiEquivDaily ?? 0) + a.daily, 0);
  const totalApiEquivWeekly = filteredAgents.reduce((s, a) => s + (a.apiEquivWeekly ?? 0) + a.weekly, 0);
  const totalApiEquivMonthly = filteredAgents.reduce((s, a) => s + (a.apiEquivMonthly ?? 0) + a.monthly, 0);

  // API equivalent totals for range
  const totalApiEquivRange = filteredAgents.reduce((s, a) => s + (a.apiEquivRange ?? (a.apiEquivMonthly ?? 0)) + (a.range ?? a.monthly), 0);

  // Summary uses range fields
  const summaryLabel = getTimeRangeLabel(timeRange, customStart, customEnd);
  const summaryCostActual = totalRange;
  const summaryCostEquiv = totalApiEquivRange;
  const summaryCost = costView === "total" ? summaryCostEquiv : costView === "equiv" ? (summaryCostEquiv - summaryCostActual) : summaryCostActual;
  const summarySavings = summaryCostEquiv - summaryCostActual;
  const showApiEquiv = costView === "equiv" || costView === "total";
  const summaryReqs = totalRangeReqs;
  const summaryBudget = global.monthly; // budget is always monthly
  const summaryReqBudget = global.dailyRequests;

  const hasActiveFilters = agentFilter || billingFilter !== "all" || providerFilter || modelFilter;

  return (
    <div className="cg-page">
      <h1 className="cg-title">Agent Costs</h1>

      {/* Filter Bar */}
      <div className="logs-filters">
        <FilterChips
          label="Time Range"
          options={[
            ...(Object.keys(TIME_RANGE_PRESETS) as Exclude<TimeRange, "custom">[]).map((tr) => ({ key: tr, label: TIME_RANGE_PRESETS[tr].label })),
            { key: "custom", label: "Custom" },
          ]}
          selected={timeRange}
          onChange={setTimeRange}
        />
        {timeRange === "custom" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", paddingLeft: 56 }}>
            <input type="date" className="logs-chip" style={{ padding: "3px 8px" }} value={customStart} max={customEnd} onChange={(e) => setCustomStart(e.target.value)} />
            <span style={{ opacity: 0.5 }}>→</span>
            <input type="date" className="logs-chip" style={{ padding: "3px 8px" }} value={customEnd} min={customStart} max={toDateStr(new Date())} onChange={(e) => setCustomEnd(e.target.value)} />
          </div>
        )}
        <FilterChips
          label="Agent"
          options={[{ key: "", label: "All" }, ...allAgentNames.map((a) => ({ key: a, label: agentMeta[a]?.name ?? a }))]}
          selected={agentFilter}
          onChange={setAgentFilter}
        />
        <FilterChips
          label="Billing"
          options={[{ key: "all", label: "All" }, { key: "metered", label: "API" }, { key: "subscription", label: "Sub" }]}
          selected={billingFilter}
          onChange={setBillingFilter}
        />
        <FilterChips
          label="Cost View"
          options={[{ key: "actual", label: "Actual" }, { key: "equiv", label: "API Equiv" }, { key: "total", label: "Total" }]}
          selected={costView}
          onChange={setCostView}
        />
        {allProviders.length > 0 && (
          <FilterChips
            label="Provider"
            options={[{ key: "", label: "All" }, ...allProviders.map((p) => ({ key: p, label: p }))]}
            selected={providerFilter}
            onChange={setProviderFilter}
          />
        )}
        {allModels.length > 0 && (
          <FilterChips
            label="Model"
            options={[{ key: "", label: "All" }, ...allModels.map(([full, short]) => ({ key: full, label: short }))]}
            selected={modelFilter}
            onChange={setModelFilter}
          />
        )}
        <FilterChips
          label="Sort"
          options={[{ key: "cost", label: "Cost" }, { key: "requests", label: "Reqs" }, { key: "name", label: "Name" }]}
          selected={sortBy}
          onChange={setSortBy}
        />
      </div>

      {/* Fleet Summary — adapts to selected period */}
      <div className="cg-summary">
        <div className="cg-summary-card cg-summary-card--primary">
          <span className="cg-summary-label">Cost {summaryLabel}</span>
          <span className="cg-summary-value">{fmtCost(summaryCost)}</span>
          {summaryCostEquiv > summaryCostActual + 0.01 && (
            <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 500 }}>~{fmtCost(summaryCostEquiv)} API equiv</span>
          )}
          {summaryBudget && summaryBudget > 0 && (
            <BudgetBar used={summaryCost} limit={summaryBudget} />
          )}
        </div>
        <div className="cg-summary-card cg-summary-card--primary">
          <span className="cg-summary-label">Requests {summaryLabel}</span>
          <span className="cg-summary-value">{summaryReqs}</span>
          {summaryReqBudget && summaryReqBudget > 0 && (
            <BudgetBar used={summaryReqs} limit={summaryReqBudget} />
          )}
        </div>
        <div className="cg-summary-card">
          <span className="cg-summary-label">Today</span>
          <span className="cg-summary-value">{fmtCost(totalDaily)}</span>
          {totalApiEquivDaily > totalDaily + 0.01 && (
            <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 500 }}>~{fmtCost(totalApiEquivDaily)} equiv</span>
          )}
        </div>
        <div className="cg-summary-card">
          <span className="cg-summary-label">This Week</span>
          <span className="cg-summary-value">{fmtCost(totalWeekly)}</span>
          {totalApiEquivWeekly > totalWeekly + 0.01 && (
            <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 500 }}>~{fmtCost(totalApiEquivWeekly)} equiv</span>
          )}
        </div>
        <div className="cg-summary-card">
          <span className="cg-summary-label">This Month</span>
          <span className="cg-summary-value">{fmtCost(totalMonthly)}</span>
          {totalApiEquivMonthly > totalMonthly + 0.01 && (
            <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 500 }}>~{fmtCost(totalApiEquivMonthly)} equiv</span>
          )}
        </div>
        <div className="cg-summary-card">
          <span className="cg-summary-label">Agents</span>
          <span className="cg-summary-value">
            {allAgents.filter((a) => !a.paused).length} active / {allAgents.length} total
          </span>
        </div>
        {showApiEquiv && summarySavings > 0 && (
          <div className="cg-summary-card" style={{ borderColor: "#22c55e" }}>
            <span className="cg-summary-label">Sub Savings {summaryLabel}</span>
            <span className="cg-summary-value" style={{ color: "#22c55e" }}>{fmtCost(summarySavings)}</span>
          </div>
        )}
      </div>

      {/* Agent Cards */}
      <div className="cg-grid">
        {sortedAgents.map((agent) => (
          <AgentCard
            key={agent.agent}
            agent={agent}
            agentMeta={agentMeta}
            onTogglePause={togglePause}
            onStartOverride={startOverride}
            onClearOverride={clearOverride}
            timeRange={timeRange}
            costView={costView}
            buildLogsUrl={buildLogsUrl}
          />
        ))}
      </div>

      {filteredAgents.length === 0 && allAgents.length > 0 && (
        <div className="cg-empty">No agents match the current filters.</div>
      )}

      {allAgents.length === 0 && (
        <div className="cg-empty">No cost data available. Agents must make LLM calls to generate cost data.</div>
      )}

      {/* Cost Timeline */}
      <TimelineSection agentMeta={agentMeta} buildLogsUrl={buildLogsUrl} />

      {/* Collapsible advanced sections */}
      <CostsAdvancedSections filteredAgents={filteredAgents} costView={costView} buildLogsUrl={buildLogsUrl} />
    </div>
  );
}
