/**
 * Thin shim — re-exports from the central agent config.
 * Kept for backwards compatibility with tests and any remaining importers.
 */
import {
  systemChannels,
  agentDiscordChannels,
  agentSessionKey,
  channelNames,
} from "@/lib/agent-config";

export const DISCORD_CHANNELS = systemChannels();
export const AGENT_DISCORD_CHANNELS = agentDiscordChannels();
export const CHANNEL_NAMES = channelNames();
export { agentSessionKey };
