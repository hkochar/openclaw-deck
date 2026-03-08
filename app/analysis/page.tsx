"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useHashTab } from "@/components/use-hash-tab";
import { useUrlState } from "@/components/use-url-state";
import { FilterChips } from "@/components/filter-chips";
import "./analysis.css";

// ── Types ────────────────────────────────────────────────────────────

interface Outcome {
  type: string;
  label: string;
  target: string | null;
  detail: string | null;
  timestamp: number;
}

interface OutcomeRegion {
  regionIndex: number;
  startTs: number;
  endTs: number;
  trigger: string | null;
  outcomes: Outcome[];
  supportingActions: Outcome[];
  toolCalls: number;
  llmCalls: number;
  cost: number;
  tokens: { in: number; out: number };
}

interface ActivitySummary {
  toolBreakdown: Array<{ tool: string; count: number; successRate: number }>;
  searchCount: number;
  uniqueUrlsFetched: number;
  sourceFetchRatio: number;
  filesRead: number;
  filesWritten: number;
  commandsRun: number;
  modelsUsed: string[];
  thinkingUsed: boolean;
  coordinationCalls: number;
}

interface QualityScores {
  overall: number;
  toolEfficiency: number;
  researchDepth: number;
  taskCompletion: number;
  errorRecovery: number;
  costEfficiency: number;
}

interface Critique {
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}

interface SessionAnalysis {
  agentType: string;
  regions: OutcomeRegion[];
  outcomes: Outcome[];
  activitySummary: ActivitySummary;
  qualityScores: QualityScores;
  critique: Critique;
  task: string | null;
}

interface RunSummary {
  startedTs: number;
  endedTs: number;
  durationMs: number;
  status: string;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  toolCallCount: number;
  billing?: "subscription" | "metered" | "mixed" | null;
}

interface FeedbackEntry {
  id: number;
  rating: number | null;
  outcomeQuality: string | null;
  notes: string | null;
  tags: string | null;
  createdAt: number;
}

interface AnalysisRecord {
  id: number;
  computedAt: number;
  guidelines: string | null;
  eventsMaxId: number;
  analysis: SessionAnalysis;
}

// ── Helpers ──────────────────────────────────────────────────────────

