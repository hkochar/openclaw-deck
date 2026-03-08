/**
 * Central agent/channel configuration loader.
 *
 * Reads config/deck-agents.json once and caches in memory.
 * All channel IDs can be overridden via environment variables.
 */

import agentsJson from "@/config/deck-agents.json";
import configJson from "@/config/deck-config.json";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentEntry {
  id: string;
  key: string;
  name: string;
  role: string;
  emoji: string;
  discordChannelId: string;
  agentDir: string;
}

interface AgentConfig {
  agents: AgentEntry[];
  systemChannels: Record<string, string>;
  pluginChannels: Record<string, string>;
  logChannels: Record<string, string>;
  opsBotCommands: Record<string, boolean>;
}

interface DeckConfig {
  serviceUrls: Record<string, string>;
}

// ── Load & cache ─────────────────────────────────────────────────────────────

const config: AgentConfig = agentsJson;
const deckConfig: DeckConfig = configJson;

export function loadConfig(): AgentConfig {
  return config;
}

// ── Agent helpers ────────────────────────────────────────────────────────────

/** All agent entries */
export function agents(): AgentEntry[] {
  return config.agents;
}

/** All agent display keys (e.g. ["alpha", "beta", ...]) */
export function agentKeys(): string[] {
  return config.agents.map((a) => a.key);
}

/** Look up an agent by display key */
export function agentByKey(key: string): AgentEntry | undefined {
  return config.agents.find((a) => a.key === key);
}

/** Map of display key → AgentEntry */
export function agentMap(): Record<string, AgentEntry> {
  return Object.fromEntries(config.agents.map((a) => [a.key, a]));
}

// ── ID ↔ key mapping ────────────────────────────────────────────────────────

/** Gateway agent ID → display key (e.g. { main: "alpha", scout: "beta" }) */
export function agentKeyMap(): Record<string, string> {
  return Object.fromEntries(config.agents.map((a) => [a.id, a.key]));
}

/** Agent display key → gateway ID (e.g. "alpha" → "main", "beta" → "beta") */
export function agentIdFromKey(key: string): string {
  const agent = agentByKey(key);
  return agent?.id ?? key;
}

/** Gateway agent ID → display key (e.g. "main" → "alpha", "beta" → "beta") */
export function agentKeyFromId(agentId: string): string {
  return agentKeyMap()[agentId] ?? agentId;
}

// ── Discord channels ────────────────────────────────────────────────────────

function envOverride(envKey: string, fallback: string): string {
  return process.env[envKey] || fallback;
}

/** Per-agent Discord channel IDs, with env var overrides */
export function agentDiscordChannels(): Record<string, string> {
  return Object.fromEntries(
    config.agents.map((a) => [
      a.key,
      envOverride(`DISCORD_CHANNEL_${a.key.toUpperCase()}`, a.discordChannelId),
    ])
  );
}

/** System-level Discord channels (systemStatus, agentMonitoring) */
export function systemChannels(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.systemChannels).map(([name, id]) => [
      name,
      envOverride(
        `DISCORD_CHANNEL_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}`,
        id
      ),
    ])
  );
}

/** Plugin channels (model-drift) */
export function pluginChannels(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.pluginChannels).map(([name, id]) => [
      name,
      envOverride(
        `DISCORD_CHANNEL_${name.replace(/-/g, "_").toUpperCase()}`,
        id
      ),
    ])
  );
}

/** Log readability channels (deck-qa, memory, tasks — user-managed) */
export function logChannels(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.logChannels).map(([name, id]) => [
      name,
      envOverride(
        `DISCORD_CHANNEL_${name.replace(/-/g, "_").toUpperCase()}`,
        id
      ),
    ])
  );
}

/** Service URLs (gateway, deckDashboard) — from config/deck-config.json */
export function serviceUrls(): Record<string, string> {
  return { ...deckConfig.serviceUrls };
}

/** Ops-bot command permissions — from config/deck-agents.json */
export function opsBotCommands(): Record<string, boolean> {
  return { ...config.opsBotCommands };
}

/** All non-agent channels combined (for channel name resolution) */
export function allChannels(): Record<string, string> {
  return {
    ...systemChannels(),
    ...pluginChannels(),
    ...logChannels(),
  };
}

// ── Session keys ─────────────────────────────────────────────────────────────

/** Build the gateway session key for an agent's Discord channel */
export function agentSessionKey(agent: string): string {
  const channels = agentDiscordChannels();
  const channelId = channels[agent] || channels[config.agents[0]?.key];
  return `agent:${agentIdFromKey(agent)}:discord:channel:${channelId}`;
}

/** Map of display key → session key */
export function agentSessionKeys(): Record<string, string> {
  return Object.fromEntries(
    config.agents.map((a) => [a.key, agentSessionKey(a.key)])
  );
}

// ── Display helpers ──────────────────────────────────────────────────────────

/** display key → label (e.g. { jane: "Alpha", scout: "Beta" }) */
export function agentLabels(): Record<string, string> {
  return Object.fromEntries(config.agents.map((a) => [a.key, a.name]));
}

/** display key → { name, emoji } */
export function agentMetadata(): Record<string, { name: string; emoji: string }> {
  return Object.fromEntries(
    config.agents.map((a) => [a.key, { name: a.name, emoji: a.emoji }])
  );
}

/** Channel ID → display name (e.g. "1000000000000000001" → "#agent-name") */
export function channelNames(): Record<string, string> {
  const result: Record<string, string> = {};
  // Agent channels
  const ac = agentDiscordChannels();
  for (const [key, id] of Object.entries(ac)) {
    result[id] = `#${key}`;
  }
  // All non-agent channels
  const all = allChannels();
  for (const [name, id] of Object.entries(all)) {
    if (id) result[id] = `#${name.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
  }
  return result;
}

// ── Agent directories ────────────────────────────────────────────────────────

/** display key → absolute path to agent workspace dir */
export function agentDirs(workspaceDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const a of config.agents) {
    if (a.agentDir) {
      result[a.key] = `${workspaceDir}/${a.agentDir}`;
    }
  }
  return result;
}
