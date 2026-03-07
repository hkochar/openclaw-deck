import { NextRequest, NextResponse } from "next/server";
import { resolveDrift } from "@/plugin/event-log";

export const dynamic = "force-dynamic";

/** POST /api/drift/resolve — resolve all drift events for an agent. */
export async function POST(req: NextRequest) {
  try {
    const { agentKey } = await req.json();
    if (!agentKey) {
      return NextResponse.json({ ok: false, error: "agentKey required" }, { status: 400 });
    }
    resolveDrift(agentKey);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
}
