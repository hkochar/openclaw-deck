import { NextRequest, NextResponse } from "next/server";
import { logSystemEvent, querySystemLog } from "@/app/api/_lib/system-log";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const since = params.get("since") ? Number(params.get("since")) : undefined;
  const limit = Math.min(Math.max(params.get("limit") ? Number(params.get("limit")) : 200, 1), 5000);
  const categories = params.get("categories")
    ? params.get("categories")!.split(",").filter(Boolean)
    : undefined;

  const events = querySystemLog({ since, limit, categories });
  return NextResponse.json({ ok: true, events });
}

// Client-side components can POST log entries
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { category, action, summary, detail, status } = body;
    if (!category || !action || !summary) {
      return NextResponse.json({ ok: false, error: "category, action, summary required" }, { status: 400 });
    }
    logSystemEvent({
      category,
      action,
      summary,
      detail: detail ?? undefined,
      status: status ?? "ok",
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
}
