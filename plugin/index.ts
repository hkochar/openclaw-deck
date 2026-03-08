import type { OpenClawPluginApi, AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "fs";
import path from "path";
import os from "os";
import { logEvent, enrichEvent, estimateCost, getDroppedEventCount, getActiveLoops, onLoopDetected, resetLoopState, getPricingTable, getBillingMode, reloadBillingMap, reconcileOpenRouterCosts, reconcileAnthropicCosts, reconcileOpenAICosts, trackProviderCall, getProviderHealth, backfillProviderHealth, trackAgentActivity, onAgentSilence, checkAgentSilence, getAgentActivity, queryContextUtilization, queryMessageDelivery, upsertSession, querySessions, backfillSessionsFromFilesystem, getSessionCount, backfillEventsFromTranscripts, backfillOrphanedTranscripts, learnPricingFromHistory, getDb, backfillSessionSources, updateSessionSource, upsertHeartbeat, updateCronModel as updateCronModelDb, reportDrift as reportDriftDb, resolveDrift as resolveDriftDb, hasUnresolvedDrift, queryUnresolvedDrift, logActivity, backfillToolMetadata, backfillMissingCosts, queryCostSummary } from "./event-log";
import { setLogger } from "./logger";
import { loadBudgetConfig, checkBudget, getCheapestModel, getThrottledModel, sendBudgetAlert, loadAllPausedState, loadPausedState, writePausedState, checkAllProviderLimits, sendProviderLimitAlert, loadProviderLimits, hasBudgetOverride, loadBudgetOverrides, setBudgetOverride, clearBudgetOverride, getSessionCostCapForAgent, getNextResetTime, shouldAutoRecover, getDeckSiteUrl, loadReplayAlertsConfig, onReplayAlert, fireReplayAlert, trackReplayLlmOutput, trackReplayToolCall, resetCronInvocation, resolveCostForAlert, checkSessionCost, checkSessionLimits, getReplaySessionSummaries, resolveAlertChannel, type BudgetCheckResult, type ReplayAlertEvent } from "./budget";
import { DiscordAlerts } from "./discord-alerts";
import { SessionJsonlPoller, setResolveAgentKey } from "./session-poller";
import { loadDeckAgentConfig, loadDeckDashboardConfig, gatewayConfig, findGatewayAgent, buildAgentKeyMap, resolveAgentKey, setAgentKeyMap, getAgentKeyMap } from "./lib/config-loader";
import { registerHttpRoutes } from "./lib/http-routes";

// ── Heartbeat throttle ──────
const _heartbeatLastTs = new Map<string, number>();
const _heartbeatLastModel = new Map<string, string>();
const _lastCronModel = new Map<string, string>();
const HEARTBEAT_THROTTLE_MS = 60_000;

function sendHeartbeat(agentKey: string, status: "active" | "blocked" = "active", model?: string): void {
  if (status === "active") {
    const now = Date.now();
    const last = _heartbeatLastTs.get(agentKey) ?? 0;
    const lastModel = _heartbeatLastModel.get(agentKey);
    const modelChanged = model && model !== lastModel;
    if (!modelChanged && now - last < HEARTBEAT_THROTTLE_MS) return;
    _heartbeatLastTs.set(agentKey, now);
    if (model) _heartbeatLastModel.set(agentKey, model);
  }
  upsertHeartbeat({ agentKey, status, model });
}

function sendUpdateCronModel(agentKey: string, model: string): void {
  if (_lastCronModel.get(agentKey) === model) return;
  _lastCronModel.set(agentKey, model);
  updateCronModelDb(agentKey, model);
}

// ── Plugin ─────────────────────────────────────────────────────────

const plugin = {
  id: "openclaw-deck-sync",
  name: "Deck Sync",
  description: "Deck sync — agent heartbeats, drift detection, cost tracking (SQLite)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Wire up gateway logger for all plugin modules
    setLogger(api.logger);

    // Load Deck config for agent/channel mappings
    const gw = gatewayConfig(api);
    const agentList = gw.agents?.list ?? [];
    const workspaceDir = agentList[0]?.workspace;

    const deckConfig = loadDeckAgentConfig(workspaceDir);
    setAgentKeyMap(buildAgentKeyMap(api, deckConfig));
    const KNOWN_AGENTS = deckConfig
      ? deckConfig.agents.map((a) => a.key)
      : Object.values(getAgentKeyMap()).filter((v, i, arr) => arr.indexOf(v) === i);
    SessionJsonlPoller.AGENT_IDS = agentList.map((a) => a.id);
    if (SessionJsonlPoller.AGENT_IDS.length === 0) {
      SessionJsonlPoller.AGENT_IDS = [...new Set(Object.keys(getAgentKeyMap()))];
    }
    setResolveAgentKey(resolveAgentKey);

    const driftChannelId = deckConfig?.pluginChannels?.["model-drift"];
    const discord = new DiscordAlerts(api, driftChannelId);

    if (deckConfig) {
      api.logger.info?.(`openclaw-deck-sync: loaded Deck config (${deckConfig.agents.length} agents)`);
    } else {
      api.logger.warn("openclaw-deck-sync: Deck config not found, using gateway config fallback");
    }
    api.logger.info?.("openclaw-deck-sync: plugin loaded");

    // Watch openclaw.json for auth profile changes (billing mode: oauth/token vs api_key)
    const openclawConfigPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    try {
      fs.watchFile(openclawConfigPath, { interval: 10_000 }, () => { reloadBillingMap(); });
    } catch { /* file may not exist yet */ }

    // Deck Bridge bot token (used for budget alerts)
    const deckBotToken = process.env.DISCORD_BOT_TOKEN_DECK ?? "";

    // ── Session JSONL → tool_call events poller ─────────────────────────
    const sessionPoller = new SessionJsonlPoller(api.logger);
    sessionPoller.start(15_000);

    // ── First-run backfill (sessions + events from filesystem) ───────────
    if (getSessionCount() === 0) {
      api.logger.info?.("openclaw-deck-sync: first run — backfilling sessions from filesystem");
      backfillSessionsFromFilesystem({ ...getAgentKeyMap() });
    }
    // Always scan for orphaned transcripts (files on disk with no session row)
    const orphaned = backfillOrphanedTranscripts({ ...getAgentKeyMap() });
    if (orphaned > 0) {
      api.logger.info?.(`openclaw-deck-sync: imported ${orphaned} orphaned transcripts as sessions`);
    }
    // Backfill events from JSONL transcripts (first-run only, skips if events exist)
    const backfilledEvents = backfillEventsFromTranscripts({ ...getAgentKeyMap() });
    if (backfilledEvents > 0) {
      api.logger.info?.(`openclaw-deck-sync: backfilled ${backfilledEvents} events from transcripts`);
    }

    // Backfill session source classification (agent/heartbeat/cron)
    const sourceBackfilled = backfillSessionSources();
    if (sourceBackfilled > 0) {
      api.logger.info?.(`openclaw-deck-sync: classified source for ${sourceBackfilled} sessions`);
    }
    // Re-classify recently active sessions every 5 minutes
    setInterval(() => {
      try {
        const reclassified = backfillSessionSources(true);
        if (reclassified > 0) api.logger.info?.(`openclaw-deck-sync: reclassified source for ${reclassified} sessions`);
      } catch { /* non-fatal */ }
    }, 5 * 60 * 1000);

    // Backfill tool metadata for events missing tool_name
    const toolsBackfilled = backfillToolMetadata();
    if (toolsBackfilled > 0) {
      api.logger.info?.(`openclaw-deck-sync: extracted tool metadata for ${toolsBackfilled} events`);
    }
    // Backfill provider_cost for events with token data but no cost
    const costsBackfilled = backfillMissingCosts();
    if (costsBackfilled > 0) {
      api.logger.info?.(`openclaw-deck-sync: calculated cost for ${costsBackfilled} events`);
    }

    // Resolve stale drift events where the agent is already back on the configured model.
    try {
      const unresolvedDrifts = queryUnresolvedDrift();
      if (unresolvedDrifts.length > 0) {
        const db = getDb();
        for (const drift of unresolvedDrifts) {
          const latest = db.prepare(
            "SELECT resolved_model FROM events WHERE agent = ? AND type = 'llm_output' AND resolved_model IS NOT NULL ORDER BY ts DESC LIMIT 1",
          ).get(drift.agent_key) as { resolved_model: string } | undefined;
          if (latest) {
            const strip = (m: string) => { const s = m.lastIndexOf("/"); return s >= 0 ? m.slice(s + 1) : m; };
            if (strip(latest.resolved_model) === strip(drift.configured_model)) {
              resolveDriftDb(drift.agent_key);
              api.logger.info?.(`[deck-sync] Auto-resolved stale drift for ${drift.agent_key} (now on ${latest.resolved_model})`);
            }
          }
        }
      }
    } catch (err) {
      api.logger.warn?.(`[deck-sync] Startup drift resolution failed: ${String(err)}`);
    }

    // Backfill provider health from historical events so Reliability tab isn't empty.
    backfillProviderHealth();

    // Learn per-model pricing from historical provider_cost data.
    learnPricingFromHistory();
    setInterval(() => learnPricingFromHistory(), 24 * 60 * 60 * 1000);

    // ── Reliability alert wiring ──────────────────────────────────────

    // Stuck loop: alert to monitoring channel
    onLoopDetected((agent, tool, count, signature) => {
      discord.sendLoopAlert(agent, tool, count, resolveAlertChannel("monitoring", deckConfig), signature);
      logEvent({
        agent,
        type: "loop_detected",
        detail: { tool, count, summary: `Stuck loop: ${tool} repeated ${count}x in last 20 calls` },
      });
    });

    // Agent silence: alert to monitoring channel
    onAgentSilence((agent, silenceMinutes) => {
      discord.sendAgentSilenceAlert(agent, silenceMinutes, resolveAlertChannel("monitoring", deckConfig));
      logEvent({
        agent,
        type: "agent_silence",
        detail: { silenceMinutes, summary: `${agent} silent for ${silenceMinutes}m` },
      });
    });

    // Check agent silence every 5 minutes
    setInterval(() => {
      checkAgentSilence(KNOWN_AGENTS);
    }, 5 * 60 * 1000);

    // Replay alerts: route to session alert channel
    onReplayAlert((event) => {
      const channelRef = resolveAlertChannel("session", deckConfig);
      discord.sendReplayAlert(event, channelRef);
    });

    // ── OpenRouter cost reconciliation ──────────────────────────────────
    const dashConfig = loadDeckDashboardConfig(workspaceDir);
    const providerKeys = dashConfig?.providerKeys as Record<string, Record<string, string>> | undefined;
    const orManagementKey = providerKeys?.openrouter?.managementKey ?? "";
    const orApiKey = process.env.OPENROUTER_API_KEY ?? "";

    if (orManagementKey) {
      reconcileOpenRouterCosts(orManagementKey, true).then((n) => {
        if (n > 0) {
          api.logger.info(`[deck-sync] OpenRouter cost reconciliation: updated ${n} events`);
          learnPricingFromHistory();
        }
      }).catch(() => {});
      setInterval(() => {
        reconcileOpenRouterCosts(orManagementKey).then((n) => {
          if (n > 0) api.logger.info(`[deck-sync] OpenRouter cost reconciliation: updated ${n} events`);
        }).catch(() => {});
      }, 5 * 60 * 1000);
    } else if (orApiKey) {
      api.logger.info("[deck-sync] No OpenRouter management key in Deck config — Activity API reconciliation disabled (regular key gets 403). Add providerKeys.openrouter.managementKey to config/deck-config.json.");
    } else {
      api.logger.info("[deck-sync] No OpenRouter API key — skipping cost reconciliation");
    }

    // ── Anthropic cost reconciliation ──────────────────────────────────
    const anthropicAdminKey = providerKeys?.anthropic?.adminKey ?? "";
    if (anthropicAdminKey) {
      reconcileAnthropicCosts(anthropicAdminKey).then((n) => {
        if (n > 0) api.logger.info(`[deck-sync] Anthropic cost reconciliation: updated ${n} events`);
      }).catch(() => {});
      setInterval(() => {
        reconcileAnthropicCosts(anthropicAdminKey).then((n) => {
          if (n > 0) api.logger.info(`[deck-sync] Anthropic cost reconciliation: updated ${n} events`);
        }).catch(() => {});
      }, 5 * 60 * 1000);
    }

    // ── OpenAI cost reconciliation ──────────────────────────────────
    const openaiAdminKey = providerKeys?.openai?.adminKey ?? "";
    if (openaiAdminKey) {
      reconcileOpenAICosts(openaiAdminKey).then((n) => {
        if (n > 0) api.logger.info(`[deck-sync] OpenAI cost reconciliation: updated ${n} events`);
      }).catch(() => {});
      setInterval(() => {
        reconcileOpenAICosts(openaiAdminKey).then((n) => {
          if (n > 0) api.logger.info(`[deck-sync] OpenAI cost reconciliation: updated ${n} events`);
        }).catch(() => {});
      }, 5 * 60 * 1000);
    }

    // ── Hook: Heartbeat on outbound messages ──────────────────────────
    api.on("message_sent", async (event, ctx) => {
      if (!event.success) return;
      if (!event.content?.trim()) return;

      const agentKey = resolveAgentKey(ctx.accountId);
      if (!agentKey) return;

      sendHeartbeat(agentKey, "active");
    });

    // ── Hook: Log inbound messages + heartbeat ────────────────────────
    api.on("message_received", async (event, ctx) => {
      const agentKey = resolveAgentKey(ctx.accountId);
      if (!agentKey) return;

      if (event.content?.trim()) {
        logEvent({
          agent: agentKey,
          session: ctx.sessionKey,
          type: "msg_in",
          detail: {
            from: event.from,
            content: event.content.slice(0, 500),
            channel: ctx.channelId,
          },
        });
      }
      sendHeartbeat(agentKey, "active");
    });

    // ── Hook: Cron failure detection on agent end ─────────────────────
    const cronFailureTracker = new Map<string, number>();

    api.on("agent_end", async (event, ctx) => {
      const agentKey = resolveAgentKey(ctx.agentId);
      if (!agentKey) return;

      // ── Cron failure detection ──────────────────────────────────────
      const isCronSession = ctx.sessionKey?.includes(":cron:") ?? false;
      if (isCronSession) {
        const cronMatch = ctx.sessionKey?.match(/:cron:([^:]+)/);
        const cronJobId = cronMatch?.[1];
        if (cronJobId) {
          try {
            const cronStorePath = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
            const raw = fs.readFileSync(cronStorePath, "utf-8");
            const store = JSON.parse(raw) as { jobs?: Array<{ id: string; name: string; state?: { consecutiveErrors?: number; lastStatus?: string; lastError?: string } }> };
            const job = store.jobs?.find((j) => j.id === cronJobId);
            if (job) {
              const errors = job.state?.consecutiveErrors ?? 0;
              const prevErrors = cronFailureTracker.get(cronJobId) ?? 0;

              if (!event.success || job.state?.lastStatus === "error") {
                const errorMsg = job.state?.lastError || event.error || `Job finished with status "${job.state?.lastStatus ?? "error"}" (no error message provided)`;
                logEvent({
                  agent: agentKey,
                  session: ctx.sessionKey,
                  type: "cron_error",
                  detail: { cronJobId, cronName: job.name, consecutiveErrors: errors, error: errorMsg },
                });
                if (errors >= 2) {
                  discord.sendCronFailureAlert(agentKey, job.name, errorMsg, errors, resolveAlertChannel("cron", deckConfig));
                }
              } else if (prevErrors >= 2 && errors === 0) {
                discord.sendCronRecoveryAlert(agentKey, job.name, resolveAlertChannel("cron", deckConfig));
                logEvent({
                  agent: agentKey,
                  session: ctx.sessionKey,
                  type: "cron_recovery",
                  detail: { cronJobId, cronName: job.name, prevErrors },
                });
              }

              cronFailureTracker.set(cronJobId, errors);
            }
          } catch {
            // Cron store read failed — skip alerting this time
          }
        }
      }

      // Reset per-invocation state for cron sessions so the next invocation starts clean
      if (isCronSession && ctx.sessionKey) {
        resetCronInvocation(agentKey, ctx.sessionKey);
        resetLoopState(agentKey);
      }

      if (!event.success) {
        sendHeartbeat(agentKey, "blocked");
        return;
      }

      sendHeartbeat(agentKey, "active");
    });

    // ── Blocked attempt collapsing ─────────────────────────────────────
    const COLLAPSE_WINDOW_MS = 60_000;
    const lastBlockedTs = new Map<string, number>();

    function logBlockedAttempt(agentKey: string, sessionKey: string | undefined, detail: Record<string, unknown>): void {
      const now = Date.now();
      const lastTs = lastBlockedTs.get(agentKey) ?? 0;

      if (now - lastTs < COLLAPSE_WINDOW_MS) {
        try {
          const db = getDb();
          if (db) {
            const recent = db.prepare(`
              SELECT id, detail FROM events
              WHERE agent = ? AND type = 'budget_blocked' AND ts > ?
              ORDER BY ts DESC LIMIT 1
            `).get(agentKey, now - COLLAPSE_WINDOW_MS) as { id: number; detail: string } | undefined;
            if (recent) {
              const existing = JSON.parse(recent.detail || "{}");
              const count = (existing.blocked_count ?? 1) + 1;
              db.prepare(`UPDATE events SET ts = ?, detail = json_set(detail, '$.blocked_count', ?, '$.last_blocked_ts', ?) WHERE id = ?`)
                .run(now, count, now, recent.id);
              lastBlockedTs.set(agentKey, now);
              return;
            }
          }
        } catch { /* fall through to new event */ }
      }

      lastBlockedTs.set(agentKey, now);
      logEvent({
        agent: agentKey,
        session: sessionKey,
        type: "budget_blocked",
        detail: { ...detail, blocked_count: 1, first_blocked_ts: now },
      });
    }

    // ── Enforcement state (shared between before_model_resolve → before_prompt_build) ──
    const enforcementState = new Map<string, {
      action: "throttle" | "block" | "alert";
      reason: string;
      detail: string;
      ts: number;
    }>();
    // Cleanup stale entries every 10 minutes
    setInterval(() => {
      const cutoff = Date.now() - 600_000;
      for (const [key, state] of enforcementState) {
        if (state.ts < cutoff) enforcementState.delete(key);
      }
    }, 600_000);

    // ── Hook: Budget enforcement via model override ───────────────────
    api.on("before_model_resolve", async (event, ctx) => {
      const agentKey = resolveAgentKey(ctx.accountId)
        || resolveAgentKey(ctx.sessionKey?.split(":")?.[1])
        || resolveAgentKey(ctx.agentId);
      if (!agentKey) return;

      // Emergency override bypasses ALL budget enforcement
      if (hasBudgetOverride(agentKey)) {
        const pauseState = loadPausedState(agentKey);
        if (pauseState?.paused) {
          writePausedState(agentKey, false, "emergency override active");
        }
        return;
      }

      // Check kill switch (paused agents)
      const pauseState = loadPausedState(agentKey);
      if (pauseState?.paused) {
        let costContext: Record<string, unknown> = {};
        try {
          const costs = queryCostSummary();
          const ac = costs.find(c => c.agent === agentKey);
          if (ac) costContext = { dailySpend: ac.daily, weeklySpend: ac.weekly, monthlySpend: ac.monthly };
        } catch { /* ok */ }

        logBlockedAttempt(agentKey, ctx.sessionKey, {
          reason: pauseState.reason ?? "paused",
          pausedSince: pauseState.since,
          ...costContext,
        });

        const resetAt = getNextResetTime("daily");
        if (ctx.sessionKey) {
          enforcementState.set(ctx.sessionKey, {
            action: "block", reason: "Agent paused",
            detail: `Agent ${agentKey} is paused: ${pauseState.reason ?? "manually paused"}. All LLM calls are blocked until an operator unpauses you.`,
            ts: Date.now(),
          });
        }
        return {
          modelOverride: `__budget_rejected__${JSON.stringify({
            code: "AGENT_PAUSED",
            agent: agentKey,
            reason: pauseState.reason ?? "paused",
            resetAt,
          })}`,
          providerOverride: "none",
        };
      }

      // Check budget
      const budgetResult = checkBudget(agentKey);
      if (budgetResult.action === "block") {
        const period = budgetResult.period.replace("Requests", "") as "daily" | "weekly" | "monthly";
        writePausedState(agentKey, true, `${period} budget exceeded`);

        let costContext: Record<string, unknown> = {};
        try {
          const costs = queryCostSummary();
          const ac = costs.find(c => c.agent === agentKey);
          const config = loadBudgetConfig();
          const budget = config.agents[agentKey];
          if (ac) costContext = { dailySpend: ac.daily, budgetLimit: budget?.daily, trigger: budgetResult.trigger, period: budgetResult.period, ratio: budgetResult.ratio };
        } catch { /* ok */ }

        logBlockedAttempt(agentKey, ctx.sessionKey, { reason: `${period} limit`, ...costContext });

        const alertChannelRef = resolveAlertChannel("budget", deckConfig);
        sendBudgetAlert(agentKey, "blocked", alertChannelRef, discord.tokens, { trigger: budgetResult.trigger, period: budgetResult.period, ratio: budgetResult.ratio }).catch(() => {});

        const resetAt = getNextResetTime(period);
        if (ctx.sessionKey) {
          enforcementState.set(ctx.sessionKey, {
            action: "block", reason: "Budget exceeded",
            detail: `Agent ${agentKey} has exceeded its ${period} budget limit ($${budgetResult.trigger} spent). All LLM calls are blocked until the budget period resets or an operator grants an override.`,
            ts: Date.now(),
          });
        }
        return {
          modelOverride: `__budget_rejected__${JSON.stringify({
            code: "BUDGET_EXCEEDED",
            agent: agentKey,
            reason: `${period}_budget_exceeded`,
            resetAt,
            trigger: budgetResult.trigger,
          })}`,
          providerOverride: "none",
        };
      }

      if (budgetResult.action === "throttle") {
        const agentConfig = findGatewayAgent(api, agentKey);
        const currentModel = agentConfig?.model ?? "claude-opus-4-6";
        const throttled = getThrottledModel(currentModel);

        if (throttled) {
          logEvent({
            agent: agentKey, session: ctx.sessionKey, type: "budget_throttle",
            detail: { from: currentModel, to: throttled.model, trigger: budgetResult.trigger, period: budgetResult.period, marker: true },
          });
          const alertChannelRef = resolveAlertChannel("budget", deckConfig);
          sendBudgetAlert(agentKey, "exceeded", alertChannelRef, discord.tokens, { trigger: budgetResult.trigger, period: budgetResult.period, ratio: budgetResult.ratio }).catch(() => {});
          if (ctx.sessionKey) {
            enforcementState.set(ctx.sessionKey, {
              action: "throttle", reason: "Budget throttle",
              detail: `Your model has been downgraded from ${currentModel} to ${throttled.model} because agent ${agentKey} is approaching its ${budgetResult.period} budget limit. Work efficiently to stay within budget.`,
              ts: Date.now(),
            });
          }
          return { modelOverride: throttled.model, providerOverride: throttled.provider };
        }
      }

      if (budgetResult.action === "alert") {
        const alertChannelRef = resolveAlertChannel("budget", deckConfig);
        sendBudgetAlert(agentKey, "threshold", alertChannelRef, discord.tokens, { trigger: budgetResult.trigger, period: budgetResult.period, ratio: budgetResult.ratio }).catch(() => {});
      }

      // ── Session cost cap enforcement ──
      if (ctx.sessionKey) {
        const billing = "metered";
        const costResult = checkSessionCost(agentKey, ctx.sessionKey, billing);
        if (costResult) {
          const config = loadBudgetConfig();

          if (costResult.action === "block") {
            logBlockedAttempt(agentKey, ctx.sessionKey, {
              reason: "session_cost_cap_exceeded",
              trigger: costResult.trigger, value: costResult.value, threshold: costResult.threshold,
            });
            fireReplayAlert({
              type: "session-cost", agent: agentKey, session: ctx.sessionKey,
              value: costResult.value, threshold: costResult.threshold,
              triggeredPct: costResult.triggeredPct,
              action: "block",
              detail: { enforcement: "blocked", costView: config.costView },
            });
            enforcementState.set(ctx.sessionKey, {
              action: "block", reason: "Session cost cap exceeded",
              detail: `This session has spent $${costResult.value.toFixed(2)} which exceeds the $${costResult.threshold} session cost cap. All further LLM calls are blocked. Start a new session or ask an operator to grant an override.`,
              ts: Date.now(),
            });
            return {
              modelOverride: `__budget_rejected__${JSON.stringify({
                code: "SESSION_COST_EXCEEDED",
                agent: agentKey,
                reason: "session_cost_cap_exceeded",
                trigger: costResult.trigger,
              })}`,
              providerOverride: "none",
            };
          }

          if (costResult.action === "throttle") {
            const agentConfig = findGatewayAgent(api, agentKey);
            const currentModel = agentConfig?.model ?? "claude-opus-4-6";
            const throttled = getThrottledModel(currentModel);
            if (throttled) {
              logEvent({
                agent: agentKey, session: ctx.sessionKey, type: "session_cost_throttle",
                detail: { from: currentModel, to: throttled.model, trigger: costResult.trigger, value: costResult.value, threshold: costResult.threshold },
              });
              fireReplayAlert({
                type: "session-cost", agent: agentKey, session: ctx.sessionKey,
                value: costResult.value, threshold: costResult.threshold,
                triggeredPct: costResult.triggeredPct,
                action: "throttle",
                detail: { enforcement: "throttled", from: currentModel, to: throttled.model, costView: config.costView },
              });
              enforcementState.set(ctx.sessionKey, {
                action: "throttle", reason: "Session cost cap approaching",
                detail: `Your model has been downgraded from ${currentModel} to ${throttled.model} because this session has spent $${costResult.value.toFixed(2)} of the $${costResult.threshold} session cost cap. Work efficiently to stay within the cap.`,
                ts: Date.now(),
              });
              return { modelOverride: throttled.model, providerOverride: throttled.provider };
            }
          }

          if (costResult.action === "alert") {
            fireReplayAlert({
              type: "session-cost", agent: agentKey, session: ctx.sessionKey,
              value: costResult.value, threshold: costResult.threshold,
              triggeredPct: costResult.triggeredPct,
              action: "alert",
              detail: { costView: config.costView, pct: Math.round((costResult.value / costResult.threshold) * 100) },
            });
          }
        }
      }

      // ── Session guardrail enforcement (duration, tool calls) ──
      if (ctx.sessionKey) {
        const guardrailResult = checkSessionLimits(agentKey, ctx.sessionKey);
        if (guardrailResult) {
          const alertType = guardrailResult.trigger === "tool-calls" ? "excessive-tools" : "long-session";

          if (guardrailResult.action === "block") {
            const guardrailLabel = guardrailResult.trigger === "tool-calls"
              ? `${guardrailResult.value} tool calls (limit: ${guardrailResult.threshold})`
              : `${guardrailResult.value} minutes (limit: ${guardrailResult.threshold} min)`;
            logBlockedAttempt(agentKey, ctx.sessionKey, {
              reason: `session_guardrail_${guardrailResult.trigger}`,
              trigger: guardrailResult.trigger, value: guardrailResult.value, threshold: guardrailResult.threshold,
            });
            fireReplayAlert({
              type: alertType, agent: agentKey, session: ctx.sessionKey,
              value: guardrailResult.value, threshold: guardrailResult.threshold,
              triggeredPct: guardrailResult.triggeredPct,
              action: "block",
              detail: { enforcement: "blocked" },
            });
            enforcementState.set(ctx.sessionKey, {
              action: "block", reason: `Session guardrail: ${guardrailResult.trigger}`,
              detail: `This session has been blocked because it exceeded the ${guardrailResult.trigger === "tool-calls" ? "tool call" : "duration"} guardrail: ${guardrailLabel}. Start a new session to continue working.`,
              ts: Date.now(),
            });
            return {
              modelOverride: `__budget_rejected__${JSON.stringify({
                code: "SESSION_GUARDRAIL_EXCEEDED",
                agent: agentKey,
                reason: `session_${guardrailResult.trigger}_exceeded`,
                trigger: guardrailResult.trigger,
              })}`,
              providerOverride: "none",
            };
          }

          if (guardrailResult.action === "throttle") {
            const agentConfig = findGatewayAgent(api, agentKey);
            const currentModel = agentConfig?.model ?? "claude-opus-4-6";
            const throttled = getThrottledModel(currentModel);
            if (throttled) {
              const guardrailLabel = guardrailResult.trigger === "tool-calls"
                ? `${guardrailResult.value}/${guardrailResult.threshold} tool calls`
                : `${guardrailResult.value}/${guardrailResult.threshold} min duration`;
              logEvent({
                agent: agentKey, session: ctx.sessionKey, type: "session_guardrail_throttle",
                detail: { from: currentModel, to: throttled.model, trigger: guardrailResult.trigger, value: guardrailResult.value, threshold: guardrailResult.threshold },
              });
              fireReplayAlert({
                type: alertType, agent: agentKey, session: ctx.sessionKey,
                value: guardrailResult.value, threshold: guardrailResult.threshold,
                triggeredPct: guardrailResult.triggeredPct,
                action: "throttle",
                detail: { enforcement: "throttled", from: currentModel, to: throttled.model },
              });
              enforcementState.set(ctx.sessionKey, {
                action: "throttle", reason: `Session guardrail: ${guardrailResult.trigger}`,
                detail: `Your model has been downgraded from ${currentModel} to ${throttled.model} because this session is approaching the ${guardrailResult.trigger === "tool-calls" ? "tool call" : "duration"} guardrail (${guardrailLabel}). Work efficiently to complete your task.`,
                ts: Date.now(),
              });
              return { modelOverride: throttled.model, providerOverride: throttled.provider };
            }
          }

          if (guardrailResult.action === "alert") {
            fireReplayAlert({
              type: alertType, agent: agentKey, session: ctx.sessionKey,
              value: guardrailResult.value, threshold: guardrailResult.threshold,
              triggeredPct: guardrailResult.triggeredPct,
              action: "alert",
              detail: { pct: Math.round((guardrailResult.value / guardrailResult.threshold) * 100) },
            });
          }
        }
      }

      // Check provider rate limits and alert if approaching
      try {
        const providerWindows = checkAllProviderLimits();
        const config = loadBudgetConfig();
        const thresholds = config.alertThresholds.sort((a, b) => b - a);
        const providerAlertRef = resolveAlertChannel("budget", deckConfig);
        for (const w of providerWindows) {
          for (const t of thresholds) {
            if (w.pct >= t) {
              sendProviderLimitAlert(w.provider, w, providerAlertRef, discord.tokens).catch(() => {});
              logEvent({
                agent: w.provider,
                type: w.pct >= 100 ? "provider_limit_exceeded" : "provider_limit_warning",
                detail: { provider: w.provider, windowId: w.windowId, used: w.used, limit: w.limit, pct: w.pct },
              });
              break;
            }
          }
        }
      } catch {
        // Don't let provider limit checks break the hook
      }
    });

    // ── Hook: Inject enforcement context into agent prompt ──
    api.on("before_prompt_build", async (_event, ctx) => {
      if (!ctx.sessionKey) return;
      const state = enforcementState.get(ctx.sessionKey);
      if (!state) return;

      if (Date.now() - state.ts > 1_800_000) {
        enforcementState.delete(ctx.sessionKey);
        return;
      }

      const label = state.action === "block" ? "BLOCKED" : state.action === "throttle" ? "THROTTLED" : "WARNING";
      const prependContext = [
        `<system-enforcement>`,
        `[${label}] ${state.reason}`,
        state.detail,
        `</system-enforcement>`,
      ].join("\n");

      return { prependContext };
    });

    // ── Hook: Log llm_input to SQLite ─────────────────────────────────
    api.on("llm_input", async (event, ctx) => {
      const agentKey = resolveAgentKey(ctx.accountId)
        || resolveAgentKey(ctx.sessionKey?.split(":")?.[1])
        || resolveAgentKey(ctx.agentId);
      if (!agentKey) return;

      const model = event.model.includes("/") ? event.model : `${event.provider}/${event.model}`;
      let promptJson: string | undefined;
      try {
        const promptData: Record<string, unknown> = {};
        if (event.systemPrompt) promptData.system = event.systemPrompt;
        if (event.historyMessages?.length) promptData.history = event.historyMessages;
        if (event.prompt) promptData.prompt = event.prompt;
        if (Object.keys(promptData).length > 0) {
          const seen = new WeakSet();
          promptJson = JSON.stringify(promptData, (_key, value) => {
            if (typeof value === "object" && value !== null) {
              if (seen.has(value)) return "[Circular]";
              seen.add(value);
            }
            return value;
          });
        }
      } catch (serErr) {
        api.logger.warn(`[deck-sync] llm_input prompt serialization failed: ${(serErr as Error).message}`);
      }

      let hasCompaction = false, hasToolUse = false;
      for (const msg of event.historyMessages ?? []) {
        if (msg.role === "compactionSummary") hasCompaction = true;
        if (msg.role === "toolResult") hasToolUse = true;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === "tool_use" || b.type === "toolCall") hasToolUse = true;
          }
        }
      }

      const inputProvider = model.split("/")[0];
      logEvent({
        agent: agentKey,
        session: ctx.sessionKey,
        type: "llm_input",
        model,
        runId: event.runId,
        prompt: promptJson,
        billing: getBillingMode(inputProvider),
        detail: {
          historyCount: event.historyMessages?.length ?? 0,
          systemPromptLen: event.systemPrompt?.length ?? 0,
          promptPreview: event.prompt?.slice(0, 2000),
          imagesCount: event.imagesCount ?? 0,
          hasCompaction: hasCompaction || undefined,
          hasToolUse: hasToolUse || undefined,
        },
      });
      trackAgentActivity(agentKey, "llm_input");
    });

    // ── OpenRouter provider-reported costs via /auth/key ───────────────
    interface OpenRouterKeyUsage {
      usage: number;
      usageDaily: number;
      usageWeekly: number;
      usageMonthly: number;
      limit: number | null;
      limitRemaining: number | null;
      ts: number;
    }
    let orKeyUsage: OpenRouterKeyUsage | null = null;

    async function fetchOrKeyUsage(): Promise<OpenRouterKeyUsage | null> {
      if (!orApiKey) return null;
      try {
        const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: { Authorization: `Bearer ${orApiKey}`, "Content-Type": "application/json" },
        });
        if (!resp.ok) return orKeyUsage;
        const body = await resp.json() as { data?: Record<string, unknown> };
        const d = body.data;
        if (!d) return orKeyUsage;
        orKeyUsage = {
          usage: (d.usage as number) ?? 0,
          usageDaily: (d.usage_daily as number) ?? 0,
          usageWeekly: (d.usage_weekly as number) ?? 0,
          usageMonthly: (d.usage_monthly as number) ?? 0,
          limit: (d.limit as number | null) ?? null,
          limitRemaining: (d.limit_remaining as number | null) ?? null,
          ts: Date.now(),
        };
        return orKeyUsage;
      } catch {
        return orKeyUsage;
      }
    }

    if (orApiKey) {
      fetchOrKeyUsage().catch(() => {});
      setInterval(() => fetchOrKeyUsage().catch(() => {}), 60_000);
    }

    const orCallTracker = new Map<string, { usage: number; ts: number }>();

    api.on("llm_input", async (event) => {
      const model = event.model?.includes("/") ? event.model : `${event.provider ?? ""}/${event.model ?? ""}`;
      if (!model.startsWith("openrouter/") || !orApiKey) return;
      await fetchOrKeyUsage();
      if (orKeyUsage) {
        orCallTracker.set(event.runId, { usage: orKeyUsage.usage, ts: Date.now() });
      }
      for (const [k, v] of orCallTracker) {
        if (Date.now() - v.ts > 600_000) orCallTracker.delete(k);
      }
    });

    // ── Hook: Log llm_output to SQLite ────────────────────────────────
    // ── Model drift detection ──────────────────────────────────────
    const lastReportedModel = new Map<string, string>();

    const agentsBase = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), ".openclaw", "agents");
    const SESSION_STORE_PATH = path.join(agentsBase, "main", "sessions", "sessions.json");

    const AGENT_SESSION_KEYS: Record<string, string> = {};
    if (deckConfig) {
      for (const a of deckConfig.agents) {
        AGENT_SESSION_KEYS[a.key] = `agent:main:discord:channel:${a.discordChannelId}`;
      }
    }

    function getSessionOverride(agentKey: string): string | null {
      try {
        const raw = fs.readFileSync(SESSION_STORE_PATH, "utf-8");
        const store = JSON.parse(raw) as Record<string, Record<string, string>>;
        const sessionKey = AGENT_SESSION_KEYS[agentKey];
        if (!sessionKey) return null;
        const entry = store[sessionKey];
        if (!entry) return null;
        const p = entry.providerOverride?.trim();
        const m = entry.modelOverride?.trim();
        if (p && m) return `${p}/${m}`;
        if (m) return m;
        return null;
      } catch {
        return null;
      }
    }

    const CRON_STORE_PATH = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");

    function getCronJobModel(sessionKey: string | undefined): string | null {
      if (!sessionKey || !sessionKey.includes(":cron:")) return null;
      const cronMatch = sessionKey.match(/:cron:([^:]+)/);
      if (!cronMatch) return null;
      const cronJobId = cronMatch[1];
      try {
        const raw = fs.readFileSync(CRON_STORE_PATH, "utf-8");
        const store = JSON.parse(raw) as { jobs?: Array<{ id: string; payload?: { model?: string } }> };
        const job = store.jobs?.find((j) => j.id === cronJobId);
        return job?.payload?.model ?? null;
      } catch {
        return null;
      }
    }

    function getCronJobName(sessionKey: string | undefined): string | null {
      if (!sessionKey || !sessionKey.includes(":cron:")) return null;
      const cronMatch = sessionKey.match(/:cron:([^:]+)/);
      if (!cronMatch) return null;
      const cronJobId = cronMatch[1];
      try {
        const raw = fs.readFileSync(CRON_STORE_PATH, "utf-8");
        const store = JSON.parse(raw) as { jobs?: Array<{ id: string; name: string }> };
        const job = store.jobs?.find((j) => j.id === cronJobId);
        return job?.name ?? null;
      } catch {
        return null;
      }
    }

    api.on("llm_output", async (event, ctx) => {
      const agentKey = resolveAgentKey(ctx.accountId)
        || resolveAgentKey(ctx.sessionKey?.split(":")?.[1])
        || resolveAgentKey(ctx.agentId);
      if (!agentKey) return;

      const actualModel = event.model.includes("/") ? event.model : `${event.provider}/${event.model}`;
      const outputProvider = actualModel.split("/")[0];
      const billing = getBillingMode(outputProvider);
      const usage = event.usage ?? {} as Record<string, number | undefined>;
      const inputTokens = (usage as Record<string, number>).input ?? 0;
      const outputTokens = (usage as Record<string, number>).output ?? 0;
      const cacheRead = (usage as Record<string, number>).cacheRead ?? 0;
      const cacheWrite = (usage as Record<string, number>).cacheWrite ?? 0;

      let providerCost: number | undefined;
      let resolvedModel: string | undefined;

      if (outputProvider === "openrouter" && orApiKey) {
        const before = orCallTracker.get(event.runId);
        orCallTracker.delete(event.runId);
        if (before) {
          await new Promise((r) => setTimeout(r, 2000));
          await fetchOrKeyUsage();
          if (orKeyUsage) {
            const delta = orKeyUsage.usage - before.usage;
            if (delta > 0.000001) {
              providerCost = Math.round(delta * 1_000_000) / 1_000_000;
              api.logger.info(`[deck-sync] OpenRouter cost delta for ${agentKey}: $${providerCost}`);
            }
          }
        }
      }

      const estimatedCost = estimateCost(actualModel, inputTokens, outputTokens, cacheRead, cacheWrite);
      if (billing === "subscription") providerCost = undefined;
      const cost = providerCost ?? estimatedCost;

      const fullResponse = event.assistantTexts?.join("\n") || undefined;

      logEvent({
        agent: agentKey,
        session: ctx.sessionKey,
        type: "llm_output",
        model: actualModel,
        inputTokens,
        outputTokens,
        cacheRead,
        cacheWrite,
        cost: Math.round(cost * 10000) / 10000,
        runId: event.runId,
        response: fullResponse,
        billing,
        resolvedModel,
        providerCost: providerCost ? Math.round(providerCost * 1_000_000) / 1_000_000 : undefined,
        detail: {
          assistantPreview: event.assistantTexts?.join("\n")?.slice(0, 2000),
          total: (usage as Record<string, number>).total ?? 0,
          resolvedModel,
        },
      });

      // ── Reliability tracking ──────────────────────────────────────
      trackAgentActivity(agentKey, "llm_output");
      trackProviderCall(outputProvider, true);
      if (ctx.sessionKey) {
        trackReplayLlmOutput(agentKey, ctx.sessionKey, cost, actualModel, inputTokens, cacheRead, billing ?? "metered", providerCost);
      }

      // ── Drift detection ──────────────────────────────────────────
      const isCron = ctx.sessionKey?.includes(":cron:") ?? false;

      if (isCron) {
        sendUpdateCronModel(agentKey, actualModel);
      } else {
        sendHeartbeat(agentKey, "active", actualModel);
      }

      const throttleKey = isCron ? `${agentKey}:cron` : agentKey;

      if (lastReportedModel.get(throttleKey) === actualModel) return;
      const previousModel = lastReportedModel.get(throttleKey);
      lastReportedModel.set(throttleKey, actualModel);

      const cfg = api.config as Record<string, unknown> | undefined;
      const agents = cfg?.agents as Record<string, unknown> | undefined;
      const agentListRaw = agents?.list;
      const agentListAll: Array<Record<string, unknown>> = Array.isArray(agentListRaw) ? agentListRaw : [];
      const agentCfg = agentListAll.find((a) => a.id === ctx.agentId);
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      const defaultModel = defaults?.model as Record<string, unknown> | undefined;
      const agentModel = agentCfg?.model as Record<string, unknown> | undefined;

      const agentPrimaryRaw = agentModel?.primary ?? defaultModel?.primary;
      const agentPrimary = typeof agentPrimaryRaw === "string"
        ? agentPrimaryRaw : "anthropic/claude-opus-4-6";

      const cronModel = isCron ? getCronJobModel(ctx.sessionKey) : null;
      const configuredPrimary = cronModel ?? agentPrimary;

      const fallbacksRaw = agentModel?.fallbacks ?? defaultModel?.fallbacks;
      const configuredFallbacks: string[] = Array.isArray(fallbacksRaw)
        ? (fallbacksRaw as string[]) : [];

      const cronName = isCron ? getCronJobName(ctx.sessionKey) : null;
      const driftLabel = cronName ? `${agentKey} (cron: ${cronName})` : agentKey;

      const normalizeModel = (m: string): string => {
        const parts = m.split("/");
        if (parts.length >= 3 && parts[0] === parts[1]) {
          return parts.slice(1).join("/");
        }
        return m;
      };
      const modelOnly = (m: string): string => {
        const n = normalizeModel(m);
        const slash = n.lastIndexOf("/");
        return slash >= 0 ? n.slice(slash + 1) : n;
      };
      const modelsMatch = (a: string, b: string): boolean => {
        const na = normalizeModel(a);
        const nb = normalizeModel(b);
        return na === nb || modelOnly(a) === modelOnly(b);
      };
      const normFallbacks = configuredFallbacks.map(normalizeModel);

      // ── Cron drift detection ──────────────────────────────────────
      if (isCron) {
        if (modelsMatch(actualModel, configuredPrimary)) {
          if (hasUnresolvedDrift(agentKey)) {
            resolveDriftDb(agentKey);
            discord.sendDriftResolved(driftLabel, configuredPrimary, resolveAlertChannel("drift", deckConfig));
          }
        } else {
          reportDriftDb(agentKey, configuredPrimary, actualModel, "cron");
          discord.sendDriftAlert(driftLabel, configuredPrimary, actualModel, "cron", resolveAlertChannel("drift", deckConfig));
          const isFree = /\bfree\b|\/auto\b/i.test(configuredPrimary);
          const isPaid = /anthropic|openai|claude|gpt/i.test(actualModel);
          logEvent({
            agent: agentKey,
            type: "model_drift",
            model: actualModel,
            detail: {
              configuredModel: configuredPrimary, actualModel, tag: "cron",
              reason: isFree && isPaid ? "free model rate-limited/unavailable, fell back to agent primary" : undefined,
            },
          });
        }
        return;
      }

      // ── Work session drift detection ──────────────────────────────
      if (modelsMatch(actualModel, configuredPrimary)) {
        if (hasUnresolvedDrift(agentKey)) {
          resolveDriftDb(agentKey);
          discord.sendDriftResolved(driftLabel, configuredPrimary, resolveAlertChannel("drift", deckConfig));
        }
        return;
      }

      const sessionOverride = getSessionOverride(agentKey);
      let tag: "session" | "fallback" | "unexpected";

      if (sessionOverride && modelsMatch(actualModel, sessionOverride)) {
        tag = "session";
      } else if (normFallbacks.some((fb) => modelsMatch(actualModel, fb))) {
        tag = "fallback";
      } else {
        tag = "unexpected";
      }

      reportDriftDb(agentKey, configuredPrimary, actualModel, tag);
      discord.sendDriftAlert(driftLabel, configuredPrimary, actualModel, tag, resolveAlertChannel("drift", deckConfig));

      const isFreeModel = /\bfree\b|\/auto\b/i.test(configuredPrimary);
      const isPaidModel = /anthropic|openai|claude|gpt/i.test(actualModel);
      logEvent({
        agent: agentKey,
        type: "model_drift",
        model: actualModel,
        detail: {
          configuredModel: configuredPrimary, actualModel, tag,
          reason: isFreeModel && isPaidModel ? "free model rate-limited/unavailable, fell back to agent primary" : undefined,
        },
      });
    });

    // ── HTTP Routes ───────────────────────────────────────────────────
    registerHttpRoutes(api, {
      sessionPoller,
      knownAgents: KNOWN_AGENTS,
      deckConfig,
      deckBotToken,
      discord,
      getOrKeyUsage: () => orKeyUsage,
      findGatewayAgent: (agentKey) => findGatewayAgent(api, agentKey),
    });

    // ── Auto-recovery: check if paused agents should be unpaused ────
    setInterval(() => {
      try {
        const allPaused = loadAllPausedState();
        for (const [agent, state] of Object.entries(allPaused)) {
          if (!state.paused) continue;
          if (!shouldAutoRecover(agent)) continue;

          const budgetResult = checkBudget(agent);
          if (budgetResult.action === "ok" || budgetResult.action === "alert") {
            writePausedState(agent, false, "auto-recovery: budget reset");
            logEvent({
              agent,
              type: "budget_auto_recovery",
              detail: { previousPauseReason: state.reason, pausedSince: state.since },
            });

            const alertChannelRef = resolveAlertChannel("budget", deckConfig);
            if (alertChannelRef) {
              const deckSiteUrl = getDeckSiteUrl();
              const pausedDuration = state.since ? Math.round((Date.now() - state.since) / 60_000) : 0;
              discord.sendRawAlert(alertChannelRef, {
                title: `Budget Auto-Recovery: ${agent}`,
                lines: [
                  `Agent:     ${agent}`,
                  `Status:    Automatically resumed after budget reset`,
                  `Paused:    ${pausedDuration}m (${state.reason ?? "budget exceeded"})`,
                ],
                buttons: [
                  { label: "View Costs", url: `${deckSiteUrl}/costs?agent=${agent}&range=today` },
                  { label: "View Logs", url: `${deckSiteUrl}/logs?agent=${agent}&since=${Date.now() - 10 * 60_000}` },
                  { label: "Configure", url: `${deckSiteUrl}/deck-config#edit.budgets` },
                ],
              });
            }
          }
        }
      } catch {
        // Don't crash on auto-recovery check
      }
    }, 60_000);
  },
};

export default plugin;
