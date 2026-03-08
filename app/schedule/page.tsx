"use client";

import { Fragment, Suspense, useEffect, useState, useCallback, useMemo } from "react";
import { ModelBadge, modelShortName } from "@/components/model-badge";
import { useUrlState } from "@/components/use-url-state";
import { FilterChips } from "@/components/filter-chips";
import agentsJson from "@/config/deck-agents.json";

// ── Types ────────────────────────────────────────────────────────────────────
type ViewMode = "list" | "grid" | "calendar";

interface CronJob {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  model: string | null;
  schedule: string;
  deleteAfterRun: boolean;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveErrors: number;
}

// (CronEntry type removed — CalendarCronEntry used instead)

type ConfigModels = Record<string, { primary: string; fallbacks: string[]; sessionModel: string; actualModel?: string }>;

// Agent key → gateway ID map
const AGENT_ID_MAP: Record<string, string> = Object.fromEntries(
  agentsJson.agents.map((a) => [a.key, a.id])
);
const CONFIG_AGENT_KEYS = agentsJson.agents.map((a) => a.key);

// ── Known models for swap ────────────────────────────────────────────────────
const AVAILABLE_MODELS = [
  { label: "kimi — nvidia/moonshotai/kimi-k2.5 (free, ~60-90s)",      value: "nvidia/moonshotai/kimi-k2.5",                  fallbacks: ["anthropic/claude-sonnet-4-5"] },
  { label: "nemotron — nvidia/nemotron-ultra-253b (free)",             value: "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1", fallbacks: ["anthropic/claude-sonnet-4-5"] },
  { label: "sonnet — anthropic/claude-sonnet-4-5",                     value: "anthropic/claude-sonnet-4-5",                   fallbacks: ["anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5"] },
  { label: "opus — anthropic/claude-opus-4-6",                         value: "anthropic/claude-opus-4-6",                     fallbacks: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"] },
  { label: "haiku — anthropic/claude-haiku-4-5",                       value: "anthropic/claude-haiku-4-5",                    fallbacks: [] },
  { label: "codex — openai/codex-mini-latest",                         value: "openai/codex-mini-latest",                     fallbacks: ["anthropic/claude-sonnet-4-5"] },
  { label: "auto — openrouter/auto",                                   value: "openrouter/auto",                              fallbacks: ["anthropic/claude-sonnet-4-5"] },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function heartbeatColor(agent: Record<string, unknown>): string {
  if (agent.isOffline) return "var(--accent-danger)";
  if (agent.isStale) return "var(--accent-warn, #e8a838)";
  return "var(--accent-success, #34d058)";
}

function modelRisk(model: string | null): "ok" | "warn" | "danger" {
  if (!model) return "danger";
  if (model === "default" || model.endsWith("/default")) return "warn";
  return "ok";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

const KNOWN_AGENTS = [...agentsJson.agents.map((a) => a.key), "creative"] as const;

function extractAgent(name: string): string {
  const lower = name.toLowerCase();
  for (const a of KNOWN_AGENTS) {
    if (lower.startsWith(a) || lower.includes(a + " ") || lower.includes(a + ":") || lower.includes(a + "-")) return a;
  }
  return "other";
}

// ── Drift Banner (compact inline) ────────────────────────────────────────────
function DriftBadge({ event }: { event: { tag: string; actualModel: string; configuredModel: string; timestamp: number } }) {
  const tagConfig: Record<string, { icon: string; label: string }> = {
    unexpected: { icon: "🔴", label: "Drift" },
    cron:       { icon: "🟠", label: "Cron Drift" },
    fallback:   { icon: "🟡", label: "Fallback" },
    session:    { icon: "🔵", label: "Override" },
  };
  const cfg = tagConfig[event.tag] ?? tagConfig.unexpected;
  const ageMs = Date.now() - event.timestamp;
  const age = ageMs < 60_000 ? "now" : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m` : `${Math.floor(ageMs / 3_600_000)}h`;

  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600,
      background: event.tag === "unexpected" ? "rgba(239,68,68,0.12)" : event.tag === "cron" ? "rgba(251,146,60,0.12)" : "rgba(251,191,36,0.12)",
      color: event.tag === "unexpected" ? "#f87171" : event.tag === "cron" ? "#fb923c" : "#fbbf24",
      border: `1px solid ${event.tag === "unexpected" ? "rgba(239,68,68,0.3)" : event.tag === "cron" ? "rgba(251,146,60,0.3)" : "rgba(251,191,36,0.3)"}`,
    }}>
      {cfg.icon} {cfg.label}: <ModelBadge model={event.actualModel} /> ({age})
    </span>
  );
}

// ── Swap Control (reused from models) ────────────────────────────────────────
type SwapState = "idle" | "testing" | "applying" | "success" | "error";

function CompactSwapControl({ agentKey }: { agentKey: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(AVAILABLE_MODELS[0].value);
  const [swapType, setSwapType] = useState<"session" | "permanent">("permanent");
  const [state, setState] = useState<SwapState>("idle");
  const [msg, setMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const selectedModel = AVAILABLE_MODELS.find((m) => m.value === selected)!;

  async function handleSwap() {
    if (swapType === "session") {
      setState("applying"); setMsg("Overriding…");
      try {
        const res = await fetch("/api/model-swap", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "session", agentId: AGENT_ID_MAP[agentKey] ?? agentKey, model: selected }),
        });
        const data = await res.json();
        if (!data.ok) { setState("error"); setMsg(data.error); }
        else { setState("success"); setMsg(`Session → ${modelShortName(selected)}`); setTimeout(() => { setState("idle"); setOpen(false); }, 3000); }
      } catch (err) { setState("error"); setMsg(err instanceof Error ? err.message : String(err)); }
      return;
    }
    setState("testing"); setMsg("Smoke testing…"); setElapsed(0);
    const tick = setInterval(() => setElapsed((e) => e + 1), 1000);
    try {
      const res = await fetch("/api/model-swap", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "swap", agentId: AGENT_ID_MAP[agentKey] ?? agentKey, model: selected, fallbacks: selectedModel.fallbacks }),
      });
      clearInterval(tick);
      const data = await res.json();
      if (!data.ok) { setState("error"); setMsg(data.error); }
      else { setState("success"); setMsg("Config updated, restarting…"); setTimeout(() => { setState("idle"); setOpen(false); }, 3000); }
    } catch (err) { clearInterval(tick); setState("error"); setMsg(err instanceof Error ? err.message : String(err)); }
  }

  if (!open) return <button className="swap-trigger" onClick={() => setOpen(true)} style={{ fontSize: 11, padding: "2px 8px" }}>Swap</button>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <select className="swap-select" value={selected} onChange={(e) => { setSelected(e.target.value); setState("idle"); setMsg(""); }} disabled={state === "testing"} style={{ fontSize: 11, padding: "3px 6px", maxWidth: 180 }}>
          {AVAILABLE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label.split(" — ")[0]}</option>)}
        </select>
        <select value={swapType} onChange={(e) => setSwapType(e.target.value as "session" | "permanent")} style={{ fontSize: 11, padding: "3px 6px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)" }}>
          <option value="session">Session</option>
          <option value="permanent">Permanent</option>
        </select>
        <button className={`swap-btn swap-btn--${state === "success" ? "success" : state === "error" ? "error" : "primary"}`} onClick={handleSwap} disabled={state === "testing" || state === "applying"} style={{ fontSize: 11, padding: "3px 10px" }}>
          {state === "testing" ? `${elapsed}s…` : state === "applying" ? "…" : "Go"}
        </button>
        <button onClick={() => { setOpen(false); setState("idle"); setMsg(""); }} style={{ fontSize: 11, padding: "2px 6px", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer" }}>✕</button>
      </div>
      {msg && <div style={{ fontSize: 11, color: state === "error" ? "var(--accent-danger)" : state === "success" ? "var(--accent-success, #34d058)" : "var(--text-muted)" }}>{msg}</div>}
    </div>
  );
}

// ── 1. Agents Table ──────────────────────────────────────────────────────────
function AgentsTable({ agents, configModels, driftEvents }: {
  agents: Array<Record<string, unknown>>;
  configModels: ConfigModels;
  driftEvents: Array<Record<string, unknown>> | undefined;
}) {
  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 4px" }}>Agent Models</h3>
      <p className="models-subtitle">Configured primary models, fallbacks, and swap controls.</p>
      <div className="models-table-wrap">
        <table className="models-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Running</th>
              <th>Primary</th>
              <th>Fallbacks</th>
              <th>Drift</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const key = agent.key as string;
              const agentConfig = configModels[key];
              const configuredPrimary = agentConfig?.primary ?? (agent.configuredModel as string);
              const configuredFallbacks = agentConfig?.fallbacks ?? (agent.configuredFallbacks as string[]) ?? [];
              const driftModel = (driftEvents as Array<{ agentKey: string; actualModel: string; tag: string; timestamp: number }> | undefined)?.find((d) => d.agentKey === key);
              const sessionOverride = agentConfig?.sessionModel !== configuredPrimary ? agentConfig?.sessionModel : undefined;
              const runningModel = agentConfig?.actualModel ?? driftModel?.actualModel ?? sessionOverride ?? configuredPrimary;
              const isAutoRouter = configuredPrimary?.includes("/auto");
              const mismatch = !isAutoRouter && runningModel && configuredPrimary && runningModel !== configuredPrimary;

              return (
                <tr key={agent._id as string} className={mismatch ? "models-row models-row--mismatch" : "models-row"}>
                  <td className="models-agent">
                    <span className="models-agent-emoji">{agent.emoji as string}</span>
                    <span className="models-agent-name">{agent.name as string}</span>
                  </td>
                  <td>
                    {mismatch ? (
                      <><ModelBadge model={runningModel} /><span className="models-mismatch-badge" title="override">⚠️</span></>
                    ) : (
                      <span className="models-same">—</span>
                    )}
                  </td>
                  <td><ModelBadge model={configuredPrimary} /></td>
                  <td className="models-fallbacks">
                    {configuredFallbacks.length > 0
                      ? configuredFallbacks.map((f, i) => <ModelBadge key={i} model={f} />)
                      : <span className="models-none">none</span>}
                  </td>
                  <td>
                    {driftModel ? <DriftBadge event={driftModel} /> : <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>}
                  </td>
                  <td><CompactSwapControl agentKey={key} /></td>
                  <td>
                    <a
                      href={`/logs?agent=${encodeURIComponent(key)}`}
                      style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap" }}
                      title={`View logs for ${agent.name as string}`}
                    >
                      Logs →
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 2. Heartbeats Table ──────────────────────────────────────────────────────

function humanSchedule(schedule: string): string {
  // "every 5m" → "Every 5 min"
  const everyMatch = schedule.match(/^every\s+(\d+)(ms|s|m|h)$/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2].toLowerCase();
    const labels: Record<string, string> = { ms: "ms", s: "sec", m: "min", h: "hr" };
    return `Every ${n} ${labels[unit] ?? unit}`;
  }
  // "cron: */20 * * * *" → parse cron expression
  let expr = schedule;
  if (expr.startsWith("cron: ")) expr = expr.slice(6);
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hour, dom, mon, dow] = parts;

  // Every N minutes
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${min.slice(2)} min`;
  }
  // Range with step: "5-59/20" = every 20 min offset by 5
  const rangeStep = min.match(/^(\d+)-\d+\/(\d+)$/);
  if (rangeStep && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${rangeStep[2]} min (offset :${rangeStep[1].padStart(2, "0")})`;
  }
  // Specific minute, every hour: "56 * * * *"
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Hourly at :${min.padStart(2, "0")}`;
  }
  // Specific minute + specific hours: "0 */4 * * *"
  if (/^\d+$/.test(min) && hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${hour.slice(2)}h at :${min.padStart(2, "0")}`;
  }
  // Every N min within hour range: "*/15 8-22 * * *"
  const stepHourRange = hour.match(/^(\d+)-(\d+)$/);
  if (min.startsWith("*/") && stepHourRange && dom === "*" && mon === "*" && dow === "*") {
    const startH = parseInt(stepHourRange[1], 10);
    const endH = parseInt(stepHourRange[2], 10);
    const fmtH = (h: number) => { const ampm = h >= 12 ? "PM" : "AM"; const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h; return `${h12} ${ampm}`; };
    return `Every ${min.slice(2)} min, ${fmtH(startH)}–${fmtH(endH)}`;
  }
  // Specific minute within hour range: "0 8-22 * * *"
  if (/^\d+$/.test(min) && stepHourRange && dom === "*" && mon === "*" && dow === "*") {
    const startH = parseInt(stepHourRange[1], 10);
    const endH = parseInt(stepHourRange[2], 10);
    const fmtH = (h: number) => { const ampm = h >= 12 ? "PM" : "AM"; const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h; return `${h12}:${String(parseInt(min)).padStart(2, "0")} ${ampm}`; };
    return `Hourly at :${min.padStart(2, "0")}, ${fmtH(startH)}–${fmtH(endH)}`;
  }
  // Specific time: "30 9 * * *"
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    const h = parseInt(hour, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Daily at ${h12}:${min.padStart(2, "0")} ${ampm}`;
  }
  // Weekly: "0 8 * * 1"
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && /^\d+$/.test(dow)) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const h = parseInt(hour, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${days[parseInt(dow, 10)] ?? dow} at ${h12}:${min.padStart(2, "0")} ${ampm}`;
  }
  return schedule;
}

// ── Cron field validator ─────────────────────────────────────────────────────
function validateCronField(field: string, name: string, min: number, max: number): string | null {
  for (const part of field.split(",")) {
    // step: */N or range/N
    const stepMatch = part.match(/^(\S+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1] : part;
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      if (step <= 0 || step > max) return `${name}: invalid step /${step}`;
    }
    if (base === "*") continue;
    // range: A-B
    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10), b = parseInt(rangeMatch[2], 10);
      if (a < min || a > max || b < min || b > max) return `${name}: ${a}-${b} out of range (${min}-${max})`;
      if (a > b) return `${name}: start ${a} > end ${b}`;
      continue;
    }
    // single number
    if (/^\d+$/.test(base)) {
      const n = parseInt(base, 10);
      if (n < min || n > max) return `${name}: ${n} out of range (${min}-${max})`;
      continue;
    }
    return `${name}: invalid value "${base}"`;
  }
  return null;
}

// ── Heartbeat Edit Panel ─────────────────────────────────────────────────────
function HeartbeatEditPanel({ cron, onSave, onCancel }: {
  cron: CronJob;
  onSave: (cronId: string, patch: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [scheduleInput, setScheduleInput] = useState(() => {
    const s = cron.schedule;
    if (s.startsWith("cron: ")) return s.slice(6);
    return s;
  });
  const [model, setModel] = useState(cron.model ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    const trimmed = scheduleInput.trim();
    if (!trimmed) return "Schedule is required";
    // "every Xm/h/s/ms" format
    if (trimmed.startsWith("every ")) {
      if (!/^every\s+(\d+)\s*(ms|s|m|h)$/i.test(trimmed)) return 'Invalid format — use "every 5m", "every 1h", etc.';
      const match = trimmed.match(/^every\s+(\d+)\s*(ms|s|m|h)$/i)!;
      const val = parseInt(match[1], 10);
      if (val <= 0) return "Interval must be positive";
      const unit = match[2].toLowerCase();
      const ms = val * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[unit] ?? 1);
      if (ms < 10000) return "Interval must be at least 10 seconds";
      if (ms > 86400000) return "Interval must be at most 24 hours";
      return null;
    }
    // Cron expression: must be 5 fields with valid ranges
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 5) return `Cron expression needs 5 fields, got ${fields.length}`;
    const ranges: [string, number, number][] = [["minute", 0, 59], ["hour", 0, 23], ["day", 1, 31], ["month", 1, 12], ["weekday", 0, 7]];
    for (let i = 0; i < 5; i++) {
      const err = validateCronField(fields[i], ranges[i][0], ranges[i][1], ranges[i][2]);
      if (err) return err;
    }
    return null;
  }

  async function handleSave() {
    const err = validate();
    if (err) { setError(err); return; }
    setSaving(true);
    setError(null);

    const patch: Record<string, unknown> = {};
    const trimmed = scheduleInput.trim();

    // Build schedule object
    if (trimmed.startsWith("every ")) {
      const match = trimmed.match(/^every\s+(\d+)\s*(ms|s|m|h)$/i);
      if (match) {
        const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
        patch.schedule = { kind: "every", everyMs: parseInt(match[1]) * (multipliers[match[2].toLowerCase()] || 1) };
      }
    } else {
      patch.schedule = { kind: "cron", expr: trimmed };
    }

    // Build payload patch for model change
    if (model.trim() && model.trim() !== (cron.model ?? "")) {
      patch.payload = { model: model.trim() };
    }

    if (Object.keys(patch).length > 0) {
      await onSave(cron.id, patch);
    }
    setSaving(false);
  }

  return (
    <tr>
      <td colSpan={99} style={{ padding: 0 }}>
        <div style={{ padding: "12px 16px", background: "var(--bg-elevated)", borderTop: "1px solid var(--accent)", borderBottom: "1px solid var(--accent)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Edit: {cron.name}</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 200px" }}>
              <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>Schedule</label>
              <input
                value={scheduleInput}
                onChange={(e) => { setScheduleInput(e.target.value); setError(null); }}
                placeholder="*/20 * * * *  or  every 5m"
                style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: `1px solid ${error ? "var(--accent-danger)" : "var(--border)"}`, background: "var(--bg-surface)", color: "var(--text)", fontSize: 13, fontFamily: "monospace" }}
              />
              {scheduleInput.trim() && !error && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  Preview: {humanSchedule(scheduleInput.startsWith("every ") ? scheduleInput : `cron: ${scheduleInput}`)}
                </div>
              )}
            </div>
            <div style={{ flex: "1 1 200px" }}>
              <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-surface)", color: "var(--text)", fontSize: 13 }}
              >
                <option value="">— no model —</option>
                {AVAILABLE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label.split(" — ")[0]} — {m.value}</option>)}
                {model && !AVAILABLE_MODELS.find((m) => m.value === model) && (
                  <option value={model}>{model} (current)</option>
                )}
              </select>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={handleSave} disabled={saving || !!error} className="cron-action-btn cron-action-btn--primary" style={{ fontSize: 12, padding: "6px 14px" }}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button onClick={onCancel} disabled={saving} className="cron-action-btn" style={{ fontSize: 12, padding: "6px 14px" }}>
                Cancel
              </button>
            </div>
          </div>
          {error && <div style={{ fontSize: 12, color: "var(--accent-danger)", marginTop: 6 }}>{error}</div>}
        </div>
      </td>
    </tr>
  );
}

// ── Shared Issues Banner ─────────────────────────────────────────────────────
function IssuesBanner({ issues, dismissedIds, onDismiss }: {
  issues: CronJob[];
  dismissedIds: Set<string>;
  onDismiss: (id: string) => void;
}) {
  const visible = issues.filter((c) => !dismissedIds.has(c.id));
  if (visible.length === 0) return null;

  return (
    <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 6 }}>
      {visible.map((hb) => (
        <div key={hb.id} style={{
          display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          borderRadius: 8, fontSize: 12,
          background: hb.consecutiveErrors >= 5 ? "rgba(239,68,68,0.08)" : "rgba(251,191,36,0.08)",
          border: `1px solid ${hb.consecutiveErrors >= 5 ? "rgba(239,68,68,0.25)" : "rgba(251,191,36,0.25)"}`,
        }}>
          <span>{hb.consecutiveErrors >= 5 ? "🔴" : "🟡"}</span>
          <strong>{hb.name}</strong>
          <span style={{ color: "var(--text-muted)" }}>—</span>
          <span style={{ color: hb.consecutiveErrors >= 5 ? "#f87171" : "#fbbf24" }}>
            {hb.consecutiveErrors} consecutive error{hb.consecutiveErrors !== 1 ? "s" : ""}
          </span>
          {hb.lastError && (
            <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={hb.lastError}>
              {hb.lastError.slice(0, 100)}
            </span>
          )}
          <a href={`/logs#system?sys.cat=cron&sys.status=error&sys.date=3&sys.q=${encodeURIComponent(hb.name)}`} style={{ color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 }}>
            View logs →
          </a>
          <button
            onClick={() => onDismiss(hb.id)}
            title="Dismiss"
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1, flexShrink: 0 }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function HeartbeatStatusBadge({ cron }: { cron: CronJob }) {
  if (cron.consecutiveErrors >= 5) return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}>🔴 {cron.consecutiveErrors} errors</span>;
  if (cron.consecutiveErrors >= 2) return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }}>🟡 {cron.consecutiveErrors} errors</span>;
  if (!cron.enabled) return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>paused</span>;
  if (cron.lastStatus === "ok") return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}>healthy</span>;
  if (cron.lastStatus === "error") return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}>error</span>;
  return <span style={{ fontSize: 11, color: "var(--text-muted)" }}>—</span>;
}

