/**
 * System alert integration for Deck gateway plugin.
 * Routes alerts to Discord, Slack, or Telegram via alert-dispatch.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDeckSiteUrl, type ReplayAlertEvent } from "./budget.js";
import { sendAlert, type AlertMessage, type AlertTokens, parseChannelRef } from "./alert-dispatch.js";

/** Redact known secret patterns before sending to any platform. */
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

/**
 * Resolve all available alert tokens from gateway config + env.
 * Called once at plugin init, cached on the instance.
 */
function resolveAlertTokens(api: OpenClawPluginApi): AlertTokens {
  const cfg = api.config as Record<string, unknown> | undefined;
  const channels = cfg?.channels as Record<string, unknown> | undefined;

  // Discord token resolution (existing logic)
  const discord = channels?.discord as Record<string, unknown> | undefined;
  const discordAccounts = discord?.accounts as Record<string, Record<string, string>> | undefined;
  let discordToken = process.env.DISCORD_BOT_TOKEN_DECK ?? "";
  if (!discordToken) {
    discordToken = (discord?.token as string) ?? "";
    if (!discordToken && discordAccounts) {
      for (const acc of Object.values(discordAccounts)) {
        if (acc?.token) { discordToken = acc.token; break; }
      }
    }
    if (!discordToken) {
      discordToken = process.env.DISCORD_BOT_TOKEN ?? "";
    }
  }
  discordToken = discordToken.replace(/^Bot\s+/i, "");

  // Slack token resolution
  const slack = channels?.slack as Record<string, unknown> | undefined;
  const slackAccounts = slack?.accounts as Record<string, Record<string, string>> | undefined;
  let slackToken = process.env.SLACK_BOT_TOKEN ?? "";
  if (!slackToken) {
    slackToken = (slack?.botToken as string) ?? "";
    if (!slackToken && slackAccounts) {
      for (const acc of Object.values(slackAccounts)) {
        if (acc?.botToken) { slackToken = acc.botToken; break; }
      }
    }
  }

  // Telegram token resolution
  const telegram = channels?.telegram as Record<string, unknown> | undefined;
  const telegramAccounts = telegram?.accounts as Record<string, Record<string, string>> | undefined;
  let telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!telegramToken) {
    telegramToken = (telegram?.botToken as string) ?? "";
    if (!telegramToken && telegramAccounts) {
      for (const acc of Object.values(telegramAccounts)) {
        if (acc?.botToken) { telegramToken = acc.botToken; break; }
      }
    }
  }

  return {
    discord: discordToken || undefined,
    slack: slackToken || undefined,
    telegram: telegramToken || undefined,
  };
}

export class DiscordAlerts {
  private readonly channelId: string;
  readonly botToken: string;
  readonly tokens: AlertTokens;
  private logger: { warn: (msg: string) => void };

  constructor(api: OpenClawPluginApi, driftChannelId?: string) {
    this.channelId = driftChannelId || "";
    this.tokens = resolveAlertTokens(api);
    this.botToken = this.tokens.discord ?? "";
    this.logger = api.logger;

    if (!this.botToken) {
      api.logger.warn("openclaw-deck-sync: No Discord bot token found for drift alerts");
    }
  }

  /** Send an alert to a channel ref (supports discord:/slack:/telegram: prefixes). */
  private send(channelRef: string, msg: AlertMessage): void {
    sendAlert(channelRef, msg, this.tokens, this.logger).catch(() => {});
  }

