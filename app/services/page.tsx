"use client";

import { useEffect, useState, useCallback } from "react";
import { ReliabilitySection } from "@/components/reliability-section";

// ── Types ────────────────────────────────────────────────────────────────────

interface ServiceInfo {
  label: string;
  name: string;
  comment: string;
  running: boolean;
  status: "running" | "stopped" | "scheduled";
  pid: number | null;
  port: string | null;
  version: string | null;
  logPath: string | null;
  keepAlive: boolean;
  startInterval: number | null;
}

interface ActionState {
  label: string;
  action: string;
  running: boolean;
}

interface RestartAllStep {
  service: string;
  ok: boolean;
  output: string;
}

// ── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, type, onClose }: { message: string; type: "success" | "error"; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className={`svc-toast svc-toast--${type}`}>
      {message}
    </div>
  );
}

// ── Log Viewer ───────────────────────────────────────────────────────────────

function LogViewer({ service, onClose }: { service: string; onClose: () => void }) {
  const [lines, setLines] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [logPath, setLogPath] = useState("");

  const shortName = service.replace("ai.openclaw.", "");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/service-control?service=${shortName}&lines=80`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setLines(data.lines);
          setLogPath(data.logPath || "");
        } else {
          setLines(`Error: ${data.error}`);
        }
      })
      .catch((e) => setLines(`Failed to fetch logs: ${e}`))
      .finally(() => setLoading(false));
  }, [shortName]);

  return (
    <div className="svc-log-viewer">
      <div className="svc-log-header">
        <div>
          <span style={{ fontWeight: 700, fontSize: "14px" }}>Logs: {shortName}</span>
          {logPath && (
            <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "8px", fontFamily: "monospace" }}>
              {logPath}
            </span>
          )}
        </div>
        <button className="svc-btn svc-btn--sm" onClick={onClose}>Close</button>
      </div>
      {loading ? (
        <div style={{ padding: "16px", color: "var(--text-muted)" }}>Loading...</div>
      ) : (
        <pre className="svc-log-content">{lines || "No logs available"}</pre>
      )}
    </div>
  );
}

// ── Service Card ─────────────────────────────────────────────────────────────

function ServiceCard({
  svc,
  actionState,
  onAction,
  onViewLogs,
}: {
  svc: ServiceInfo;
  actionState: ActionState | null;
  onAction: (label: string, action: string) => void;
  onViewLogs: (label: string) => void;
}) {
  const busy = actionState?.label === svc.label && actionState.running;
  const busyAction = actionState?.label === svc.label ? actionState.action : null;

  const statusColor =
    svc.status === "running" ? "#22c55e" : svc.status === "scheduled" ? "#22c55e" : "#ef4444";

  return (
    <div className="svc-card">
      <div className="svc-card-header">
        <span
          className="svc-status-dot"
          style={{
            background: statusColor,
            boxShadow: `0 0 6px ${statusColor}60`,
          }}
        />
        <div className="svc-card-info">
          <div className="svc-card-name">{svc.name}</div>
          {svc.comment && <div className="svc-card-comment">{svc.comment}</div>}
        </div>
      </div>

      {/* Metadata badges */}
      <div className="svc-badges">
        <span className={`svc-badge svc-badge--${svc.status}`}>
          {svc.status === "scheduled" && svc.startInterval
            ? `runs every ${formatInterval(svc.startInterval)}`
            : svc.status}
        </span>
        {svc.pid && <span className="svc-badge svc-badge--mono">PID {svc.pid}</span>}
        {svc.port && <span className="svc-badge svc-badge--mono">:{svc.port}</span>}
        {svc.keepAlive && <span className="svc-badge svc-badge--mono">keep-alive</span>}
      </div>

      {/* Actions */}
      <div className="svc-actions">
        {svc.status !== "running" && (
          <button
            className="svc-btn svc-btn--start"
            onClick={() => onAction(svc.label, "start")}
            disabled={!!busy}
          >
            {busyAction === "start" ? "Starting..." : "Start"}
          </button>
        )}
        {svc.status === "running" && (
          <button
            className="svc-btn svc-btn--stop"
            onClick={() => onAction(svc.label, "stop")}
            disabled={!!busy}
          >
            {busyAction === "stop" ? "Stopping..." : "Stop"}
          </button>
        )}
        <button
          className="svc-btn svc-btn--restart"
          onClick={() => onAction(svc.label, "restart")}
          disabled={!!busy}
        >
          {busyAction === "restart" ? "Restarting..." : "Restart"}
        </button>
        <button
          className="svc-btn svc-btn--sm"
          onClick={() => onViewLogs(svc.label)}
        >
          Logs
        </button>
      </div>

      <div className="svc-card-label">{svc.label}</div>
    </div>
  );
}

// ── Model Tester ──────────────────────────────────────────────────────────────
type TestState = "idle" | "testing" | "success" | "error";

interface ConfigModel {
  id: string;
  name: string;
  provider: string;
}

function ModelTester() {
  const [configModels, setConfigModels] = useState<ConfigModel[]>([]);
  const [selected, setSelected] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [testSource, setTestSource] = useState<"list" | "custom">("list");
  const [state, setState] = useState<TestState>("idle");
  const [resultLines, setResultLines] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    fetch("/api/models-list")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.models?.length) {
          setConfigModels(d.models);
          setSelected(d.models[0].id);
        }
      })
      .catch(() => {});
  }, []);

  const modelToTest = testSource === "custom" ? customModel.trim() : selected;
  const isNvidia = modelToTest.includes("nvidia");

  async function handleTest(source: "list" | "custom") {
    const model = source === "custom" ? customModel.trim() : selected;
    if (!model) return;
    setTestSource(source);
    setState("testing");
    setResultLines([]);
    setElapsed(0);
    const tick = setInterval(() => setElapsed((e) => e + 1), 1000);

    try {
      const res = await fetch("/api/model-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", model }),
      });
      clearInterval(tick);
      const data = await res.json();

      if (data.ok) {
        setState("success");
        const lines: string[] = [];
        lines.push(`Model: ${model}`);
        lines.push(`Duration: ${data.durationMs ? (data.durationMs / 1000).toFixed(1) : "?"}s`);
        lines.push(`Response: ${data.response || "(no content returned)"}`);
        if (data.finishReason) lines.push(`Finish reason: ${data.finishReason}`);
        if (data.usage) lines.push(`Tokens: ${data.usage.promptTokens} in / ${data.usage.completionTokens} out (${data.usage.totalTokens} total)`);
        setResultLines(lines);
      } else {
        setState("error");
        const lines: string[] = [];
        lines.push(`Model: ${model}`);
        if (data.durationMs) lines.push(`Duration: ${(data.durationMs / 1000).toFixed(1)}s`);
        if (data.stage) lines.push(`Stage: ${data.stage}`);
        let errorText = data.error ?? "Test failed";
        try {
          const parsed = JSON.parse(errorText);
          if (parsed.message) errorText = parsed.message;
          if (parsed.type) errorText = `${parsed.type}: ${errorText}`;
          if (parsed.code) errorText += ` (code: ${parsed.code})`;
        } catch {
          // use as-is
        }
        lines.push(`Error: ${errorText}`);
        setResultLines(lines);
      }
    } catch (err) {
      clearInterval(tick);
      setState("error");
      setResultLines([`Model: ${model}`, `Error: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }

  const groupedOptions: { provider: string; models: ConfigModel[] }[] = [];
  for (const m of configModels) {
    const group = groupedOptions.find((g) => g.provider === m.provider);
    if (group) group.models.push(m);
    else groupedOptions.push({ provider: m.provider, models: [m] });
  }

  return (
    <div className="model-tester">
      <h3>Model Tester</h3>
      <p className="models-subtitle">
        Smoke test any model — sends &quot;What is 2+2?&quot; and checks for a response.
      </p>

      <div className="model-tester-row">
        <div className="model-tester-input">
          <select
            className="swap-select"
            value={selected}
            onChange={(e) => { setSelected(e.target.value); if (testSource === "list") { setState("idle"); setResultLines([]); } }}
            disabled={state === "testing" || configModels.length === 0}
          >
            {configModels.length === 0 && <option value="">Loading models...</option>}
            {groupedOptions.map((g) => (
              <optgroup key={g.provider} label={g.provider}>
                {g.models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} — {m.id}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <button
          className={`swap-btn swap-btn--${testSource === "list" && state === "success" ? "success" : testSource === "list" && state === "error" ? "error" : "primary"}`}
          onClick={() => handleTest("list")}
          disabled={state === "testing" || !selected}
        >
          {state === "testing" && testSource === "list" ? `Testing… ${elapsed}s` : "Test"}
        </button>
      </div>

      <div className="model-tester-row">
        <div className="model-tester-input">
          <input
            type="text"
            className="model-tester-custom"
            placeholder="provider/model-id"
            value={customModel}
            onChange={(e) => { setCustomModel(e.target.value); if (testSource === "custom") { setState("idle"); setResultLines([]); } }}
            disabled={state === "testing"}
          />
        </div>
        <button
          className={`swap-btn swap-btn--${testSource === "custom" && state === "success" ? "success" : testSource === "custom" && state === "error" ? "error" : "primary"}`}
          onClick={() => handleTest("custom")}
          disabled={state === "testing" || !customModel.trim()}
        >
          {state === "testing" && testSource === "custom" ? `Testing… ${elapsed}s` : "Test"}
        </button>
      </div>

      {(state === "testing" || resultLines.length > 0) && (
        <div className={`swap-msg swap-msg--${state}`}>
          {state === "testing" && isNvidia && (
            <div className="swap-progress">
              <div className="swap-progress-bar" style={{ width: `${Math.min((elapsed / 90) * 100, 95)}%` }} />
            </div>
          )}
          {state === "testing" && <span>Testing {modelToTest}… {elapsed}s</span>}
          {state !== "testing" && (
            <pre className="model-tester-result">{resultLines.join("\n")}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ServicesPage() {
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionState, setActionState] = useState<ActionState | null>(null);
  const [viewingLogs, setViewingLogs] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  // Operations state
  const [doctorOutput, setDoctorOutput] = useState<string | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [revertOutput, setRevertOutput] = useState<string | null>(null);
  const [revertRunning, setRevertRunning] = useState(false);
  const [restartAllRunning, setRestartAllRunning] = useState(false);
  const [restartAllSteps, setRestartAllSteps] = useState<RestartAllStep[]>([]);
  const [confirmRestartAll, setConfirmRestartAll] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [includeGateway, setIncludeGateway] = useState(false);
  const [applyRunning, setApplyRunning] = useState(false);
  const [applyStatus, setApplyStatus] = useState<{ ok: boolean; error?: string; rolledBack?: boolean; phase?: string } | null>(null);

  const showToast = useCallback((message: string, type: "success" | "error") => {
    setToast({ message, type });
  }, []);

  const loadServices = useCallback(() => {
    fetch("/api/services")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setServices(data.services);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadServices();
    const interval = setInterval(loadServices, 15_000);
    return () => clearInterval(interval);
  }, [loadServices]);

  // ── Service action handler ─────────────────────────────────────────────

  async function handleServiceAction(label: string, action: string) {
    setActionState({ label, action, running: true });
    try {
      const res = await fetch("/api/service-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: label, action }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`${SERVICE_NAMES[label] || label} ${action} succeeded`, "success");
        window.dispatchEvent(new Event("gateway-changed"));
      } else {
        showToast(`${action} failed: ${data.output || data.error}`, "error");
      }
      // Refresh after a moment for status to settle
      setTimeout(loadServices, 2000);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setActionState(null);
    }
  }

  // ── Doctor ─────────────────────────────────────────────────────────────

  async function handleDoctor() {
    setDoctorRunning(true);
    setDoctorOutput(null);
    try {
      const res = await fetch("/api/service-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "doctor" }),
      });
      const data = await res.json();
      setDoctorOutput(data.output || "No output");
    } catch (e) {
      setDoctorOutput(`Error: ${e instanceof Error ? e.message : e}`);
    } finally {
      setDoctorRunning(false);
    }
  }

  // ── Revert Config ──────────────────────────────────────────────────────

  async function handleRevertConfig() {
    setRevertRunning(true);
    setRevertOutput(null);
    setConfirmRevert(false);
    try {
      const res = await fetch("/api/service-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revert-config" }),
      });
      const data = await res.json();
      setRevertOutput(data.output || "No output");
      if (data.ok) {
        showToast("Config reverted", "success");
      }
    } catch (e) {
      setRevertOutput(`Error: ${e instanceof Error ? e.message : e}`);
    } finally {
      setRevertRunning(false);
    }
  }

  // ── Apply Config Safely ──────────────────────────────────────────────

  async function handleApplySafely() {
    setApplyRunning(true);
    setApplyStatus(null);
    try {
      const res = await fetch("/api/service-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply-config-safely", reason: "manual apply from Services page" }),
      });
      const data = await res.json();
      setApplyStatus(data);
      if (data.ok) {
        showToast("Config applied — gateway healthy", "success");
      } else {
        showToast(data.rolledBack ? "Rolled back to last good config" : `Apply failed: ${data.error}`, "error");
      }
      window.dispatchEvent(new Event("gateway-changed"));
      setTimeout(loadServices, 3000);
    } catch (e) {
      setApplyStatus({ ok: false, error: e instanceof Error ? e.message : String(e) });
      showToast("Apply failed", "error");
    } finally {
      setApplyRunning(false);
    }
  }

  // ── Restart All ────────────────────────────────────────────────────────

  async function handleRestartAll() {
    setRestartAllRunning(true);
    setRestartAllSteps([]);
    setConfirmRestartAll(false);
    try {
      const res = await fetch("/api/service-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart-all", includeGateway }),
      });
      const data = await res.json();
      setRestartAllSteps(data.steps || []);
      if (data.ok) {
        showToast("All services restarted", "success");
        window.dispatchEvent(new Event("gateway-changed"));
      } else {
        showToast("Some services failed to restart", "error");
      }
      setTimeout(loadServices, 3000);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setRestartAllRunning(false);
    }
  }

  return (
    <div style={{ padding: "0 0 40px" }}>
      <div style={{ marginBottom: "24px" }}>
        <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 4px" }}>Services</h2>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: 0 }}>
          Managed services. Start, stop, restart, and view logs.
        </p>
      </div>

      {/* Service Cards */}
      {loading && <div className="loading">Loading services...</div>}

      {!loading && services.length === 0 && (
        <div style={{ textAlign: "center", padding: "48px", color: "var(--text-muted)", fontStyle: "italic" }}>
          No managed services found. On macOS, services are discovered from LaunchAgent plists in ~/Library/LaunchAgents/. On Linux, manage services with systemd or your preferred process manager.
        </div>
      )}

      {!loading && services.length > 0 && (
        <div className="svc-grid">
          {services.map((svc) => (
            <ServiceCard
              key={svc.label}
              svc={svc}
              actionState={actionState}
              onAction={handleServiceAction}
              onViewLogs={setViewingLogs}
            />
          ))}
        </div>
      )}

      {/* Log Viewer */}
      {viewingLogs && (
        <LogViewer service={viewingLogs} onClose={() => setViewingLogs(null)} />
      )}

      {/* Reliability */}
      <div style={{ marginTop: "40px" }}>
        <ReliabilitySection />
      </div>

      {/* Model Tester */}
      <div style={{ marginTop: "40px" }}>
        <ModelTester />
      </div>

      {/* Operations */}
      <div style={{ marginTop: "40px" }}>
        <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 4px" }}>Operations</h2>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: "0 0 16px" }}>
          System-wide diagnostics and maintenance actions.
        </p>

        <div className="svc-ops-grid">
          {/* Doctor */}
          <div className="svc-ops-card">
            <div className="svc-ops-card-header">
              <div className="svc-ops-card-title">Run Doctor</div>
              <p className="svc-ops-card-desc">
                Run <code>openclaw doctor</code> to check system health and configuration.
              </p>
            </div>
            <button
              className="svc-btn svc-btn--start"
              onClick={handleDoctor}
              disabled={doctorRunning}
            >
              {doctorRunning ? "Running..." : "Run Doctor"}
            </button>
            {doctorOutput && (
              <pre className="svc-ops-output">{doctorOutput}</pre>
            )}
          </div>

          {/* Revert Config */}
          <div className="svc-ops-card">
            <div className="svc-ops-card-header">
              <div className="svc-ops-card-title">Revert Config</div>
              <p className="svc-ops-card-desc">
                Revert <code>openclaw.json</code> to the last git-committed version.
              </p>
            </div>
            {confirmRevert ? (
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: "12px", color: "#f59e0b" }}>Revert uncommitted changes?</span>
                <button
                  className="svc-btn svc-btn--danger"
                  onClick={handleRevertConfig}
                  disabled={revertRunning}
                >
                  {revertRunning ? "Reverting..." : "Confirm"}
                </button>
                <button
                  className="svc-btn svc-btn--sm"
                  onClick={() => setConfirmRevert(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="svc-btn svc-btn--stop"
                onClick={() => setConfirmRevert(true)}
                disabled={revertRunning}
              >
                Revert Config
              </button>
            )}
            {revertOutput && (
              <pre className="svc-ops-output">{revertOutput}</pre>
            )}
          </div>

          {/* Apply Config Safely */}
          <div className="svc-ops-card">
            <div className="svc-ops-card-header">
              <div className="svc-ops-card-title">Apply Config Safely</div>
              <p className="svc-ops-card-desc">
                Restart gateway with auto-rollback. If health check fails, reverts to last known good config.
              </p>
            </div>
            <button
              className="svc-btn svc-btn--start"
              onClick={handleApplySafely}
              disabled={applyRunning}
            >
              {applyRunning ? "Applying..." : "Apply Safely"}
            </button>
            {applyStatus && (
              <div style={{
                marginTop: "8px",
                padding: "8px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                background: applyStatus.ok ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)",
                border: `1px solid ${applyStatus.ok ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                color: applyStatus.ok ? "#10b981" : "#ef4444",
              }}>
                {applyStatus.ok
                  ? "Config applied — gateway healthy"
                  : `${applyStatus.rolledBack ? "Rolled back to last good config" : "Apply failed"}: ${applyStatus.error ?? "unknown error"}`
                }
              </div>
            )}
          </div>

          {/* Restart All */}
          <div className="svc-ops-card">
            <div className="svc-ops-card-header">
              <div className="svc-ops-card-title">Restart All Services</div>
              <p className="svc-ops-card-desc">
                Sequentially restart non-gateway services (Deck, sentinel, ops-bot).
              </p>
            </div>
            <label className="svc-checkbox">
              <input
                type="checkbox"
                checked={includeGateway}
                onChange={(e) => setIncludeGateway(e.target.checked)}
                disabled={restartAllRunning}
              />
              <span>Include gateway</span>
            </label>
            {confirmRestartAll ? (
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: "12px", color: "#f59e0b" }}>
                  Restart {includeGateway ? "all services + gateway" : "all services (no gateway)"}?
                </span>
                <button
                  className="svc-btn svc-btn--danger"
                  onClick={handleRestartAll}
                  disabled={restartAllRunning}
                >
                  {restartAllRunning ? "Restarting..." : "Confirm"}
                </button>
                <button
                  className="svc-btn svc-btn--sm"
                  onClick={() => setConfirmRestartAll(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="svc-btn svc-btn--stop"
                onClick={() => setConfirmRestartAll(true)}
                disabled={restartAllRunning}
              >
                Restart All
              </button>
            )}
            {restartAllSteps.length > 0 && (
              <div className="svc-restart-steps">
                {restartAllSteps.map((step, i) => (
                  <div key={i} className={`svc-restart-step svc-restart-step--${step.ok ? "pass" : "fail"}`}>
                    <span className="svc-restart-step-badge">{step.ok ? "OK" : "FAIL"}</span>
                    <span>{step.service}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatInterval(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}



// ── Constants ────────────────────────────────────────────────────────────────

const SERVICE_NAMES: Record<string, string> = {
  "ai.openclaw.gateway": "Gateway",
  "ai.openclaw.deck": "Deck",
  "ai.openclaw.ops-bot": "Ops Bot",
  "ai.openclaw.sentinel": "Sentinel",
};
