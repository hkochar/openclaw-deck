import type { Agent } from "@/lib/types";

interface OverviewCardsProps {
  agents: Agent[];
  totalDailyCost: number | null;
  totalApiEquivDaily: number | null;
  uptimeSeconds: number | null;
  alertCount: number;
}

export function OverviewCards({ agents, totalDailyCost, totalApiEquivDaily, uptimeSeconds, alertCount }: OverviewCardsProps) {
  const activeAgents = agents.filter((a) => (a.computedStatus ?? a.status) === "active").length;

  return (
    <section className="grid cards" role="region" aria-label="Key metrics">
      <article className="card" role="status" aria-label={`Agents Active: ${activeAgents} of ${agents.length}`}>
        <div className="muted">Agents Active</div>
        <div className="kpi">{activeAgents}/{agents.length}</div>
      </article>

      <article className="card" role="status" aria-label={`Today's Cost`}>
        <div className="muted">Today&apos;s Cost</div>
        <div className="kpi">{totalDailyCost !== null ? `$${totalDailyCost.toFixed(2)}` : "—"}</div>
        {totalApiEquivDaily !== null && totalApiEquivDaily > 0 && (
          <div className="kpi-sub">~${totalApiEquivDaily.toFixed(2)} API equiv</div>
        )}
      </article>

      <article className="card" role="status" aria-label={`Gateway Uptime: ${formatUptime(uptimeSeconds)}`}>
        <div className="muted">Gateway Uptime</div>
        <div className="kpi">{formatUptime(uptimeSeconds)}</div>
      </article>

      <article className="card" role="status" aria-label={`Active Alerts: ${alertCount}`}>
        <div className="muted">Active Alerts</div>
        <div className="kpi" style={alertCount > 0 ? { color: "var(--accent-danger)" } : undefined}>
          {alertCount}
        </div>
      </article>
    </section>
  );
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
