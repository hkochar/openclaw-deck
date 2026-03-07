import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { logSystemEvent } from "@/app/api/_lib/system-log";
import { queryAgentsWithHealth } from "@/plugin/event-log";

const HOME = process.env.HOME || "~";
const CONFIG_PATH = path.join(HOME, ".openclaw", "openclaw.json");
const SESSION_STORE_PATH = path.join(HOME, ".openclaw", "agents", "main", "sessions", "sessions.json");

import { agentKeyMap, agentSessionKeys } from "@/lib/agent-config";

const AGENT_KEY_MAP = agentKeyMap();
const AGENT_SESSION_KEYS = agentSessionKeys();

import { resolveSessionModel } from "@/app/api/_lib/model-utils";
import type { SessionEntry } from "@/app/api/_lib/model-utils";

// Fetch actual running models from SQLite heartbeats
function fetchHeartbeatModels(): Record<string, string> {
  try {
    const agents = queryAgentsWithHealth();
    const map: Record<string, string> = {};
    for (const a of agents) {
      if (a.agent_key && a.model) map[a.agent_key] = a.model;
    }
    return map;
  } catch {
    return {};
  }
}

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    const agents: Array<{ id: string; model: string | { primary: string; fallbacks?: string[] } }> =
      config?.agents?.list ?? [];

    // Read session store for intentional overrides
    let sessionStore: Record<string, SessionEntry> = {};
    try {
      const sessionRaw = fs.readFileSync(SESSION_STORE_PATH, "utf-8");
      sessionStore = JSON.parse(sessionRaw);
    } catch {
      // Session store may not exist yet
    }

    // Fetch actual running models from heartbeats
    const heartbeatModels = fetchHeartbeatModels();

    const models: Record<string, { primary: string; fallbacks: string[]; sessionModel: string; actualModel?: string }> = {};
    for (const agent of agents) {
      const modelConfig = agent.model;
      if (!modelConfig || typeof modelConfig === "string") continue;
      if (!modelConfig.primary) continue;
      const key = AGENT_KEY_MAP[agent.id] ?? agent.id;
      const sessionKey = AGENT_SESSION_KEYS[key];
      const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;
      models[key] = {
        primary: modelConfig.primary,
        fallbacks: modelConfig.fallbacks ?? [],
        sessionModel: resolveSessionModel(sessionEntry, modelConfig.primary),
        actualModel: heartbeatModels[key],
      };
    }

    // Detect model mismatches: session override set but actual model differs
    for (const [key, m] of Object.entries(models)) {
      if (!m.actualModel) continue;
      const expected = m.sessionModel;
      const normalizeModel = (s: string) => s.replace(/^openrouter\/openrouter\//, "openrouter/");
      const normExpected = normalizeModel(expected);
      const normActual = normalizeModel(m.actualModel);
      if (normExpected.includes("/auto")) continue;
      if (normActual !== normExpected) {
        logSystemEvent({
          category: "model",
          action: "mismatch",
          summary: `${key} running ${m.actualModel} instead of expected ${expected}`,
          detail: { agent: key, expected, actual: m.actualModel, primary: m.primary, sessionOverride: expected !== m.primary },
          status: "error",
        });
      }
    }

    return NextResponse.json({ ok: true, models });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
