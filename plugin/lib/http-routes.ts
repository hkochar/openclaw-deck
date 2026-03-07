import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";

/** Check if hostname is a Tailscale CGNAT IP (100.64.0.0/10). */
function isTailscaleIp(host: string): boolean {
  if (net.isIP(host) !== 4) return false;
  const parts = host.split(".");
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 100 && b >= 64 && b <= 127;
}

const EXTRA_ORIGINS = (process.env.DECK_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

/** Set CORS header only for trusted local origins (localhost, loopback, Tailscale CGNAT, env allowlist). */
function setCorsOrigin(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || isTailscaleIp(hostname) || EXTRA_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
  } catch {}
}
import {
  queryStream, querySummary, querySubFilterCounts, queryAgents,
  queryCostSummary, queryCostTimeline, queryToolCosts,
  queryMemoryOps, queryMemoryTimeline, queryContextUtilization,
  queryMessageDelivery, querySessions, queryEventDetail,
  queryDailyActivity, queryActivityChunksForDay,
  getDroppedEventCount, getActiveLoops, getProviderHealth,
  getPricingTable, getDb, logEvent,
} from "../event-log";
import {
  loadBudgetConfig, checkBudget, getThrottledModel,
  loadAllPausedState, loadPausedState, writePausedState,
  checkAllProviderLimits, sendBudgetAlert, loadProviderLimits,
  loadBudgetOverrides, setBudgetOverride, clearBudgetOverride,
  shouldAutoRecover, getDeckSiteUrl, getReplaySessionSummaries,
  fireReplayAlert,
  type ReplayAlertEvent,
} from "../budget";
import { checkAgentSilence, getAgentActivity } from "../event-log";
import type { DeckAgentConfig, GatewayAgentEntry } from "./config-loader";

export interface HttpRouteContext {
  sessionPoller: { getStatus(): unknown };
  knownAgents: string[];
  deckConfig: DeckAgentConfig | null;
  deckBotToken: string;
  discord: { botToken: string; sendReplayAlert(event: unknown, channelId: string): void };
  getOrKeyUsage(): unknown;
  findGatewayAgent(agentKey: string): GatewayAgentEntry | undefined;
}

