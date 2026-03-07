import { NextResponse } from "next/server";
import { queryAgentsWithHealth } from "@/plugin/event-log";
import agentsConfig from "@/config/deck-agents.json";

export const dynamic = "force-dynamic";

/** GET /api/agents — agent roster merged with heartbeat health. */
export async function GET() {
  const heartbeats = queryAgentsWithHealth();
  const hbMap = new Map(heartbeats.map((h) => [h.agent_key, h]));

  const now = Date.now();
  const agents = agentsConfig.agents.map((a) => {
    const hb = hbMap.get(a.key);
    const lastHb = hb?.last_heartbeat ?? null;
    const ageMs = lastHb ? now - lastHb : null;
    return {
      id: a.id,
      key: a.key,
      name: a.name,
      role: a.role,
      emoji: a.emoji,
      status: hb?.status ?? "offline",
      computed_status: hb?.computed_status ?? "offline",
      model: hb?.model ?? null,
      configured_model: hb?.configured_model ?? null,
      session_key: hb?.session_key ?? null,
      cron_model: hb?.cron_model ?? null,
      cron_model_updated_at: hb?.cron_model_updated_at ?? null,
      bio: hb?.bio ?? null,
      last_heartbeat: lastHb,
      heartbeat_age_ms: ageMs,
      is_stale: ageMs != null && ageMs > 2 * 60 * 1000,
      is_offline: ageMs == null || ageMs > 5 * 60 * 1000,
    };
  });

  return NextResponse.json({ ok: true, agents });
}
