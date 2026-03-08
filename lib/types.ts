export type AgentStatus = "active" | "idle" | "blocked" | "offline";

export type Agent = {
  _id: string;
  key: string;
  name: string;
  role: string;
  emoji?: string;
  status: AgentStatus;
  computedStatus?: AgentStatus;
  lastHeartbeat: number | null;
  heartbeatAgeMs?: number;
  isStale?: boolean;
  isOffline?: boolean;
  model?: string;
  configuredModel?: string;
  configuredFallbacks?: string[];
  bio?: string;
  sessionKey?: string;
};

export type Activity = {
  _id: string;
  type: string;
  message: string;
  timestamp: number;
  agentId?: string;
  agent?: {
    name: string;
    emoji: string;
  } | null;
};