export function registerHttpRoutes(api: OpenClawPluginApi, ctx: HttpRouteContext): void {
  // ── Log stream ────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/stream",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", "http://localhost");
      const result = queryStream({
        agent: url.searchParams.get("agent") || undefined,
        type: url.searchParams.get("type") || undefined,
        types: url.searchParams.get("types") || undefined,
        since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
        until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        runId: url.searchParams.get("run_id") || undefined,
        session: url.searchParams.get("session") || undefined,
        subFilters: url.searchParams.get("sub_filters") || undefined,
        source: url.searchParams.get("source") || undefined,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Event detail ──────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/event-detail",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = Number(url.searchParams.get("id"));
      if (!id || isNaN(id)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Missing or invalid id parameter" }));
        return;
      }
      const result = queryEventDetail(id);
      res.statusCode = result ? 200 : 404;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result ?? { error: "Not found" }));
    },
  });

  // ── Summary ───────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/summary",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", "http://localhost");
      const since = url.searchParams.has("since")
        ? Number(url.searchParams.get("since"))
        : Date.now() - 24 * 60 * 60 * 1000;
      const agent = url.searchParams.get("agent") || undefined;
      const result = querySummary(since, agent);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Sub-filter counts ─────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/sub-filter-counts",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", "http://localhost");
      const since = url.searchParams.has("since")
        ? Number(url.searchParams.get("since"))
        : Date.now() - 24 * 60 * 60 * 1000;
      const until = url.searchParams.has("until")
        ? Number(url.searchParams.get("until"))
        : undefined;
      const result = querySubFilterCounts(since, until);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Agents list ───────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/agents",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const result = queryAgents();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Tool costs ────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/tool-costs",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const since = Number(url.searchParams.get("since") ?? Date.now() - 7 * 86400000);
      const agent = url.searchParams.get("agent") || undefined;
      const result = queryToolCosts(since, agent);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Health ────────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/health",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      const loops = getActiveLoops();
      const silent = checkAgentSilence(ctx.knownAgents);
      const result = {
        ok: loops.length === 0,
        uptime: Math.floor(process.uptime()),
        droppedEvents: getDroppedEventCount(),
        activeLoops: loops.length,
        loops: loops.map(l => ({ agent: l.agent, tool: l.tool, count: l.count, since: l.firstTs })),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        providers: getProviderHealth(),
        silentAgents: silent.length,
        poller: ctx.sessionPoller.getStatus(),
        ts: Date.now(),
      };
      res.statusCode = loops.length > 0 ? 503 : 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Stuck loops ───────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/stuck-loops",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      const result = getActiveLoops();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Reliability: sessions ─────────────────────────────────────────
  api.registerHttpRoute({
    path: "/reliability/sessions",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      const config = loadBudgetConfig();
      res.end(JSON.stringify({ cap: config.sessionCostCap, sessions: getReplaySessionSummaries(20) }));
    },
  });

  // ── Reliability: providers ────────────────────────────────────────
  api.registerHttpRoute({
    path: "/reliability/providers",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(getProviderHealth()));
    },
  });

  // ── Reliability: agents ───────────────────────────────────────────
  api.registerHttpRoute({
    path: "/reliability/agents",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify({
        activity: getAgentActivity(),
        silent: checkAgentSilence(ctx.knownAgents),
      }));
    },
  });

  // ── Reliability: context ──────────────────────────────────────────
  api.registerHttpRoute({
    path: "/reliability/context",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const since = Number(url.searchParams.get("since") ?? Date.now() - 7 * 86400000);
      const agent = url.searchParams.get("agent") || undefined;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(queryContextUtilization(since, agent)));
    },
  });

  // ── Reliability: messages ─────────────────────────────────────────
  api.registerHttpRoute({
    path: "/reliability/messages",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const since = Number(url.searchParams.get("since") ?? Date.now() - 24 * 86400000);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(queryMessageDelivery(since)));
    },
  });

  // ── Memory ops ────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/memory-ops",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const since = Number(url.searchParams.get("since") ?? Date.now() - 7 * 86400000);
      const agent = url.searchParams.get("agent") || undefined;
      const result = queryMemoryOps(since, agent);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Memory timeline ───────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/memory-timeline",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const since = Number(url.searchParams.get("since") ?? Date.now() - 7 * 86400000);
      const agent = url.searchParams.get("agent") || undefined;
      const file = url.searchParams.get("file") || undefined;
      const result = queryMemoryTimeline(since, { agent, file });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Poller status ─────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/poller-status",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(ctx.sessionPoller.getStatus()));
    },
  });

  // ── Sessions ──────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/sessions",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const agent = url.searchParams.get("agent") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const includeArchived = url.searchParams.get("include_archived") === "true";
      const result = querySessions({ agent, status: status ?? (includeArchived ? "all" : undefined), includeArchived });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Costs summary ─────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/costs",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const result = queryCostSummary();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Cost timeline ─────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/logs/timeline",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const agent = url.searchParams.get("agent") ?? undefined;
      const days = parseInt(url.searchParams.get("days") ?? "7", 10);
      const result = queryCostTimeline({ agent, days: isNaN(days) ? 7 : days });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Daily activity ────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/activity/daily",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const days = parseInt(url.searchParams.get("days") ?? "30", 10);
      const result = queryDailyActivity({ days: isNaN(days) ? 30 : days });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Day sessions ──────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/activity/day-sessions",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const date = url.searchParams.get("date");
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Missing or invalid date param (YYYY-MM-DD)" }));
        return;
      }
      const result = queryActivityChunksForDay(date);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Week sessions ─────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/activity/week-sessions",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      if (!start || !end || !datePattern.test(start) || !datePattern.test(end)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Missing or invalid start/end params (YYYY-MM-DD)" }));
        return;
      }
      const result: Record<string, unknown> = {};
      const startDate = new Date(start + "T00:00:00");
      const endDate = new Date(end + "T00:00:00");
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        result[ds] = queryActivityChunksForDay(ds);
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(result));
    },
  });

  // ── Budget status ─────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/budget/status",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const sinceParam = url.searchParams.get("since");
      const untilParam = url.searchParams.get("until");
      const since = sinceParam ? Number(sinceParam) : undefined;
      const until = untilParam ? Number(untilParam) : undefined;
      const costs = queryCostSummary((since || until) ? { since, until } : undefined);
      const config = loadBudgetConfig();
      const paused = loadAllPausedState();
      const pricing = getPricingTable();

      const overrides = loadBudgetOverrides();

      const agents = costs.map((c) => {
        const agentBudget = config.agents[c.agent];
        const budgetResult = checkBudget(c.agent);

        let throttledTo: string | null = null;
        if (budgetResult.action === "throttle") {
          const agentCfg = ctx.findGatewayAgent(c.agent);
          const primaryModel = agentCfg?.model ?? "claude-opus-4-6";
          const throttled = getThrottledModel(primaryModel);
          throttledTo = throttled?.model ?? null;
        }

        let blockedAttempts = 0;
        const pauseState = paused[c.agent];
        if (pauseState?.paused && pauseState.since) {
          try {
            const db = getDb();
            const row = db.prepare(`SELECT COALESCE(SUM(json_extract(detail, '$.blocked_count')), 0) as cnt FROM events WHERE agent = ? AND type = 'budget_blocked' AND ts > ?`).get(c.agent, pauseState.since) as { cnt: number } | undefined;
            blockedAttempts = row?.cnt ?? 0;
          } catch { /* ok */ }
        }

        return {
          ...c,
          budget: agentBudget ?? null,
          paused: pauseState?.paused ?? false,
          pauseReason: pauseState?.reason ?? null,
          pausedSince: pauseState?.since ?? null,
          dailyPercent: agentBudget?.daily
            ? Math.round((c.daily / agentBudget.daily!) * 100)
            : null,
          budgetAction: budgetResult.action,
          throttledTo,
          blockedAttempts,
          autoRecovery: shouldAutoRecover(c.agent),
          override: overrides[c.agent] ?? null,
        };
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify({
        agents,
        global: config.global,
        alertThresholds: config.alertThresholds,
        pricing,
      }));
    },
  });

  // ── Provider limits status ────────────────────────────────────────
  api.registerHttpRoute({
    path: "/provider-limits/status",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      const windows = checkAllProviderLimits();
      const config = loadProviderLimits();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify({ windows, config }));
    },
  });

  // ── OpenRouter provider costs ─────────────────────────────────────
  api.registerHttpRoute({
    path: "/provider-costs/openrouter",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(ctx.getOrKeyUsage() ?? { error: "no API key or not fetched yet" }));
    },
  });

  // ── Pause status ──────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/agent/pause-status",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(loadAllPausedState()));
    },
  });

  // ── Pause/unpause agent ───────────────────────────────────────────
  api.registerHttpRoute({
    path: "/agent/pause",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        setCorsOrigin(req, res);
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.end();
        return;
      }
      if (req.method !== "POST") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { agent, paused, reason } = JSON.parse(body) as { agent: string; paused: boolean; reason?: string };
          if (!agent) { res.statusCode = 400; res.end(JSON.stringify({ error: "agent required" })); return; }
          writePausedState(agent, paused, reason ?? "manual");
          logEvent({
            agent,
            type: paused ? "agent_paused" : "agent_resumed",
            detail: { reason: reason ?? "manual" },
          });

          // Send Discord system alert for pause/resume
          const config = loadBudgetConfig();
          const alertChannelId = ctx.deckConfig?.systemChannels?.[config.alertChannel] ?? "";
          const botToken = ctx.deckBotToken || ctx.discord.botToken;
          if (botToken && alertChannelId) {
            sendBudgetAlert(agent, paused ? "paused" : "resumed", alertChannelId, botToken, {
              trigger: reason ?? "manual",
              skipCooldown: true,
            }).catch(() => {});
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          setCorsOrigin(req, res);
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid JSON body" }));
        }
      });
    },
  });

  // ── Budget overrides list ─────────────────────────────────────────
  api.registerHttpRoute({
    path: "/budget/overrides",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      setCorsOrigin(req, res);
      res.end(JSON.stringify(loadBudgetOverrides()));
    },
  });

  // ── Budget override set/clear ─────────────────────────────────────
  api.registerHttpRoute({
    path: "/budget/override",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        setCorsOrigin(req, res);
        res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);

          if (req.method === "POST") {
            const { agent, durationHours, reason } = parsed;
            if (!agent || !durationHours) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "agent and durationHours required" }));
              return;
            }
            const override = setBudgetOverride(agent, durationHours * 3600_000, reason ?? "emergency override");
            logEvent({
              agent,
              type: "budget_override_start",
              detail: { durationHours, reason, expiresAt: override.expiresAt },
            });

            const config = loadBudgetConfig();
            const alertChannelId = ctx.deckConfig?.systemChannels?.[config.alertChannel] ?? "";
            const botToken = ctx.deckBotToken || ctx.discord.botToken;
            if (botToken && alertChannelId) {
              const deckSiteUrl = getDeckSiteUrl();
              fetch(`https://discord.com/api/v10/channels/${alertChannelId}/messages`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bot ${botToken}` },
                body: JSON.stringify({
                  content: [
                    `**Budget Override: ${agent}**`,
                    "```",
                    `Agent:     ${agent}`,
                    `Duration:  ${durationHours}h`,
                    `Reason:    ${reason ?? "emergency"}`,
                    `Expires:   ${new Date(override.expiresAt).toLocaleString("en-US")}`,
                    `Status:    All budget limits temporarily lifted`,
                    "```",
                  ].join("\n"),
                  components: [{
                    type: 1,
                    components: [
                      { type: 2, style: 5, label: "View Costs", url: `${deckSiteUrl}/costs?agent=${agent}&range=today` },
                      { type: 2, style: 5, label: "View Logs", url: `${deckSiteUrl}/logs?agent=${agent}&since=${Date.now() - 10 * 60_000}` },
                      { type: 2, style: 5, label: "Configure", url: `${deckSiteUrl}/deck-config#edit.budgets` },
                    ],
                  }],
                }),
                signal: AbortSignal.timeout(10_000),
              }).catch(() => {});
            }

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            setCorsOrigin(req, res);
            res.end(JSON.stringify({ ok: true, override }));
            return;
          }

          if (req.method === "DELETE") {
            const { agent } = parsed;
            if (!agent) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "agent required" }));
              return;
            }
            clearBudgetOverride(agent);
            logEvent({ agent, type: "budget_override_cleared" });
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            setCorsOrigin(req, res);
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          res.statusCode = 405;
          res.end("Method Not Allowed");
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid JSON body" }));
        }
      });
    },
  });

  // ── Test budget alert ─────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/budget/test-alert",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        setCorsOrigin(req, res);
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.end();
        return;
      }
      if (req.method !== "POST") { res.statusCode = 405; res.end("Method Not Allowed"); return; }

      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const { agent, level } = parsed as { agent?: string; level?: string };
          if (!agent) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "agent required" }));
            return;
          }
          const alertLevel = (level === "exceeded" || level === "blocked") ? level : "threshold";

          const config = loadBudgetConfig();
          const alertChannelId = ctx.deckConfig?.systemChannels?.[config.alertChannel] ?? "";
          const botToken = ctx.deckBotToken || ctx.discord.botToken;

          if (!botToken || !alertChannelId) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            setCorsOrigin(req, res);
            res.end(JSON.stringify({ ok: true, sent: false, reason: "no bot token or alert channel" }));
            return;
          }

          const costs = queryCostSummary();
          const agentCost = costs.find((c) => c.agent === agent);
          const agentBudget = config.agents[agent];
          const testRatio = agentBudget?.daily && agentCost
            ? agentCost.daily / agentBudget.daily
            : alertLevel === "blocked" ? 1.15 : alertLevel === "exceeded" ? 1.0 : 0.85;

          await sendBudgetAlert(agent, alertLevel, alertChannelId, botToken, {
            trigger: "agent", period: "daily", ratio: testRatio, skipCooldown: true,
          });

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          setCorsOrigin(req, res);
          res.end(JSON.stringify({ ok: true, sent: true, level: alertLevel, costView: config.costView }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          setCorsOrigin(req, res);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  });

  // ── Test replay alert ─────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/replay/test-alert",
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        setCorsOrigin(req, res);
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.end();
        return;
      }
      if (req.method !== "POST") { res.statusCode = 405; res.end("Method Not Allowed"); return; }

      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          const { agent, type } = parsed as { agent?: string; type?: string };
          if (!agent) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "agent required" }));
            return;
          }

          const alertType = (["session-cost", "step-cost", "long-session", "excessive-tools", "context-critical"].includes(type ?? ""))
            ? type! : "session-cost";

          const budgetCfg = loadBudgetConfig();
          const costViewLabel = budgetCfg.costView === "actual" ? "Actual"
            : budgetCfg.costView === "api-equiv" ? "API Equiv" : "Total";

          const testEvents: Record<string, ReplayAlertEvent> = {
            "session-cost": {
              type: "session-cost", agent, session: "test-session",
              value: 7.50, threshold: 5.00,
              detail: { totalCost: 7.50, costView: costViewLabel, billing: "metered",
                actualCost: 7.50, apiEquivCost: 7.50, test: true },
            },
            "step-cost": {
              type: "step-cost", agent, session: "test-session",
              value: 0.85, threshold: 0.50,
              detail: { stepCost: 0.85, model: "claude-opus-4-6", costView: costViewLabel,
                billing: "metered", actualCost: 0.85, apiEquivCost: 0.85, test: true },
            },
            "long-session": {
              type: "long-session", agent, session: "test-session",
              value: 90, threshold: 60,
              detail: { durationMinutes: 90, startTs: Date.now() - 90 * 60_000, test: true },
            },
            "excessive-tools": {
              type: "excessive-tools", agent, session: "test-session",
              value: 250, threshold: 200,
              detail: { toolCallCount: 250, test: true },
            },
            "context-critical": {
              type: "context-critical", agent, session: "test-session",
              value: 92, threshold: 85,
              detail: { utilization: 92, inputTokens: 184_000, cacheRead: 50_000, maxContext: 200_000,
                model: "claude-opus-4-6", test: true },
            },
          };

          fireReplayAlert(testEvents[alertType]);

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          setCorsOrigin(req, res);
          res.end(JSON.stringify({ ok: true, type: alertType, costView: budgetCfg.costView, alertChannel: budgetCfg.alertChannel }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          setCorsOrigin(req, res);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  });
}
