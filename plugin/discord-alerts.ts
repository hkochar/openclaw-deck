/**
 * Discord alert integration for Deck gateway plugin.
 * Extracted from index.ts — sends drift, budget, silence, and loop alerts to Discord.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDeckSiteUrl, type ReplayAlertEvent } from "./budget.js";

/** Redact known secret patterns before sending to Discord. */
function redactSecrets(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/sk_[a-zA-Z0-9]{20,}/g, "[REDACTED]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, "Bearer [REDACTED]")
    .replace(/xoxb-[a-zA-Z0-9-]+/g, "[REDACTED]")
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, "[REDACTED]");
}

/** Build a /costs URL filtered by agent + today */
function costsUrl(base: string, agent?: string): string {
  const params = new URLSearchParams({ range: "today" });
  if (agent) params.set("agent", agent);
  return `${base}/costs?${params}`;
}

/** Build a /logs URL filtered by agent + last 10 minutes */
function logsUrl(base: string, agent?: string): string {
  const since = Date.now() - 10 * 60 * 1000;
  const params = new URLSearchParams({ since: String(since) });
  if (agent) params.set("agent", agent);
  return `${base}/logs?${params}`;
}

export class DiscordAlerts {
  private readonly channelId: string;
  readonly botToken: string;
  private logger: { warn: (msg: string) => void };

  constructor(api: OpenClawPluginApi, driftChannelId?: string) {
    this.channelId = driftChannelId || "";
    // Token is per-account in config (channels.discord.accounts.<agent>.token)
    // Use any bot's token — they're all in the same guild
    const cfg = api.config as Record<string, unknown> | undefined;
    const channels = cfg?.channels as Record<string, unknown> | undefined;
    const discord = channels?.discord as Record<string, unknown> | undefined;
    const accounts = discord?.accounts as Record<string, Record<string, string>> | undefined;

    // Prefer Deck Bridge bot token for system alerts (not agent identity)
    const deckToken = process.env.DISCORD_BOT_TOKEN_DECK ?? "";
    let token = deckToken;
    if (!token) {
      // Fall back to agent token if Deck bot not configured
      token = (discord?.token as string) ?? "";
      if (!token && accounts) {
        for (const acc of Object.values(accounts)) {
          if (acc?.token) { token = acc.token; break; }
        }
      }
      if (!token) {
        token = process.env.DISCORD_BOT_TOKEN
          ?? process.env.DISCORD_BOT_TOKEN_DECK
          ?? "";
      }
    }
    this.botToken = token.replace(/^Bot\s+/i, ""); // normalize
    this.logger = api.logger;

    if (!this.botToken) {
      api.logger.warn("openclaw-deck-sync: No Discord bot token found for drift alerts");
    }
  }

  sendDriftAlert(agentKey: string, configured: string, actual: string, tag: string): void {
    if (!this.botToken) return;

    const titles: Record<string, string> = {
      unexpected: "Unexpected Model Drift",
      cron:       "Cron Model Drift",
      fallback:   "Fallback Activated",
      session:    "Session Override Active",
    };

    // Infer likely cause when configured model is free/cheap and actual is paid
    const isFreeModel = /\bfree\b|\/auto\b/i.test(configured);
    const isPaidActual = /anthropic|openai|claude|gpt/i.test(actual);
    const likelyCause = isFreeModel && isPaidActual
      ? "Likely: free model rate-limited or unavailable, fell back to agent primary"
      : undefined;

    const lines = [
      `**${titles[tag] ?? "Model Drift"}**`,
      "```",
      `Agent:       ${agentKey}`,
      `Configured:  ${configured}`,
      `Running:     ${actual}`,
    ];
    if (likelyCause) lines.push(`Cause:       ${likelyCause}`);
    lines.push("```");

    const deckSiteUrl = getDeckSiteUrl();
    this.postMessage({
      content: lines.join("\n"),
      components: [{
        type: 1,
        components: [
          { type: 2, style: 5, label: "View Agents", url: `${deckSiteUrl}/schedule` },
          { type: 2, style: 5, label: "View Logs", url: logsUrl(deckSiteUrl, agentKey) },
          { type: 2, style: 5, label: "Configure", url: `${deckSiteUrl}/deck-config#edit.agents` },
        ],
      }],
    });
  }

