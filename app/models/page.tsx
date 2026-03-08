"use client";

import { useEffect, useState, useCallback } from "react";

import agentsJson from "@/config/deck-agents.json";

interface AgentRow {
  _id: string;
  key: string;
  name: string;
  role: string;
  emoji: string;
  status: string;
  computedStatus: string;
  lastHeartbeat: number;
  model?: string;
  configuredModel?: string;
  configuredFallbacks?: string[];
  bio?: string;
  sessionKey?: string;
  cronModel?: string;
  cronModelUpdatedAt?: number;
}

// Agent key → gateway ID map (e.g. "alpha" → "main")
const AGENT_ID_MAP: Record<string, string> = Object.fromEntries(
  agentsJson.agents.map((a) => [a.key, a.id])
);

// ── Known models ─────────────────────────────────────────────────────────────
const AVAILABLE_MODELS = [
  { label: "kimi — nvidia/moonshotai/kimi-k2.5 (free, ~60-90s)",      value: "nvidia/moonshotai/kimi-k2.5",                  fallbacks: ["anthropic/claude-sonnet-4-5"] },
  { label: "nemotron — nvidia/nemotron-ultra-253b (free)",             value: "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1", fallbacks: ["anthropic/claude-sonnet-4-5"] },
  { label: "sonnet — anthropic/claude-sonnet-4-5",                     value: "anthropic/claude-sonnet-4-5",                   fallbacks: ["anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5"] },
  { label: "opus — anthropic/claude-opus-4-6",                         value: "anthropic/claude-opus-4-6",                     fallbacks: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"] },
  { label: "haiku — anthropic/claude-haiku-4-5",                       value: "anthropic/claude-haiku-4-5",                    fallbacks: [] },
  { label: "codex — openai/codex-mini-latest",                         value: "openai/codex-mini-latest",                     fallbacks: ["anthropic/claude-sonnet-4-5"] },
  { label: "auto — openrouter/auto",                                   value: "openrouter/auto",                              fallbacks: ["anthropic/claude-sonnet-4-5"] },
  { label: "kimi-or — openrouter/moonshotai/kimi-k2.5 (costs $)",     value: "openrouter/moonshotai/kimi-k2.5",               fallbacks: ["anthropic/claude-sonnet-4-5"] },
];

// ── Configured model data (loaded from openclaw.json + session store via API) ─
type ConfigModels = Record<string, { primary: string; fallbacks: string[]; sessionModel: string; actualModel?: string }>;

// ── Cron data types ──────────────────────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────────────
import { ModelBadge, modelShortName } from "@/components/model-badge";

function modelRisk(model: string | null): "ok" | "warn" | "danger" {
  if (!model) return "danger";
  if (model === "default" || model.endsWith("/default")) return "warn";
  return "ok";
}

// ── Swap row component ───────────────────────────────────────────────────────
type SwapState = "idle" | "testing" | "applying" | "success" | "error";
type SwapType = "session" | "permanent";

function SwapControl({ agentKey, agentId }: { agentKey: string; agentId: string }) {
  const [open, setOpen] = useState(false);
  const [swapType, setSwapType] = useState<SwapType>("permanent");
  const [selected, setSelected] = useState(AVAILABLE_MODELS[0].value);
  const [state, setState] = useState<SwapState>("idle");
  const [msg, setMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const selectedModel = AVAILABLE_MODELS.find((m) => m.value === selected)!;
  const isNvidia = selected.includes("nvidia");

  async function handleSwap() {
    if (swapType === "session") {
      setState("applying");
      setMsg("Overriding session model…");
      try {
        const res = await fetch("/api/model-swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "session", agentId: AGENT_ID_MAP[agentKey] ?? agentKey, model: selected }),
        });
        const data = await res.json();
        if (!data.ok) {
          setState("error");
          setMsg(`Failed: ${data.error}`);
        } else {
          setState("success");
          setMsg(`✅ Session model set to ${modelShortName(selected)}. No restart needed. Reverts on next gateway restart.`);
          setTimeout(() => { setState("idle"); setOpen(false); }, 4000);
        }
      } catch (err) {
        setState("error");
        setMsg(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // Permanent swap
    setState("testing");
    setMsg(isNvidia ? "Smoke testing model… (Kimi can take 60-90s, hang tight)" : "Smoke testing model…");
    setElapsed(0);
    const tick = setInterval(() => setElapsed((e) => e + 1), 1000);

    try {
      const res = await fetch("/api/model-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "swap",
          agentId: AGENT_ID_MAP[agentKey] ?? agentKey,
          model: selected,
          fallbacks: selectedModel.fallbacks,
        }),
      });
      clearInterval(tick);
      const data = await res.json();

      if (!data.ok) {
        setState("error");
        const stage = data.stage === "smoke_test" ? "Smoke test failed" : "Config patch failed";
        setMsg(`${stage}: ${data.error}`);
      } else {
        setState("success");
        setMsg(`✅ Config updated in ${data.durationMs ? Math.round(data.durationMs / 1000) : "?"}s. Gateway restarting…`);
        setTimeout(() => { setState("idle"); setOpen(false); }, 4000);
      }
    } catch (err) {
      clearInterval(tick);
      setState("error");
      setMsg(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="swap-control">
      {!open && (
        <button className="swap-trigger" onClick={() => setOpen(true)}>
          Swap model
        </button>
      )}
      {open && (
        <div className="swap-panel">
          {/* Session vs Permanent toggle */}
          <div className="swap-type-row">
            <label className={`swap-type-opt${swapType === "session" ? " swap-type-opt--active" : ""}`}>
              <input type="radio" name={`swapType-${agentId}`} value="session"
                checked={swapType === "session"}
                onChange={() => { setSwapType("session"); setState("idle"); setMsg(""); }} />
              Session only
            </label>
            <label className={`swap-type-opt${swapType === "permanent" ? " swap-type-opt--active" : ""}`}>
              <input type="radio" name={`swapType-${agentId}`} value="permanent"
                checked={swapType === "permanent"}
                onChange={() => { setSwapType("permanent"); setState("idle"); setMsg(""); }} />
              Permanent
            </label>
          </div>
          <p className="swap-type-hint">
            {swapType === "session"
              ? "Changes running session only — no restart, reverts when gateway restarts."
              : "Updates config permanently — smoke tests model, then restarts gateway."}
          </p>

          <select
            className="swap-select"
            value={selected}
            onChange={(e) => { setSelected(e.target.value); setState("idle"); setMsg(""); }}
            disabled={state === "testing" || state === "applying"}
          >
            {AVAILABLE_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>

          <div className="swap-actions">
            <button
              className={`swap-btn swap-btn--${state === "success" ? "success" : state === "error" ? "error" : "primary"}`}
              onClick={handleSwap}
              disabled={state === "testing" || state === "applying"}
            >
              {state === "testing" ? `Testing… ${elapsed}s`
                : state === "applying" ? "Applying…"
                : state === "success" ? "Applied ✓"
                : swapType === "session" ? "Override session"
                : "Swap & restart"}
            </button>
            <button className="swap-cancel" onClick={() => { setOpen(false); setState("idle"); setMsg(""); }}>
              Cancel
            </button>
          </div>

          {msg && (
            <div className={`swap-msg swap-msg--${state}`}>
              {state === "testing" && isNvidia && (
                <div className="swap-progress">
                  <div className="swap-progress-bar" style={{ width: `${Math.min((elapsed / 90) * 100, 95)}%` }} />
                </div>
              )}
              {msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Cron Model Risks (stripped-down — full management in Calendar) ───────────
function CronModelRisks() {
  const [crons, setCrons] = useState<CronJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/crons")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setCrons(d.crons);
        else setError(d.error ?? "Failed to load crons");
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return null;
  if (!crons) return null;

  // Only show crons with model risk (unset or "default")
  const atRisk = crons.filter((c) => {
    if (c.deleteAfterRun && !c.enabled) return false;
    return modelRisk(c.model) !== "ok";
  });

  if (atRisk.length === 0) return null;

  return (
    <div className="crons-section">
      <div className="crons-header">
        <h3>Cron Model Warnings</h3>
        <p className="models-subtitle">
          {atRisk.length} cron{atRisk.length !== 1 ? "s" : ""} with missing or default model — risks expensive Sonnet fallback.
          {" "}<a href="/schedule" style={{ color: "var(--accent)" }}>Manage all crons in Schedule →</a>
        </p>
      </div>

      <div className="models-table-wrap">
        <table className="models-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Agent</th>
              <th>Model Issue</th>
            </tr>
          </thead>
          <tbody>
            {atRisk.map((cron) => {
              const risk = modelRisk(cron.model);
              return (
                <tr key={cron.id} className={`models-row cron-row${!cron.enabled ? " cron-row--disabled" : ""}`}>
                  <td className="cron-name">
                    {cron.name}
                    {!cron.enabled && <span className="cron-disabled-badge">disabled</span>}
                  </td>
                  <td className="cron-agent">{cron.agentId}</td>
                  <td className="cron-model-cell">
                    {risk === "danger" && (
                      <span className="cron-no-model">⚠️ unset — risks Sonnet default</span>
                    )}
                    {risk === "warn" && (
                      <span className="cron-warn-model">⚠️ {cron.model} — inherits default</span>
                    )}
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

// ── Cron Health Banner ───────────────────────────────────────────────────────
function CronHealthBanner() {
  const [failingCrons, setFailingCrons] = useState<CronJob[]>([]);

  useEffect(() => {
    function fetchCrons() {
      fetch("/api/crons")
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) {
            const failing = (d.crons as CronJob[]).filter(
              (c) => c.enabled && c.consecutiveErrors >= 2,
            );
            setFailingCrons(failing);
          }
        })
        .catch(() => {});
    }
    fetchCrons();
    const interval = setInterval(fetchCrons, 30_000);
    return () => clearInterval(interval);
  }, []);

  if (failingCrons.length === 0) return null;

  return (
    <div className="drift-banner">
      {failingCrons.map((cron) => {
        const severity = cron.consecutiveErrors >= 5 ? "drift-alert--unexpected" : "drift-alert--fallback";
        const icon = cron.consecutiveErrors >= 5 ? "🔴" : "🟡";
        return (
          <div key={cron.id} className={`drift-alert ${severity}`}>
            <span className="drift-alert-icon">{icon}</span>
            <span className="drift-alert-label">Cron Failing</span>
            <span className="drift-alert-detail">
              <strong>{cron.name}</strong> ({cron.agentId}) — {cron.consecutiveErrors} consecutive errors
              {cron.lastError && <span className="cron-error-hint"> — {cron.lastError.slice(0, 100)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Agent Heartbeats Table ────────────────────────────────────────────────────
function AgentHeartbeats({ agents }: { agents: Array<Record<string, unknown>> }) {
  const configAgentKeys = agentsJson.agents.map((a) => a.key);
  const sorted = [...agents]
    .filter((a) => configAgentKeys.includes(a.key as string))
    .sort((a, b) => configAgentKeys.indexOf(a.key as string) - configAgentKeys.indexOf(b.key as string));

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

  return (
    <div className="heartbeats-section">
      <h3>Agent Heartbeats</h3>
      <p className="models-subtitle">
        Live heartbeat status from the gateway. Stale after 20m, offline after 45m.
      </p>
      <div className="models-table-wrap">
        <table className="models-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Last Heartbeat</th>
              <th>Work Model</th>
              <th>Cron Model</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((agent) => {
              const ageMs = agent.heartbeatAgeMs as number;
              const cronModel = agent.cronModel as string | undefined;
              const cronUpdatedAt = agent.cronModelUpdatedAt as number | undefined;
              const cronAgeMs = cronUpdatedAt ? Date.now() - cronUpdatedAt : null;

              return (
                <tr key={agent._id as string} className="models-row">
                  <td className="models-agent">
                    <span className="models-agent-emoji">{agent.emoji as string}</span>
                    <span className="models-agent-name">{agent.name as string}</span>
                  </td>
                  <td>
                    <span className={`status-dot status-dot--${agent.computedStatus as string}`} />
                    <span className="models-status-text">{agent.computedStatus as string}</span>
                  </td>
                  <td style={{ color: heartbeatColor(agent) }}>
                    {formatAge(ageMs)}
                    <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 6 }}>
                      {new Date(agent.lastHeartbeat as number).toLocaleTimeString()}
                    </span>
                  </td>
                  <td>
                    {agent.model ? (
                      <ModelBadge model={agent.model as string} />
                    ) : (
                      <span className="models-none">—</span>
                    )}
                  </td>
                  <td>
                    {cronModel ? (
                      <>
                        <ModelBadge model={cronModel} />
                        {cronAgeMs !== null && (
                          <span style={{
                            fontSize: 11,
                            marginLeft: 4,
                            color: cronAgeMs > 45 * 60_000 ? "var(--accent-danger)" : "var(--text-muted)",
                          }}>
                            {formatAge(cronAgeMs)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="models-none">—</span>
                    )}
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

// ── Drift banner ─────────────────────────────────────────────────────────────
function DriftBanner() {
  const [driftEvents, setDriftEvents] = useState<Array<{ _id: string; agentKey: string; actualModel: string; configuredModel: string; tag: string; timestamp: number }>>([]);

  useEffect(() => {
    const fetchDrift = () => {
      fetch("/api/drift")
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) setDriftEvents(data.events.map((e: Record<string, unknown>) => ({
            _id: String(e.id),
            agentKey: e.agent_key,
            actualModel: e.actual_model,
            configuredModel: e.configured_model,
            tag: e.tag,
            timestamp: e.timestamp,
          })));
        })
        .catch(() => {});
    };
    fetchDrift();
    const interval = setInterval(fetchDrift, 10_000);
    return () => clearInterval(interval);
  }, []);

  if (driftEvents.length === 0) return null;

  const tagConfig: Record<string, { icon: string; cls: string; label: string }> = {
    unexpected: { icon: "🔴", cls: "drift-alert--unexpected", label: "Unexpected Drift" },
    cron:       { icon: "🟠", cls: "drift-alert--fallback",   label: "Cron Drift" },
    fallback:   { icon: "🟡", cls: "drift-alert--fallback",   label: "Fallback Active" },
    session:    { icon: "🔵", cls: "drift-alert--session",    label: "Session Override" },
  };

  function timeAgo(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  return (
    <div className="drift-banner">
      {driftEvents.map((event) => {
        const cfg = tagConfig[event.tag] ?? tagConfig.unexpected;
        return (
          <div key={event._id} className={`drift-alert ${cfg.cls}`}>
            <span className="drift-alert-icon">{cfg.icon}</span>
            <span className="drift-alert-label">{cfg.label}</span>
            <span className="drift-alert-detail">
              <strong>{event.agentKey}</strong> running{" "}
              <ModelBadge model={event.actualModel} /> instead of{" "}
              <ModelBadge model={event.configuredModel} />
            </span>
            <span className="drift-alert-time">{timeAgo(event.timestamp)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function ModelsPage() {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [driftEvents, setDriftEvents] = useState<Array<{ _id: string; agentKey: string; actualModel: string; configuredModel: string; tag: string; timestamp: number }>>([]);
  const [configModels, setConfigModels] = useState<ConfigModels>({});

  const fetchAll = useCallback(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setAgents(data.agents.map((a: Record<string, unknown>): AgentRow => ({
          _id: a.key as string, key: a.key as string, name: a.name as string,
          role: a.role as string, emoji: a.emoji as string,
          status: (a.status as string) ?? "offline",
          computedStatus: (a.computed_status as string) ?? "offline",
          lastHeartbeat: (a.last_heartbeat as number) ?? 0,
          model: a.model as string | undefined,
          configuredModel: a.configured_model as string | undefined,
          bio: a.bio as string | undefined,
          sessionKey: a.session_key as string | undefined,
          cronModel: a.cron_model as string | undefined,
          cronModelUpdatedAt: a.cron_model_updated_at as number | undefined,
        })));
      })
      .catch(() => {});

    fetch("/api/drift")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setDriftEvents(data.events.map((e: Record<string, unknown>) => ({
          _id: String(e.id), agentKey: e.agent_key, actualModel: e.actual_model,
          configuredModel: e.configured_model, tag: e.tag, timestamp: e.timestamp,
        })));
      })
      .catch(() => {});

    fetch("/api/agent-models")
      .then((r) => r.json())
      .then((d) => { if (d.ok) setConfigModels(d.models); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  if (!agents) return <div className="loading">Loading agents...</div>;

  const configAgentKeys = agentsJson.agents.map((a) => a.key);
  const sorted = [...agents]
    .filter((a) => configAgentKeys.includes(a.key))
    .sort((a, b) => configAgentKeys.indexOf(a.key) - configAgentKeys.indexOf(b.key));

  return (
    <div className="models-page">
      <div className="models-header">
        <h2>Agent Models</h2>
        <p className="models-subtitle">
          Session model shown only when it differs from primary.
          <strong> Session only</strong> = no restart, reverts on gateway restart.
          <strong> Permanent</strong> = smoke test + config update + gateway restart.
        </p>
      </div>

      <DriftBanner />
      <CronHealthBanner />

      <div className="models-table-wrap">
        <table className="models-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th className="models-col-running">Running</th>
              <th>Primary</th>
              <th className="models-col-fallbacks">Fallbacks</th>
              <th className="models-col-status">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((agent) => {
              const agentConfig = configModels[agent.key];
              const configuredPrimary = agentConfig?.primary ?? agent.configuredModel;
              const configuredFallbacks = agentConfig?.fallbacks ?? agent.configuredFallbacks ?? [];
              // Prefer actual running model (heartbeat truth), then drift events, then session store
              const driftModel = driftEvents?.find((d) => d.agentKey === agent.key)?.actualModel;
              const sessionOverride = agentConfig?.sessionModel !== configuredPrimary ? agentConfig?.sessionModel : undefined;
              const runningModel = agentConfig?.actualModel ?? driftModel ?? sessionOverride ?? configuredPrimary;
              // Don't flag mismatch for auto-routing models (openrouter/auto routes to real models)
              const isAutoRouter = configuredPrimary?.includes("/auto");
              const mismatch = !isAutoRouter && runningModel && configuredPrimary && runningModel !== configuredPrimary;

              return (
                <tr key={agent._id} className={mismatch ? "models-row models-row--mismatch" : "models-row"}>
                  <td className="models-agent">
                    <span className="models-agent-emoji">{agent.emoji}</span>
                    <span className="models-agent-name">{agent.name}</span>
                  </td>
                  <td className="models-session-cell models-col-running">
                    {mismatch ? (
                      <>
                        <ModelBadge model={runningModel} />
                        <span className="models-mismatch-badge" title={`Running ${runningModel} instead of ${configuredPrimary}`}>⚠️ override</span>
                      </>
                    ) : (
                      <span className="models-same">—</span>
                    )}
                    {agent.cronModel && (
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }} title={`Last cron model update: ${agent.cronModelUpdatedAt ? new Date(agent.cronModelUpdatedAt).toLocaleString() : "unknown"}`}>
                        Cron: <ModelBadge model={agent.cronModel} />
                        {(() => {
                          const updatedAt = agent.cronModelUpdatedAt;
                          if (!updatedAt) return null;
                          const ageMin = Math.floor((Date.now() - updatedAt) / 60_000);
                          const stale = ageMin > 45;
                          return <span style={{ marginLeft: 4, color: stale ? "var(--accent-danger)" : "var(--text-muted)" }}>({ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`})</span>;
                        })()}
                      </div>
                    )}
                  </td>
                  <td><ModelBadge model={configuredPrimary} /></td>
                  <td className="models-fallbacks models-col-fallbacks">
                    {configuredFallbacks.length > 0
                      ? configuredFallbacks.map((f, i) => <ModelBadge key={i} model={f} />)
                      : <span className="models-none">none</span>}
                  </td>
                  <td className="models-col-status">
                    <span className={`status-dot status-dot--${agent.computedStatus}`} />
                    <span className="models-status-text">{agent.computedStatus}</span>
                  </td>
                  <td className="models-swap-cell">
                    <SwapControl agentKey={agent.key} agentId={agent._id} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="models-legend">
        <p>⚠️ <strong>Mismatch</strong> = session is running a different model than configured. Usually a stale session after a config change. Use &quot;Session only&quot; swap to fix without restarting.</p>
      </div>

      <AgentHeartbeats agents={sorted as unknown as Array<Record<string, unknown>>} />

      <CronModelRisks />
    </div>
  );
}
