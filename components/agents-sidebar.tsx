import type { Agent } from "@/lib/types";

function lastSeen(agent: Agent): string {
  const hb = agent.lastHeartbeat;
  if (!hb) return "never";
  const ms = Date.now() - hb;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function AgentsSidebar({ agents }: { agents: Agent[] }) {
  if (!agents || agents.length === 0) {
    return (
      <div className="agents-sidebar">
        <h2>Agents</h2>
        <p className="muted">No agents yet</p>
      </div>
    );
  }

  const sortedAgents = [...agents].sort((a, b) => {
    const statusOrder = { active: 0, idle: 1, blocked: 2, offline: 3 };
    const aStatus = a.computedStatus ?? a.status;
    const bStatus = b.computedStatus ?? b.status;
    const statusDiff = (statusOrder[aStatus as keyof typeof statusOrder] ?? 99) -
                       (statusOrder[bStatus as keyof typeof statusOrder] ?? 99);
    if (statusDiff !== 0) return statusDiff;
    // Within same status group, most recently active (newest heartbeat) first
    return (b.lastHeartbeat ?? 0) - (a.lastHeartbeat ?? 0);
  });

  return (
    <nav className="agents-sidebar" role="region" aria-label="Agent roster">
      <h2 id="agents-heading">Agents</h2>
      <div style={{ marginTop: "1rem" }} role="list" aria-labelledby="agents-heading">
        {sortedAgents.map((agent) => {
          const status = agent.computedStatus ?? agent.status;
          return (
          <div
            key={agent._id}
            className={`agent-card ${status}`}
            role="listitem"
            tabIndex={0}
            aria-label={`${agent.name}, ${agent.role}, ${status}`}
          >
            <div className="agent-header">
              <span className="agent-emoji" role="img" aria-label={agent.name}>
                {agent.emoji || "🤖"}
                <span className={`agent-dot ${status}`} />
              </span>
              <span className="agent-name">{agent.name}</span>
            </div>
            <div className="agent-role">{agent.role}</div>
            <div className="agent-status-row">
              <span className={`agent-status ${status}`} aria-label={`Status: ${status}`}>{status}</span>
              <span className="agent-last-seen">{lastSeen(agent)}</span>
            </div>
            {agent.bio && (
              <div
                className="muted"
                style={{
                  marginTop: "0.5rem",
                  fontSize: "0.75rem",
                  lineHeight: "1.4",
                }}
              >
                {agent.bio}
              </div>
            )}
          </div>
          );
        })}
      </div>
    </nav>
  );
}