  sendDriftResolved(agentKey: string, primary: string): void {
    if (!this.botToken) return;
    this.postMessage({
      content: `**Drift Resolved** — ${agentKey} is back on configured primary: ${primary}`,
    });
  }

  sendCronFailureAlert(agentKey: string, cronName: string, error: string, consecutiveErrors: number): void {
    if (!this.botToken) return;
    const deckSiteUrl = getDeckSiteUrl();
    this.postMessage({
      content: [
        "**Cron Job Failure**",
        "```",
        `Agent:     ${agentKey}`,
        `Job:       ${cronName}`,
        `Failures:  ${consecutiveErrors} consecutive`,
        `Error:     ${(redactSecrets(error.slice(0, 200)) || "(no error message)")}`,
        "```",
      ].join("\n"),
      components: [{
        type: 1,
        components: [
          { type: 2, style: 5, label: "View Crons", url: `${deckSiteUrl}/schedule?view=calendar` },
          { type: 2, style: 5, label: "View Logs", url: logsUrl(deckSiteUrl, agentKey) },
          { type: 2, style: 5, label: "Configure", url: `${deckSiteUrl}/deck-config#edit.agents` },
        ],
      }],
    });
  }

  // Session cost cap alerts now go through the general sendReplayAlert path

  private silenceAlertCooldown = new Map<string, number>();

  sendAgentSilenceAlert(agentKey: string, silenceMinutes: number, channelId?: string): void {
    if (!this.botToken) return;
    // Cooldown: don't re-alert same agent within 10 minutes
    const now = Date.now();
    const last = this.silenceAlertCooldown.get(agentKey) ?? 0;
    if (now - last < 10 * 60_000) return;
    this.silenceAlertCooldown.set(agentKey, now);

    const deckSiteUrl = getDeckSiteUrl();
    this.postToChannel(channelId ?? this.channelId, {
      content: [
        "**Agent Silent**",
        "```",
        `Agent:     ${agentKey}`,
        `Silent:    ${silenceMinutes}m (no LLM activity detected)`,
        `Since:     ${new Date(now - silenceMinutes * 60_000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
        "```",
      ].join("\n"),
      components: [{
        type: 1,
        components: [
          { type: 2, style: 5, label: "View Agents", url: `${deckSiteUrl}/schedule` },
          { type: 2, style: 5, label: "View Logs", url: logsUrl(deckSiteUrl, agentKey) },
          { type: 2, style: 5, label: "View Sessions", url: `${deckSiteUrl}/sessions?agent=${agentKey}` },
        ],
      }],
    });
  }

  sendLoopAlert(agentKey: string, tool: string, count: number, channelId?: string, signature?: string): void {
    if (!this.botToken) return;
    const deckSiteUrl = getDeckSiteUrl();
    // Extract a readable snippet from the signature (tool:params)
    const paramSnippet = signature ? signature.replace(/^[^:]*:/, "").slice(0, 120) : undefined;
    this.postToChannel(channelId ?? this.channelId, {
      content: [
        "**Stuck Agent Loop Detected**",
        "```",
        `Agent:     ${agentKey}`,
        `Tool:      ${tool}`,
        `Repeats:   ${count}x in last 20 calls`,
        ...(paramSnippet ? [`Params:    ${paramSnippet}${paramSnippet.length >= 120 ? "…" : ""}`] : []),
        "```",
      ].join("\n"),
      components: [{
        type: 1,
        components: [
          { type: 2, style: 5, label: "View Logs", url: logsUrl(deckSiteUrl, agentKey) },
          { type: 2, style: 5, label: "View Sessions", url: `${deckSiteUrl}/sessions?agent=${agentKey}` },
          { type: 2, style: 5, label: "View Agents", url: `${deckSiteUrl}/schedule` },
        ],
      }],
    });
  }

