import { NextRequest, NextResponse } from "next/server";
import { queryActivities } from "@/plugin/event-log";
import agentsConfig from "@/config/deck-agents.json";

export const dynamic = "force-dynamic";

const emojiMap = new Map(agentsConfig.agents.map((a) => [a.key, a.emoji]));

/** GET /api/activities — recent activity feed. */
export async function GET(req: NextRequest) {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? 50), 1), 1000);
  const events = queryActivities(limit).map((e) => ({
    ...e,
    agent_emoji: emojiMap.get(e.agent_key ?? "") ?? "",
  }));
  return NextResponse.json({ ok: true, events });
}
