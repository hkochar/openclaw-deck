"use client";

import type { Agent } from "@/lib/types";

interface AgentCostInfo {
  agent: string;
  daily: number;
  apiEquivDaily?: number;
  dailyPercent: number | null;
  budget: { daily?: number; action?: string } | null;
  paused: boolean;
  pauseReason: string | null;
  budgetAction: string;
  throttledTo: string | null;
  override: { expiresAt: number } | null;
  billing: string;
}

interface AgentStatusGridProps {
  agents: Agent[];
  costs: AgentCostInfo[];
}

export function AgentStatusGrid({ agents, costs }: AgentStatusGridProps) {
  const costMap = new Map(costs.map((c) => [c.agent, c]));

  const rows = agents
    .map((a) => ({ agent: a, cost: costMap.get(a.key) ?? null }))
    .sort((a, b) => {
      const order = statusOrder(a.agent, a.cost) - statusOrder(b.agent, b.cost);
      if (order !== 0) return order;
      return (a.agent.name ?? "").localeCompare(b.agent.name ?? "");
    });

  return (
    <section className="agent-grid" role="region" aria-label="Agent Status">
      <h3 className="section-heading">Agent Status</h3>
      <div className="agent-grid-table">
        {rows.map(({ agent, cost }) => (
          <AgentRow key={agent.key} agent={agent} cost={cost} />
        ))}
      </div>
    </section>
  );
}

function AgentRow({ agent, cost }: { agent: Agent; cost: AgentCostInfo | null }) {
  const status = resolveStatus(agent, cost);
  const hasBudget = cost?.budget?.daily != null;

  return (
    <div className="agent-grid-row">
      <div className="agent-grid-identity">
        <span className="agent-grid-emoji">{agent.emoji || "🤖"}</span>
        <span className="agent-grid-name">{agent.name}</span>
      </div>
      <div className="agent-grid-status">
        <span className={`agent-grid-badge agent-grid-badge--${status.key}`}>{status.label}</span>
      </div>
      <div className="agent-grid-budget">
        {hasBudget && cost ? (
          <>
            <div className="agent-grid-progress-bar">
              <div
                className={`agent-grid-progress-fill agent-grid-progress-fill--${progressColor(cost.dailyPercent ?? 0)}`}
                style={{ width: `${Math.min(cost.dailyPercent ?? 0, 100)}%` }}
              />
            </div>
            {cost.billing === "subscription" ? (
              <span className="agent-grid-cost">
                <span className="agent-grid-cost-line">API equiv: ${(cost.apiEquivDaily ?? 0).toFixed(2)} / ${cost.budget?.daily?.toFixed(2)}</span>
                <span className="agent-grid-cost-sub">Actual: $0.00 (subscription)</span>
              </span>
            ) : (
              <span className="agent-grid-cost">
                ${cost.daily.toFixed(2)}{cost.budget?.daily ? ` / $${cost.budget.daily.toFixed(2)}` : ""}
              </span>
            )}
          </>
        ) : (
          <span className="muted" style={{ fontSize: "0.75rem" }}>No budget</span>
        )}
      </div>
      <div className="agent-grid-actions">
        {cost?.paused ? (
          <a href={`/budget-action?action=pause&agent=${agent.key}`} className="agent-grid-btn agent-grid-btn--primary">
            Resume
          </a>
        ) : hasBudget ? (
          <a href={`/budget-action?action=pause&agent=${agent.key}`} className="agent-grid-btn agent-grid-btn--danger">
            Pause
          </a>
        ) : null}
        {hasBudget && (
          <a href={`/budget-action?action=override&agent=${agent.key}`} className="agent-grid-btn agent-grid-btn--secondary">
            Override
          </a>
        )}
      </div>
    </div>
  );
}

function resolveStatus(agent: Agent, cost: AgentCostInfo | null): { key: string; label: string } {
  if (cost?.paused) return { key: "paused", label: "PAUSED" };
  if (cost?.budgetAction === "block" && (cost.dailyPercent ?? 0) >= 100) return { key: "blocked", label: "BLOCKED" };
  if (cost?.budgetAction === "throttle" && cost.throttledTo) return { key: "throttled", label: "THROTTLED" };
  if (cost?.override && cost.override.expiresAt > Date.now()) return { key: "override", label: "OVERRIDE" };
  const computed = agent.computedStatus ?? agent.status;
  if (computed === "active") return { key: "running", label: "RUNNING" };
  if (computed === "idle") return { key: "idle", label: "IDLE" };
  return { key: "offline", label: "OFFLINE" };
}

function statusOrder(agent: Agent, cost: AgentCostInfo | null): number {
  const s = resolveStatus(agent, cost);
  const order: Record<string, number> = { paused: 0, blocked: 1, throttled: 2, override: 3, running: 4, idle: 5, offline: 6 };
  return order[s.key] ?? 7;
}

function progressColor(pct: number): string {
  if (pct >= 100) return "danger";
  if (pct >= 80) return "warning";
  return "ok";
}
