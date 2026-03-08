import { NextResponse } from "next/server";
import { queryUnresolvedDrift } from "@/plugin/event-log";

export const dynamic = "force-dynamic";

/** GET /api/drift — unresolved model drift events. */
export async function GET() {
  const events = queryUnresolvedDrift();
  return NextResponse.json({ ok: true, events });
}
