"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type Status = "idle" | "loading" | "executing" | "done" | "error";

interface PauseState {
  paused: boolean;
  since?: number;
  reason?: string;
}

interface Override {
  agent: string;
  expiresAt: number;
  reason: string;
  createdAt: number;
}

export default function BudgetActionPage() {
  const params = useSearchParams();
  const action = params.get("action"); // "pause" | "override"
  const agent = params.get("agent");

  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pauseState, setPauseState] = useState<PauseState | null>(null);
  const [override, setOverride] = useState<Override | null>(null);
  const [durationHours, setDurationHours] = useState(1);

  // Fetch current state on load
  useEffect(() => {
    if (!agent || !action) { setStatus("idle"); return; }

    (async () => {
      try {
        if (action === "pause" || action === "unpause") {
          const res = await fetch("/api/agent-pause");
          if (!res.ok) throw new Error("Failed to fetch pause state");
          const data = await res.json();
          setPauseState(data[agent] ?? { paused: false });
        } else if (action === "override") {
          const res = await fetch("/api/budget-override");
          if (!res.ok) throw new Error("Failed to fetch override state");
          const data = await res.json();
          setOverride(data[agent] ?? null);
        }
        setStatus("idle");
      } catch (err) {
        setError(String(err));
        setStatus("error");
      }
    })();
  }, [agent, action]);

  if (!agent || !action) {
    return <div style={styles.card}><p style={styles.muted}>Missing action or agent parameter.</p></div>;
  }

  if (action !== "pause" && action !== "unpause" && action !== "override") {
    return <div style={styles.card}><p style={styles.muted}>Unknown action: {action}</p></div>;
  }

  async function executePause() {
    if (!agent) return;
    const willPause = !pauseState?.paused;
    setStatus("executing");
    try {
      const res = await fetch("/api/agent-pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, paused: willPause, reason: willPause ? "paused via budget alert" : "resumed via budget alert" }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setPauseState({ paused: willPause, since: Date.now(), reason: willPause ? "paused via budget alert" : undefined });
      setStatus("done");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  async function executeOverride() {
    if (!agent) return;
    setStatus("executing");
    try {
      const res = await fetch("/api/budget-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, durationHours, reason: "override via budget alert" }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const data = await res.json();
      setOverride(data.override ?? { agent, expiresAt: Date.now() + durationHours * 3600_000, reason: "override via budget alert", createdAt: Date.now() });
      setStatus("done");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  if (status === "loading") {
    return <div style={styles.card}><p style={styles.muted}>Loading...</p></div>;
  }

  // ── Pause / unpause action ──
  if (action === "pause" || action === "unpause") {
    const isPaused = pauseState?.paused ?? false;
    return (
      <div style={styles.card}>
        <h2 style={styles.heading}>{isPaused ? "Resume" : "Pause"} Agent</h2>
        <div style={styles.field}>
          <span style={styles.label}>Agent</span>
          <span style={styles.value}>{agent}</span>
        </div>
        <div style={styles.field}>
          <span style={styles.label}>Current status</span>
          <span style={{ ...styles.value, color: isPaused ? "var(--accent-danger)" : "var(--accent)" }}>
            {isPaused ? "Paused" : "Running"}
          </span>
        </div>
        {isPaused && pauseState?.reason && (
          <div style={styles.field}>
            <span style={styles.label}>Reason</span>
            <span style={styles.value}>{pauseState.reason}</span>
          </div>
        )}
        {isPaused && pauseState?.since && (
          <div style={styles.field}>
            <span style={styles.label}>Paused since</span>
            <span style={styles.value}>{new Date(pauseState.since).toLocaleString()}</span>
          </div>
        )}

        {status === "done" ? (
          <div style={styles.result}>
            <p style={{ color: "var(--accent)" }}>{isPaused ? "Agent paused." : "Agent resumed."}</p>
            <a href={`/costs?agent=${agent}`} style={styles.link}>View Costs</a>
          </div>
        ) : status === "error" ? (
          <div style={styles.result}>
            <p style={{ color: "var(--accent-danger)" }}>{error}</p>
          </div>
        ) : (
          <div style={styles.actions}>
            <p style={styles.muted}>
              {isPaused
                ? "This will resume all LLM calls for this agent."
                : "This will block all LLM calls for this agent until manually resumed or auto-recovery triggers."}
            </p>
            <button
              onClick={executePause}
              disabled={status === "executing"}
              style={isPaused ? styles.btnPrimary : styles.btnDanger}
            >
              {status === "executing" ? "Processing..." : isPaused ? "Resume Agent" : "Pause Agent"}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Override action ──
  return (
    <div style={styles.card}>
      <h2 style={styles.heading}>Budget Override</h2>
      <div style={styles.field}>
        <span style={styles.label}>Agent</span>
        <span style={styles.value}>{agent}</span>
      </div>
      {override && override.expiresAt > Date.now() && (
        <div style={styles.field}>
          <span style={styles.label}>Active override</span>
          <span style={{ ...styles.value, color: "var(--accent-warning)" }}>
            Expires {new Date(override.expiresAt).toLocaleString()}
          </span>
        </div>
      )}

      {status === "done" ? (
        <div style={styles.result}>
          <p style={{ color: "var(--accent)" }}>
            Budget override applied for {durationHours}h. Expires {new Date(Date.now() + durationHours * 3600_000).toLocaleString()}.
          </p>
          <a href={`/costs?agent=${agent}`} style={styles.link}>View Costs</a>
        </div>
      ) : status === "error" ? (
        <div style={styles.result}>
          <p style={{ color: "var(--accent-danger)" }}>{error}</p>
        </div>
      ) : (
        <div style={styles.actions}>
          <p style={styles.muted}>
            Temporarily lift all budget limits for this agent. The agent will also be unpaused if currently paused.
          </p>
          <div style={styles.durationRow}>
            {[1, 4, 8].map((h) => (
              <button
                key={h}
                onClick={() => setDurationHours(h)}
                style={durationHours === h ? styles.durationActive : styles.durationBtn}
              >
                {h}h
              </button>
            ))}
          </div>
          <button
            onClick={executeOverride}
            disabled={status === "executing"}
            style={styles.btnPrimary}
          >
            {status === "executing" ? "Processing..." : `Apply Override (${durationHours}h)`}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Inline styles (matches Deck dashboard dark theme) ──
const styles: Record<string, React.CSSProperties> = {
  card: {
    maxWidth: 480,
    margin: "3rem auto",
    background: "var(--bg-surface)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "2rem",
  },
  heading: {
    fontSize: "1.25rem",
    fontWeight: 600,
    marginBottom: "1.5rem",
  },
  field: {
    display: "flex",
    justifyContent: "space-between",
    padding: "0.5rem 0",
    borderBottom: "1px solid var(--border)",
  },
  label: {
    color: "var(--text-muted)",
    fontSize: "0.875rem",
  },
  value: {
    fontWeight: 500,
    fontSize: "0.875rem",
  },
  muted: {
    color: "var(--text-muted)",
    fontSize: "0.875rem",
    marginBottom: "1rem",
  },
  actions: {
    marginTop: "1.5rem",
  },
  result: {
    marginTop: "1.5rem",
    textAlign: "center" as const,
  },
  link: {
    color: "var(--accent)",
    textDecoration: "none",
    fontSize: "0.875rem",
    marginTop: "0.5rem",
    display: "inline-block",
  },
  btnPrimary: {
    width: "100%",
    padding: "0.75rem",
    background: "var(--accent)",
    color: "#000",
    border: "none",
    borderRadius: 6,
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  btnDanger: {
    width: "100%",
    padding: "0.75rem",
    background: "var(--accent-danger)",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  durationRow: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "1rem",
  },
  durationBtn: {
    flex: 1,
    padding: "0.5rem",
    background: "var(--bg-elevated)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: "0.875rem",
    cursor: "pointer",
  },
  durationActive: {
    flex: 1,
    padding: "0.5rem",
    background: "var(--accent)",
    color: "#000",
    border: "1px solid var(--accent)",
    borderRadius: 6,
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: "pointer",
  },
};