function scoreToGrade(score: number): string {
  if (score >= 93) return "A";
  if (score >= 87) return "A-";
  if (score >= 83) return "B+";
  if (score >= 77) return "B";
  if (score >= 73) return "B-";
  if (score >= 67) return "C+";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

function scoreColorClass(score: number): string {
  if (score >= 80) return "a";
  if (score >= 60) return "b";
  if (score >= 40) return "c";
  return "d";
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortModel(m: string): string {
  const parts = m.split("/");
  return parts[parts.length - 1].replace(/-\d{8}$/, "");
}

// ── Session Picker ───────────────────────────────────────────────────

interface AgentInfo {
  key: string;
  name: string;
  emoji: string;
  agentId: string;
  sessionCount: number;
  lastActive: number;
  sessions: SessionItem[];
}

interface SessionItem {
  key: string;
  fullKey: string;
  displayName: string | null;
  label: string | null;
  channel: string | null;
  model: string | null;
  totalTokens: number;
  updatedAt: number;
  status: string;
}

function SessionPickerContent() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessFilters, setSessFilter] = useUrlState({
    agent: { type: "string" as const, default: "" },
  });
  const selectedAgent = sessFilters.agent || null;
  const setSelectedAgent = useCallback((v: string | null) => setSessFilter("agent", v ?? ""), [setSessFilter]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/agent-sessions")
      .then((r) => r.json())
      .then((data) => {
        if (data.agents) {
          setAgents(data.agents);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Get sessions for the selected agent (or all agents)
  const allSessions: Array<SessionItem & { agentName: string; agentKey: string }> = [];
  const sourceAgents = selectedAgent
    ? agents.filter((a) => a.key === selectedAgent)
    : agents;
  for (const agent of sourceAgents) {
    for (const s of agent.sessions) {
      allSessions.push({ ...s, agentName: agent.name, agentKey: agent.key });
    }
  }
  allSessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const filtered = filter
    ? allSessions.filter(
        (s) =>
          s.agentName.toLowerCase().includes(filter.toLowerCase()) ||
          (s.displayName ?? "").toLowerCase().includes(filter.toLowerCase()) ||
          (s.label ?? "").toLowerCase().includes(filter.toLowerCase()) ||
          s.fullKey.toLowerCase().includes(filter.toLowerCase()),
      )
    : allSessions;

  function navigateTo(sessionKey: string) {
    router.push(`/analysis?session=${encodeURIComponent(sessionKey)}`);
  }

  if (loading) {
    return <div className="si-loading">Loading sessions...</div>;
  }

  return (
    <>
      {/* Agent filter chips */}
      <FilterChips
        label="Agent"
        options={[
          { key: "", label: "All", count: allSessions.length },
          ...agents.map((a) => ({ key: a.key, label: a.name, count: a.sessions.length })),
        ]}
        selected={selectedAgent ?? ""}
        onChange={(v: string) => setSelectedAgent(v || null)}
      />

      {/* Search */}
      <div className="si-section">
        <input
          type="text"
          placeholder="Search sessions by name, label, or key..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="si-feedback-notes"
          style={{ minHeight: "auto", padding: "10px 14px" }}
        />
      </div>

      {/* Session list */}
      <div className="si-section">
        {filtered.length === 0 ? (
          <div className="si-loading" style={{ height: 120 }}>
            No sessions found{filter ? ` matching "${filter}"` : ""}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {filtered.slice(0, 50).map((s) => (
              <div
                key={s.fullKey}
                className="si-region"
                style={{ cursor: "pointer" }}
                onClick={() => navigateTo(s.fullKey)}
              >
                <div className="si-region-header">
                  <span className="si-badge si-badge--type" style={{ minWidth: 50, textAlign: "center" }}>
                    {s.agentName}
                  </span>
                  <span className="si-region-trigger">
                    {s.displayName || s.label || s.key}
                  </span>
                  <span className="si-region-stats">
                    {s.totalTokens > 0 && (
                      <span>{fmtTokens(s.totalTokens)} tok</span>
                    )}
                    <span className="si-badge si-badge--status" data-status={s.status}>
                      {s.status}
                    </span>
                    <span>
                      {timeAgo(s.updatedAt)}
                    </span>
                  </span>
                </div>
              </div>
            ))}
            {filtered.length > 50 && (
              <div style={{ textAlign: "center", padding: 12, color: "var(--text-muted)", fontSize: 13 }}>
                Showing 50 of {filtered.length} sessions. Use search to narrow results.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Outcome Types ────────────────────────────────────────────────────

interface OutcomeRow {
  id: number;
  ts: number;
  agent: string;
  session: string;
  outcomeType: string;
  label: string;
  target: string | null;
  detail: string | null;
}

const OUTCOME_TYPE_LABELS: Record<string, string> = {
  file_written: "File Written",
  file_edited: "File Edited",
  search_performed: "Search",
  url_fetched: "URL Fetched",
  code_committed: "Commit",
  test_run: "Test Run",
  command_run: "Command",
  message_sent: "Message",
};

const RANGE_MS: Record<string, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

// ── Hash filter helpers ──────────────────────────────────────────────

function parseHashFilters(): { agent: string | null; type: string | null; range: string } {
  if (typeof window === "undefined") return { agent: null, type: null, range: "7d" };
  const hash = window.location.hash.slice(1); // remove #
  const parts = hash.split("&");
  let agent: string | null = null;
  let type: string | null = null;
  let range = "7d";
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k === "agent" && v) agent = decodeURIComponent(v);
    if (k === "type" && v) type = decodeURIComponent(v);
    if (k === "range" && v && RANGE_MS[v]) range = v;
  }
  return { agent, type, range };
}

function buildHash(agent: string | null, type: string | null, range: string): string {
  const parts = ["outcomes"];
  if (agent) parts.push(`agent=${encodeURIComponent(agent)}`);
  if (type) parts.push(`type=${encodeURIComponent(type)}`);
  if (range !== "7d") parts.push(`range=${range}`);
  return parts.join("&");
}

// ── Outcomes View ────────────────────────────────────────────────────

function OutcomesView() {
  const router = useRouter();
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // SSR-safe: initialize with defaults, hydrate from hash on mount
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<string>("7d");
  const [hydrated, setHydrated] = useState(false);

  // Hydrate filters from hash on first mount
  useEffect(() => {
    const initial = parseHashFilters();
    setSelectedAgent(initial.agent);
    setSelectedType(initial.type);
    setTimeRange(initial.range);
    setHydrated(true);
  }, []);

  // Sync filters to hash (skip until hydrated)
  useEffect(() => {
    if (!hydrated) return;
    const hash = buildHash(selectedAgent, selectedType, timeRange);
    history.replaceState(null, "", `#${hash}`);
  }, [selectedAgent, selectedType, timeRange, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    setLoading(true);
    const since = Date.now() - RANGE_MS[timeRange];
    const params = new URLSearchParams({ since: String(since), limit: "200" });
    if (selectedAgent) params.set("agent", selectedAgent);
    if (selectedType) params.set("type", selectedType);

    fetch(`/api/outcomes?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setOutcomes(data.outcomes ?? []);
          setAgents(data.agents ?? []);
          setTotal(data.total ?? 0);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedAgent, selectedType, timeRange, hydrated]);

  return (
    <>
      {/* Filters */}
      <div className="logs-filters">
        <FilterChips
          label="Agent"
          options={[{ key: "", label: "All" }, ...agents.map((a) => ({ key: a, label: a }))]}
          selected={selectedAgent ?? ""}
          onChange={(v: string) => setSelectedAgent(v || null)}
        />
        <FilterChips
          label="Type"
          options={[{ key: "", label: "All" }, ...Object.entries(OUTCOME_TYPE_LABELS).map(([key, label]) => ({ key, label }))]}
          selected={selectedType ?? ""}
          onChange={(v: string) => setSelectedType(v || null)}
        />
        <FilterChips
          label="Time Range"
          options={Object.keys(RANGE_MS).map((r) => ({ key: r, label: r }))}
          selected={timeRange}
          onChange={setTimeRange}
        />
      </div>

      {/* Outcomes list */}
      <div className="si-section">
        {loading ? (
          <div className="si-loading" style={{ height: 120 }}>Loading outcomes...</div>
        ) : outcomes.length === 0 ? (
          <div className="si-loading" style={{ height: 120 }}>
            No outcomes found
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {outcomes.map((o) => (
              <div key={o.id} className="si-region si-outcome-row">
                <div className="si-region-header">
                  <span className="si-outcome-type">
                    {OUTCOME_TYPE_LABELS[o.outcomeType] ?? o.outcomeType.replace("_", " ")}
                  </span>
                  <span className="si-region-trigger si-selectable">
                    {o.target ? (
                      <span className="si-outcome-target" title={o.target}>
                        {o.label}
                      </span>
                    ) : (
                      o.label
                    )}
                  </span>
                  <span className="si-region-stats">
                    <span className="si-badge si-badge--type">{o.agent}</span>
                    <span>{timeAgo(o.ts)}</span>
                    <button
                      className="si-outcome-link"
                      title="View session analysis"
                      onClick={() =>
                        router.push(`/analysis?session=${encodeURIComponent(o.session)}`)
                      }
                    >
                      &#8594;
                    </button>
                  </span>
                </div>
              </div>
            ))}
            {total > outcomes.length && (
              <div
                style={{
                  textAlign: "center",
                  padding: 12,
                  color: "var(--text-muted)",
                  fontSize: 13,
                }}
              >
                Showing {outcomes.length} of {total.toLocaleString()} outcomes
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── Deliverable Types ─────────────────────────────────────────────────

interface DeliverableItem {
  type: string;
  label: string;
  target: string | null;
  ts: number;
}

interface DeliverableGroup {
  id: string;
  agent: string;
  session: string;
  date: number;
  main: DeliverableItem;
  supporting: DeliverableItem[];
}

const DELIVERABLE_TYPE_LABELS: Record<string, string> = {
  message_sent: "Sent",
  code_committed: "Committed",
  test_run: "Test",
  file_written: "Wrote",
  file_edited: "Edited",
};

// ── Deliverables View ─────────────────────────────────────────────────

function DeliverablesView() {
  const router = useRouter();
  const [groups, setGroups] = useState<DeliverableGroup[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [delFilters, setDelFilter] = useUrlState({
    "del.agent": { type: "string" as const, default: "" },
  });
  const selectedAgent = delFilters["del.agent"] || null;
  const setSelectedAgent = useCallback((v: string | null) => setDelFilter("del.agent", v ?? ""), [setDelFilter]);

  const fetchGroups = useCallback(
    (offset: number, append: boolean) => {
      const setter = append ? setLoadingMore : setLoading;
      setter(true);
      const params = new URLSearchParams({ offset: String(offset), limit: "50" });
      if (selectedAgent) params.set("agent", selectedAgent);

      fetch(`/api/deliverables?${params}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            if (append) {
              setGroups((prev) => [...prev, ...(data.groups ?? [])]);
            } else {
              setGroups(data.groups ?? []);
            }
            setAgents(data.agents ?? []);
            setTotal(data.total ?? 0);
            setHasMore(data.hasMore ?? false);
          }
        })
        .catch(() => {})
        .finally(() => setter(false));
    },
    [selectedAgent],
  );

  useEffect(() => {
    fetchGroups(0, false);
  }, [fetchGroups]);

  return (
    <>
      {/* Agent filter */}
      <FilterChips
        label="Agent"
        options={[{ key: "", label: "All" }, ...agents.map((a) => ({ key: a, label: a }))]}
        selected={selectedAgent ?? ""}
        onChange={(v: string) => setSelectedAgent(v || null)}
      />

      {/* Groups */}
      <div className="si-section">
        {loading ? (
          <div className="si-loading" style={{ height: 120 }}>Loading deliverables...</div>
        ) : groups.length === 0 ? (
          <div className="si-loading" style={{ height: 120 }}>No deliverables found</div>
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.id} className="si-deliverable-group">
                <div className="si-deliverable-header">
                  <span className="si-deliverable-agent">{g.agent}</span>
                  <span className="si-outcome-type">
                    {DELIVERABLE_TYPE_LABELS[g.main.type] ?? g.main.type.replace("_", " ")}
                  </span>
                  {g.supporting.length > 0 && (
                    <span>+ {g.supporting.length} file{g.supporting.length !== 1 ? "s" : ""}</span>
                  )}
                  <span className="si-deliverable-date">
                    {new Date(g.date).toLocaleDateString([], { month: "short", day: "numeric" })}
                  </span>
                </div>
                <div className="si-deliverable-main">
                  <span className="si-deliverable-star">★</span>
                  <span
                    className="si-deliverable-main-label"
                    data-type={g.main.type}
                    title={g.main.target ?? g.main.label}
                  >
                    {g.main.label}
                  </span>
                  <span className="si-deliverable-nav">
                    <button
                      className="si-outcome-link"
                      title="View deliverable details"
                      onClick={() =>
                        router.push(`/analysis?deliverable=${encodeURIComponent(g.id)}`)
                      }
                    >
                      &#8594;
                    </button>
                  </span>
                </div>
                {g.supporting.length > 0 && (
                  <div className="si-deliverable-tree">
                    {g.supporting.map((s, i) => (
                      <div key={i} className="si-deliverable-item" title={s.target ?? s.label}>
                        <span className="si-deliverable-badge">
                          {DELIVERABLE_TYPE_LABELS[s.type] ?? s.type.replace("_", " ")}
                        </span>
                        {s.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {total > 0 && (
              <div className="si-deliverable-count">
                Showing {groups.length} of {total} deliverable groups
              </div>
            )}
            {hasMore && (
              <button
                className="si-load-more"
                disabled={loadingMore}
                onClick={() => fetchGroups(groups.length, true)}
              >
                {loadingMore ? "Loading..." : "Load More"}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ── Deliverable Detail View ───────────────────────────────────────────

interface DetailEvent {
  id: number;
  ts: number;
  toolName: string | null;
  toolQuery: string | null;
  toolTarget: string | null;
  toolTargetFull: string | null;
  success: boolean | null;
  durationMs: number | null;
}

interface DetailSources {
  searches: string[];
  urlsFetched: Array<{ url: string; hostname: string }>;
  filesRead: Array<{ path: string; full: string }>;
  filesEdited: Array<{ path: string; full: string }>;
  searchCount: number;
  fetchCount: number;
  readCount: number;
  editCount: number;
}

interface ReportSources {
  searches: string[];
  urlsFetched: Array<{ url: string; hostname: string }>;
  searchCount: number;
  fetchCount: number;
  uniqueDomains: number;
  filesRead: number;
  filesEdited: number;
}

interface DetailSummary {
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  totalCost: number | null;
  totalTokensIn: number;
  totalTokensOut: number;
  model: string | null;
  billing: string | null;
}

interface DetailSibling {
  groupKey: string;
  type: string;
  label: string;
  firstTs: number;
  lastTs: number;
  itemCount: number;
  isCurrent: boolean;
}

interface DetailDeliverable {
  id: string;
  agent: string;
  session: string;
  groupKey: string;
  main: { type: string; label: string; target: string | null; ts: number };
  supporting: Array<{ type: string; label: string; target: string | null; ts: number }>;
  firstTs: number;
  lastTs: number;
  itemCount: number;
}

/** Friendly tool name for timeline display */
const TOOL_LABELS: Record<string, string> = {
  web_search: "search",
  web_fetch: "fetch",
  sessions_send: "send",
};

/** Build knowledge docs link */
function docsLink(fullPath: string): string {
  return `/knowledge#docs/${encodeURIComponent(fullPath)}`;
}

/** Collapsible source group */
function SourceGroup({ icon, title, count, totalCount, children }: {
  icon: string; title: string; count: number; totalCount: number;
  children: React.ReactNode[];
}) {
  const [expanded, setExpanded] = useState(false);
  const PREVIEW = 5;
  const visible = expanded ? children : children.slice(0, PREVIEW);
  const hasMore = children.length > PREVIEW;

  if (count === 0) return null;

  return (
    <div className="si-source-group">
      <div className="si-source-group-header">
        <span className="si-detail-source-icon">{icon}</span>
        <span className="si-source-group-title">
          {totalCount} {title}{totalCount !== 1 ? "s" : ""}
          {totalCount !== count && <span className="si-source-group-dedup"> ({count} unique)</span>}
        </span>
      </div>
      <ul className="si-detail-sources">
        {visible}
      </ul>
      {hasMore && (
        <button
          className="si-detail-timeline-toggle"
          onClick={() => setExpanded((p) => !p)}
        >
          {expanded ? "Show less" : `Show ${children.length - PREVIEW} more`}
        </button>
      )}
    </div>
  );
}

function DeliverableDetailView({ groupKey, initialTab }: { groupKey: string; initialTab?: string }) {
  const router = useRouter();
  const [deliverable, setDeliverable] = useState<DetailDeliverable | null>(null);
  const [events, setEvents] = useState<DetailEvent[]>([]);
  const [sources, setSources] = useState<DetailSources | null>(null);
  const [summary, setSummary] = useState<DetailSummary | null>(null);
  const [siblings, setSiblings] = useState<DetailSibling[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFullTimeline, setShowFullTimeline] = useState(false);
  const [detailTab, setDetailTab] = useState<"detail" | "report">(
    initialTab === "report" ? "report" : "detail",
  );

  // Sync detailTab when parent changes initialTab via URL
  useEffect(() => {
    setDetailTab(initialTab === "report" ? "report" : "detail");
  }, [initialTab]);

  // Report tab state
  const [analysisData, setAnalysisData] = useState<SessionAnalysis | null>(null);
  const [analysisRunSummary, setAnalysisRunSummary] = useState<RunSummary | null>(null);
  const [analysisSources, setAnalysisSources] = useState<ReportSources | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // Reset analysis state for new deliverable
    setAnalysisData(null);
    setAnalysisSources(null);
    setAnalysisRunSummary(null);
    setAnalysisError(null);
    fetch(`/api/deliverables/${encodeURIComponent(groupKey)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || "Failed to load");
        setDeliverable(data.deliverable);
        setEvents(data.events ?? []);
        setSources(data.sources ?? null);
        setSummary(data.summary ?? null);
        setSiblings(data.siblings ?? []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [groupKey]);

  // Fetch analysis when Report tab is selected
  useEffect(() => {
    if (detailTab !== "report" || analysisData) return;
    setAnalysisLoading(true);
    setAnalysisError(null);
    fetch(`/api/deliverables/${encodeURIComponent(groupKey)}/analysis`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || "Failed to compute analysis");
        setAnalysisData(data.analysis);
        setAnalysisRunSummary(data.runSummary ?? null);
        setAnalysisSources(data.sources ?? null);
      })
      .catch((err) => setAnalysisError(err instanceof Error ? err.message : "Failed"))
      .finally(() => setAnalysisLoading(false));
  }, [detailTab, groupKey, analysisData]);

  if (loading) return <div className="si-loading">Loading deliverable...</div>;
  if (error) return <div className="si-error">Error: {error}</div>;
  if (!deliverable) return <div className="si-error">Deliverable not found</div>;

  const d = deliverable;
  const s = summary;
  const src = sources;
  const dateStr = new Date(d.lastTs).toLocaleDateString([], {
    month: "short", day: "numeric",
  });

  // Build outputs: main + supporting
  const allOutputs = [
    { ...d.main, isMain: true },
    ...d.supporting.map((si) => ({ ...si, isMain: false })),
  ];

  // Timeline
  const TIMELINE_PREVIEW = 20;
  const visibleTimeline = showFullTimeline ? events : events.slice(0, TIMELINE_PREVIEW);
  const hasMoreTimeline = events.length > TIMELINE_PREVIEW;

  // Sources totals
  const totalSources = src
    ? src.searches.length + src.urlsFetched.length + src.filesRead.length + src.filesEdited.length
    : 0;

  return (
    <div>
      {/* Header */}
      <div className="si-header">
        <button className="si-back" onClick={() => router.push("/analysis#deliverables")}>
          Back
        </button>
        <div className="si-header-info">
          <div className="si-detail-hero">
            <div className="si-detail-agent">
              <strong>{d.agent}</strong> &middot; {dateStr}
              {s && s.durationMs > 0 && <> &middot; {fmtDuration(s.durationMs)}</>}
            </div>
            <div className="si-detail-main-label">{d.main.label}</div>
          </div>
        </div>
      </div>

      {detailTab === "report" ? (
        <DeliverableReport
          analysisData={analysisData}
          analysisRunSummary={analysisRunSummary}
          analysisSources={analysisSources}
          analysisLoading={analysisLoading}
          analysisError={analysisError}
        />
      ) : (
      <>

      {/* What was produced */}
      <div className="si-detail-section">
        <div className="si-detail-section-title">
          What was produced ({allOutputs.length})
        </div>
        <ul className="si-detail-outputs">
          {allOutputs.map((item, i) => {
            const isFile = item.type === "file_written" || item.type === "file_edited";
            const linkHref = item.target ? docsLink(item.target) : null;

            return (
              <li key={i} className="si-detail-output-item">
                {item.isMain && <span className="si-detail-output-star">★</span>}
                <span className="si-detail-output-badge">
                  {DELIVERABLE_TYPE_LABELS[item.type] ?? item.type.replace("_", " ")}
                </span>
                {linkHref ? (
                  <a
                    className="si-detail-output-label si-detail-output-link"
                    data-mono={isFile ? "true" : undefined}
                    href={linkHref}
                    title={item.target ?? item.label}
                  >
                    {item.label}
                  </a>
                ) : (
                  <span
                    className="si-detail-output-label"
                    title={item.label}
                  >
                    {item.label}
                  </span>
                )}
                {linkHref && (
                  <a className="si-detail-doc-link" href={linkHref} title="View file">
                    →
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Research & sources */}
      {src && totalSources > 0 && (
        <div className="si-detail-section">
          <div className="si-detail-section-title">
            Research &amp; sources
          </div>

          <SourceGroup
            icon="🔍"
            title="web search"
            count={src.searches.length}
            totalCount={src.searchCount}
          >
            {src.searches.map((q, i) => (
              <li key={`s-${i}`} className="si-detail-source-item">
                <span className="si-detail-source-text" title={q}>{q}</span>
              </li>
            ))}
          </SourceGroup>

          <SourceGroup
            icon="🌐"
            title="URL fetched"
            count={src.urlsFetched.length}
            totalCount={src.fetchCount}
          >
            {src.urlsFetched.map((u, i) => (
              <li key={`u-${i}`} className="si-detail-source-item">
                <a
                  className="si-detail-source-text si-detail-source-link"
                  href={u.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={u.url}
                >
                  {u.hostname}{u.url.includes("/") ? ` — ${u.url.split("/").slice(3).join("/").slice(0, 60)}` : ""}
                </a>
              </li>
            ))}
          </SourceGroup>

          <SourceGroup
            icon="📖"
            title="file read"
            count={src.filesRead.length}
            totalCount={src.readCount}
          >
            {src.filesRead.map((f, i) => (
              <li key={`r-${i}`} className="si-detail-source-item">
                <a
                  className="si-detail-source-text si-detail-source-link"
                  href={docsLink(f.full)}
                  title={f.full}
                >
                  {f.path}
                </a>
              </li>
            ))}
          </SourceGroup>

          <SourceGroup
            icon="✏️"
            title="file edited"
            count={src.filesEdited.length}
            totalCount={src.editCount}
          >
            {src.filesEdited.map((f, i) => (
              <li key={`e-${i}`} className="si-detail-source-item">
                <a
                  className="si-detail-source-text si-detail-source-link"
                  href={docsLink(f.full)}
                  title={f.full}
                >
                  {f.path}
                </a>
              </li>
            ))}
          </SourceGroup>
        </div>
      )}

      {/* Timeline */}
      {events.length > 0 && (
        <div className="si-detail-section">
          <div className="si-detail-section-title">
            Timeline ({events.length} tool calls)
          </div>
          <ul className="si-detail-timeline">
            {visibleTimeline.map((e) => (
              <li key={e.id} className="si-detail-timeline-item">
                <span className="si-detail-timeline-ts">{fmtTime(e.ts)}</span>
                <span className="si-detail-timeline-type" data-tool={e.toolName}>
                  {TOOL_LABELS[e.toolName ?? ""] ?? e.toolName ?? "tool"}
                </span>
                <span className="si-detail-timeline-detail">
                  {e.toolTarget ?? e.toolQuery ?? ""}
                  {e.success === false && " ✗"}
                </span>
              </li>
            ))}
          </ul>
          {hasMoreTimeline && (
            <button
              className="si-detail-timeline-toggle"
              onClick={() => setShowFullTimeline((p) => !p)}
            >
              {showFullTimeline ? "Show less" : `Show all ${events.length} events`}
            </button>
          )}
        </div>
      )}

      {/* Session stats */}
      {s && (
        <div className="si-detail-section">
          <div className="si-detail-section-title">Session stats</div>
          <div className="si-detail-cost">
            <div className="si-detail-cost-card">
              <div className="si-detail-cost-label">Tool Calls</div>
              <div className="si-detail-cost-value">{s.toolCalls}</div>
            </div>
            {s.llmCalls > 0 && (
              <div className="si-detail-cost-card">
                <div className="si-detail-cost-label">LLM Calls</div>
                <div className="si-detail-cost-value">{s.llmCalls}</div>
              </div>
            )}
            {s.model && (
              <div className="si-detail-cost-card">
                <div className="si-detail-cost-label">Model</div>
                <div className="si-detail-cost-value" style={{ fontSize: 14 }}>
                  {s.model.split(", ").map(shortModel).join(", ")}
                </div>
              </div>
            )}
            <div className="si-detail-cost-card">
              <div className="si-detail-cost-label">Duration</div>
              <div className="si-detail-cost-value">{fmtDuration(s.durationMs)}</div>
            </div>
            {(s.totalTokensIn > 0 || s.totalTokensOut > 0) && (
              <div className="si-detail-cost-card">
                <div className="si-detail-cost-label">Tokens</div>
                <div className="si-detail-cost-value">
                  {fmtTokens(s.totalTokensIn)} in / {fmtTokens(s.totalTokensOut)} out
                </div>
              </div>
            )}
            {s.totalCost != null && (
              <div className="si-detail-cost-card">
                <div className="si-detail-cost-label">Cost</div>
                <div className="si-detail-cost-value">{s.billing === "subscription" ? `~${fmtCost(s.totalCost)} equiv` : fmtCost(s.totalCost)}</div>
              </div>
            )}
            {s.billing && (
              <div className="si-detail-cost-card">
                <div className="si-detail-cost-label">Billing</div>
                <div className="si-detail-cost-value" style={{ fontSize: 14 }}>
                  {s.billing}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Session deliverables (sibling navigation) */}
      {siblings.length > 1 && (
        <div className="si-detail-section">
          <div className="si-detail-section-title">
            Session deliverables ({siblings.length})
          </div>
          <div className="si-detail-siblings">
            {siblings.map((sib) => (
              <button
                key={sib.groupKey}
                className={`si-detail-sibling ${sib.isCurrent ? "si-detail-sibling--current" : ""}`}
                onClick={() => {
                  if (!sib.isCurrent) {
                    const tabParam = detailTab === "report" ? "&tab=report" : "";
                    router.push(`/analysis?deliverable=${encodeURIComponent(sib.groupKey)}${tabParam}`);
                  }
                }}
                title={sib.label}
              >
                <span className="si-detail-sibling-badge">
                  {DELIVERABLE_TYPE_LABELS[sib.type] ?? sib.type.replace("_", " ")}
                </span>
                <span className="si-detail-sibling-label">{sib.label}</span>
                <span className="si-detail-sibling-time">
                  {fmtTime(sib.firstTs)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      </>
      )}
    </div>
  );
}

// ── Deliverable Report ────────────────────────────────────────────────

function DeliverableReport({
  analysisData,
  analysisRunSummary,
  analysisSources,
  analysisLoading,
  analysisError,
}: {
  analysisData: SessionAnalysis | null;
  analysisRunSummary: RunSummary | null;
  analysisSources: ReportSources | null;
  analysisLoading: boolean;
  analysisError: string | null;
}) {
  const [showAllSearches, setShowAllSearches] = useState(false);
  const [showAllUrls, setShowAllUrls] = useState(false);

  if (analysisLoading) return <div className="si-loading">Computing report...</div>;
  if (analysisError) return <div className="si-error">Error: {analysisError}</div>;
  if (!analysisData) return <div className="si-error">No analysis data</div>;

  const scores = analysisData.qualityScores;
  const activity = analysisData.activitySummary;
  const critique = analysisData.critique;
  const src = analysisSources;

  const searches = src?.searches ?? [];
  const urls = src?.urlsFetched ?? [];
  const uniqueDomains = src?.uniqueDomains ?? new Set(urls.map((u) => u.hostname)).size;

  const SEARCH_PREVIEW = 20;
  const URL_PREVIEW = 15;
  const visibleSearches = showAllSearches ? searches : searches.slice(0, SEARCH_PREVIEW);
  const visibleUrls = showAllUrls ? urls : urls.slice(0, URL_PREVIEW);

  const scoreItems: Array<{ label: string; key: keyof QualityScores }> = [
    { label: "Research Depth", key: "researchDepth" },
    { label: "Task Completion", key: "taskCompletion" },
    { label: "Tool Efficiency", key: "toolEfficiency" },
    { label: "Error Recovery", key: "errorRecovery" },
    { label: "Cost Efficiency", key: "costEfficiency" },
  ];

  return (
    <>
      {/* Score cards — compact row */}
      <div className="si-section">
        <div className="si-scores">
          <div className="si-score-card si-score-card--overall">
            <div>
              <div className="si-score-label">Overall</div>
              <div className={`si-score-grade si-score--${scoreColorClass(scores.overall)}`}>
                {scoreToGrade(scores.overall)}
              </div>
            </div>
            <div>
              <div className={`si-score-value si-score--${scoreColorClass(scores.overall)}`}>
                {scores.overall}/100
              </div>
            </div>
          </div>
          {scoreItems.map(({ label, key }) => {
            const val = scores[key];
            const color = scoreColorClass(val);
            return (
              <div key={key} className="si-score-card">
                <div className="si-score-label">{label}</div>
                <div className={`si-score-value si-score--${color}`}>{val}</div>
                <div className="si-score-bar">
                  <div className={`si-score-bar-fill si-score-bar-fill--${color}`} style={{ width: `${val}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Assessment — right after scores */}
      {(critique.strengths.length > 0 || critique.weaknesses.length > 0 || critique.suggestions.length > 0) && (
        <div className="si-section">
          <div className="si-rpt-assessment">
            {critique.strengths.map((s, i) => (
              <div key={`s-${i}`} className="si-rpt-finding si-rpt-finding--strength">{s}</div>
            ))}
            {critique.weaknesses.map((w, i) => (
              <div key={`w-${i}`} className="si-rpt-finding si-rpt-finding--weakness">{w}</div>
            ))}
            {critique.suggestions.map((sg, i) => (
              <div key={`sg-${i}`} className="si-rpt-finding si-rpt-finding--suggestion">{sg}</div>
            ))}
          </div>
        </div>
      )}

      {/* Research coverage stats */}
      <div className="si-section">
        <div className="si-section-title">Research Coverage</div>
        <div className="si-rpt-stats">
          <div className="si-rpt-stat">
            <div className="si-rpt-stat-value">{src?.searchCount ?? activity.searchCount}</div>
            <div className="si-rpt-stat-label">searches</div>
          </div>
          <div className="si-rpt-stat">
            <div className="si-rpt-stat-value">{searches.length}</div>
            <div className="si-rpt-stat-label">unique queries</div>
          </div>
          <div className="si-rpt-stat">
            <div className="si-rpt-stat-value">{src?.fetchCount ?? urls.length}</div>
            <div className="si-rpt-stat-label">pages fetched</div>
          </div>
          <div className="si-rpt-stat">
            <div className="si-rpt-stat-value">{uniqueDomains}</div>
            <div className="si-rpt-stat-label">unique domains</div>
          </div>
          <div className="si-rpt-stat">
            <div className="si-rpt-stat-value">
              {(src?.searchCount ?? activity.searchCount) > 0
                ? `${Math.round((src?.fetchCount ?? urls.length) / (src?.searchCount ?? activity.searchCount) * 100)}%`
                : "n/a"}
            </div>
            <div className="si-rpt-stat-label">fetch ratio</div>
          </div>
          <div className="si-rpt-stat">
            <div className="si-rpt-stat-value">{src?.filesRead ?? activity.filesRead}</div>
            <div className="si-rpt-stat-label">files read</div>
          </div>
        </div>
      </div>

      {/* All searches — the methodology trail */}
      {searches.length > 0 && (
        <div className="si-section">
          <div className="si-section-title">
            Search Queries ({searches.length} unique)
          </div>
          <ol className="si-rpt-search-list">
            {visibleSearches.map((q, i) => (
              <li key={i} className="si-rpt-search-item">{q}</li>
            ))}
          </ol>
          {searches.length > SEARCH_PREVIEW && (
            <button className="si-detail-timeline-toggle" onClick={() => setShowAllSearches((p) => !p)}>
              {showAllSearches ? "Show less" : `Show all ${searches.length} queries`}
            </button>
          )}
        </div>
      )}

      {/* Sources checked — URLs with domains */}
      {urls.length > 0 && (
        <div className="si-section">
          <div className="si-section-title">
            Sources Checked ({urls.length} URLs across {uniqueDomains} domains)
          </div>
          <ul className="si-rpt-url-list">
            {visibleUrls.map((u, i) => (
              <li key={i} className="si-rpt-url-item">
                <span className="si-rpt-url-domain">{u.hostname}</span>
                <a
                  className="si-rpt-url-path"
                  href={u.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={u.url}
                >
                  {u.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 80) || "/"}
                </a>
              </li>
            ))}
          </ul>
          {urls.length > URL_PREVIEW && (
            <button className="si-detail-timeline-toggle" onClick={() => setShowAllUrls((p) => !p)}>
              {showAllUrls ? "Show less" : `Show all ${urls.length} URLs`}
            </button>
          )}
        </div>
      )}

      {/* Cost & Usage */}
      {analysisRunSummary && (() => {
        // Detect missing cost data: $0 cost with very low token input suggests LLM events weren't logged
        const costNotTracked = analysisRunSummary.totalCostUsd === 0
          && analysisRunSummary.totalTokensIn < 1000
          && analysisRunSummary.toolCallCount > 10;
        return (
          <div className="si-section">
            <div className="si-section-title">Usage</div>
            <div className="si-rpt-stats">
              <div className="si-rpt-stat">
                <div className="si-rpt-stat-value">
                  {costNotTracked ? "not tracked" : `${analysisRunSummary.billing === "subscription" ? "~" : ""}${fmtCost(analysisRunSummary.totalCostUsd)}${analysisRunSummary.billing === "subscription" ? " equiv" : ""}`}
                </div>
                <div className="si-rpt-stat-label">total cost</div>
              </div>
              {!costNotTracked && (
                <>
                  <div className="si-rpt-stat">
                    <div className="si-rpt-stat-value">{fmtTokens(analysisRunSummary.totalTokensIn)}</div>
                    <div className="si-rpt-stat-label">tokens in</div>
                  </div>
                  <div className="si-rpt-stat">
                    <div className="si-rpt-stat-value">{fmtTokens(analysisRunSummary.totalTokensOut)}</div>
                    <div className="si-rpt-stat-label">tokens out</div>
                  </div>
                </>
              )}
              <div className="si-rpt-stat">
                <div className="si-rpt-stat-value">{analysisRunSummary.toolCallCount}</div>
                <div className="si-rpt-stat-label">tool calls</div>
              </div>
              <div className="si-rpt-stat">
                <div className="si-rpt-stat-value">{fmtDuration(analysisRunSummary.durationMs)}</div>
                <div className="si-rpt-stat-label">duration</div>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}

// ── Inner Page Component ─────────────────────────────────────────────

const VALID_TABS = ["sessions", "outcomes", "deliverables"] as const;
type AnalysisTab = (typeof VALID_TABS)[number];

function AnalysisPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const sessionKey = params.get("session") ?? "";
  const deliverableKey = params.get("deliverable") ?? "";
  const [tab, setTab] = useHashTab<AnalysisTab>("sessions", VALID_TABS);

  const [analyses, setAnalyses] = useState<AnalysisRecord[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Re-run state
  const [guidelinesInput, setGuidelinesInput] = useState("");
  const [rerunning, setRerunning] = useState(false);

  // Feedback form state
  const [fbRating, setFbRating] = useState<number>(0);
  const [fbQuality, setFbQuality] = useState<string>("");
  const [fbNotes, setFbNotes] = useState("");
  const [fbSaving, setFbSaving] = useState(false);
  const [fbSaved, setFbSaved] = useState(false);

  // Region expand state
  const [expandedRegions, setExpandedRegions] = useState<Set<number>>(new Set());

  const fetchAnalysis = useCallback(async () => {
    if (!sessionKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/logs/session-analysis?session=${encodeURIComponent(sessionKey)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Unknown error");
      const records: AnalysisRecord[] = data.analyses ?? [];
      setAnalyses(records);
      setSelectedId((prev) => prev ?? (records.length > 0 ? records[0].id : null));
      setRunSummary(data.runSummary);
      setFeedback(data.feedback ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analysis");
    } finally {
      setLoading(false);
    }
  }, [sessionKey]);

  const runAnalysis = async () => {
    if (!sessionKey || rerunning) return;
    setRerunning(true);
    try {
      const res = await fetch("/api/logs/session-analysis/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionKey,
          guidelines: guidelinesInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to run analysis");
      const record: AnalysisRecord = data.record;
      // Add to list and select it
      setAnalyses((prev) => [record, ...prev]);
      setSelectedId(record.id);
      setGuidelinesInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run analysis");
    } finally {
      setRerunning(false);
    }
  };

  useEffect(() => {
    fetchAnalysis();
  }, [fetchAnalysis]);

  const toggleRegion = (idx: number) => {
    setExpandedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const submitFeedback = async () => {
    if (!sessionKey || fbSaving) return;
    setFbSaving(true);
    setFbSaved(false);
    try {
      const res = await fetch("/api/logs/session-analysis/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionKey,
          rating: fbRating || null,
          outcomeQuality: fbQuality || null,
          notes: fbNotes || null,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setFbSaved(true);
        setFbRating(0);
        setFbQuality("");
        setFbNotes("");
        // Refresh to get updated feedback list
        fetchAnalysis();
      }
    } catch {
      /* ignore */
    } finally {
      setFbSaving(false);
    }
  };

  // Deliverable detail view — show all tabs at one level
  if (deliverableKey) {
    const dtab = params.get("tab") ?? "";
    const activeSubTab = dtab === "report" ? "report" : "detail";
    return (
      <div className="si-page">
        <div className="ds-tabs">
          <button
            className="ds-tab"
            onClick={() => { router.push("/analysis#sessions"); setTab("sessions"); }}
          >
            Sessions
          </button>
          <button
            className="ds-tab"
            onClick={() => { router.push("/analysis#outcomes"); setTab("outcomes"); }}
          >
            Outcomes
          </button>
          <button
            className="ds-tab"
            onClick={() => { router.push("/analysis#deliverables"); }}
          >
            Deliverables
          </button>
          <span className="ds-tab-separator" />
          <button
            className={`ds-tab ${activeSubTab === "detail" ? "active" : ""}`}
            onClick={() => {
              router.replace(`/analysis?deliverable=${encodeURIComponent(deliverableKey)}`, { scroll: false });
            }}
          >
            Detail
          </button>
          <button
            className={`ds-tab ${activeSubTab === "report" ? "active" : ""}`}
            onClick={() => {
              router.replace(`/analysis?deliverable=${encodeURIComponent(deliverableKey)}&tab=report`, { scroll: false });
            }}
          >
            Report
          </button>
        </div>
        <DeliverableDetailView groupKey={deliverableKey} initialTab={dtab} />
      </div>
    );
  }

  // Sub-tab view when no session selected
  if (!sessionKey) {
    return (
      <div className="si-page">
        <div className="ds-tabs">
          <button
            className={`ds-tab ${tab === "sessions" ? "active" : ""}`}
            onClick={() => setTab("sessions")}
          >
            Sessions
          </button>
          <button
            className={`ds-tab ${tab === "outcomes" ? "active" : ""}`}
            onClick={() => setTab("outcomes")}
          >
            Outcomes
          </button>
          <button
            className={`ds-tab ${tab === "deliverables" ? "active" : ""}`}
            onClick={() => setTab("deliverables")}
          >
            Deliverables
          </button>
        </div>
        {tab === "sessions" && <SessionPickerContent />}
        {tab === "outcomes" && <OutcomesView />}
        {tab === "deliverables" && <DeliverablesView />}
      </div>
    );
  }

  if (loading) {
    return <div className="si-loading">Loading analysis...</div>;
  }

  if (error) {
    return <div className="si-error">Error: {error}</div>;
  }

  if (analyses.length === 0) {
    return <div className="si-error">No analysis data available.</div>;
  }

  const selected = analyses.find((a) => a.id === selectedId) ?? analyses[0];
  const analysis = selected.analysis;
  const scores = analysis.qualityScores;
  const activity = analysis.activitySummary;
  const critique = analysis.critique;

  const scoreItems: Array<{ label: string; key: keyof QualityScores }> = [
    { label: "Tool Efficiency", key: "toolEfficiency" },
    { label: "Research Depth", key: "researchDepth" },
    { label: "Task Completion", key: "taskCompletion" },
    { label: "Error Recovery", key: "errorRecovery" },
    { label: "Cost Efficiency", key: "costEfficiency" },
  ];

  return (
    <div className="si-page">
      {/* Header */}
      <div className="si-header">
        <button className="si-back" onClick={() => router.back()}>Back</button>
        <div className="si-header-info">
          <div className="si-header-agent">Session Analysis</div>
          <div className="si-header-meta">
            <span className="si-badge si-badge--type">{analysis.agentType}</span>
            {runSummary && (
              <span
                className="si-badge si-badge--status"
                data-status={runSummary.status}
              >
                {runSummary.status}
              </span>
            )}
            {runSummary && (
              <span className="si-badge">{fmtDuration(runSummary.durationMs)}</span>
            )}
            {runSummary && (
              <span className="si-badge">{runSummary.billing === "subscription" ? "~" : ""}{fmtCost(runSummary.totalCostUsd)}{runSummary.billing === "subscription" ? " equiv" : ""}</span>
            )}
          </div>
        </div>
        <button
          className="si-back"
          onClick={() => router.push(`/replay?session=${encodeURIComponent(sessionKey)}`)}
        >
          Replay
        </button>
      </div>

      {/* Analysis History */}
      {analyses.length > 0 && (
        <div className="si-section">
          <div className="si-section-title">
            Analysis History ({analyses.length})
          </div>
          <div className="si-history">
            {analyses.map((rec) => (
              <button
                key={rec.id}
                className={`si-history-card ${rec.id === selected.id ? "si-history-card--active" : ""}`}
                onClick={() => setSelectedId(rec.id)}
              >
                <div className="si-history-grade">
                  <span className={`si-score--${scoreColorClass(rec.analysis.qualityScores.overall)}`}>
                    {scoreToGrade(rec.analysis.qualityScores.overall)}
                  </span>
                </div>
                <div className="si-history-info">
                  <div className="si-history-label">
                    {rec.guidelines ? rec.guidelines.slice(0, 60) + (rec.guidelines.length > 60 ? "..." : "") : "Default"}
                  </div>
                  <div className="si-history-meta">
                    {timeAgo(rec.computedAt)} &middot; {rec.analysis.qualityScores.overall}/100
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Re-run with Guidelines */}
      <div className="si-section">
        <div className="si-section-title">Re-run Analysis</div>
        <div className="si-rerun">
          <textarea
            className="si-feedback-notes"
            placeholder='Custom guidelines (optional). Examples: "focus on depth", "ignore cost", "penalize loops", "strict"'
            value={guidelinesInput}
            onChange={(e) => setGuidelinesInput(e.target.value)}
          />
          <button
            className="si-feedback-submit"
            onClick={runAnalysis}
            disabled={rerunning}
            style={{ marginTop: 8 }}
          >
            {rerunning ? "Running..." : "Run Analysis"}
          </button>
          {selected.guidelines && (
            <div className="si-rerun-current">
              Current analysis guidelines: <em>{selected.guidelines}</em>
            </div>
          )}
        </div>
      </div>

      {/* Task */}
      {analysis.task && (
        <div className="si-section">
          <div className="si-section-title">Task</div>
          <div className="si-task">{analysis.task}</div>
        </div>
      )}

      {/* Quality Scores */}
      <div className="si-section">
        <div className="si-section-title">Quality Scores</div>
        <div className="si-scores">
          <div className="si-score-card si-score-card--overall">
            <div>
              <div className="si-score-label">Overall</div>
              <div className={`si-score-grade si-score--${scoreColorClass(scores.overall)}`}>
                {scoreToGrade(scores.overall)}
              </div>
            </div>
            <div>
              <div className={`si-score-value si-score--${scoreColorClass(scores.overall)}`}>
                {scores.overall}/100
              </div>
            </div>
          </div>
          {scoreItems.map(({ label, key }) => {
            const val = scores[key];
            const color = scoreColorClass(val);
            return (
              <div key={key} className="si-score-card">
                <div className="si-score-label">{label}</div>
                <div className={`si-score-value si-score--${color}`}>
                  {val}
                </div>
                <div className="si-score-bar">
                  <div
                    className={`si-score-bar-fill si-score-bar-fill--${color}`}
                    style={{ width: `${val}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Work Regions */}
      <div className="si-section">
        <div className="si-section-title">
          Work Regions ({analysis.regions.length})
        </div>
        {analysis.regions.map((region) => {
          const isOpen = expandedRegions.has(region.regionIndex);
          return (
            <div key={region.regionIndex} className="si-region">
              <div
                className="si-region-header"
                onClick={() => toggleRegion(region.regionIndex)}
              >
                <span className={`si-region-toggle ${isOpen ? "si-region-toggle--open" : ""}`}>
                  &#9654;
                </span>
                <span className="si-region-index">R{region.regionIndex + 1}</span>
                <span className="si-region-trigger">
                  {region.trigger ?? "[autonomous]"}
                </span>
                <span className="si-region-stats">
                  <span>{region.outcomes.length} outcome{region.outcomes.length !== 1 ? "s" : ""}</span>
                  <span>{region.toolCalls} tools</span>
                  <span>{runSummary?.billing === "subscription" ? "~" : ""}{fmtCost(region.cost)}</span>
                </span>
              </div>
              {isOpen && (
                <div className="si-region-detail">
                  {region.outcomes.length > 0 && (
                    <div className="si-region-outcomes">
                      <div className="si-region-sub-title">Outcomes</div>
                      {region.outcomes.map((o, i) => (
                        <div key={i} className="si-outcome-item">
                          <span className="si-outcome-type">{o.type.replace("_", " ")}</span>
                          <span>{o.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {region.supportingActions.length > 0 && (
                    <div className="si-region-supporting">
                      <div className="si-region-sub-title">Supporting Actions</div>
                      {region.supportingActions.map((o, i) => (
                        <div key={i} className="si-outcome-item">
                          <span className="si-outcome-type">{o.type.replace("_", " ")}</span>
                          <span>{o.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="si-region-stats" style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>
                    {region.llmCalls} LLM calls |{" "}
                    {fmtTokens(region.tokens.in)} in / {fmtTokens(region.tokens.out)} out |{" "}
                    {fmtTime(region.startTs)} - {fmtTime(region.endTs)}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Activity Breakdown */}
      <div className="si-section">
        <div className="si-section-title">Activity Breakdown</div>
        <div className="si-activity">
          <div className="si-activity-stat">
            <div className="si-activity-stat-label">Searches</div>
            <div className="si-activity-stat-value">{activity.searchCount}</div>
          </div>
          <div className="si-activity-stat">
            <div className="si-activity-stat-label">URLs Fetched</div>
            <div className="si-activity-stat-value">{activity.uniqueUrlsFetched}</div>
          </div>
          <div className="si-activity-stat">
            <div className="si-activity-stat-label">Fetch Ratio</div>
            <div className="si-activity-stat-value">
              {activity.searchCount > 0
                ? `${Math.round(activity.sourceFetchRatio * 100)}%`
                : "n/a"}
            </div>
          </div>
          <div className="si-activity-stat">
            <div className="si-activity-stat-label">Files Written</div>
            <div className="si-activity-stat-value">{activity.filesWritten}</div>
          </div>
          <div className="si-activity-stat">
            <div className="si-activity-stat-label">Files Read</div>
            <div className="si-activity-stat-value">{activity.filesRead}</div>
          </div>
          <div className="si-activity-stat">
            <div className="si-activity-stat-label">Commands</div>
            <div className="si-activity-stat-value">{activity.commandsRun}</div>
          </div>
          {activity.modelsUsed.length > 0 && (
            <div className="si-activity-stat" style={{ gridColumn: "1 / -1" }}>
              <div className="si-activity-stat-label">Models</div>
              <div className="si-activity-stat-value" style={{ fontSize: 14 }}>
                {activity.modelsUsed.map(shortModel).join(", ")}
              </div>
            </div>
          )}
          {activity.toolBreakdown.length > 0 && (
            <div className="si-activity-table">
              <table>
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Count</th>
                    <th>Success</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.toolBreakdown.map((t) => (
                    <tr key={t.tool}>
                      <td>{t.tool}</td>
                      <td>{t.count}</td>
                      <td>{t.successRate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Critique */}
      {(critique.strengths.length > 0 || critique.weaknesses.length > 0 || critique.suggestions.length > 0) && (
        <div className="si-section">
          <div className="si-section-title">Critique</div>
          <ul className="si-critique-list">
            {critique.strengths.map((s, i) => (
              <li key={`s-${i}`} className="si-critique-item">
                <span className="si-critique-icon si-critique-icon--strength">+</span>
                <span>{s}</span>
              </li>
            ))}
            {critique.weaknesses.map((w, i) => (
              <li key={`w-${i}`} className="si-critique-item">
                <span className="si-critique-icon si-critique-icon--weakness">-</span>
                <span>{w}</span>
              </li>
            ))}
            {critique.suggestions.map((sg, i) => (
              <li key={`sg-${i}`} className="si-critique-item">
                <span className="si-critique-icon si-critique-icon--suggestion">&rarr;</span>
                <span>{sg}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Run Summary */}
      {runSummary && (
        <div className="si-section">
          <div className="si-section-title">Run Summary</div>
          <div className="si-task" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
            <div>
              <div className="si-activity-stat-label">Duration</div>
              <div style={{ fontFamily: "monospace", fontSize: 14 }}>{fmtDuration(runSummary.durationMs)}</div>
            </div>
            <div>
              <div className="si-activity-stat-label">Cost</div>
              <div style={{ fontFamily: "monospace", fontSize: 14 }}>{runSummary.billing === "subscription" ? "~" : ""}{fmtCost(runSummary.totalCostUsd)}{runSummary.billing === "subscription" ? " equiv" : ""}</div>
            </div>
            <div>
              <div className="si-activity-stat-label">Tokens In</div>
              <div style={{ fontFamily: "monospace", fontSize: 14 }}>{fmtTokens(runSummary.totalTokensIn)}</div>
            </div>
            <div>
              <div className="si-activity-stat-label">Tokens Out</div>
              <div style={{ fontFamily: "monospace", fontSize: 14 }}>{fmtTokens(runSummary.totalTokensOut)}</div>
            </div>
            <div>
              <div className="si-activity-stat-label">Tool Calls</div>
              <div style={{ fontFamily: "monospace", fontSize: 14 }}>{runSummary.toolCallCount}</div>
            </div>
          </div>
        </div>
      )}

      {/* Feedback */}
      <div className="si-section">
        <div className="si-section-title">Your Feedback</div>
        <div className="si-feedback">
          <div className="si-feedback-row">
            <span className="si-feedback-label">Rating</span>
            <div className="si-feedback-stars">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  className={`si-feedback-star ${fbRating >= star ? "si-feedback-star--active" : ""}`}
                  onClick={() => setFbRating(star)}
                >
                  ★
                </button>
              ))}
            </div>
          </div>
          <div className="si-feedback-row">
            <span className="si-feedback-label">Quality</span>
            <div className="si-feedback-quality">
              {["good", "acceptable", "poor"].map((q) => (
                <button
                  key={q}
                  className={`si-feedback-quality-btn ${fbQuality === q ? "si-feedback-quality-btn--active" : ""}`}
                  onClick={() => setFbQuality(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
          <textarea
            className="si-feedback-notes"
            placeholder="Notes (optional)..."
            value={fbNotes}
            onChange={(e) => setFbNotes(e.target.value)}
          />
          <div style={{ display: "flex", alignItems: "center" }}>
            <button
              className="si-feedback-submit"
              onClick={submitFeedback}
              disabled={fbSaving || (!fbRating && !fbQuality && !fbNotes)}
            >
              {fbSaving ? "Saving..." : "Submit Feedback"}
            </button>
            {fbSaved && <span className="si-feedback-saved">Saved</span>}
          </div>

          {/* Previous feedback */}
          {feedback.length > 0 && (
            <div className="si-feedback-history">
              <div className="si-region-sub-title">Previous Feedback</div>
              {feedback.map((fb) => (
                <div key={fb.id} className="si-feedback-history-item">
                  {fb.rating ? `★ ${fb.rating}/5` : ""}
                  {fb.outcomeQuality ? ` · ${fb.outcomeQuality}` : ""}
                  {fb.notes ? ` · "${fb.notes}"` : ""}
                  {" · "}
                  {new Date(fb.createdAt).toLocaleDateString()}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page Export (Suspense boundary for useSearchParams) ───────────────

export default function AnalysisPage() {
  return (
    <Suspense fallback={<div className="si-loading">Loading...</div>}>
      <AnalysisPageInner />
    </Suspense>
  );
}
