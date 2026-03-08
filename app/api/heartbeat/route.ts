import { NextRequest, NextResponse } from "next/server";
import { upsertHeartbeat } from "@/plugin/event-log";

export const dynamic = "force-dynamic";

/** POST /api/heartbeat — upsert agent heartbeat. */
export async function POST(req: NextRequest) {
  try {
    const { agentKey, status, model, configuredModel, sessionKey, bio } = await req.json();
    if (!agentKey || !status) {
      return NextResponse.json({ ok: false, error: "agentKey and status required" }, { status: 400 });
    }
    upsertHeartbeat({ agentKey, status, model, configuredModel, sessionKey, bio });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
}
