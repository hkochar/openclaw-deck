"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAgentConfig } from "@/lib/use-agent-config";
import { FilterChips } from "@/components/filter-chips";

// ── Types ────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  snippet: string;
  sourceType: string;
  sourceId: string;
  timestamp: number;
  agent: string;
  clickUrl: string;
}

interface SearchGroup {
  type: string;
  label: string;
  count: number;
  results: SearchResult[];
}

interface SearchResponse {
  query: string;
  totalHits: number;
  groups: SearchGroup[];
}

// ── Constants ────────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  { key: "", label: "All" },
  { key: "event", label: "Events" },
  { key: "session", label: "Sessions" },
  { key: "deliverable", label: "Deliverables" },
  { key: "analysis", label: "Analysis" },
  { key: "activity", label: "Activities" },
  { key: "config", label: "Config" },
  { key: "doc", label: "Docs" },
];

const BADGE_COLORS: Record<string, string> = {
  event: "#2563eb",
  session: "#7c3aed",
  deliverable: "#d97706",
  analysis: "#059669",
  activity: "#6366f1",
  heartbeat: "#ec4899",
  config: "#8b5cf6",
  doc: "#14b8a6",
};

// ── Helpers ──────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Parse snippet HTML into safe React elements (only <mark> highlights preserved). */
function parseSnippet(html: string): Array<{ text: string; highlighted: boolean }> {
  const parts: Array<{ text: string; highlighted: boolean }> = [];
  let inMark = false;
  for (const segment of html.split(/(<\/?mark>)/gi)) {
    const lower = segment.toLowerCase();
    if (lower === "<mark>") { inMark = true; continue; }
    if (lower === "</mark>") { inMark = false; continue; }
    // Strip any other HTML tags from this text segment
    const clean = segment.replace(/<[^>]*>/g, "");
    if (clean) parts.push({ text: clean, highlighted: inMark });
  }
  return parts;
}

// ── Inner Component ─────────────────────────────────────────────────

function SearchPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { agentKeys, agentLabels, agentMetadata } = useAgentConfig();

  // State from URL
  const initialQuery = searchParams.get("q") ?? "";
  const initialType = searchParams.get("type") ?? "";
  const initialAgent = searchParams.get("agent") ?? "";

  const [input, setInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [typeFilter, setTypeFilter] = useState(initialType);
  const [agentFilter, setAgentFilter] = useState(initialAgent);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Debounce input → query
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(input), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input]);

  // Sync state to URL
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (typeFilter) params.set("type", typeFilter);
    if (agentFilter) params.set("agent", agentFilter);
    const qs = params.toString();
    const url = qs ? `/search?${qs}` : "/search";
    router.replace(url, { scroll: false });
  }, [query, typeFilter, agentFilter, router]);

  // Fetch results
  const fetchResults = useCallback(async () => {
    if (!query) { setResults(null); return; }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: query });
      if (typeFilter) params.set("type", typeFilter);
      if (agentFilter) params.set("agent", agentFilter);
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Search failed");
      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, [query, typeFilter, agentFilter]);

  useEffect(() => { fetchResults(); }, [fetchResults]);

  const toggleGroup = (type: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // Agent filter chips
  const agentOptions = agentKeys.map(k => ({
    key: k,
    label: agentMetadata[k]?.emoji
      ? `${agentMetadata[k].emoji} ${agentLabels[k] || k}`
      : agentLabels[k] || k,
  }));

  return (
    <div className="search-page">
      <h1>Search</h1>

      {/* Search input */}
      <div className="search-input-wrap">
        <input
          className="search-input"
          type="text"
          placeholder="Search events, sessions, docs, config…"
          value={input}
          onChange={e => setInput(e.target.value)}
          autoFocus
        />
        {input && (
          <button
            className="search-clear-btn"
            onClick={() => { setInput(""); setQuery(""); setResults(null); }}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="search-filters">
        <FilterChips
          label="Type"
          options={TYPE_OPTIONS}
          selected={typeFilter}
          onChange={(v: string) => setTypeFilter(v)}
        />
        {agentOptions.length > 0 && (
          <FilterChips
            label="Agent"
            options={[{ key: "", label: "All" }, ...agentOptions]}
            selected={agentFilter}
            onChange={(v: string) => setAgentFilter(v)}
          />
        )}
      </div>

      {/* Results area */}
      <div className="search-results">
        {loading && <p className="search-loading">Searching…</p>}
        {error && <p className="search-error">{error}</p>}
        {!loading && !error && !query && !results && (
          <div className="search-hint">
            <p className="search-hint-title">Search across all your agent data</p>
            <div className="search-hint-categories">
              <div className="search-hint-cat"><span className="search-result-badge" style={{ background: BADGE_COLORS.event }}>Events</span> LLM calls, tool invocations, messages</div>
              <div className="search-hint-cat"><span className="search-result-badge" style={{ background: BADGE_COLORS.session }}>Sessions</span> Agent session transcripts and metadata</div>
              <div className="search-hint-cat"><span className="search-result-badge" style={{ background: BADGE_COLORS.doc }}>Docs</span> Agent memory files and documentation</div>
              <div className="search-hint-cat"><span className="search-result-badge" style={{ background: BADGE_COLORS.config }}>Config</span> Gateway and dashboard configuration</div>
              <div className="search-hint-cat"><span className="search-result-badge" style={{ background: BADGE_COLORS.activity }}>Activities</span> System events and status changes</div>
              <div className="search-hint-cat"><span className="search-result-badge" style={{ background: BADGE_COLORS.analysis }}>Analysis</span> Session quality scores and assessments</div>
              <div className="search-hint-cat"><span className="search-result-badge" style={{ background: BADGE_COLORS.deliverable }}>Deliverables</span> Tracked outputs and artifacts</div>
            </div>
            <p className="search-hint-examples">Try: <code>error</code>, <code>budget exceeded</code>, <code>model drift</code>, or an agent name</p>
          </div>
        )}
        {!loading && !error && query && results && results.totalHits === 0 && (
          <p className="search-empty">No results for &ldquo;{query}&rdquo;</p>
        )}
        {!loading && results && results.totalHits > 0 && (
          <>
            <p className="search-summary">{results.totalHits.toLocaleString()} results</p>
            {results.groups.map(group => (
              <div key={group.type} className="search-group">
                <button
                  className="search-group-header"
                  onClick={() => toggleGroup(group.type)}
                >
                  <span className="search-group-chevron">{collapsed.has(group.type) ? "▸" : "▾"}</span>
                  <span>{group.label}</span>
                  <span className="search-group-count">({group.count})</span>
                </button>
                {!collapsed.has(group.type) && (
                  <div className="search-group-results">
                    {group.results.map((r, i) => (
                      <a
                        key={`${r.sourceId}-${i}`}
                        href={r.clickUrl}
                        className="search-result"
                      >
                        <div className="search-result-top">
                          <span
                            className="search-result-badge"
                            style={{ background: BADGE_COLORS[r.sourceType] || "#666" }}
                          >
                            {r.sourceType}
                          </span>
                          <span className="search-result-title">{r.title}</span>
                        </div>
                        {r.snippet && (
                          <p className="search-result-snippet">
                            {parseSnippet(r.snippet).map((part, i) =>
                              part.highlighted ? <mark key={i}>{part.text}</mark> : part.text
                            )}
                          </p>
                        )}
                        <div className="search-result-meta">
                          {r.agent && (
                            <span className="search-result-agent">
                              {agentMetadata[r.agent]?.emoji ?? ""} {agentLabels[r.agent] || r.agent}
                            </span>
                          )}
                          {r.timestamp > 0 && (
                            <span className="search-result-time">{relativeTime(r.timestamp)}</span>
                          )}
                        </div>
                      </a>
                    ))}
                    {group.count > group.results.length && (
                      <p className="search-more">
                        Showing {group.results.length} of {group.count} — refine your query to see more
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ── Page Export ──────────────────────────────────────────────────────

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="search-page"><h1>Search</h1><p>Loading…</p></div>}>
      <SearchPageInner />
    </Suspense>
  );
}
