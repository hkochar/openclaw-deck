"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

const STORAGE_KEY = "deck-setup-dismissed";

interface SetupItem {
  id: string;
  label: string;
  description: string;
  link: string;
  linkLabel: string;
  required: boolean;
  check: (data: CheckData) => boolean;
}

interface CheckData {
  gatewayOk: boolean;
  pluginActive: boolean;
  agentCount: number;
  budgetsConfigured: boolean;
  discordConfigured: boolean;
  hasEvents: boolean;
}

const ITEMS: SetupItem[] = [
  {
    id: "gateway",
    label: "Connect gateway",
    description: "Deck needs to reach your OpenClaw gateway to show live data.",
    link: "/deck-config#edit.infra",
    linkLabel: "Configure gateway URL",
    required: true,
    check: (d) => d.gatewayOk,
  },
  {
    id: "agents",
    label: "Configure agents",
    description: "Give your agents names, roles, and emoji so they show up in the dashboard.",
    link: "/deck-config#edit.agents",
    linkLabel: "Add agents",
    required: true,
    check: (d) => d.agentCount > 0,
  },
  {
    id: "plugin",
    label: "Install gateway plugin",
    description: "The plugin captures LLM calls, costs, and events in real time.",
    link: "/services",
    linkLabel: "Check services",
    required: true,
    check: (d) => d.pluginActive,
  },
  {
    id: "budgets",
    label: "Set up budget limits",
    description: "Daily caps per agent prevent runaway costs. Start with Alert Only.",
    link: "/deck-config#edit.budgets",
    linkLabel: "Configure budgets",
    required: false,
    check: (d) => d.budgetsConfigured,
  },
  {
    id: "alerts",
    label: "Connect alert notifications",
    description: "Get budget alerts, drift detection, and pause/resume controls via Discord or Slack.",
    link: "/deck-config#edit.alerts",
    linkLabel: "Set up alerts",
    required: false,
    check: (d) => d.discordConfigured,
  },
];

export function SetupChecklist() {
  const [dismissed, setDismissed] = useState(true);
  const [data, setData] = useState<CheckData | null>(null);

  const fetchStatus = useCallback(() => {
    Promise.all([
      fetch("/api/gateway-health").then((r) => r.json()).catch(() => ({ ok: false })),
      fetch("/api/agents").then((r) => r.json()).catch(() => ({ ok: false, agents: [] })),
      fetch("/api/deck-config").then((r) => r.json()).catch(() => ({})),
      fetch("/api/logs/stream?limit=1").then((r) => r.json()).catch(() => ({ events: [] })),
    ]).then(([health, agents, config, logs]) => {
      const budgets = config.budgets ?? {};
      const hasAgentBudgets = Object.keys(budgets.agents ?? {}).length > 0;
      const hasGlobalBudget = (budgets.global?.daily ?? 0) > 0 || (budgets.global?.weekly ?? 0) > 0;
      const channels = config.systemChannels ?? {};
      const alertRouting = config.alertRouting ?? {};
      const hasLegacyChannels = Object.values(channels).some((v) => v && String(v).length > 10);
      const hasAlertRouting = (alertRouting.channels?.length ?? 0) > 0;
      const hasDiscord = hasLegacyChannels || hasAlertRouting;

      setData({
        gatewayOk: health.ok && health.uptime !== undefined,
        pluginActive: health.poller?.running === true || (health.uptime ?? 0) > 0,
        agentCount: agents.agents?.length ?? 0,
        budgetsConfigured: hasAgentBudgets || hasGlobalBudget,
        discordConfigured: hasDiscord,
        hasEvents: (logs.events?.length ?? 0) > 0,
      });
    });
  }, []);

  useEffect(() => {
    const wasDismissed = localStorage.getItem(STORAGE_KEY) === "1";
    setDismissed(wasDismissed);
    fetchStatus();
  }, [fetchStatus]);

  // Re-check when user returns to the page
  useEffect(() => {
    const handler = () => fetchStatus();
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [fetchStatus]);

  if (dismissed || !data) return null;

  const completed = ITEMS.filter((item) => item.check(data));
  const remaining = ITEMS.filter((item) => !item.check(data));
  const allDone = remaining.length === 0;

  // Auto-dismiss if everything is configured
  if (allDone) {
    localStorage.setItem(STORAGE_KEY, "1");
    return null;
  }

  const requiredRemaining = remaining.filter((i) => i.required);

  function handleDismiss() {
    localStorage.setItem(STORAGE_KEY, "1");
    setDismissed(true);
  }

  return (
    <div className="setup-checklist">
      <div className="setup-checklist-header">
        <div>
          <h3 className="setup-checklist-title">
            Setup — {completed.length}/{ITEMS.length} configured
          </h3>
          <p className="setup-checklist-subtitle">
            {requiredRemaining.length > 0
              ? `${requiredRemaining.length} required step${requiredRemaining.length > 1 ? "s" : ""} remaining`
              : "Core setup done — optional items below"}
          </p>
        </div>
        <button className="setup-checklist-dismiss" onClick={handleDismiss} title="Dismiss">&times;</button>
      </div>

      <div className="setup-checklist-items">
        {/* Show completed items as checked */}
        {completed.map((item) => (
          <div key={item.id} className="setup-item setup-item--done">
            <span className="setup-item-check">&#10003;</span>
            <span className="setup-item-label">{item.label}</span>
          </div>
        ))}

        {/* Show remaining items with action links */}
        {remaining.map((item) => (
          <div key={item.id} className="setup-item setup-item--pending">
            <span className="setup-item-circle" />
            <div className="setup-item-content">
              <span className="setup-item-label">
                {item.label}
                {!item.required && <span className="setup-item-optional">optional</span>}
              </span>
              <p className="setup-item-desc">{item.description}</p>
              <Link href={item.link} className="setup-item-link">{item.linkLabel} &rarr;</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
