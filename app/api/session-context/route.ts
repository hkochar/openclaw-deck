import { NextResponse } from "next/server";
import { querySessionContext } from "@/plugin/event-log";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = querySessionContext();
    return NextResponse.json({ ok: true, sessions });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
