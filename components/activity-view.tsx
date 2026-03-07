"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useUrlState } from "@/components/use-url-state";
import { FilterChips } from "@/components/filter-chips";
import agentsJson from "@/config/deck-agents.json";

// ── Mobile Hooks ─────────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}

function useSwipe(
  ref: React.RefObject<HTMLDivElement | null>,
  onSwipeLeft: () => void,
  onSwipeRight: () => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    const onStart = (e: TouchEvent) => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; };
    const onEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx > 0) onSwipeRight();
        else onSwipeLeft();
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => { el.removeEventListener("touchstart", onStart); el.removeEventListener("touchend", onEnd); };
  }, [ref, onSwipeLeft, onSwipeRight]);
}

const pillStyle = (active: boolean, color?: string): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, cursor: "pointer",
  border: `1px solid ${active ? (color ?? "var(--accent)") : "var(--border)"}`,
  background: active ? `${color ?? "var(--accent)"}22` : "var(--bg-elevated)",
  color: active ? (color ?? "var(--accent)") : "var(--text-muted)",
  transition: "all 0.15s",
});

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Activity View ──────────────────────────────────────────────────────────

interface DailyActivity {
  agent: string;
  date: string;
  sessions: number;
  activeMinutes: number;
  cost: number;
  api_equiv_cost: number;
  calls: number;
  tokens: number;
}

interface ActivityChunk {
  session_key: string;
  agent: string;
  session_id: string | null;
  channel: string | null;
  display_name: string | null;
  model: string | null;
  chunk_start: number;
  chunk_end: number;
  cost: number;
  api_equiv_cost: number;
  calls: number;
  tokens: number;
  billing: "metered" | "subscription" | null;
  source: "agent" | "heartbeat" | "cron";
}

const AGENT_COLORS: Record<string, string> = Object.fromEntries(
  agentsJson.agents.map((a, i) => {
    const palette = ["#63b3ed", "#fb923c", "#a78bfa", "#fbbf24", "#34d399", "#f87171", "#e879f9"];
    return [a.key, palette[i % palette.length]];
  })
);

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

/** Format cost with ~equiv annotation when subscription billing is involved.
 *  compact=true returns short form for tight spaces (e.g. "~$0.58") */
function formatCostLabel(cost: number, apiEquiv: number, compact?: boolean): string {
  if (cost <= 0 && apiEquiv <= 0) return "$0.00";
  if (cost <= 0) return compact ? `~$${apiEquiv.toFixed(2)}` : `~$${apiEquiv.toFixed(2)} equiv`;
  const subPortion = apiEquiv - cost;
  if (subPortion >= 0.005) return compact ? `$${cost.toFixed(2)}+` : `$${cost.toFixed(2)} + ~$${subPortion.toFixed(2)} equiv`;
  return `$${cost.toFixed(2)}`;
}

// Reusable chunk layout computation (Google Calendar-style overlap detection)
type LayoutChunk = { chunk: ActivityChunk; idx: number; col: number; totalCols: number; top: number; height: number };
const MIN_VISUAL_MINUTES = 15;

