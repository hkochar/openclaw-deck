/**
 * Provider rate limit checking and alerting.
 * Extracted from budget.ts — checks usage against configured provider windows.
 */

import { queryProviderUsage } from "./event-log.js";
import {
  loadProviderLimits,
  getDeckSiteUrl,
  logToSystemLog,
  costsUrl,
  logsUrl,
  lastAlertTs,
  ALERT_COOLDOWN,
  type ProviderLimitWindow,
  type ProviderWindowStatus,
} from "./budget.js";
import { sendAlert, type AlertTokens } from "./alert-dispatch.js";

/** Compute the start of the current fixed window.
 *  If an anchorEpoch is provided, windows are aligned to that anchor (step forward/backward by duration).
 *  Otherwise falls back to midnight UTC (daily) or Sunday midnight UTC (weekly). */
function fixedWindowStart(durationSec: number, anchorEpoch?: number): number {
  const now = Date.now();
  const durationMs = durationSec * 1000;

  if (anchorEpoch) {
    // Step from anchor to find the window containing "now"
    if (now >= anchorEpoch) {
      const elapsed = now - anchorEpoch;
      const windowIndex = Math.floor(elapsed / durationMs);
      return anchorEpoch + windowIndex * durationMs;
    } else {
      const elapsed = anchorEpoch - now;
      const windowIndex = Math.ceil(elapsed / durationMs);
      return anchorEpoch - windowIndex * durationMs;
    }
  }

  // Fallback: align to UTC boundaries
  const d = new Date(now);
  if (durationSec <= 86400) {
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
  // Weekly: Sunday midnight UTC
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function formatWindowLabel(w: ProviderLimitWindow): string {
  const dur = w.duration;
  const durStr = dur < 3600 ? `${Math.round(dur / 60)}m`
    : dur < 86400 ? `${Math.round(dur / 3600)}h`
    : dur < 604800 ? `${Math.round(dur / 86400)}d`
    : "weekly";
  const type = w.rolling ? "rolling" : "fixed";
  const suffix = !w.shared && w.model ? ` (${w.model})` : "";
  return `${durStr} ${type}${suffix}`;
}

/**
 * Check all rate limit windows for a provider.
 * Returns status for each window with usage and percentage.
 */
export function checkProviderLimits(provider: string): ProviderWindowStatus[] {
  const limits = loadProviderLimits()[provider];
  if (!limits?.windows?.length) return [];

  const results: ProviderWindowStatus[] = [];

  for (const w of limits.windows) {
    const since = w.rolling
      ? Date.now() - w.duration * 1000
      : fixedWindowStart(w.duration, w.anchorEpoch);

    const events = queryProviderUsage(provider, since);

    let used: number;
    // Track per-model counts for breakdown
    const modelCounts: Record<string, { raw: number; weighted: number }> = {};

    if (w.shared && w.weights) {
      // Weighted pool: sum weight per event based on model substring match
      const weightKeys = Object.entries(w.weights).sort((a, b) => b[0].length - a[0].length);
      used = 0;
      for (const ev of events) {
        const lower = ev.model.toLowerCase();
        let weight = 1.0; // default weight if no match
        for (const [substr, w2] of weightKeys) {
          if (lower.includes(substr.toLowerCase())) {
            weight = w2;
            break;
          }
        }
        used += weight;
        const key = ev.model;
        if (!modelCounts[key]) modelCounts[key] = { raw: 0, weighted: 0 };
        modelCounts[key].raw += 1;
        modelCounts[key].weighted += weight;
      }
    } else if (!w.shared && w.model) {
      // Per-model: count only events matching this model substring
      const modelLower = w.model.toLowerCase();
      used = 0;
      for (const ev of events) {
        if (ev.model.toLowerCase().includes(modelLower)) {
          used += 1;
          const key = ev.model;
          if (!modelCounts[key]) modelCounts[key] = { raw: 0, weighted: 0 };
          modelCounts[key].raw += 1;
          modelCounts[key].weighted += 1;
        }
      }
    } else {
      // Flat count of all events
      used = events.length;
      for (const ev of events) {
        const key = ev.model;
        if (!modelCounts[key]) modelCounts[key] = { raw: 0, weighted: 0 };
        modelCounts[key].raw += 1;
        modelCounts[key].weighted += 1;
      }
    }

    // Build breakdown sorted by weighted desc
    const breakdown = Object.entries(modelCounts)
      .map(([model, c]) => ({ model, raw: c.raw, weighted: Math.round(c.weighted * 100) / 100 }))
      .sort((a, b) => b.weighted - a.weighted);

    const pct = w.limit > 0 ? Math.round((used / w.limit) * 100) : 0;
    const windowStart = since;
    let resetsAt: number;
    if (w.rolling) {
      // Rolling: oldest event falls off at its ts + duration. If no events, show full duration.
      const oldestTs = events.length > 0 ? events[0].ts : 0;
      resetsAt = oldestTs > 0 ? oldestTs + w.duration * 1000 : Date.now() + w.duration * 1000;
    } else {
      // Fixed: current window start + duration
      resetsAt = fixedWindowStart(w.duration, w.anchorEpoch) + w.duration * 1000;
    }
    results.push({
      windowId: w.id,
      provider,
      label: formatWindowLabel(w),
      used: Math.round(used * 100) / 100,
      limit: w.limit,
      pct,
      breakdown: breakdown.length > 0 ? breakdown : undefined,
      windowStart,
      resetsAt,
      rolling: !!w.rolling,
    });
  }

  return results;
}

/**
 * Check all configured providers and return status for every window.
 */
export function checkAllProviderLimits(): ProviderWindowStatus[] {
  const all = loadProviderLimits();
  const results: ProviderWindowStatus[] = [];
  for (const provider of Object.keys(all)) {
    results.push(...checkProviderLimits(provider));
  }
  return results;
}

/**
 * Send a provider rate limit alert. Uses same cooldown system.
 * channelRef supports platform prefixes: "discord:123", "slack:C0ABC", "telegram:-100123".
 */
export async function sendProviderLimitAlert(
  provider: string,
  window: ProviderWindowStatus,
  channelRef: string,
  botTokenOrTokens: string | AlertTokens,
): Promise<void> {
  const now = Date.now();
  const key = `provider:${provider}:${window.windowId}`;
  const last = lastAlertTs.get(key) ?? 0;
  if (now - last < ALERT_COOLDOWN) return;
  lastAlertTs.set(key, now);

  const label = window.pct >= 100 ? "LIMIT REACHED" : "APPROACHING LIMIT";

  const limitStatus = window.pct >= 100 ? "error" : "warning";
  logToSystemLog("budget", `provider-limit-${limitStatus === "error" ? "exceeded" : "warning"}`,
    `${provider} ${window.label}: ${window.used}/${window.limit} (${window.pct}%)`,
    { provider, windowId: window.windowId, used: window.used, limit: window.limit, pct: window.pct },
    limitStatus);

  if (!channelRef) return;

  const tokens: AlertTokens = typeof botTokenOrTokens === "string"
    ? { discord: botTokenOrTokens || undefined }
    : botTokenOrTokens;

  const deckSiteUrl = getDeckSiteUrl();
  await sendAlert(channelRef, {
    title: `Provider ${label}`,
    lines: [
      `Provider:  ${provider}`,
      `Window:    ${window.label}`,
      `Usage:     ${window.used} / ${window.limit} (${window.pct}%)`,
      ...(window.pct >= 100 ? ["Status:    Requests may be rate-limited by the provider."] : []),
    ],
    buttons: [
      { label: "View Costs", url: costsUrl(deckSiteUrl) },
      { label: "View Logs", url: logsUrl(deckSiteUrl) },
      { label: "Configure", url: `${deckSiteUrl}/deck-config#edit.budgets.providerLimits` },
    ],
  }, tokens);
}
