interface DriftEvent {
  id: number;
  agent_key: string;
  configured_model: string;
  actual_model: string;
  timestamp: number;
}

interface CronJob {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  consecutiveErrors: number;
  lastError: string | null;
}

interface AgentCostAlert {
  agent: string;
  dailyPercent: number | null;
  budgetAction: string;
  paused: boolean;
}

interface ContextSession {
  agent: string;
  session: string;
  contextPercent: number;
  promptTokens: number;
  maxContext: number;
  estimatedTurnsLeft: number | null;
  lastCallTs: number;
}

interface ActiveAlertsProps {
  drift: DriftEvent[];
  crons: CronJob[];
  costs: AgentCostAlert[];
  hotSessions?: ContextSession[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function shortSession(s: string): string {
  const m = s.match(/^[^:]+:[^:]+:(.+)$/);
  return m ? m[1] : s;
}

export function ActiveAlerts({ drift, crons, costs, hotSessions }: ActiveAlertsProps) {
  const alerts: { key: string; icon: string; message: string; href?: string; severity: "warning" | "error" }[] = [];

  // Drift alerts
  for (const d of drift) {
    alerts.push({
      key: `drift-${d.id}`,
      icon: "⚠",
      message: `Model Drift: ${d.agent_key} running ${d.actual_model}, configured ${d.configured_model}`,
      href: "/schedule",
      severity: "warning",
    });
  }

  // Cron failure alerts
  const failedCrons = crons.filter((c) => c.enabled && c.consecutiveErrors >= 2);
  for (const c of failedCrons) {
    alerts.push({
      key: `cron-${c.id}`,
      icon: "⚠",
      message: `Cron Failure: ${c.name} (${c.consecutiveErrors} consecutive)`,
      href: "/schedule",
      severity: "error",
    });
  }

  // Budget alerts
  const budgetAlerts = costs.filter((c) => (c.dailyPercent ?? 0) >= 80 || c.paused);
  for (const c of budgetAlerts) {
    if (c.paused) {
      alerts.push({
        key: `budget-paused-${c.agent}`,
        icon: "⛔",
        message: `Agent Paused: ${c.agent}`,
        href: `/costs?agent=${c.agent}`,
        severity: "error",
      });
    } else {
      alerts.push({
        key: `budget-${c.agent}`,
        icon: "⚠",
        message: `Budget Warning: ${c.agent} at ${Math.round(c.dailyPercent ?? 0)}% daily limit`,
        href: `/costs?agent=${c.agent}`,
        severity: "warning",
      });
    }
  }

  // Context pressure alerts (>80% = warning, >90% = error)
  if (hotSessions) {
    for (const s of hotSessions) {
      if (s.contextPercent < 80) continue;
      const turnsMsg = s.estimatedTurnsLeft != null ? ` · ~${s.estimatedTurnsLeft} turns left` : "";
      const severity = s.contextPercent >= 90 ? "error" as const : "warning" as const;
      alerts.push({
        key: `ctx-${s.session}`,
        icon: severity === "error" ? "🔴" : "🟡",
        message: `Context Pressure: ${s.agent} / ${shortSession(s.session)} at ${s.contextPercent.toFixed(1)}% (${formatTokens(s.promptTokens)} / ${formatTokens(s.maxContext)})${turnsMsg}`,
        href: `/sessions?session=${encodeURIComponent(s.session)}#replay`,
        severity,
      });
    }
  }

  return (
    <section className="active-alerts" role="region" aria-label="Active Alerts">
      <h3 className="section-heading">Active Alerts</h3>
      {alerts.length === 0 ? (
        <div className="active-alerts-empty">
          <span className="active-alerts-check">✓</span>
          <span>No active alerts</span>
        </div>
      ) : (
        <div className="active-alerts-list">
          {alerts.map((alert) => {
            const content = (
              <div key={alert.key} className={`active-alerts-item active-alerts-item--${alert.severity}`}>
                <span className="active-alerts-icon">{alert.icon}</span>
                <span className="active-alerts-message">{alert.message}</span>
              </div>
            );
            if (alert.href) {
              return (
                <a key={alert.key} href={alert.href} style={{ textDecoration: "none", color: "inherit" }}>
                  {content}
                </a>
              );
            }
            return content;
          })}
        </div>
      )}
    </section>
  );
}