  sendDriftAlert(agentKey: string, configured: string, actual: string, tag: string, channelId?: string): void {
    const titles: Record<string, string> = {
      unexpected: "Unexpected Model Drift",
      cron:       "Cron Model Drift",
      fallback:   "Fallback Activated",
      session:    "Session Override Active",
    };

    const isFreeModel = /\bfree\b|\/auto\b/i.test(configured);
    const isPaidActual = /anthropic|openai|claude|gpt/i.test(actual);
    const likelyCause = isFreeModel && isPaidActual
      ? "Likely: free model rate-limited or unavailable, fell back to agent primary"
      : undefined;

    const deckSiteUrl = getDeckSiteUrl();
    this.send(channelId ?? this.channelId, {
      title: titles[tag] ?? "Model Drift",
      lines: [
        `Agent:       ${agentKey}`,
        `Configured:  ${configured}`,
        `Running:     ${actual}`,
        ...(likelyCause ? [`Cause:       ${likelyCause}`] : []),
      ],
      buttons: [
        { label: "View Agents", url: `${deckSiteUrl}/schedule` },
        { label: "View Logs", url: logsUrl(deckSiteUrl, agentKey) },
        { label: "Configure", url: `${deckSiteUrl}/deck-config#edit.agents` },
      ],
    });
  }

  sendDriftResolved(agentKey: string, primary: string, channelId?: string): void {
    this.send(channelId ?? this.channelId, {
      title: `Drift Resolved`,
      lines: [`${agentKey} is back on configured primary: ${primary}`],
    });
  }

  sendCronFailureAlert(agentKey: string, cronName: string, error: string, consecutiveErrors: number, channelId?: string): void {
    const deckSiteUrl = getDeckSiteUrl();
    this.send(channelId ?? this.channelId, {
      title: "Cron Job Failure",
      lines: [
        `Agent:     ${agentKey}`,
        `Job:       ${cronName}`,
        `Failures:  ${consecutiveErrors} consecutive`,
        `Error:     ${(redactSecrets(error.slice(0, 200)) || "(no error message)")}`,
      ],
      buttons: [
        { label: "View Crons", url: `${deckSiteUrl}/schedule?view=calendar` },
        { label: "View Logs", url: logsUrl(deckSiteUrl, agentKey) },
        { label: "Configure", url: `${deckSiteUrl}/deck-config#edit.agents` },
      ],
    });
  }

  private silenceAlertCooldown = new Map<string, number>();

