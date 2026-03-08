"use client";

import { useEffect, useState, useCallback } from "react";
import { OverviewCards } from "@/components/overview-cards";
import { AgentStatusGrid } from "@/components/agent-status-grid";
import { SystemHealth } from "@/components/system-health";
import type { SystemStatsData, ChannelStatusData } from "@/components/system-health";
import { ActiveAlerts } from "@/components/active-alerts";
import { ActivityFeed } from "@/components/activity-feed";
import { SetupChecklist } from "@/components/setup-checklist";
import type { Agent, Activity } from "@/lib/types";

interface HealthData {
  ok: boolean;
  uptime: number;
  droppedEvents: number;
  activeLoops: number;
  loops: { agent: string; tool: string; count: number }[];
  poller?: { running: boolean; lastPollMs: number; filesTracked: number };
}

interface ServiceData {
  label: string;
  name: string;
  running: boolean;
  status: string;
}

interface CronData {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  consecutiveErrors: number;
  lastError: string | null;
}

interface DriftEvent {
  id: number;
  agent_key: string;
  configured_model: string;
  actual_model: string;
  timestamp: number;
}

interface AgentCostData {
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

interface ContextSession {
  agent: string;
  session: string;
  model: string;
  contextPercent: number;
  promptTokens: number;
  maxContext: number;
  estimatedTurnsLeft: number | null;
  lastCallTs: number;
}

export default function HomePage() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [costs, setCosts] = useState<AgentCostData[] | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [services, setServices] = useState<ServiceData[] | null>(null);
  const [crons, setCrons] = useState<CronData[] | null>(null);
  const [drift, setDrift] = useState<DriftEvent[] | null>(null);
  const [systemStats, setSystemStats] = useState<SystemStatsData | null>(null);
  const [channels, setChannels] = useState<ChannelStatusData[] | null>(null);
  const [hotSessions, setHotSessions] = useState<ContextSession[]>([]);

  const fetchData = useCallback(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setAgents(
            data.agents.map((a: Record<string, unknown>) => ({
              _id: a.key,
              key: a.key,
              name: a.name,
              role: a.role,
              emoji: a.emoji,
              status: a.status ?? "offline",
              computedStatus: a.computed_status ?? "offline",
              lastHeartbeat: a.last_heartbeat ?? null,
              model: a.model,
              configuredModel: a.configured_model,
              bio: a.bio,
              sessionKey: a.session_key,
            })),
          );
        }
      })
      .catch(() => {});

    fetch("/api/activities?limit=20")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setActivities(
            data.events.map((e: Record<string, unknown>) => ({
              _id: String(e.id),
              type: e.type,
              message: e.message,
              timestamp: e.timestamp,
              agentId: e.agent_key,
              agent: e.agent_name ? { name: e.agent_name as string, emoji: (e.agent_emoji as string) || "" } : null,
            })),
          );
        }
      })
      .catch(() => {});

    fetch("/api/agent-costs")
      .then((r) => r.json())
      .then((data) => {
        if (data.agents) {
          setCosts(data.agents);
        }
      })
      .catch(() => {});

    fetch("/api/services")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setServices(data.services);
      })
      .catch(() => {});

    fetch("/api/drift")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setDrift(data.events);
      })
      .catch(() => {});

    fetch("/api/crons")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setCrons(data.crons);
      })
      .catch(() => {});

    fetch("/api/gateway-health")
      .then((r) => r.json())
      .then((data) => {
        if (data.uptime !== undefined) setHealth(data);
      })
      .catch(() => {});

    fetch("/api/system-stats")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setSystemStats(data);
      })
      .catch(() => {});

    fetch("/api/session-context")
      .then((r) => r.json())
      .then((data) => {
        if (data.sessions) {
          setHotSessions(data.sessions.filter((s: ContextSession) => s.contextPercent >= 50));
        }
      })
      .catch(() => {});
  }, []);

  const fetchChannels = useCallback(() => {
    fetch("/api/channel-status")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setChannels(data.channels);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Channel status is slower (~3s CLI call) — poll less frequently, don't block initial render
  useEffect(() => {
    const timer = setTimeout(fetchChannels, 500); // slight delay so fast data renders first
    const interval = setInterval(fetchChannels, 30_000);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [fetchChannels]);

  const loading = !agents;
  const totalDailyCost = costs ? costs.reduce((sum, c) => sum + (c.daily ?? 0), 0) : null;
  const totalApiEquivDaily = costs ? costs.reduce((sum, c) => sum + (c.apiEquivDaily ?? 0), 0) : null;
  const alertCount = countAlerts(drift, crons, costs, hotSessions);

  return (
    <div className="container">
      <h1>Deck</h1>
      <p className="muted">Real-time agent coordination dashboard</p>

      {loading ? (
        <p className="muted" style={{ marginTop: "1rem" }} role="status">Loading live dashboard data...</p>
      ) : (
        <>
          <SetupChecklist />

          <OverviewCards
            agents={agents}
            totalDailyCost={totalDailyCost}
            totalApiEquivDaily={totalApiEquivDaily}
            uptimeSeconds={health?.uptime ?? null}
            alertCount={alertCount}
          />

          <div className="overview-columns">
            <AgentStatusGrid agents={agents} costs={costs ?? []} />
            <SystemHealth
              services={services ?? []}
              health={health}
              crons={crons ?? []}
              stats={systemStats}
              channels={channels}
            />
          </div>

          <ActiveAlerts
            drift={drift ?? []}
            crons={crons ?? []}
            costs={costs ?? []}
            hotSessions={hotSessions}
          />

          <h2 style={{ marginTop: "2rem" }}>Activity Feed</h2>
          <ActivityFeed activities={activities ?? []} />
        </>
      )}
    </div>
  );
}

function countAlerts(
  drift: DriftEvent[] | null,
  crons: CronData[] | null,
  costs: AgentCostData[] | null,
  hotSessions?: ContextSession[],
): number {
  let count = 0;
  if (drift) count += drift.length;
  if (crons) count += crons.filter((c) => c.enabled && c.consecutiveErrors >= 2).length;
  if (costs) count += costs.filter((c) => (c.dailyPercent ?? 0) >= 80 || c.paused).length;
  if (hotSessions) count += hotSessions.filter(s => s.contextPercent >= 80).length;
  return count;
}
