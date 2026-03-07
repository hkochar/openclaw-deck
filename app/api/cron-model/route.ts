import { NextRequest, NextResponse } from "next/server";
import { updateCronModel } from "@/plugin/event-log";

export const dynamic = "force-dynamic";

/** POST /api/cron-model — update cron model for an agent. */
export async function POST(req: NextRequest) {
  try {
    const { agentKey, cronModel } = await req.json();
    if (!agentKey || !cronModel) {
      return NextResponse.json({ ok: false, error: "agentKey and cronModel required" }, { status: 400 });
    }
    updateCronModel(agentKey, cronModel);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
}