function HeartbeatsTable({ agents, heartbeatCrons, scheduleEntries, onToggle, onEdit, togglingId, dismissedIds, onDismiss }: {
  agents: Array<Record<string, unknown>>;
  heartbeatCrons: CronJob[];
  scheduleEntries: CalendarCronEntry[];
  onToggle: (c: CronJob) => void;
  onEdit: (cronId: string, patch: Record<string, unknown>) => Promise<void>;
  togglingId: string | null;
  dismissedIds: Set<string>;
  onDismiss: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  // Match heartbeat crons to agents by name/agentId
  function findHeartbeatCrons(agentKey: string): CronJob[] {
    const gatewayId = AGENT_ID_MAP[agentKey] ?? agentKey;
    return heartbeatCrons.filter((c) => {
      const lower = c.name.toLowerCase();
      return lower.includes(agentKey) || c.agentId === gatewayId || c.agentId === agentKey;
    });
  }

  // Schedule entry lookup for lastRun/nextRun
  const scheduleMap = new Map(scheduleEntries.map((s) => [s.id, s]));

  // Issues: consecutive errors or last error
  const issues = heartbeatCrons.filter((c) => c.consecutiveErrors >= 2 || (c.lastError && c.lastStatus === "error"));

  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 4px" }}>Agent Heartbeats</h3>
      <p className="models-subtitle">Heartbeat cron status per agent. Toggle to pause/resume. Click &quot;Edit&quot; to change schedule or model.</p>

      <IssuesBanner issues={issues} dismissedIds={dismissedIds} onDismiss={onDismiss} />

      <div className="models-table-wrap">
        <table className="models-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Heartbeat Cron</th>
              <th>Schedule</th>
              <th>Model</th>
              <th>Last Run</th>
              <th>Status</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const key = agent.key as string;
              const agentHbCrons = findHeartbeatCrons(key);

              if (agentHbCrons.length === 0) {
                return (
                  <tr key={agent._id as string} className="models-row" style={{ opacity: 0.5 }}>
                    <td className="models-agent">
                      <span className="models-agent-emoji">{agent.emoji as string}</span>
                      <span className="models-agent-name">{agent.name as string}</span>
                    </td>
                    <td colSpan={7} style={{ fontSize: 12, color: "var(--text-muted)" }}>No heartbeat cron configured</td>
                  </tr>
                );
              }

              return agentHbCrons.map((hb, idx) => {
                const sched = scheduleMap.get(hb.id);
                const lastRunStr = sched?.lastRun;
                const lastRunAge = lastRunStr ? Date.now() - new Date(lastRunStr).getTime() : null;
                const isSubRow = idx > 0;
                const isEditing = editingId === hb.id;

                return (
                  <Fragment key={hb.id}>
                    <tr className={`models-row${!hb.enabled ? " cron-row--disabled" : ""}`} style={isSubRow ? { borderTop: "1px dashed var(--border)" } : undefined}>
                      <td className="models-agent">
                        {idx === 0 ? (
                          <>
                            <span className="models-agent-emoji">{agent.emoji as string}</span>
                            <span className="models-agent-name">{agent.name as string}</span>
                            <div style={{ fontSize: 11, color: heartbeatColor(agent), marginTop: 2 }}>
                              <span className={`status-dot status-dot--${agent.computedStatus as string}`} />
                              {agent.computedStatus as string} · {formatAge(agent.heartbeatAgeMs as number)}
                            </div>
                          </>
                        ) : (
                          <span style={{ paddingLeft: 24, fontSize: 11, color: "var(--text-muted)" }}>↳</span>
                        )}
                      </td>
                      <td>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{hb.name}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>id: {hb.id.slice(0, 8)}</div>
                      </td>
                      <td>
                        <div style={{ fontSize: 13 }}>{humanSchedule(hb.schedule)}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>{hb.schedule}</div>
                      </td>
                      <td>{hb.model ? <ModelBadge model={hb.model} /> : <span className="models-none">—</span>}</td>
                      <td>
                        {lastRunStr ? (
                          <div>
                            <div style={{ fontSize: 12 }}>{fmtDate(lastRunStr)}</div>
                            {lastRunAge !== null && (
                              <div style={{ fontSize: 11, color: lastRunAge > 60 * 60_000 ? "var(--accent-danger)" : "var(--text-muted)" }}>
                                {formatAge(lastRunAge)}
                              </div>
                            )}
                          </div>
                        ) : <span style={{ fontSize: 12, color: "var(--text-muted)" }}>never</span>}
                      </td>
                      <td>
                        <HeartbeatStatusBadge cron={hb} />
                        {hb.lastError && (
                          <div style={{ fontSize: 10, color: "var(--accent-danger)", marginTop: 3, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={hb.lastError}>
                            {hb.lastError.slice(0, 60)}…
                          </div>
                        )}
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <label className="cron-toggle" title={`${hb.enabled ? "Pause" : "Resume"} ${hb.name}`}>
                            <input type="checkbox" checked={hb.enabled} disabled={togglingId === hb.id} onChange={() => onToggle(hb)} />
                            <span className="cron-toggle-slider" />
                          </label>
                          <button
                            onClick={() => setEditingId(isEditing ? null : hb.id)}
                            className="cron-action-btn"
                            style={{ fontSize: 11, padding: "2px 8px" }}
                          >
                            {isEditing ? "Cancel" : "Edit"}
                          </button>
                        </div>
                      </td>
                      <td>
                        <a
                          href={`/logs#system?sys.cat=cron&sys.date=3&sys.q=${encodeURIComponent(hb.name)}`}
                          style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap" }}
                          title={`View logs for "${hb.name}"`}
                        >
                          Logs →
                        </a>
                      </td>
                    </tr>
                    {isEditing && (
                      <HeartbeatEditPanel
                        cron={hb}
                        onSave={async (id, patch) => { await onEdit(id, patch); setEditingId(null); }}
                        onCancel={() => setEditingId(null)}
                      />
                    )}
                  </Fragment>
                );
              });
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 3. Crons Table ───────────────────────────────────────────────────────────
function CronsTable({ crons, scheduleEntries, onToggle, onEdit, togglingId, dismissedIds, onDismiss }: {
  crons: CronJob[];
  scheduleEntries: CalendarCronEntry[];
  onToggle: (c: CronJob) => void;
  onEdit: (cronId: string, patch: Record<string, unknown>) => Promise<void>;
  togglingId: string | null;
  dismissedIds: Set<string>;
  onDismiss: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const enabled = crons.filter((c) => c.enabled || (!c.deleteAfterRun));
  const atRisk = crons.filter((c) => c.enabled && modelRisk(c.model) !== "ok");
  const failing = crons.filter((c) => c.consecutiveErrors >= 2 || (c.lastError && c.lastStatus === "error"));

  // Map schedule entries by id for lastRun/nextRun lookup
  const scheduleMap = new Map(scheduleEntries.map((s) => [s.id, s]));

  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 4px" }}>Cron Jobs</h3>
      <p className="models-subtitle">
        {crons.length} total, {crons.filter((c) => c.enabled).length} enabled
        {atRisk.length > 0 && <span style={{ color: "var(--accent-warn, #e8a838)" }}> — {atRisk.length} with model warnings</span>}
        {failing.length > 0 && <span style={{ color: "var(--accent-danger)" }}> — {failing.length} failing</span>}
      </p>

      <IssuesBanner issues={failing} dismissedIds={dismissedIds} onDismiss={onDismiss} />

      <div className="models-table-wrap">
        <table className="models-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Agent</th>
              <th>Schedule</th>
              <th>Model</th>
              <th>Last Run</th>
              <th>Next Run</th>
              <th>Status</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {enabled
              .sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1))
              .map((cron) => {
                const risk = modelRisk(cron.model);
                const sched = scheduleMap.get(cron.id);
                const lastRunStr = sched?.lastRun;
                const lastRunAge = lastRunStr ? Date.now() - new Date(lastRunStr).getTime() : null;
                return (
                  <Fragment key={cron.id}>
                    <tr className={`models-row${!cron.enabled ? " cron-row--disabled" : ""}`}>
                      <td style={{ fontWeight: 500, fontSize: 13 }}>
                        {cron.name}
                        {!cron.enabled && <span className="cron-disabled-badge">disabled</span>}
                      </td>
                      <td style={{ fontSize: 12 }}>{cron.agentId}</td>
                      <td style={{ fontSize: 12, color: "var(--text-muted)" }} title={cron.schedule}>
                        {humanSchedule(cron.schedule)}
                      </td>
                      <td>
                        {risk === "danger" ? (
                          <span style={{ color: "var(--accent-danger)", fontSize: 12 }}>⚠️ unset</span>
                        ) : risk === "warn" ? (
                          <span style={{ color: "var(--accent-warn, #e8a838)", fontSize: 12 }}>⚠️ {cron.model}</span>
                        ) : (
                          <ModelBadge model={cron.model} />
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {lastRunAge != null ? (
                          <span title={fmtDate(lastRunStr!)}>{formatAge(lastRunAge)}</span>
                        ) : "—"}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {sched?.nextRun ? fmtDate(sched.nextRun) : "—"}
                      </td>
                      <td><HeartbeatStatusBadge cron={cron} /></td>
                      <td style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <button
                          onClick={() => setEditingId(editingId === cron.id ? null : cron.id)}
                          style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, padding: "2px 6px" }}
                        >
                          {editingId === cron.id ? "Cancel" : "Edit"}
                        </button>
                        <label className="cron-toggle">
                          <input type="checkbox" checked={cron.enabled} disabled={togglingId === cron.id} onChange={() => onToggle(cron)} />
                          <span className="cron-toggle-slider" />
                        </label>
                      </td>
                      <td>
                        <a
                          href={`/logs#system?sys.cat=cron&sys.date=3&sys.q=${encodeURIComponent(cron.name)}`}
                          style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap" }}
                          title={`View logs for "${cron.name}"`}
                        >
                          Logs →
                        </a>
                      </td>
                    </tr>
                    {editingId === cron.id && (
                          <HeartbeatEditPanel
                            cron={cron}
                            onSave={async (id, patch) => { await onEdit(id, patch); setEditingId(null); }}
                            onCancel={() => setEditingId(null)}
                          />
                    )}
                  </Fragment>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 4. Combined Grid View ────────────────────────────────────────────────────
function CombinedGrid({ agents, configModels, driftEvents, crons }: {
  agents: Array<Record<string, unknown>>;
  configModels: ConfigModels;
  driftEvents: Array<Record<string, unknown>> | undefined;
  crons: CronJob[];
}) {
  // Group crons by agent
  const cronsByAgent: Record<string, CronJob[]> = {};
  for (const c of crons) {
    // Try to match cron agent to known agent key
    const agentKey = extractAgent(c.name) !== "other" ? extractAgent(c.name) : c.agentId;
    if (!cronsByAgent[agentKey]) cronsByAgent[agentKey] = [];
    cronsByAgent[agentKey].push(c);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>
      {agents.map((agent) => {
        const key = agent.key as string;
        const agentConfig = configModels[key];
        const configuredPrimary = agentConfig?.primary ?? (agent.configuredModel as string);
        const configuredFallbacks = agentConfig?.fallbacks ?? (agent.configuredFallbacks as string[]) ?? [];
        const driftModel = (driftEvents as Array<{ agentKey: string; actualModel: string; tag: string; timestamp: number }> | undefined)?.find((d) => d.agentKey === key);
        const ageMs = agent.heartbeatAgeMs as number;
        const cronModel = agent.cronModel as string | undefined;
        const cronUpdatedAt = agent.cronModelUpdatedAt as number | undefined;
        const cronAgeMs = cronUpdatedAt ? Date.now() - cronUpdatedAt : null;
        const agentCrons = cronsByAgent[key] ?? cronsByAgent[AGENT_ID_MAP[key]] ?? [];
        const failingCrons = agentCrons.filter((c) => c.enabled && c.consecutiveErrors >= 2);
        const riskCrons = agentCrons.filter((c) => c.enabled && modelRisk(c.model) !== "ok");

        return (
          <div key={agent._id as string} style={{
            background: "var(--bg-surface)",
            border: `1px solid ${driftModel ? "rgba(251,146,60,0.4)" : failingCrons.length > 0 ? "rgba(239,68,68,0.4)" : "var(--border)"}`,
            borderRadius: 10,
            padding: "16px 18px",
            display: "flex", flexDirection: "column", gap: 12,
          }}>
            {/* Header: agent name + status */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20 }}>{agent.emoji as string}</span>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{agent.name as string}</span>
                <span className={`status-dot status-dot--${agent.computedStatus as string}`} />
              </div>
              <CompactSwapControl agentKey={key} />
            </div>

            {/* Drift alert */}
            {driftModel && <DriftBadge event={driftModel} />}

            {/* Model info */}
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 13 }}>
              <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>Primary</span>
              <span><ModelBadge model={configuredPrimary} /></span>

              <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>Fallbacks</span>
              <span>
                {configuredFallbacks.length > 0
                  ? configuredFallbacks.map((f, i) => <ModelBadge key={i} model={f} />)
                  : <span style={{ color: "var(--text-muted)" }}>none</span>}
              </span>

              <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>Heartbeat</span>
              <span style={{ color: heartbeatColor(agent) }}>
                {agent.lastHeartbeat ? formatAge(ageMs) : "never"}
                {agent.lastHeartbeat ? (
                  <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 4 }}>
                    ({new Date(agent.lastHeartbeat).toLocaleTimeString()})
                  </span>
                ) : null}
              </span>

              <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>Work Model</span>
              <span>{agent.model ? <ModelBadge model={agent.model as string} /> : <span style={{ color: "var(--text-muted)" }}>—</span>}</span>

              {cronModel && (
                <>
                  <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>Cron Model</span>
                  <span>
                    <ModelBadge model={cronModel} />
                    {cronAgeMs !== null && (
                      <span style={{ fontSize: 11, marginLeft: 4, color: cronAgeMs > 45 * 60_000 ? "var(--accent-danger)" : "var(--text-muted)" }}>
                        {formatAge(cronAgeMs)}
                      </span>
                    )}
                  </span>
                </>
              )}
            </div>

            {/* Crons summary */}
            {agentCrons.length > 0 && (
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>
                  Crons ({agentCrons.filter((c) => c.enabled).length}/{agentCrons.length} enabled)
                  {failingCrons.length > 0 && <span style={{ color: "var(--accent-danger)" }}> — {failingCrons.length} failing</span>}
                  {riskCrons.length > 0 && <span style={{ color: "var(--accent-warn, #e8a838)" }}> — {riskCrons.length} model risk</span>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {agentCrons.slice(0, 5).map((c) => (
                    <div key={c.id} style={{
                      display: "flex", alignItems: "center", gap: 6, fontSize: 11,
                      opacity: c.enabled ? 1 : 0.5,
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.consecutiveErrors >= 2 ? "var(--accent-danger)" : c.enabled ? "var(--accent-success, #34d058)" : "var(--text-muted)", flexShrink: 0 }} />
                      <span style={{ fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                      <span style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>{c.schedule}</span>
                      {c.model && <ModelBadge model={c.model} />}
                    </div>
                  ))}
                  {agentCrons.length > 5 && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>+{agentCrons.length - 5} more</div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 5. Calendar View ─────────────────────────────────────────────────────────

// Cron field parser (for calendar grid day mapping)
function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    let start = min, end = max;
    if (base === "*") { /* default */ }
    else {
      const rangeMatch = base.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) { start = parseInt(rangeMatch[1], 10); end = parseInt(rangeMatch[2], 10); }
      else { start = end = parseInt(base, 10); }
    }
    for (let i = start; i <= end; i += step) result.add(i);
  }
  return result;
}

function cronDaysInMonth(schedule: string, year: number, month: number): Set<number> {
  // Extract cron expression from schedule label like "cron: 0 */4 * * *"
  let expr = schedule;
  if (expr.startsWith("cron: ")) expr = expr.slice(6);
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) {
    // "every Xm/h" → runs every day
    if (schedule.startsWith("every ")) {
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      return new Set(Array.from({ length: daysInMonth }, (_, i) => i + 1));
    }
    return new Set();
  }
  const domField = parts[2], monField = parts[3], dowField = parts[4];
  const months = parseCronField(monField, 1, 12);
  if (!months.has(month + 1)) return new Set();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const doms = parseCronField(domField, 1, 31);
  const dows = parseCronField(dowField, 0, 7);
  if (dows.has(7)) dows.add(0);
  const domRestricted = domField !== "*", dowRestricted = dowField !== "*";
  const result = new Set<number>();
  for (let day = 1; day <= daysInMonth; day++) {
    const dow = new Date(year, month, day).getDay();
    if (domRestricted && dowRestricted) { if (doms.has(day) || dows.has(dow)) result.add(day); }
    else if (domRestricted) { if (doms.has(day)) result.add(day); }
    else if (dowRestricted) { if (dows.has(dow)) result.add(day); }
    else result.add(day);
  }
  return result;
}

type ModelColor = "purple" | "yellow" | "blue" | "orange" | "gray";
function modelColor(model: string | null): ModelColor {
  if (!model) return "gray";
  if (model.includes("kimi") || model.includes("nvidia") || model.includes("moonshotai")) return "purple";
  if (model.includes("haiku")) return "yellow";
  if (model.includes("sonnet")) return "blue";
  if (model.includes("opus")) return "orange";
  return "gray";
}
const MODEL_COLOR_MAP: Record<ModelColor, { bg: string; color: string; border: string }> = {
  purple: { bg: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "rgba(167,139,250,0.3)" },
  yellow: { bg: "rgba(251,191,36,0.15)",  color: "#fbbf24", border: "rgba(251,191,36,0.3)" },
  blue:   { bg: "rgba(99,179,237,0.15)",  color: "#63b3ed", border: "rgba(99,179,237,0.3)" },
  orange: { bg: "rgba(251,146,60,0.15)",  color: "#fb923c", border: "rgba(251,146,60,0.3)" },
  gray:   { bg: "var(--bg-elevated)",      color: "var(--text-muted)", border: "var(--border)" },
};

interface CalendarCronEntry {
  id: string;
  name: string;
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  model: string | null;
  status: string | null;
  enabled: boolean;
}

function modelLabel(model: string | null): string {
  if (!model) return "unknown";
  if (model.includes("kimi") || model.includes("nvidia") || model.includes("moonshotai")) return "kimi";
  if (model.includes("haiku")) return "haiku";
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("free")) return "free";
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}

type CalendarViewMode = "day" | "week" | "month";
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LEGEND_ITEMS: { label: string; color: string }[] = [
  { label: "sonnet", color: "#63b3ed" },
  { label: "opus", color: "#fb923c" },
  { label: "haiku", color: "#fbbf24" },
  { label: "kimi/nvidia", color: "#a78bfa" },
  { label: "other", color: "var(--text-muted)" },
  { label: "errors", color: "#ef4444" },
];

// Shared pill button style helper
const pillStyle = (active: boolean, color?: string): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, cursor: "pointer",
  border: `1px solid ${active ? (color ?? "var(--accent)") : "var(--border)"}`,
  background: active ? `${color ?? "var(--accent)"}22` : "var(--bg-elevated)",
  color: active ? (color ?? "var(--accent)") : "var(--text-muted)",
  transition: "all 0.15s",
});

// Shared job card renderer
function JobCard({ job, health }: { job: CalendarCronEntry; health?: CronJob }) {
  const failing = health && health.consecutiveErrors >= 2;
  return (
    <div style={{
      background: "var(--bg-elevated)",
      border: `1px solid ${failing ? "rgba(239,68,68,0.4)" : "var(--border)"}`,
      borderRadius: 8, padding: "10px 12px",
    }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "var(--text)" }}>
        {job.name}
        {failing && <span style={{ marginLeft: 6, color: "var(--accent-danger)", fontSize: 11 }}>({health!.consecutiveErrors} errors)</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>{job.schedule}</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
          <ModelBadge model={job.model} />
          <span style={{
            display: "inline-block", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600,
            background: job.enabled ? "rgba(34,197,94,0.15)" : "var(--bg-elevated)",
            color: job.enabled ? "#22c55e" : "var(--text-muted)",
            border: `1px solid ${job.enabled ? "rgba(34,197,94,0.3)" : "var(--border)"}`,
          }}>
            {job.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        {job.nextRun && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Next: {fmtDate(job.nextRun)}</div>}
        {job.lastRun && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Last: {fmtDate(job.lastRun)}</div>}
        {health?.lastError && <div style={{ fontSize: 11, color: "var(--accent-danger)", marginTop: 2 }}>{health.lastError.slice(0, 100)}</div>}
      </div>
    </div>
  );
}

function CalendarView({ scheduleEntries, healthCrons }: {
  scheduleEntries: CalendarCronEntry[];
  healthCrons: CronJob[];
}) {
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [viewDate, setViewDate] = useState(() => new Date());

  const [calFilters, setCalFilter] = useUrlState({
    "cal.view":   { type: "string" as const, default: "month" },
    "cal.agents": { type: "set" as const, default: new Set<string>() },
    "cal.models": { type: "set" as const, default: new Set<string>() },
    "cal.status": { type: "string" as const, default: "all" },
  });
  const calView = calFilters["cal.view"] as CalendarViewMode;
  const setCalView = useCallback((v: CalendarViewMode) => setCalFilter("cal.view", v), [setCalFilter]);
  const agentFilter = calFilters["cal.agents"];
  const setAgentFilter = useCallback((v: Set<string>) => setCalFilter("cal.agents", v), [setCalFilter]);
  const modelFilter = calFilters["cal.models"];
  const setModelFilter = useCallback((v: Set<string>) => setCalFilter("cal.models", v), [setCalFilter]);
  const statusFilter = calFilters["cal.status"] as "all" | "enabled" | "disabled";
  const setStatusFilter = useCallback((v: "all" | "enabled" | "disabled") => setCalFilter("cal.status", v), [setCalFilter]);

  const healthMap = useMemo(() => new Map(healthCrons.map((c) => [c.id, c])), [healthCrons]);

  // Compute available filter options
  const allAgents = useMemo(() => [...new Set(scheduleEntries.map((e) => extractAgent(e.name)))].sort(), [scheduleEntries]);
  const allModels = useMemo(() => [...new Set(scheduleEntries.map((e) => modelLabel(e.model)))].sort(), [scheduleEntries]);
  const enabledCount = useMemo(() => scheduleEntries.filter((e) => e.enabled).length, [scheduleEntries]);
  const disabledCount = scheduleEntries.length - enabledCount;

  // Filter entries
  const filtered = useMemo(() => scheduleEntries.filter((e) => {
    if (statusFilter === "enabled" && !e.enabled) return false;
    if (statusFilter === "disabled" && e.enabled) return false;
    if (agentFilter.size > 0 && !agentFilter.has(extractAgent(e.name))) return false;
    if (modelFilter.size > 0 && !modelFilter.has(modelLabel(e.model))) return false;
    return true;
  }), [scheduleEntries, statusFilter, agentFilter, modelFilter]);

  const hasFilters = agentFilter.size > 0 || modelFilter.size > 0 || statusFilter !== "all";

  // Navigation helpers
  const now = new Date();
  const goToday = () => { setViewDate(new Date()); setSelectedDay(null); };
  const navigate = (delta: number) => {
    const d = new Date(viewDate);
    if (calView === "month") d.setMonth(d.getMonth() + delta);
    else if (calView === "week") d.setDate(d.getDate() + delta * 7);
    else d.setDate(d.getDate() + delta);
    setViewDate(d);
    setSelectedDay(null);
  };

  // Date context for current view
  const vYear = viewDate.getFullYear();
  const vMonth = viewDate.getMonth();
  // Build day→jobs map for current month
  const dayMap = useMemo(() => {
    const map: Record<number, CalendarCronEntry[]> = {};
    for (const job of filtered) {
      const days = cronDaysInMonth(job.schedule, vYear, vMonth);
      for (const day of days) {
        if (!map[day]) map[day] = [];
        map[day].push(job);
      }
    }
    return map;
  }, [filtered, vYear, vMonth]);

  // Header label
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

  // Month grid cells
  const daysInMonth = new Date(vYear, vMonth + 1, 0).getDate();
  const firstDow = new Date(vYear, vMonth, 1).getDay();
  const monthCells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (monthCells.length % 7 !== 0) monthCells.push(null);

  // Week view: get 7 days for the week containing viewDate
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

  // Get jobs for a specific date
  const getJobsForDate = (date: Date): CalendarCronEntry[] => {
    const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
    // If same month as dayMap, use it
    if (y === vYear && m === vMonth) return dayMap[d] ?? [];
    // Otherwise compute on the fly
    return filtered.filter((job) => cronDaysInMonth(job.schedule, y, m).has(d));
  };

  const isToday = (date: Date) => date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const selectedJobs = selectedDay !== null ? (dayMap[selectedDay] ?? []) : [];

  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 4px" }}>Cron Calendar</h3>

      {/* ── Filters ─────────────────────────────────────────── */}
      <div className="logs-filters" style={{ margin: "10px 0 6px" }}>
        <FilterChips
          label="Status"
          options={[
            { key: "all", label: "All", count: scheduleEntries.length },
            { key: "enabled", label: "Enabled", count: enabledCount },
            { key: "disabled", label: "Disabled", count: disabledCount },
          ]}
          selected={statusFilter}
          onChange={setStatusFilter}
        />
        <FilterChips label="Agent" options={allAgents.map((a) => ({ key: a, label: a }))} selected={agentFilter} onChange={setAgentFilter} />
        <FilterChips label="Model" options={allModels.map((m) => ({ key: m, label: m }))} selected={modelFilter} onChange={setModelFilter} />
      </div>

      {/* ── Legend ───────────────────────────────────────────── */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", margin: "4px 0 12px", fontSize: 11, color: "var(--text-muted)" }}>
        {LEGEND_ITEMS.map((item) => (
          <span key={item.label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: item.color, display: "inline-block" }} />
            {item.label}
          </span>
        ))}
        <span style={{ marginLeft: 8 }}>{filtered.length} job{filtered.length !== 1 ? "s" : ""}{hasFilters ? " (filtered)" : ""}</span>
      </div>

      {/* ── Navigation + View Switcher ──────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => navigate(-1)} style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "4px 10px", cursor: "pointer", fontSize: 13 }}>&#8249;</button>
          <span style={{ fontWeight: 700, fontSize: 15, minWidth: 200, textAlign: "center" }}>{headerLabel}</span>
          <button onClick={() => navigate(1)} style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "4px 10px", cursor: "pointer", fontSize: 13 }}>&#8250;</button>
          <button onClick={goToday} style={{ ...pillStyle(false), marginLeft: 4, fontSize: 11 }}>Today</button>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {(["day", "week", "month"] as CalendarViewMode[]).map((v) => (
            <button key={v} onClick={() => { setCalView(v); setSelectedDay(null); }} style={{
              padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer",
              borderRadius: v === "day" ? "6px 0 0 6px" : v === "month" ? "0 6px 6px 0" : 0,
              border: "1px solid var(--border)",
              background: calView === v ? "var(--accent)" : "var(--bg-elevated)",
              color: calView === v ? "#000" : "var(--text-muted)",
            }}>
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Month View ──────────────────────────────────────── */}
      {calView === "month" && (
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 520px", minWidth: 320 }}>
            {/* DOW headers */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
              {DOW_LABELS.map((d) => (
                <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", padding: "4px 0" }}>{d}</div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
              {monthCells.map((day, idx) => {
                if (day === null) return <div key={`e-${idx}`} style={{ minHeight: 52 }} />;
                const jobs = dayMap[day] ?? [];
                const isTodayCell = vYear === now.getFullYear() && vMonth === now.getMonth() && day === now.getDate();
                const isSelected = day === selectedDay;
                const colors = [...new Set(jobs.map((j) => modelColor(j.model)))];
                const hasFailing = jobs.some((j) => { const h = healthMap.get(j.id); return h && h.consecutiveErrors >= 2; });
                return (
                  <div key={day} onClick={() => setSelectedDay(isSelected ? null : day)} style={{
                    minHeight: 52, padding: 6, borderRadius: 6, position: "relative",
                    border: isSelected ? "1px solid var(--accent)" : hasFailing ? "1px solid rgba(239,68,68,0.4)" : isTodayCell ? "1px solid #555" : "1px solid var(--border)",
                    background: isSelected ? "rgba(74,222,128,0.08)" : isTodayCell ? "var(--bg-elevated)" : "var(--bg-surface)",
                    cursor: jobs.length > 0 ? "pointer" : "default", transition: "all 0.1s",
                  }}>
                    <div style={{ fontSize: 12, fontWeight: isTodayCell ? 700 : 500, color: isTodayCell ? "var(--accent)" : "var(--text)", marginBottom: 4 }}>{day}</div>
                    {colors.length > 0 && (
                      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                        {colors.slice(0, 4).map((c) => (
                          <span key={c} style={{ width: 7, height: 7, borderRadius: "50%", background: MODEL_COLOR_MAP[c].color, display: "inline-block", flexShrink: 0 }} />
                        ))}
                        {colors.length > 4 && <span style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: "7px" }}>+</span>}
                      </div>
                    )}
                    {jobs.length > 1 && <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>{jobs.length} jobs</div>}
                    {hasFailing && <div style={{ position: "absolute", top: 4, right: 6, fontSize: 10 }}>🔴</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Day detail sidebar (month view) */}
          {selectedDay !== null && (
            <div style={{ flex: "0 0 300px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>
                  {new Date(vYear, vMonth, selectedDay).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </div>
                <button onClick={() => setSelectedDay(null)} style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 12, padding: "2px 8px", cursor: "pointer" }}>✕</button>
              </div>
              {selectedJobs.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>No jobs scheduled.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {selectedJobs.map((job) => <JobCard key={job.id} job={job} health={healthMap.get(job.id)} />)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Week View ──────────────────────────────────────── */}
      {calView === "week" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
          {weekDays.map((date) => {
            const jobs = getJobsForDate(date);
            const isTodayCol = isToday(date);
            const hasFailing = jobs.some((j) => { const h = healthMap.get(j.id); return h && h.consecutiveErrors >= 2; });
            return (
              <div key={date.toISOString()} style={{
                minHeight: 300, borderRadius: 8, padding: 10,
                border: isTodayCol ? "1px solid #555" : hasFailing ? "1px solid rgba(239,68,68,0.3)" : "1px solid var(--border)",
                background: isTodayCol ? "var(--bg-elevated)" : "var(--bg-surface)",
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 2 }}>
                  {DOW_LABELS[date.getDay()]}
                </div>
                <div style={{ fontSize: 14, fontWeight: isTodayCol ? 700 : 500, color: isTodayCol ? "var(--accent)" : "var(--text)", marginBottom: 8 }}>
                  {date.getDate()}
                </div>
                {jobs.length === 0 ? (
                  <div style={{ fontSize: 10, color: "var(--text-muted)", fontStyle: "italic" }}>No jobs</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {jobs.slice(0, 8).map((job) => {
                      const health = healthMap.get(job.id);
                      const failing = health && health.consecutiveErrors >= 2;
                      return (
                        <div key={job.id} style={{
                          padding: "4px 6px", borderRadius: 5, fontSize: 10,
                          border: `1px solid ${failing ? "rgba(239,68,68,0.3)" : "var(--border)"}`,
                          background: "var(--bg-elevated)", opacity: job.enabled ? 1 : 0.5,
                        }}>
                          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{job.name}</div>
                          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: MODEL_COLOR_MAP[modelColor(job.model)].color, flexShrink: 0 }} />
                            <span style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: 9 }}>{job.schedule.replace("cron: ", "")}</span>
                          </div>
                        </div>
                      );
                    })}
                    {jobs.length > 8 && <div style={{ fontSize: 10, color: "var(--text-muted)" }}>+{jobs.length - 8} more</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Day View ───────────────────────────────────────── */}
      {calView === "day" && (() => {
        const dayJobs = getJobsForDate(viewDate);
        return (
          <div>
            {dayJobs.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic", padding: "20px 0" }}>No jobs scheduled for this day.</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
                {dayJobs.map((job) => <JobCard key={job.id} job={job} health={healthMap.get(job.id)} />)}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}


// ── Page ─────────────────────────────────────────────────────────────────────
export default function TempPageWrapper() {
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <TempPage />
    </Suspense>
  );
}

function TempPage() {
  const [agents, setAgents] = useState<Array<{
    _id: string; key: string; name: string; role: string; emoji: string;
    status: string; computedStatus: string; lastHeartbeat: number | null;
    heartbeatAgeMs?: number | null; isStale?: boolean; isOffline?: boolean;
    model?: string; configuredModel?: string; bio?: string; sessionKey?: string;
    cronModel?: string; cronModelUpdatedAt?: number;
  }> | null>(null);
  const [driftEvents, setDriftEvents] = useState<Array<{
    _id: string; agentKey: string; actualModel: string; configuredModel: string;
    tag: string; timestamp: number;
  }>>([]);
  const [configModels, setConfigModels] = useState<ConfigModels>({});
  const [crons, setCrons] = useState<CronJob[] | null>(null);
  const [scheduleEntries, setScheduleEntries] = useState<CalendarCronEntry[] | null>(null);
  const [viewFilters, setViewFilter] = useUrlState({
    view: { type: "string" as const, default: "list" },
  });
  const view = viewFilters.view as ViewMode;
  const setView = useCallback((v: ViewMode) => setViewFilter("view", v), [setViewFilter]);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const stored = localStorage.getItem("schedule-dismissed-alerts");
      if (stored) setDismissedAlerts(new Set(JSON.parse(stored)));
    } catch { /* ignore */ }
  }, []);
  const handleDismissAlert = useCallback((id: string) => {
    setDismissedAlerts((prev) => {
      const next = new Set([...prev, id]);
      localStorage.setItem("schedule-dismissed-alerts", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const fetchAgentsAndDrift = useCallback(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setAgents(data.agents.map((a: Record<string, unknown>) => ({
          _id: a.key as string, key: a.key as string, name: a.name as string,
          role: a.role as string, emoji: a.emoji as string,
          status: (a.status as string) ?? "offline",
          computedStatus: (a.computed_status as string) ?? "offline",
          lastHeartbeat: (a.last_heartbeat as number | null) ?? null,
          heartbeatAgeMs: (a.heartbeat_age_ms as number | null) ?? null,
          isStale: (a.is_stale as boolean) ?? false,
          isOffline: (a.is_offline as boolean) ?? true,
          model: a.model as string | undefined,
          configuredModel: a.configured_model as string | undefined,
          bio: a.bio as string | undefined, sessionKey: a.session_key as string | undefined,
          cronModel: a.cron_model as string | undefined,
          cronModelUpdatedAt: a.cron_model_updated_at as number | undefined,
        })));
      })
      .catch(() => {});

    fetch("/api/drift")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setDriftEvents(data.events.map((e: Record<string, unknown>) => ({
          _id: String(e.id), agentKey: e.agent_key as string,
          actualModel: e.actual_model as string,
          configuredModel: e.configured_model as string,
          tag: e.tag as string, timestamp: e.timestamp as number,
        })));
      })
      .catch(() => {});
  }, []);

  const fetchConfigModels = useCallback(() => {
    fetch("/api/agent-models").then((r) => r.json()).then((d) => { if (d.ok) setConfigModels(d.models); }).catch(() => {});
  }, []);

  const fetchCrons = useCallback(() => {
    fetch("/api/crons").then((r) => r.json()).then((d) => { if (d.ok) setCrons(d.crons); }).catch(() => {});
  }, []);

  const fetchSchedule = useCallback(() => {
    fetch("/api/cron-schedule").then((r) => r.json()).then((data) => {
      if (Array.isArray(data)) setScheduleEntries(data);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchAgentsAndDrift();
    fetchConfigModels();
    fetchCrons();
    fetchSchedule();
    const i0 = setInterval(fetchAgentsAndDrift, 10_000);
    const i1 = setInterval(fetchConfigModels, 30_000);
    const i2 = setInterval(fetchCrons, 30_000);
    const i3 = setInterval(fetchSchedule, 60_000);
    return () => { clearInterval(i0); clearInterval(i1); clearInterval(i2); clearInterval(i3); };
  }, [fetchAgentsAndDrift, fetchConfigModels, fetchCrons, fetchSchedule]);

  async function handleCronToggle(cron: CronJob) {
    setTogglingId(cron.id);
    try {
      const res = await fetch("/api/cron-manage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", jobId: cron.id, enabled: !cron.enabled, jobName: cron.name }),
      });
      const data = await res.json();
      if (data.ok) {
        setCrons((prev) => prev?.map((c) => c.id === cron.id ? { ...c, enabled: !cron.enabled } : c) ?? null);
        setTimeout(fetchCrons, 1000);
      }
    } catch { /* ignore */ }
    finally { setTogglingId(null); }
  }

  async function handleCronEdit(cronId: string, patch: Record<string, unknown>) {
    try {
      const cron = (crons ?? []).find((c) => c.id === cronId);
      const res = await fetch("/api/cron-manage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", jobId: cronId, patch, jobName: cron?.name }),
      });
      const data = await res.json();
      if (data.ok) {
        fetchCrons();
        fetchSchedule();
      }
    } catch { /* ignore */ }
  }

  if (!agents) return <div className="loading">Loading…</div>;

  const sorted = [...agents]
    .filter((a) => CONFIG_AGENT_KEYS.includes(a.key))
    .sort((a, b) => CONFIG_AGENT_KEYS.indexOf(a.key) - CONFIG_AGENT_KEYS.indexOf(b.key));

  const agentRecords = sorted as unknown as Array<Record<string, unknown>>;

  return (
    <div style={{ padding: "0 0 40px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 4px" }}>Schedule</h2>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
            Models, heartbeats, drift, and cron health — all in one place.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {(["list", "grid", "calendar"] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: "5px 14px", borderRadius: 6,
                border: `1px solid ${view === v ? "var(--accent)" : "var(--border)"}`,
                background: view === v ? "rgba(74,222,128,0.1)" : "var(--bg-elevated)",
                color: view === v ? "var(--accent)" : "var(--text-muted)",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              {v === "list" ? "☰ List" : v === "grid" ? "▦ Grid" : "📅 Calendar"}
            </button>
          ))}
        </div>
      </div>

      {view === "list" && (
        <>
          <AgentsTable agents={agentRecords} configModels={configModels} driftEvents={driftEvents as Array<Record<string, unknown>> | undefined} />
          <HeartbeatsTable
            agents={agentRecords}
            heartbeatCrons={(crons ?? []).filter((c) => c.name.toLowerCase().includes("heartbeat"))}
            scheduleEntries={(scheduleEntries ?? []).filter((s) => s.name.toLowerCase().includes("heartbeat"))}
            onToggle={handleCronToggle}
            onEdit={handleCronEdit}
            togglingId={togglingId}
            dismissedIds={dismissedAlerts}
            onDismiss={handleDismissAlert}
          />
          {crons && <CronsTable crons={crons} scheduleEntries={(scheduleEntries ?? []).filter((s) => !s.name.toLowerCase().includes("heartbeat"))} onToggle={handleCronToggle} onEdit={handleCronEdit} togglingId={togglingId} dismissedIds={dismissedAlerts} onDismiss={handleDismissAlert} />}
        </>
      )}
      {view === "grid" && (
        <CombinedGrid
          agents={agentRecords}
          configModels={configModels}
          driftEvents={driftEvents as Array<Record<string, unknown>> | undefined}
          crons={crons ?? []}
        />
      )}
      {view === "calendar" && (
        <CalendarView
          scheduleEntries={scheduleEntries ?? []}
          healthCrons={crons ?? []}
        />
      )}
    </div>
  );
}
