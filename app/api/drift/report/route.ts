import { NextRequest, NextResponse } from "next/server";
import { reportDrift } from "@/plugin/event-log";

export const dynamic = "force-dynamic";

/** POST /api/drift/report — report a model drift event. */
export async function POST(req: NextRequest) {
  try {
    const { agentKey, configuredModel, actualModel, tag } = await req.json();
    if (!agentKey || !configuredModel || !actualModel || !tag) {
      return NextResponse.json(
        { ok: false, error: "agentKey, configuredModel, actualModel, tag required" },
        { status: 400 },
      );
    }
    reportDrift(agentKey, configuredModel, actualModel, tag);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
}
