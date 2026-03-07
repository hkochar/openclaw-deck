"use client";

import { useState, useEffect } from "react";

interface AgentConfigData {
  agentKeys: string[];
  agentLabels: Record<string, string>;
  agentMetadata: Record<string, { name: string; emoji: string }>;
  channelNames: Record<string, string>;
}

let cached: AgentConfigData | null = null;
let fetching: Promise<AgentConfigData> | null = null;

function fetchConfig(): Promise<AgentConfigData> {
  if (cached) return Promise.resolve(cached);
  if (fetching) return fetching;
  fetching = fetch("/api/deck-config")
    .then((r) => r.json())
    .then((data) => {
      cached = data;
      fetching = null;
      return data;
    })
    .catch(() => {
      fetching = null;
      // Fallback: empty data
      return { agentKeys: [], agentLabels: {}, agentMetadata: {}, channelNames: {} };
    });
  return fetching;
}

export function useAgentConfig(): AgentConfigData & { loading: boolean } {
  const [data, setData] = useState<AgentConfigData | null>(cached);

  useEffect(() => {
    if (cached) {
      setData(cached);
      return;
    }
    fetchConfig().then(setData);
  }, []);

  if (!data) {
    return { loading: true, agentKeys: [], agentLabels: {}, agentMetadata: {}, channelNames: {} };
  }
  return { loading: false, ...data };
}