function computeChunkLayout(
  chunks: ActivityChunk[],
  dayStartMs: number,
  dayEndMs: number,
  hourHeight: number,
  startHour: number,
): LayoutChunk[] {
  const minHeightPx = (MIN_VISUAL_MINUTES / 60) * hourHeight;
  const minHeightMs = MIN_VISUAL_MINUTES * 60 * 1000;

  const sorted = chunks.map((c, idx) => {
    const start = Math.max(c.chunk_start, dayStartMs);
    const end = Math.min(c.chunk_end, dayEndMs);
    const visualEnd = Math.max(end, start + minHeightMs);
    return { chunk: c, idx, start, end, visualEnd };
  }).sort((a, b) => a.start - b.start || a.end - b.end);

  const columns: number[] = [];
  const layoutItems: LayoutChunk[] = [];
  const groups: number[][] = [];
  let currentGroup: number[] = [];
  let groupEnd = 0;

  for (const item of sorted) {
    if (currentGroup.length > 0 && item.start >= groupEnd) {
      groups.push([...currentGroup]);
      currentGroup = [];
      columns.length = 0;
    }
    let col = 0;
    while (col < columns.length && columns[col] > item.start) col++;
    if (col === columns.length) columns.push(0);
    columns[col] = item.visualEnd;

    const startOffset = (item.start - dayStartMs) / 3600000 - startHour;
    const duration = (item.end - item.start) / 3600000;
    const li = layoutItems.length;
    layoutItems.push({
      chunk: item.chunk, idx: item.idx, col, totalCols: 0,
      top: startOffset * hourHeight,
      height: Math.max(duration * hourHeight, minHeightPx),
    });
    currentGroup.push(li);
    groupEnd = Math.max(groupEnd, item.visualEnd);
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  for (const group of groups) {
    const maxCol = Math.max(...group.map((i) => layoutItems[i].col)) + 1;
    for (const i of group) layoutItems[i].totalCols = maxCol;
  }

  return layoutItems;
}

// Render a single chunk block (reused by day and week views)
function ChunkBlock({ li, color, hourHeight, compact, logsHref }: {
  li: LayoutChunk; color: string; hourHeight: number; compact?: boolean; logsHref?: string;
}) {
  const c = li.chunk;
  const costLabel = formatCostLabel(c.cost, c.api_equiv_cost);
  const minHeightPx = (MIN_VISUAL_MINUTES / 60) * hourHeight;
  const colWidth = (100 - 2) / li.totalCols;
  const leftPct = 1 + li.col * colWidth;
  const widthPct = colWidth - 0.5;
  const start = c.chunk_start;
  const end = c.chunk_end;
  const startTime = new Date(start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const endTime = new Date(end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const durationMin = Math.round((end - start) / 60000);

  const isCompact = compact || li.height < 24;
  const isMedium = !isCompact && li.height < 50;

  return (
    <div style={{
      position: "absolute", top: li.top,
      left: `${leftPct}%`, width: `${widthPct}%`,
      height: li.height, minHeight: minHeightPx,
      background: `${color}22`, border: `1px solid ${color}55`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 4,
      padding: isCompact ? "1px 6px" : "3px 6px",
      overflow: "hidden", cursor: "pointer",
      fontSize: isCompact ? 9 : 10,
      lineHeight: isCompact ? 1.1 : 1.3,
      transition: "opacity 0.15s",
      boxSizing: "border-box",
      display: isCompact ? "flex" : "block",
      alignItems: isCompact ? "center" : undefined,
      gap: isCompact ? 6 : undefined,
    }}
    title={`${c.agent}: ${startTime} – ${endTime} (${formatMinutes(durationMin)})\n${costLabel} · ${c.calls} calls · ${c.tokens.toLocaleString()} tokens\n${c.channel ?? ""} ${c.display_name ?? ""}`}
    onClick={() => { if (logsHref) window.location.href = logsHref; }}
    >
      {isCompact ? (
        <>
          <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{startTime}</span>
          <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {formatMinutes(durationMin)} &middot; {costLabel}
          </span>
        </>
      ) : isMedium ? (
        <>
          <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {startTime} – {endTime}
          </div>
          <div style={{ color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {formatMinutes(durationMin)} &middot; {costLabel} &middot; {c.calls}c
          </div>
        </>
      ) : (
        <>
          <div style={{ fontWeight: 600, marginBottom: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {startTime} – {endTime}
          </div>
          <div style={{ color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {formatMinutes(durationMin)} &middot; {costLabel} &middot; {c.calls}c
          </div>
          {!compact && li.height > 52 && c.channel && (
            <div style={{ color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>
              {c.channel}{c.display_name ? ` · ${c.display_name}` : ""}
            </div>
          )}
          {!compact && li.height > 68 && (
            <div style={{ marginTop: 2, display: "flex", gap: 6 }}>
              <a href={`/replay?session=${encodeURIComponent(c.session_key)}`}
                onClick={(e) => e.stopPropagation()}
                style={{ color, fontSize: 10, textDecoration: "none", fontWeight: 600 }}>
                Replay
              </a>
              <a href={logsHref ?? `/logs?agent=${c.agent}&session=${encodeURIComponent(c.session_key)}`}
                onClick={(e) => e.stopPropagation()}
                style={{ color, fontSize: 10, textDecoration: "none", fontWeight: 600 }}>
                Logs
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Mini calendar sidebar (Google Calendar style)
function MiniCalendar({ viewDate, onSelectDate, activityDates }: {
  viewDate: Date;
  onSelectDate: (date: Date) => void;
  activityDates: Set<string>;
}) {
  const [displayMonth, setDisplayMonth] = useState(() => new Date(viewDate.getFullYear(), viewDate.getMonth(), 1));
  const now = new Date();
  const dYear = displayMonth.getFullYear();
  const dMonth = displayMonth.getMonth();
  const daysInMonth = new Date(dYear, dMonth + 1, 0).getDate();
  const firstDow = new Date(dYear, dMonth, 1).getDay();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const fmtDs = (y: number, m: number, d: number) =>
    `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  return (
    <div style={{ width: 220, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <button onClick={() => setDisplayMonth(new Date(dYear, dMonth - 1, 1))}
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px" }}>&#8249;</button>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {displayMonth.toLocaleString("en-US", { month: "long", year: "numeric" })}
        </span>
        <button onClick={() => setDisplayMonth(new Date(dYear, dMonth + 1, 1))}
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px" }}>&#8250;</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, textAlign: "center" }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, padding: "2px 0" }}>{d}</div>
        ))}
        {cells.map((day, idx) => {
          if (day === null) return <div key={`e-${idx}`} style={{ height: 26 }} />;
          const isToday = dYear === now.getFullYear() && dMonth === now.getMonth() && day === now.getDate();
          const isSelected = dYear === viewDate.getFullYear() && dMonth === viewDate.getMonth() && day === viewDate.getDate();
          const hasActivity = activityDates.has(fmtDs(dYear, dMonth, day));
          return (
            <div key={day} onClick={() => onSelectDate(new Date(dYear, dMonth, day))}
              style={{
                height: 26, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                cursor: "pointer", borderRadius: "50%", fontSize: 11, position: "relative",
                fontWeight: isToday ? 700 : 400,
                background: isSelected ? "var(--accent)" : isToday ? "rgba(74,222,128,0.15)" : "transparent",
                color: isSelected ? "#000" : isToday ? "var(--accent)" : "var(--text)",
              }}>
              {day}
              {hasActivity && !isSelected && (
                <div style={{ position: "absolute", bottom: 1, width: 4, height: 4, borderRadius: "50%", background: "var(--accent)" }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Time gutter (reused by day and week views)
function TimeGutter({ earliestHour, totalHours, hourHeight, headerHeight }: {
  earliestHour: number; totalHours: number; hourHeight: number; headerHeight: number;
}) {
  return (
    <div style={{ width: 50, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--bg-elevated)" }}>
      <div style={{ height: headerHeight, borderBottom: "1px solid var(--border)" }} />
      {Array.from({ length: totalHours }, (_, i) => {
        const hour = earliestHour + i;
        const label = hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`;
        return (
          <div key={hour} style={{
            height: hourHeight, borderBottom: "1px solid var(--border)",
            fontSize: 10, color: "var(--text-muted)", padding: "2px 6px 0", textAlign: "right",
          }}>
            {label}
          </div>
        );
      })}
    </div>
  );
}

// ── Mobile Activity Components ───────────────────────────────────────────────

function MobileFilterDrawer({ open, onClose, children, hasFilters, onReset }: {
  open: boolean; onClose: () => void;
  children: React.ReactNode; hasFilters: boolean; onReset: () => void;
}) {
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100 }} />
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0, maxHeight: "75vh", overflowY: "auto",
        background: "var(--bg-surface)", borderTop: "1px solid var(--border)",
        borderRadius: "16px 16px 0 0", padding: "16px 16px 32px", zIndex: 101,
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--border)", margin: "0 auto 16px" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Filters</span>
          {hasFilters && (
            <button onClick={() => { onReset(); onClose(); }} style={{
              fontSize: 11, padding: "3px 10px", background: "rgba(239,68,68,0.15)",
              color: "#f87171", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4,
              cursor: "pointer", fontFamily: "var(--font-mono)",
            }}>Reset All</button>
          )}
        </div>
        {children}
      </div>
    </>
  );
}

function MobileMonthGrid({ vYear, vMonth, monthCells, byDateStr, selectedDate, onSelect, dateStr: dateStrFn }: {
  vYear: number; vMonth: number;
  monthCells: (number | null)[];
  byDateStr: Map<string, { cost: number; api_equiv_cost: number; agents: Map<string, DailyActivity> }>;
  selectedDate: Date;
  onSelect: (date: Date) => void;
  dateStr: (y: number, m: number, d: number) => string;
}) {
  const now = new Date();
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", textAlign: "center" }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", padding: "4px 0" }}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {monthCells.map((day, idx) => {
          if (day === null) return <div key={`e-${idx}`} style={{ height: 40 }} />;
          const ds = dateStrFn(vYear, vMonth, day);
          const dayData = byDateStr.get(ds);
          const isToday = vYear === now.getFullYear() && vMonth === now.getMonth() && day === now.getDate();
          const isSelected = day === selectedDate.getDate() && vMonth === selectedDate.getMonth() && vYear === selectedDate.getFullYear();
          const hasActivity = dayData && dayData.agents.size > 0;
          return (
            <div key={day} onClick={() => onSelect(new Date(vYear, vMonth, day))} style={{
              height: 40, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              borderRadius: 8, cursor: "pointer", position: "relative",
              background: isSelected ? "rgba(74,222,128,0.2)" : isToday ? "var(--bg-elevated)" : "transparent",
              border: isSelected ? "1px solid var(--accent)" : "1px solid transparent",
            }}>
              <span style={{ fontSize: 13, fontWeight: isToday ? 700 : 400, color: isSelected ? "var(--accent)" : isToday ? "var(--accent)" : "var(--text)" }}>{day}</span>
              {hasActivity && <div style={{ position: "absolute", bottom: 3, width: 4, height: 4, borderRadius: "50%", background: "var(--accent)" }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MobileAgendaList({ date, dayData, navigateToDay, resolveCost }: {
  date: Date;
  dayData: { cost: number; api_equiv_cost: number; agents: Map<string, DailyActivity> } | undefined;
  navigateToDay: (d: Date) => void;
  resolveCost: (d: { cost: number; api_equiv_cost?: number }) => number;
}) {
  if (!dayData || dayData.agents.size === 0) return (
    <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
      No activity on {date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
    </div>
  );
  const agents = [...dayData.agents.entries()].sort((a, b) => resolveCost(b[1]) - resolveCost(a[1]));
  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        {date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
      </div>
      {agents.map(([agent, d]) => {
        const color = AGENT_COLORS[agent] ?? "var(--text-muted)";
        return (
          <div key={agent} onClick={() => navigateToDay(date)} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
            background: "var(--bg-surface)", borderRadius: 8, marginBottom: 6,
            border: "1px solid var(--border)", cursor: "pointer", borderLeft: `3px solid ${color}`,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color }}>{agent}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {d.sessions} session{d.sessions !== 1 ? "s" : ""} &middot; {formatMinutes(d.activeMinutes)} &middot; {d.calls} calls
              </div>
            </div>
            <div style={{ fontWeight: 700, fontSize: 14, fontFamily: "monospace" }}>{formatCostLabel(d.cost, d.api_equiv_cost)}</div>
          </div>
        );
      })}
      <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", fontSize: 12, color: "var(--text-muted)" }}>
        <span>Total</span>
        <span style={{ fontWeight: 700, color: "var(--text)" }}>{formatCostLabel(
          agents.reduce((s, [, d]) => s + d.cost, 0),
          agents.reduce((s, [, d]) => s + d.api_equiv_cost, 0),
        )}</span>
      </div>
    </div>
  );
}

type ActivityViewMode = "day" | "week" | "month";

function ActivityView() {
  const [data, setData] = useState<DailyActivity[] | null>(null);
  const [viewDate, setViewDate] = useState(new Date());
  const [dayChunks, setDayChunks] = useState<ActivityChunk[] | null>(null);
  const [dayChunksLoading, setDayChunksLoading] = useState(false);
  const [weekChunks, setWeekChunks] = useState<Record<string, ActivityChunk[]> | null>(null);
  const [weekChunksLoading, setWeekChunksLoading] = useState(false);

  // Activity filters synced to URL with act. prefix
  const [actFilters, setActFilter] = useUrlState({
    "act.view":     { type: "string" as const, default: "month" },
    "act.agents":   { type: "set" as const, default: new Set<string>() },
    "act.billing":  { type: "string" as const, default: "all" },
    "act.costView": { type: "string" as const, default: "actual" },
    "act.source":   { type: "string" as const, default: "all" },
    "act.minTokens": { type: "number" as const, default: 0 },
    "act.minCost":  { type: "number" as const, default: 0 },
  });
  const agentFilter = actFilters["act.agents"];
  const setAgentFilter = useCallback((v: Set<string>) => setActFilter("act.agents", v), [setActFilter]);
  const calView = actFilters["act.view"] as ActivityViewMode;
  const setCalView = useCallback((v: ActivityViewMode) => setActFilter("act.view", v), [setActFilter]);
  const billingFilter = actFilters["act.billing"] as "all" | "metered" | "subscription";
  const setBillingFilter = useCallback((v: string) => setActFilter("act.billing", v), [setActFilter]);
  const costView = actFilters["act.costView"] as "actual" | "equiv" | "total";
  const setCostView = useCallback((v: string) => setActFilter("act.costView", v), [setActFilter]);
  const sourceFilter = actFilters["act.source"] as "all" | "agent" | "heartbeat" | "cron";
  const setSourceFilter = useCallback((v: string) => setActFilter("act.source", v), [setActFilter]);
  const minTokens = actFilters["act.minTokens"];
  const setMinTokens = useCallback((v: number) => setActFilter("act.minTokens", v), [setActFilter]);
  const minCost = actFilters["act.minCost"];
  const setMinCost = useCallback((v: number) => setActFilter("act.minCost", v), [setActFilter]);

  // Mobile state
  const isMobile = useIsMobile();
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [mobileSelectedDate, setMobileSelectedDate] = useState(new Date());
  const timelineRef = useRef<HTMLDivElement>(null);


  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Apply all chunk-level filters (agent, billing, source, minTokens, minCost)
  const filterChunks = useCallback((chunks: ActivityChunk[]): ActivityChunk[] => {
    let result = chunks;
    if (agentFilter.size > 0) result = result.filter((c) => agentFilter.has(c.agent));
    if (billingFilter === "metered") result = result.filter((c) => c.billing === "metered");
    else if (billingFilter === "subscription") result = result.filter((c) => c.billing === "subscription");
    if (sourceFilter !== "all") result = result.filter((c) => c.source === sourceFilter);
    if (minTokens > 0) result = result.filter((c) => c.tokens >= minTokens);
    if (minCost > 0) result = result.filter((c) => {
      const cv = costView === "equiv" ? (c.api_equiv_cost ?? c.cost) : costView === "total" ? c.cost + (c.api_equiv_cost ?? 0) : c.cost;
      return cv >= minCost;
    });
    return result;
  }, [agentFilter, billingFilter, costView, sourceFilter, minTokens, minCost]);

  // Build a /logs URL for a chunk with current activity filters passed through
  const buildLogsHref = useCallback((c: ActivityChunk) => {
    const p = new URLSearchParams();
    p.set("agent", c.agent);
    // Time range: chunk start/end as ms timestamps (Logs page expects Number())
    p.set("since", String(c.chunk_start));
    p.set("until", String(c.chunk_end));
    if (billingFilter !== "all") p.set("billing", billingFilter);
    if (costView !== "actual") p.set("costView", costView);
    return `/logs?${p.toString()}`;
  }, [billingFilter, costView]);

  // Navigate to a specific day (used by all views)
  const navigateToDay = useCallback((date: Date) => {
    setViewDate(date);
    setCalView("day");
  }, []);

  // Fetch day chunks
  const fetchDayChunks = useCallback((date: Date) => {
    setDayChunksLoading(true);
    fetch(`/api/activity-day-sessions?date=${fmtDate(date)}`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setDayChunks(d); })
      .catch(() => setDayChunks([]))
      .finally(() => setDayChunksLoading(false));
  }, []);

  // Fetch week chunks
  const fetchWeekChunks = useCallback((startDate: Date, extraDays = 0) => {
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6 + extraDays);
    setWeekChunksLoading(true);
    fetch(`/api/activity-week-sessions?start=${fmtDate(startDate)}&end=${fmtDate(endDate)}`)
      .then((r) => r.json())
      .then((d) => { if (d && typeof d === "object") setWeekChunks(d as Record<string, ActivityChunk[]>); })
      .catch(() => setWeekChunks({}))
      .finally(() => setWeekChunksLoading(false));
  }, []);

  // Trigger chunk fetch based on view
  useEffect(() => {
    if (calView === "day") fetchDayChunks(viewDate);
    else if (calView === "week") {
      const ws = new Date(viewDate);
      ws.setDate(ws.getDate() - ws.getDay());
      ws.setHours(0, 0, 0, 0);
      // On mobile 3-day view, fetch a few extra days to handle boundary cases
      fetchWeekChunks(ws, isMobile ? 3 : 0);
    }
  }, [calView, viewDate, isMobile, fetchDayChunks, fetchWeekChunks]);

  // Always fetch 90 days for month/mini-calendar
  const fetchActivity = useCallback(() => {
    fetch("/api/activity-daily?days=90").then((r) => r.json()).then((d) => {
      if (Array.isArray(d)) setData(d);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchActivity();
    const iv = setInterval(fetchActivity, 60_000);
    return () => clearInterval(iv);
  }, [fetchActivity]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return agentFilter.size > 0 ? data.filter((d) => agentFilter.has(d.agent)) : data;
  }, [data, agentFilter]);

  type DaySummary = { cost: number; api_equiv_cost: number; minutes: number; sessions: number; calls: number; tokens: number; agents: Map<string, DailyActivity> };
  const byDateStr = useMemo(() => {
    const map = new Map<string, DaySummary>();
    for (const d of filtered) {
      const existing = map.get(d.date) ?? { cost: 0, api_equiv_cost: 0, minutes: 0, sessions: 0, calls: 0, tokens: 0, agents: new Map() };
      existing.cost += d.cost;
      existing.api_equiv_cost += (d.api_equiv_cost ?? 0);
      existing.minutes += d.activeMinutes;
      existing.sessions += d.sessions;
      existing.calls += d.calls;
      existing.tokens += d.tokens;
      existing.agents.set(d.agent, d);
      map.set(d.date, existing);
    }
    return map;
  }, [filtered]);

  // Set of dates with activity (for mini calendar dots)
  const activityDates = useMemo(() => new Set(byDateStr.keys()), [byDateStr]);

  const allAgents = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.map((d) => d.agent))].sort();
  }, [data]);

  const hasFilters = agentFilter.size > 0 || billingFilter !== "all" || costView !== "actual" || sourceFilter !== "all" || minTokens > 0 || minCost > 0;
  const activeFilterCount = (agentFilter.size > 0 ? 1 : 0) + (billingFilter !== "all" ? 1 : 0) + (costView !== "actual" ? 1 : 0) + (sourceFilter !== "all" ? 1 : 0) + (minTokens > 0 ? 1 : 0) + (minCost > 0 ? 1 : 0);
  const resetAllFilters = useCallback(() => { setAgentFilter(new Set()); setBillingFilter("all"); setCostView("actual"); setSourceFilter("all"); setMinTokens(0); setMinCost(0); }, [setAgentFilter, setBillingFilter, setCostView, setSourceFilter, setMinTokens, setMinCost]);

  const now = new Date();
  const goToday = () => setViewDate(new Date());
  const navigate = (delta: number) => {
    const d = new Date(viewDate);
    if (calView === "month") d.setMonth(d.getMonth() + delta);
    else if (calView === "week") d.setDate(d.getDate() + delta * (isMobile ? 3 : 7));
    else d.setDate(d.getDate() + delta);
    setViewDate(d);
  };

  // Swipe navigation for mobile day/week views
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useSwipe(timelineRef, useCallback(() => navigateRef.current(1), []), useCallback(() => navigateRef.current(-1), []));

  const vYear = viewDate.getFullYear();
  const vMonth = viewDate.getMonth();

  const dateStr = (y: number, m: number, d: number) =>
    `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const headerLabel = calView === "month"
    ? viewDate.toLocaleString("en-US", { month: "long", year: "numeric" })
    : calView === "week"
      ? (() => {
          const d = new Date(viewDate);
          d.setDate(d.getDate() - d.getDay());
          const end = new Date(d); end.setDate(end.getDate() + 6);
          return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
        })()
      : viewDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // Month grid
  const daysInMonth = new Date(vYear, vMonth + 1, 0).getDate();
  const firstDow = new Date(vYear, vMonth, 1).getDay();
  const monthCells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (monthCells.length % 7 !== 0) monthCells.push(null);

  // Week view dates
  const weekStart = useMemo(() => {
    const d = new Date(viewDate);
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
  }, [viewDate]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  }), [weekStart]);

  const isToday = (date: Date) => date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();

  const resolveDailyCost = useCallback((d: { cost: number; api_equiv_cost?: number }) => costView === "equiv" ? (d.api_equiv_cost ?? d.cost) : costView === "total" ? d.cost + (d.api_equiv_cost ?? 0) : d.cost, [costView]);

  const monthMaxCost = useMemo(() => {
    let max = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = dateStr(vYear, vMonth, d);
      const day = byDateStr.get(ds);
      if (day) {
        const c = resolveDailyCost(day);
        if (c > max) max = c;
      }
    }
    return max || 1;
  }, [byDateStr, vYear, vMonth, daysInMonth, resolveDailyCost]);

  // Compute week time range for week view timeline
  const weekTimeRange = useMemo(() => {
    if (calView !== "week" || !weekChunks) return { earliest: 8, latest: 18 };
    let earliest = 24, latest = 0;
    for (const dayChunksArr of Object.values(weekChunks)) {
      const fc = filterChunks(dayChunksArr);
      for (const c of fc) {
        const ds = new Date(c.chunk_start);
        const de = new Date(c.chunk_end);
        const startH = ds.getHours() + ds.getMinutes() / 60;
        const endH = de.getHours() + de.getMinutes() / 60;
        if (startH < earliest) earliest = startH;
        if (endH > latest) latest = endH;
      }
    }
    if (earliest >= latest) return { earliest: 8, latest: 18 };
    return {
      earliest: Math.max(0, Math.floor(earliest) - 1),
      latest: Math.min(24, Math.ceil(latest) + 1),
    };
  }, [calView, weekChunks, filterChunks]);

  if (!data) return <div style={{ padding: 20, color: "var(--text-muted)" }}>Loading activity data...</div>;

  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 4px" }}>Agent Activity</h3>

      {/* Filters — mobile: compact button + drawer; desktop: pills + chip groups */}
      {isMobile ? (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
            <button onClick={() => setFilterDrawerOpen(true)} style={{
              display: "flex", alignItems: "center", gap: 5, padding: "6px 12px",
              background: activeFilterCount > 0 ? "rgba(74,222,128,0.12)" : "var(--bg-elevated)",
              border: `1px solid ${activeFilterCount > 0 ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--text)",
            }}>
              <span style={{ fontSize: 14 }}>&#9881;</span>
              Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
            </button>
          </div>
          <MobileFilterDrawer open={filterDrawerOpen} onClose={() => setFilterDrawerOpen(false)} hasFilters={hasFilters} onReset={resetAllFilters}>
            <div className="logs-filters" style={{ flexDirection: "column", gap: 10 }}>
              <FilterChips label="Agents" options={allAgents.map((a) => ({ key: a, label: a }))} selected={agentFilter} onChange={setAgentFilter} />
              <FilterChips label="Billing" options={[{ key: "all", label: "All" }, { key: "metered", label: "API" }, { key: "subscription", label: "Sub" }]} selected={billingFilter} onChange={setBillingFilter} />
              <FilterChips label="Source" options={[{ key: "all", label: "All" }, { key: "agent", label: "Agent" }, { key: "heartbeat", label: "HB" }, { key: "cron", label: "Cron" }]} selected={sourceFilter} onChange={setSourceFilter} />
              <FilterChips label="Cost View" options={[{ key: "actual", label: "Actual" }, { key: "equiv", label: "API Equiv" }, { key: "total", label: "Total" }]} selected={costView} onChange={setCostView} />
              <FilterChips label="Min Tokens" options={[0, 1000, 10000, 50000, 100000].map((t) => ({ key: String(t), label: t === 0 ? "Any" : `${t >= 1000 ? `${(t / 1000).toFixed(1)}K` : t}+` }))} selected={String(minTokens)} onChange={(v: string) => setMinTokens(Number(v))} />
              <FilterChips label="Min Cost" options={[0, 0.01, 0.05, 0.10, 0.50].map((c) => ({ key: String(c), label: c === 0 ? "Any" : `$${c}+` }))} selected={String(minCost)} onChange={(v: string) => setMinCost(Number(v))} />
            </div>
          </MobileFilterDrawer>
        </>
      ) : (
        <>
          {/* Filter bar */}
          <div className="logs-filters" style={{ marginBottom: 16 }}>
            <FilterChips label="Agents" options={allAgents.map((a) => ({ key: a, label: a }))} selected={agentFilter} onChange={setAgentFilter} />
            <FilterChips label="Billing" options={[{ key: "all", label: "All" }, { key: "metered", label: "API" }, { key: "subscription", label: "Sub" }]} selected={billingFilter} onChange={setBillingFilter} />
            <FilterChips label="Cost View" options={[{ key: "actual", label: "Actual" }, { key: "equiv", label: "API Equiv" }, { key: "total", label: "Total" }]} selected={costView} onChange={setCostView} />
            <FilterChips label="Source" options={[{ key: "all", label: "All" }, { key: "agent", label: "Agent" }, { key: "heartbeat", label: "Heartbeat" }, { key: "cron", label: "Cron" }]} selected={sourceFilter} onChange={setSourceFilter} />
            <FilterChips label="Min Tokens" options={[0, 1000, 10000, 50000, 100000].map((t) => ({ key: String(t), label: t === 0 ? "Any" : `${t >= 1000 ? `${(t / 1000).toFixed(1)}K` : t}+` }))} selected={String(minTokens)} onChange={(v: string) => setMinTokens(Number(v))} />
            <FilterChips label="Min Cost" options={[0, 0.01, 0.05, 0.10, 0.50].map((c) => ({ key: String(c), label: c === 0 ? "Any" : `$${c}+` }))} selected={String(minCost)} onChange={(v: string) => setMinCost(Number(v))} />
          </div>
        </>
      )}

      {/* Navigation + View Switcher */}
      <div className="activity-nav" style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => navigate(-1)} style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "4px 10px", cursor: "pointer", fontSize: 13, minHeight: 36 }}>&#8249;</button>
          <span style={{ fontWeight: 700, fontSize: isMobile ? 13 : 15, minWidth: isMobile ? 0 : 200, textAlign: "center" }}>{isMobile && calView === "week" ? (() => {
            const start = new Date(viewDate);
            start.setDate(start.getDate() - 1);
            const end = new Date(start);
            end.setDate(end.getDate() + 2);
            return `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
          })() : headerLabel}</span>
          <button onClick={() => navigate(1)} style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "4px 10px", cursor: "pointer", fontSize: 13, minHeight: 36 }}>&#8250;</button>
          <button onClick={goToday} style={{ ...pillStyle(false), marginLeft: 4, fontSize: 11, minHeight: 36 }}>Today</button>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {(["day", "week", "month"] as ActivityViewMode[]).map((v) => (
            <button key={v} onClick={() => setCalView(v)} style={{
              padding: "6px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer", minHeight: 36,
              borderRadius: v === "day" ? "6px 0 0 6px" : v === "month" ? "0 6px 6px 0" : 0,
              border: "1px solid var(--border)",
              background: calView === v ? "var(--accent)" : "var(--bg-elevated)",
              color: calView === v ? "#000" : "var(--text-muted)",
            }}>
              {v === "week" && isMobile ? "3 Day" : v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Month View — mobile: compact grid + agenda; desktop: pill bars + click to day */}
      {calView === "month" && (isMobile ? (
        <div ref={timelineRef}>
          <MobileMonthGrid
            vYear={vYear} vMonth={vMonth} monthCells={monthCells}
            byDateStr={byDateStr} selectedDate={mobileSelectedDate}
            onSelect={(d) => setMobileSelectedDate(d)}
            dateStr={dateStr}
          />
          <MobileAgendaList
            date={mobileSelectedDate}
            dayData={byDateStr.get(dateStr(mobileSelectedDate.getFullYear(), mobileSelectedDate.getMonth(), mobileSelectedDate.getDate()))}
            navigateToDay={navigateToDay} resolveCost={resolveDailyCost}
          />
        </div>
      ) : (
        <div style={{ display: "flex", gap: 0 }}>
          <div style={{ marginRight: 16 }}>
            <MiniCalendar viewDate={viewDate} onSelectDate={navigateToDay} activityDates={activityDates} />
          </div>
          <div style={{ flex: 1 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
            {DOW_LABELS.map((d) => (
              <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", padding: "4px 0" }}>{d}</div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
            {monthCells.map((day, idx) => {
              if (day === null) return <div key={`e-${idx}`} style={{ minHeight: 80 }} />;
              const ds = dateStr(vYear, vMonth, day);
              const dayData = byDateStr.get(ds);
              const isTodayCell = vYear === now.getFullYear() && vMonth === now.getMonth() && day === now.getDate();
              const dayCost = dayData ? resolveDailyCost(dayData) : 0;
              const intensity = dayData ? Math.min(dayCost / monthMaxCost, 1) : 0;
              const agentEntries = dayData ? [...dayData.agents.entries()]
                .filter(([, d]) => {
                  if (minCost > 0 && resolveDailyCost(d) < minCost) return false;
                  if (minTokens > 0 && d.tokens < minTokens) return false;
                  return true;
                })
                .sort((a, b) => resolveDailyCost(b[1]) - resolveDailyCost(a[1])) : [];
              const maxPills = 3;
              const overflow = agentEntries.length - maxPills;
              return (
                <div key={day} onClick={() => navigateToDay(new Date(vYear, vMonth, day))} style={{
                  minHeight: 80, padding: 6, borderRadius: 6, position: "relative",
                  border: isTodayCell ? "1px solid #555" : "1px solid var(--border)",
                  background: intensity > 0 ? `rgba(74, 222, 128, ${0.03 + intensity * 0.12})`
                    : isTodayCell ? "var(--bg-elevated)" : "var(--bg-surface)",
                  cursor: "pointer", transition: "all 0.1s",
                }}>
                  <div style={{ fontSize: 12, fontWeight: isTodayCell ? 700 : 500, color: isTodayCell ? "var(--accent)" : "var(--text)", marginBottom: 4 }}>{day}</div>
                  {agentEntries.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      {agentEntries.slice(0, maxPills).map(([agent, d]) => {
                        const color = AGENT_COLORS[agent] ?? "var(--text-muted)";
                        return (
                          <div key={agent} style={{
                            display: "flex", alignItems: "center", gap: 3,
                            background: `${color}22`, borderRadius: 3,
                            padding: "1px 4px", fontSize: 9, lineHeight: 1.2,
                            borderLeft: `2px solid ${color}`,
                            overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
                          }}>
                            <span style={{ fontWeight: 600, color }}>{agent}</span>
                            <span style={{ color: "var(--text-muted)", marginLeft: "auto" }}>{formatCostLabel(d.cost, d.api_equiv_cost, true)}</span>
                          </div>
                        );
                      })}
                      {overflow > 0 && (
                        <div style={{ fontSize: 9, color: "var(--text-muted)", paddingLeft: 4 }}>+{overflow} more</div>
                      )}
                    </div>
                  )}
                  {dayData && dayCost > 0 && agentEntries.length === 0 && (
                    <div style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "monospace" }}>{formatCostLabel(dayData.cost, dayData.api_equiv_cost, true)}</div>
                  )}
                </div>
              );
            })}
          </div>
          </div>
        </div>
      ))}

      {/* Week View — mobile: 3-day, no sidebar; desktop: 7-column timeline */}
      {calView === "week" && (() => {
        const HOUR_HEIGHT = isMobile ? 40 : 50;
        const earliestHour = weekTimeRange.earliest;
        const latestHour = weekTimeRange.latest;
        const totalHours = Math.max(latestHour - earliestHour, 4);
        // Mobile: show 3 days centered on viewDate
        const displayDays = isMobile ? (() => {
          const d = new Date(viewDate);
          d.setDate(d.getDate() - 1);
          return Array.from({ length: 3 }, (_, i) => {
            const dd = new Date(d);
            dd.setDate(dd.getDate() + i);
            return dd;
          });
        })() : weekDays;

        return (
          <div ref={isMobile ? timelineRef : undefined} style={{ display: "flex", gap: 0 }}>
            {/* Mini calendar sidebar — desktop only */}
            {!isMobile && (
              <div style={{ marginRight: 16 }}>
                <MiniCalendar viewDate={viewDate} onSelectDate={navigateToDay} activityDates={activityDates} />
              </div>
            )}

            {/* Week timeline */}
            <div style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "var(--bg-surface)" }}>
              {weekChunksLoading ? (
                <div style={{ padding: 20, color: "var(--text-muted)" }}>Loading week activity...</div>
              ) : (
                <div style={{ display: "flex" }}>
                  <TimeGutter earliestHour={earliestHour} totalHours={totalHours} hourHeight={HOUR_HEIGHT} headerHeight={44} />
                  {displayDays.map((date) => {
                    const ds = fmtDate(date);
                    const dayStartMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
                    const dayEndMs = dayStartMs + 86400000;
                    const rawChunks = weekChunks?.[ds] ?? [];
                    const filteredChunks = filterChunks(rawChunks);
                    const layout = computeChunkLayout(filteredChunks, dayStartMs, dayEndMs, HOUR_HEIGHT, earliestHour);
                    const isTodayCol = isToday(date);
                    return (
                      <div key={ds} onClick={() => navigateToDay(date)} style={{
                        flex: 1, minWidth: 80, borderRight: "1px solid var(--border)", position: "relative",
                        cursor: "pointer",
                        background: isTodayCol ? "rgba(74,222,128,0.04)" : "transparent",
                      }}>
                        {/* Date header */}
                        <div style={{
                          height: 44, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                          borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)",
                        }}>
                          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)" }}>
                            {DOW_LABELS[date.getDay()]}
                          </div>
                          <div style={{
                            fontSize: 16, fontWeight: isTodayCol ? 700 : 500,
                            color: isTodayCol ? "#000" : "var(--text)",
                            background: isTodayCol ? "var(--accent)" : "transparent",
                            borderRadius: "50%", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
                          }}>
                            {date.getDate()}
                          </div>
                        </div>
                        {/* Hour grid */}
                        <div style={{ position: "relative", height: totalHours * HOUR_HEIGHT }}>
                          {Array.from({ length: totalHours }, (_, i) => (
                            <div key={i} style={{
                              position: "absolute", top: i * HOUR_HEIGHT, width: "100%",
                              height: HOUR_HEIGHT, borderBottom: "1px solid var(--border)",
                            }} />
                          ))}
                          {/* Chunks */}
                          {layout.map((li) => (
                            <ChunkBlock key={`${li.chunk.session_key}-${li.idx}`}
                              li={li} color={AGENT_COLORS[li.chunk.agent] ?? "var(--text-muted)"}
                              hourHeight={HOUR_HEIGHT} compact
                              logsHref={buildLogsHref(li.chunk)}
                            />
                          ))}
                          {/* Now indicator */}
                          {isTodayCol && (() => {
                            const nowMs = Date.now();
                            const nowHour = (nowMs - dayStartMs) / 3600000;
                            if (nowHour >= earliestHour && nowHour <= latestHour) {
                              const top = (nowHour - earliestHour) * HOUR_HEIGHT;
                              return (
                                <div style={{ position: "absolute", top, left: 0, right: 0, height: 2, background: "var(--accent-danger, #ef4444)", zIndex: 2 }}>
                                  <div style={{ position: "absolute", left: -4, top: -3, width: 8, height: 8, borderRadius: "50%", background: "var(--accent-danger, #ef4444)" }} />
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Day View — mobile: full-width, inline summary; desktop: sidebar + timeline */}
      {calView === "day" && (() => {
        const dayStartMs = new Date(viewDate.getFullYear(), viewDate.getMonth(), viewDate.getDate()).getTime();
        const dayEndMs = dayStartMs + 86400000;

        const filteredChunks = filterChunks(dayChunks ?? []);

        const totalActiveMin = Math.round(filteredChunks.reduce((sum, c) => sum + (c.chunk_end - c.chunk_start), 0) / 60000);
        const totalActualCost = filteredChunks.reduce((sum, c) => sum + c.cost, 0);
        const totalEquivCost = filteredChunks.reduce((sum, c) => sum + (c.api_equiv_cost ?? c.cost), 0);
        const totalCostLabel = formatCostLabel(totalActualCost, totalEquivCost);
        const totalCalls = filteredChunks.reduce((sum, c) => sum + c.calls, 0);

        // Always show midnight-to-midnight
        const earliestHour = 0;
        const latestHour = 24;
        const totalHours = latestHour - earliestHour;
        const HOUR_HEIGHT = isMobile ? 50 : 60;

        // Group chunks by agent for column layout
        const agentChunks = new Map<string, ActivityChunk[]>();
        for (const c of filteredChunks) {
          const arr = agentChunks.get(c.agent) ?? [];
          arr.push(c);
          agentChunks.set(c.agent, arr);
        }
        const agentKeys = [...agentChunks.keys()].sort();

        return (
          <div ref={isMobile ? timelineRef : undefined} style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 0 }}>
            {/* Mobile: inline summary strip */}
            {isMobile && (
              <div style={{
                display: "flex", gap: 12, padding: "8px 12px", marginBottom: 8,
                background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8,
                overflowX: "auto", whiteSpace: "nowrap", fontSize: 11,
              }}>
                <div><span style={{ color: "var(--text-muted)" }}>Cost </span><span style={{ fontWeight: 700 }}>{totalCostLabel}</span></div>
                <div><span style={{ color: "var(--text-muted)" }}>Active </span><span style={{ fontWeight: 700 }}>{formatMinutes(totalActiveMin)}</span></div>
                <div><span style={{ color: "var(--text-muted)" }}>Blocks </span><span style={{ fontWeight: 700 }}>{filteredChunks.length}</span></div>
                <div><span style={{ color: "var(--text-muted)" }}>Calls </span><span style={{ fontWeight: 700 }}>{totalCalls}</span></div>
              </div>
            )}

            {/* Desktop: Mini calendar sidebar + summary */}
            {!isMobile && (
              <div style={{ marginRight: 16 }}>
                <MiniCalendar viewDate={viewDate} onSelectDate={navigateToDay} activityDates={activityDates} />
                <div style={{ marginTop: 16, padding: 12, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Summary</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--text-muted)" }}>Cost</span>
                      <span style={{ fontWeight: 700 }}>{totalCostLabel}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--text-muted)" }}>Active</span>
                      <span style={{ fontWeight: 700 }}>{formatMinutes(totalActiveMin)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--text-muted)" }}>Blocks</span>
                      <span style={{ fontWeight: 700 }}>{filteredChunks.length}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--text-muted)" }}>LLM Calls</span>
                      <span style={{ fontWeight: 700 }}>{totalCalls}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Day timeline */}
            <div style={{ flex: 1 }}>
              {dayChunksLoading ? (
                <div style={{ padding: 20, color: "var(--text-muted)" }}>Loading activity...</div>
              ) : (
                <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "var(--bg-surface)" }}>
                  <TimeGutter earliestHour={earliestHour} totalHours={totalHours} hourHeight={HOUR_HEIGHT} headerHeight={32} />

                  {/* Agent columns (or empty placeholder) */}
                  <div style={{ display: "flex", flex: 1, overflow: "auto" }}>
                    {agentKeys.length === 0 ? (
                      <div style={{ flex: 1, position: "relative" }}>
                        <div style={{ height: 32, display: "flex", alignItems: "center", padding: "0 8px", borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                          No activity
                        </div>
                        <div style={{ position: "relative", height: totalHours * HOUR_HEIGHT }}>
                          {Array.from({ length: totalHours }, (_, i) => (
                            <div key={i} style={{ position: "absolute", top: i * HOUR_HEIGHT, width: "100%", height: HOUR_HEIGHT, borderBottom: "1px solid var(--border)" }} />
                          ))}
                          {isToday(viewDate) && (() => {
                            const nowMs = Date.now();
                            const nowHour = (nowMs - dayStartMs) / 3600000;
                            if (nowHour >= earliestHour && nowHour <= latestHour) {
                              const top = (nowHour - earliestHour) * HOUR_HEIGHT;
                              return (
                                <div style={{ position: "absolute", top, left: 0, right: 0, height: 2, background: "var(--accent-danger, #ef4444)", zIndex: 2 }}>
                                  <div style={{ position: "absolute", left: -4, top: -3, width: 8, height: 8, borderRadius: "50%", background: "var(--accent-danger, #ef4444)" }} />
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </div>
                    ) : agentKeys.map((agent) => {
                      const chunks = agentChunks.get(agent) ?? [];
                      const color = AGENT_COLORS[agent] ?? "var(--text-muted)";
                      const layout = computeChunkLayout(chunks, dayStartMs, dayEndMs, HOUR_HEIGHT, earliestHour);
                      return (
                        <div key={agent} style={{ flex: 1, minWidth: 140, borderRight: "1px solid var(--border)", position: "relative" }}>
                          <div style={{
                            height: 32, display: "flex", alignItems: "center", gap: 5,
                            padding: "0 8px", borderBottom: "1px solid var(--border)",
                            background: "var(--bg-elevated)", fontSize: 12, fontWeight: 600,
                          }}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                            {agent}
                          </div>

                          <div style={{ position: "relative", height: totalHours * HOUR_HEIGHT }}>
                            {Array.from({ length: totalHours }, (_, i) => (
                              <div key={i} style={{
                                position: "absolute", top: i * HOUR_HEIGHT, width: "100%",
                                height: HOUR_HEIGHT, borderBottom: "1px solid var(--border)",
                              }} />
                            ))}
                            {layout.map((li) => (
                              <ChunkBlock key={`${li.chunk.session_key}-${li.idx}`}
                                li={li} color={color} hourHeight={HOUR_HEIGHT}
                                logsHref={buildLogsHref(li.chunk)}
                              />
                            ))}
                            {/* Now indicator */}
                            {isToday(viewDate) && (() => {
                              const nowMs = Date.now();
                              const nowHour = (nowMs - dayStartMs) / 3600000;
                              if (nowHour >= earliestHour && nowHour <= latestHour) {
                                const top = (nowHour - earliestHour) * HOUR_HEIGHT;
                                return (
                                  <div style={{ position: "absolute", top, left: 0, right: 0, height: 2, background: "var(--accent-danger, #ef4444)", zIndex: 2 }}>
                                    <div style={{ position: "absolute", left: -4, top: -3, width: 8, height: 8, borderRadius: "50%", background: "var(--accent-danger, #ef4444)" }} />
                                  </div>
                                );
                              }
                              return null;
                            })()}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

    </div>
  );
}

export { ActivityView };