  sendAgentSilenceAlert(agentKey: string, silenceMinutes: number, channelId?: string): void {
    const now = Date.now();
    const last = this.silenceAlertCooldown.get(agentKey) ?? 0;
    if (now - last < 10 * 60_000) return;
    this.silenceAlertCooldown.set(agentKey, now);

    const deckSiteUrl = getDeckSiteUrl();
    this.send(channelId ?? this.channelId, {
      title: "Agent Silent",
      lines: [
        `Agent:     ${agentKey}`,
        `Silent:    ${silenceMinutes}m (no LLM activity detected)`,
        `Since:     ${new Date(now - silenceMinutes * 60_000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
      ],
      buttons: [
        { label: "View Agents", url: `${deckSiteUrl}/schedule` },
        { label: "View Logs", url: logsUrl(deckSiteUrl, agentKey) },
        { label: "View Sessions", url: `${deckSiteUrl}/sessions?agent=${agentKey}` },
      ],
    });
  }

  sendLoopAlert(agentKey: string, tool: string, count: number, channelId?: string, signature?: string): void {
    const deckSiteUrl = getDeckSiteUrl();
    const paramSnippet = signature ? signature.replace(/^[^:]*:/, "").slice(0, 120) : undefined;
    this.send(channelId ?? this.channelId, {
      title: "Stuck Agent Loop Detected",
      lines: [
        `Agent:     ${agentKey}`,
        `Tool:      ${tool}`,
        `Repeats:   ${count}x in last 20 calls`,
        ...(paramSnippet ? [`Params:    ${paramSnippet}${paramSnippet.length >= 120 ? "…" : ""}`] : []),
      ],
      buttons: [
        { label: "View Logs", url: logsUrl(deckSiteUrl, agentKey) },
        { label: "View Sessions", url: `${deckSiteUrl}/sessions?agent=${agentKey}` },
        { label: "View Agents", url: `${deckSiteUrl}/schedule` },
      ],
    });
  }

  sendCronRecoveryAlert(agentKey: string, cronName: string, channelId?: string): void {
    this.send(channelId ?? this.channelId, {
      title: "Cron Job Recovered",
      lines: [`${agentKey} job ${cronName} is healthy again.`],
    });
  }

  sendReplayAlert(event: ReplayAlertEvent, channelId: string): void {
    if (!channelId) return;

    const titles: Record<string, string> = {
      "session-cost": "Session Cost Spike",
      "step-cost": "Expensive LLM Step",
      "long-session": "Long-Running Session",
      "excessive-tools": "Excessive Tool Calls",
      "context-critical": "Context Window Critical",
    };
    const icons: Record<string, string> = {
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
    const icon = icons[event.type] ?? "🟡";
    const unit = units[event.type] ?? "";
    const valStr = unit === "$" ? `$${event.value.toFixed(2)}` : `${event.value}${unit}`;
    const threshStr = unit === "$" ? `$${event.threshold.toFixed(2)}` : `${event.threshold}${unit}`;

    const deckSiteUrl = getDeckSiteUrl();
    const sessionSlug = event.session.slice(0, 80);
    const costViewLabel = event.detail?.costView as string | undefined;

    const fieldMap: Record<string, string> = {
      "session-cost": "sessionCostCap",
      "step-cost": "sessionCostCap",
      "long-session": "maxSessionDuration",
      "excessive-tools": "maxToolCalls",
      "context-critical": "contextThreshold",
    };
    const field = fieldMap[event.type] ?? "";
    const configHash = field ? `#edit.budgets.${field}` : "#edit.budgets";

    const actionLabel = event.action && event.action !== "alert"
      ? ` [${event.action.toUpperCase()}]` : "";
    const enforcementLine = event.detail?.enforcement
      ? [`Action:    ${String(event.detail.enforcement)}`] : [];
    const triggeredLine = event.triggeredPct != null
      ? [`Triggered: at ${event.triggeredPct}% of limit`] : [];

    this.send(channelId, {
      title: `${title}${actionLabel}`,
      icon,
      lines: [
        `Agent:     ${event.agent}`,
        `Value:     ${valStr} (threshold: ${threshStr})`,
        ...triggeredLine,
        ...(costViewLabel ? [`Cost View: ${costViewLabel}`] : []),
        ...enforcementLine,
        `Session:   ${sessionSlug}`,
      ],
      buttons: [
        { label: "View Session", url: `${deckSiteUrl}/sessions?session=${encodeURIComponent(event.session)}` },
        { label: "View Costs", url: costsUrl(deckSiteUrl, event.agent) },
        { label: "View Logs", url: logsUrl(deckSiteUrl, event.agent) },
        { label: "Configure", url: `${deckSiteUrl}/deck-config${configHash}` },
      ],
    });
  }

  /** Send a raw AlertMessage to a channel ref. Used by external callers (budget, rate-limits). */
  sendRawAlert(channelRef: string, msg: AlertMessage): void {
    this.send(channelRef, msg);
  }

  /**
   * @deprecated Use sendRawAlert or the specific send* methods instead.
   * Kept for backward compatibility with direct Discord API callers during migration.
   */
  postToChannel(channelId: string, body: Record<string, unknown>): void {
    if (!channelId) return;
    // Check if this is a prefixed ref — if so, we can't use raw Discord format
    const { platform } = parseChannelRef(channelId);
    if (platform !== "discord") {
      this.logger.warn(`openclaw-deck-sync: postToChannel called with non-discord ref "${channelId}", use sendRawAlert instead`);
      return;
    }
    if (!this.botToken) return;
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

  /**
   * @deprecated Use sendRawAlert or the specific send* methods instead.
   */
  postMessage(body: Record<string, unknown>): void {
    if (!this.channelId) return;
    this.postToChannel(this.channelId, body);
  }
}