  sendCronRecoveryAlert(agentKey: string, cronName: string): void {
    if (!this.botToken) return;
    this.postMessage({
      content: `**Cron Job Recovered** — ${agentKey} job **${cronName}** is healthy again.`,
    });
  }

  sendReplayAlert(event: ReplayAlertEvent, channelId: string): void {
    if (!this.botToken || !channelId) return;

    const titles: Record<string, string> = {
      "session-cost": "Session Cost Spike",
      "step-cost": "Expensive LLM Step",
      "long-session": "Long-Running Session",
      "excessive-tools": "Excessive Tool Calls",
      "context-critical": "Context Window Critical",
    };
    const colors: Record<string, string> = {
      "session-cost": "🔴",
      "step-cost": "🟡",
      "long-session": "🟡",
      "excessive-tools": "🟡",
      "context-critical": "🔴",
    };
    const units: Record<string, string> = {
      "session-cost": "$",
      "step-cost": "$",
      "long-session": "min",
      "excessive-tools": "calls",
      "context-critical": "%",
    };

    const title = titles[event.type] ?? event.type;
    const icon = colors[event.type] ?? "🟡";
    const unit = units[event.type] ?? "";
    const valStr = unit === "$" ? `$${event.value.toFixed(2)}` : `${event.value}${unit}`;
    const threshStr = unit === "$" ? `$${event.threshold.toFixed(2)}` : `${event.threshold}${unit}`;

    const deckSiteUrl = getDeckSiteUrl();
    const sessionSlug = event.session.slice(0, 80);
    // Show cost view label for cost-related alerts (e.g. "Actual", "API Equiv")
    const costViewLabel = event.detail?.costView as string | undefined;

    // Map alert type → exact config field for deep linking (all in budgets tab)
    const fieldMap: Record<string, string> = {
      "session-cost": "sessionCostCap",
      "step-cost": "sessionCostCap",
      "long-session": "maxSessionDuration",
      "excessive-tools": "maxToolCalls",
      "context-critical": "contextThreshold",
    };
    const field = fieldMap[event.type] ?? "";
    const configHash = field ? `#edit.budgets.${field}` : "#edit.budgets";

    // Show enforcement action if not just alert
    const actionLabel = event.action && event.action !== "alert"
      ? ` [${event.action.toUpperCase()}]` : "";
    const enforcementLine = event.detail?.enforcement
      ? [`Action:    ${String(event.detail.enforcement)}`] : [];

    this.postToChannel(channelId, {
      content: [
        `${icon} **${title}**${actionLabel}`,
        "```",
        `Agent:     ${event.agent}`,
        `Value:     ${valStr} (threshold: ${threshStr})`,
        ...(costViewLabel ? [`Cost View: ${costViewLabel}`] : []),
        ...enforcementLine,
        `Session:   ${sessionSlug}`,
        "```",
      ].join("\n"),
      components: [{
        type: 1,
        components: [
          { type: 2, style: 5, label: "View Session", url: `${deckSiteUrl}/sessions?session=${encodeURIComponent(event.session)}` },
          { type: 2, style: 5, label: "View Costs", url: costsUrl(deckSiteUrl, event.agent) },
          { type: 2, style: 5, label: "View Logs", url: logsUrl(deckSiteUrl, event.agent) },
          { type: 2, style: 5, label: "Configure", url: `${deckSiteUrl}/deck-config${configHash}` },
        ],
      }],
    });
  }

  postToChannel(channelId: string, body: Record<string, unknown>): void {
    if (!channelId) return;
    fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${this.botToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      this.logger.warn(`openclaw-deck-sync: Discord alert to ${channelId} failed: ${String(err)}`);
    });
  }

  postMessage(body: Record<string, unknown>): void {
    if (!this.channelId) return;
    fetch(`https://discord.com/api/v10/channels/${this.channelId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${this.botToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      this.logger.warn(`openclaw-deck-sync: Discord drift alert failed: ${String(err)}`);
    });
  }
}
