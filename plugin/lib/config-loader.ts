import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "fs";
import path from "path";

export const DECK_ROOT = process.env.DECK_ROOT || path.resolve(__dirname, "..", "..");

export interface DeckAgentEntry {
  id: string;
  key: string;
  name: string;
  role: string;
  emoji: string;
  discordChannelId: string;
  agentDir: string;
}

export interface DeckAgentConfig {
  agents: DeckAgentEntry[];
  systemChannels: Record<string, string>;
  pluginChannels: Record<string, string>;
  logChannels: Record<string, string>;
}

export function loadDeckAgentConfig(workspaceDir?: string): DeckAgentConfig | null {
  const candidates = [
    workspaceDir ? path.join(workspaceDir, "dashboard", path.basename(DECK_ROOT), "config/deck-agents.json") : null,
    path.join(DECK_ROOT, "config/deck-agents.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as DeckAgentConfig;
    } catch { /* try next */ }
  }
  return null;
}

export function loadDeckDashboardConfig(workspaceDir?: string): Record<string, unknown> | null {
  const candidates = [
    workspaceDir ? path.join(workspaceDir, "dashboard", path.basename(DECK_ROOT), "config/deck-config.json") : null,
    path.join(DECK_ROOT, "config/deck-config.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

export interface GatewayAgentEntry {
  id: string;
  model?: string;
  workspace?: string;
  [key: string]: unknown;
}

export interface GatewayConfigShape {
  agents?: { list?: GatewayAgentEntry[] };
  channels?: { discord?: { accounts?: Record<string, unknown> } };
  bindings?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

// Mutable agent key map — set during plugin init
let AGENT_KEY_MAP: Record<string, string> = {};

export function setAgentKeyMap(map: Record<string, string>): void {
  AGENT_KEY_MAP = map;
}

export function getAgentKeyMap(): Record<string, string> {
  return AGENT_KEY_MAP;
}

export function gatewayConfig(api: OpenClawPluginApi): GatewayConfigShape {
  return (api.config ?? {}) as GatewayConfigShape;
}

export function findGatewayAgent(api: OpenClawPluginApi, agentKey: string): GatewayAgentEntry | undefined {
  return gatewayConfig(api).agents?.list?.find(
    (a) => resolveAgentKey(a.id) === agentKey
  );
}

export function buildAgentKeyMap(api: OpenClawPluginApi, deckConfig: DeckAgentConfig | null): Record<string, string> {
  const map: Record<string, string> = {};

  if (deckConfig) {
    for (const a of deckConfig.agents) {
      map[a.id] = a.key;
      map[a.key] = a.key;
    }
  } else {
    const gw = gatewayConfig(api);
    const agentList = gw.agents?.list ?? [];
    const accounts = (gw.channels?.discord?.accounts ?? {}) as Record<string, unknown>;

    const bindings = (gw.bindings ?? []) as Array<Record<string, unknown>>;
    const agentToAccount: Record<string, string> = {};
    for (const b of bindings) {
      const aId = b.agentId as string | undefined;
      const match = b.match as Record<string, unknown> | undefined;
      const acctId = match?.accountId as string | undefined;
      if (aId && acctId && !agentToAccount[aId]) {
        agentToAccount[aId] = acctId;
      }
    }

    for (const agent of agentList) {
      const id = agent.id;
      const accountName = agentToAccount[id] ?? id;
      map[id] = accountName;
      map[accountName] = accountName;
    }
  }

  return map;
}

export function resolveAgentKey(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return AGENT_KEY_MAP[id] ?? (id in AGENT_KEY_MAP ? undefined : id);
}
